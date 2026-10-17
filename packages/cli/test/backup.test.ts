import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backup.js';
import { openHub } from '../src/engine-client.js';

describe('kalibra backup', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'kalibra-bk-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('copies every project while Kalibra is running, and the copy opens as-is', async () => {
    const dir = tmp();
    const hub = openHub(dir);
    const me = hub.localPrincipal();
    const voice = await hub.call<any>(me, 'create_project', { name: 'Voice' });
    await hub.callProject(me, 'default', 'create_dataset', { name: 'D1', columns: [{ key: 'q' }] });
    await hub.callProject(me, voice.id, 'create_dataset', { name: 'D2', columns: [{ key: 'q' }] });
    const blob = await hub.callProject<any>(me, voice.id, 'upload_file', { name: 'a.txt', base64: Buffer.from('hello').toString('base64') });
    writeFileSync(join(dir, '.engine.json'), '{}');

    // The hub stays open (as a running server would) while the backup is taken.
    const out = join(tmp(), 'backup');
    const r = backup(dir, out);
    hub.close();
    expect(r.databases).toBe(3); // hub.db + two projects
    expect(readdirSync(out)).not.toContain('.engine.json');
    expect(readdirSync(out).some((f) => f.endsWith('-wal'))).toBe(false);

    const restored = openHub(out);
    const p = restored.localPrincipal();
    expect((await restored.call<any[]>(p, 'list_projects', {})).map((x) => x.name).sort()).toEqual(['My project', 'Voice']);
    expect((await restored.callProject<any[]>(p, voice.id, 'list_datasets', {})).map((d) => d.name)).toEqual(['D2']);
    expect((await restored.engine(voice.id).blobs.get(blob.hash)).toString()).toBe('hello');
    restored.close();
  });

  it('does not copy a backup folder kept inside the data folder into itself', () => {
    const dir = tmp();
    openHub(dir).close();
    const r = backup(dir, join(dir, 'backups', 'today'));
    expect(r.databases).toBe(1); // hub.db (no project opened yet)
    expect(readdirSync(join(dir, 'backups', 'today', 'backups'))).toEqual([]);
  });

  it('refuses a folder that already has files and a folder without Kalibra data', () => {
    const full = tmp();
    writeFileSync(join(full, 'x'), 'x');
    expect(() => backup(tmp(), join(tmp(), 'b'))).toThrow(/No Kalibra data/);
    const dir = tmp();
    openHub(dir).close();
    expect(() => backup(dir, full)).toThrow(/not empty/);
  });
});
