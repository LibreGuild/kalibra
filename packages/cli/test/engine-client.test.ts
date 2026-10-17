import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '@kalibra/core';
import { startServer } from '@kalibra/server';
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

  it('explains that secrets encrypted by the old desktop app must be added again, instead of reading them as unset', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'secrets.enc'), 'opaque');
    const store = secretsFor(dir);
    await expect(store.get('openai_api_key')).rejects.toThrow(/Delete secrets\.enc/);
    await expect(store.list()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('talks to a team server under /kalibra, with or without /kalibra in the address', async () => {
    const hub = await Hub.open({ dir: tmp(), mode: 'server' });
    await hub.completeSetup((await hub.setupCode())!, { username: 'admin', password: 'a-long-password-1' });
    const { token } = await hub.accounts.createToken((await hub.accounts.find('admin'))!.id, { name: 'cli' });
    const srv = await startServer({ hub });
    try {
      for (const server of [srv.url, `${srv.url}/`, `${srv.url}/kalibra`, `${srv.url}/kalibra/`]) {
        const client = await connect(tmp(), { kind: 'cli', id: 'cli' }, { server, token });
        expect(client.mode).toBe('remote');
        expect(client.serverUrl).toBe(srv.url);
        expect(await client.call('list_datasets', {})).toEqual([]);
        await client.close();
      }
    } finally {
      await srv.close();
      await hub.close();
    }
  });

  it('works in the default project and switches projects in process', async () => {
    const dir = tmp();
    const hub = await openHub(dir);
    const voice = await hub.call<any>(hub.localPrincipal(), 'create_project', { name: 'Voice' });
    await hub.close();

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
