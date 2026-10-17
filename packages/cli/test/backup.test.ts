import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backup } from '../src/backup.js';
import { openHub, usesLocalFilesOfRunningServer, writeServerMarker, clearServerMarker } from '../src/engine-client.js';
import { fileKey, MemoryObjects, sqliteDatabases } from '@kalibra/core';

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
    const hub = await openHub(dir);
    const me = hub.localPrincipal();
    const voice = await hub.call<any>(me, 'create_project', { name: 'Voice' });
    await hub.callProject(me, 'default', 'create_dataset', { name: 'D1', columns: [{ key: 'q' }] });
    await hub.callProject(me, voice.id, 'create_dataset', { name: 'D2', columns: [{ key: 'q' }] });
    const blob = await hub.callProject<any>(me, voice.id, 'upload_file', { name: 'a.txt', base64: Buffer.from('hello').toString('base64') });
    writeFileSync(join(dir, '.engine.json'), '{}');

    // The hub stays open (as a running server would) while the backup is taken.
    const out = join(tmp(), 'backup');
    const r = await backup(dir, out);
    await hub.close();
    expect(r.databases).toBe(3); // hub.db + two projects
    expect(readdirSync(out)).not.toContain('.engine.json');
    expect(readdirSync(out).some((f) => f.endsWith('-wal'))).toBe(false);

    // The copy is always a plain SQLite data folder (also when the data was in Postgres).
    const restored = await openHub(out, 'local', { databases: sqliteDatabases() });
    const p = restored.localPrincipal();
    expect((await restored.call<any[]>(p, 'list_projects', {})).map((x) => x.name).sort()).toEqual(['My project', 'Voice']);
    expect((await restored.callProject<any[]>(p, voice.id, 'list_datasets', {})).map((d) => d.name)).toEqual(['D2']);
    expect((await (await restored.engine(voice.id)).blobs.get(blob.hash)).toString()).toBe('hello');
    await restored.close();
  });

  it('with a bucket: downloads the referenced files and leaves the sync state and cache out', async () => {
    const dir = tmp();
    const hub = await openHub(dir);
    const me = hub.localPrincipal();
    const blob = await hub.callProject<any>(me, 'default', 'upload_file', { name: 'a.txt', base64: Buffer.from('in the bucket').toString('base64') });
    const projectDir = (await hub.engine('default')).dir;
    await hub.close();
    // As in setup B: the file lives in the bucket (not on disk), and the sync left its markers and cache.
    const objects = new MemoryObjects();
    await objects.put(fileKey(blob.hash), Buffer.from('in the bucket'));
    rmSync(join(projectDir, 'blobs'), { recursive: true, force: true });
    writeFileSync(join(dir, 'hub.db.sync.json'), '{"generation":"g","seq":3}');
    mkdirSync(join(dir, 'cache', 'files'), { recursive: true });
    writeFileSync(join(dir, 'cache', 'files', 'x'), 'cached');

    const out = join(tmp(), 'backup');
    const r = await backup(dir, out, { objects });
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(out, 'hub.db.sync.json'))).toBe(false);
    expect(existsSync(join(out, 'cache'))).toBe(false);
    const restored = await openHub(out, 'local', { databases: sqliteDatabases() });
    expect((await (await restored.engine('default')).blobs.get(blob.hash)).toString()).toBe('in the bucket');
    await restored.close();
  });

  it('kalibra users works on the files of a setup-B server running on this machine', () => {
    const dir = tmp();
    const b = { KALIBRA_STORAGE_URL: 'gs://bucket/x', KALIBRA_SECRET_KEY: 'k'.repeat(44) };
    expect(usesLocalFilesOfRunningServer(dir, b)).toBe(false); // nothing running: takes the lease as usual
    writeServerMarker(dir);
    try {
      expect(usesLocalFilesOfRunningServer(dir, b)).toBe(true);
      expect(usesLocalFilesOfRunningServer(dir, {})).toBe(false); // setup A: files are local anyway
      expect(usesLocalFilesOfRunningServer(dir, { ...b, KALIBRA_DATABASE_URL: 'postgres://h/d' })).toBe(false); // Postgres: no lease
    } finally {
      clearServerMarker(dir);
    }
  });

  it('does not copy a backup folder kept inside the data folder into itself', async () => {
    const dir = tmp();
    await (await openHub(dir)).close();
    const r = await backup(dir, join(dir, 'backups', 'today'));
    expect(r.databases).toBe(1); // hub.db (no project opened yet)
    expect(readdirSync(join(dir, 'backups', 'today', 'backups'))).toEqual([]);
  });

  it('refuses a folder that already has files and a folder without Kalibra data', async () => {
    const full = tmp();
    writeFileSync(join(full, 'x'), 'x');
    await expect(backup(tmp(), join(tmp(), 'b'))).rejects.toThrow(/No Kalibra data/);
    const dir = tmp();
    await (await openHub(dir)).close();
    await expect(backup(dir, full)).rejects.toThrow(/not empty/);
  });
});
