import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, openHub, secretsFor } from '../src/engine-client.js';

describe('CLI access to Kalibra', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'kalibra-cli-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('uses the plain secret file for CLI workspaces', async () => {
    const store = secretsFor(tmp());
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });

  it('explains that desktop-encrypted secrets need the app instead of reading them as unset', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'secrets.enc'), 'opaque');
    const store = secretsFor(dir);
    await expect(store.get('openai_api_key')).rejects.toThrow(/desktop app/);
    await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('works in the default project and switches projects in process', async () => {
    const dir = tmp();
    const hub = openHub(dir);
    const voice = await hub.call<any>(hub.localPrincipal(), 'create_project', { name: 'Voice' });
    hub.close();

    const client = await connect(dir, { kind: 'cli', id: 'cli' });
    expect(client.mode).toBe('local');
    expect(client.project()).toBe('default');
    await client.call('create_dataset', { name: 'In default', columns: [{ key: 'q' }] });
    await client.useProject('voice');
    expect(client.project()).toBe(voice.id);
    expect(await client.call('list_datasets', {})).toEqual([]);
    const names = (await client.describe()).filter((o) => o.hub).map((o) => o.name);
    expect(names).toContain('list_projects');
    await expect(client.useProject('missing')).rejects.toThrow(/not found/);
    await client.close();

    const again = await connect(dir, { kind: 'cli', id: 'cli' }, { project: 'Voice' });
    expect(again.project()).toBe(voice.id);
    await again.close();
  });
});
