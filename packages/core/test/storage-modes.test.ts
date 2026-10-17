import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, PROJECT_MIGRATIONS, sqliteControl, type Db } from '../src/db.js';
import { BucketBlobStore, FileCache } from '../src/deploy/bucket-blobs.js';
import { deployConfigFrom } from '../src/deploy/config.js';
import { BucketLease, leaseIsFree } from '../src/deploy/lease.js';
import { MemoryObjects, openObjectStore, PreconditionFailed, type ObjectStore } from '../src/deploy/objects.js';
import { DbSecretStore, SecretKey } from '../src/deploy/secrets.js';
import { decodeDelta, encodeDelta, readWal, SqliteSync, syncedClose } from '../src/deploy/sqlite-sync.js';
import { openStorage } from '../src/deploy/storage.js';
import { Hub } from '../src/hub/hub.js';
import { LOCAL_USER } from '../src/registry.js';

const KEY = 'k'.repeat(44); // base64 of 33 bytes
const dirs: string[] = [];
const tmp = (name = 'kalibra-storage-') => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const text = async (s: NodeJS.ReadableStream | Readable) => {
  const parts: Buffer[] = [];
  for await (const c of s as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString('utf8');
};

// ── Bucket contract: the same checks for every store ─────────────────────────

const stores: [string, () => Promise<ObjectStore>][] = [['memory', async () => new MemoryObjects()]];
// Real clouds when configured, e.g. KALIBRA_TEST_GCS=gs://bucket/prefix (credentials from the environment).
for (const [name, env] of [['gcs', 'KALIBRA_TEST_GCS'], ['s3', 'KALIBRA_TEST_S3'], ['azure', 'KALIBRA_TEST_AZURE']] as const) {
  const url = process.env[env];
  if (url) stores.push([name, () => openObjectStore({ storageUrl: `${url.replace(/\/$/, '')}/contract-${Date.now()}`, s3Endpoint: process.env.KALIBRA_S3_ENDPOINT, s3Region: process.env.KALIBRA_S3_REGION })]);
}

describe.each(stores)('bucket contract: %s', (_name, open) => {
  it('puts, reads, lists, streams ranges and deletes', { timeout: 60_000 }, async () => {
    const s = await open();
    const a = await s.put('dir/a.txt', Buffer.from('hello world'), { contentType: 'text/plain' });
    expect(a.size).toBe(11);
    expect((await s.get('dir/a.txt'))?.data.toString()).toBe('hello world');
    expect(await s.get('dir/missing')).toBeUndefined();
    expect(await s.head('dir/missing')).toBeUndefined();
    expect((await s.head('dir/a.txt'))?.size).toBe(11);
    expect(await text(await s.stream('dir/a.txt', { start: 6, end: 10 }))).toBe('world');
    const f = join(tmp(), 'b.bin');
    writeFileSync(f, Buffer.alloc(3000, 7));
    await s.putFile('dir/b.bin', f);
    expect(await s.list('dir/')).toEqual(['dir/a.txt', 'dir/b.bin']);
    await expect(s.stream('dir/nope')).rejects.toThrow();
    await s.delete('dir/a.txt');
    await s.delete('dir/b.bin');
    await s.delete('dir/never-existed');
    expect(await s.list('dir/')).toEqual([]);
  });

  it('refuses conditional writes that would overwrite someone else', { timeout: 60_000 }, async () => {
    const s = await open();
    const v1 = await s.put('lease.json', Buffer.from('1'), { ifAbsent: true });
    await expect(s.put('lease.json', Buffer.from('x'), { ifAbsent: true })).rejects.toBeInstanceOf(PreconditionFailed);
    const v2 = await s.put('lease.json', Buffer.from('2'), { ifVersion: v1.version });
    await expect(s.put('lease.json', Buffer.from('3'), { ifVersion: v1.version })).rejects.toBeInstanceOf(PreconditionFailed);
    expect((await s.get('lease.json'))?.info.version).toBe(v2.version);
    await s.delete('lease.json');
  });
});

// ── Files in a bucket ────────────────────────────────────────────────────────

describe('files in a bucket', () => {
  async function project(objects: MemoryObjects, cache: FileCache) {
    const db = await openSqlite(':memory:', PROJECT_MIGRATIONS);
    return { db, blobs: new BucketBlobStore(objects, db, cache) };
  }

  it('stores each file once, reads it back (also in ranges) and keeps projects apart', async () => {
    const objects = new MemoryObjects();
    const cache = new FileCache(join(tmp(), 'cache'), 1 << 20);
    const a = await project(objects, cache);
    const b = await project(objects, cache);
    const data = Buffer.from('RIFF....WAVEfmt the audio bytes');
    const info = await a.blobs.put(data, { name: 'clip.wav' });
    expect(info.mime).toBe('audio/wav');
    expect([...objects.objects.keys()]).toEqual([`files/${info.hash.slice(0, 2)}/${info.hash.slice(2, 4)}/${info.hash}`]);
    await b.blobs.put(data, { name: 'same.wav' });
    expect(objects.calls.put).toBe(1); // the second project's identical file is not uploaded again
    expect((await a.blobs.get(info.hash)).toString()).toBe(data.toString());
    expect(await text(a.blobs.stream(info.hash, { start: 0, end: 3 }))).toBe('RIFF');
    expect(await a.blobs.has(info.hash)).toBe(true);
    // A project without a record of the file can't read it, even though the bucket has it.
    const c = await project(objects, cache);
    expect(await c.blobs.has(info.hash)).toBe(false);
    await expect(c.blobs.get(info.hash)).rejects.toThrow(/not found/i);
  });

  it('downloads into a bounded cache and serves ranges before the file is cached', async () => {
    const objects = new MemoryObjects();
    const dir = tmp();
    const cache = new FileCache(join(dir, 'cache'), 2500);
    const p = await project(objects, cache);
    const one = await p.blobs.put(Buffer.alloc(1500, 1), {});
    const two = await p.blobs.put(Buffer.alloc(1500, 2), {});
    expect(cache.size).toBeLessThanOrEqual(2500); // the first file was evicted
    expect(cache.has(one.hash)).toBe(false);
    expect(await text(p.blobs.stream(one.hash, { start: 0, end: 2 }))).toBe('\x01\x01\x01');
    await new Promise((r) => setTimeout(r, 50)); // background download of the whole file
    expect((await p.blobs.get(one.hash)).length).toBe(1500);
    expect((await p.blobs.get(two.hash))[0]).toBe(2);
    // A fresh process finds the cache on disk.
    expect(new FileCache(join(dir, 'cache'), 2500).size).toBe(cache.size);
  });

  it('streams large uploads through a temp file and enforces the size limit', async () => {
    const objects = new MemoryObjects();
    const p = await project(objects, new FileCache(join(tmp(), 'cache'), 1 << 20));
    const chunks = (n: number) => (async function* () {
      for (let i = 0; i < n; i++) yield Buffer.alloc(1000, i);
    })();
    const info = await p.blobs.putStream!(chunks(5), { name: 'x.bin' }, 10_000);
    expect(info.size).toBe(5000);
    await expect(p.blobs.putStream!(chunks(20), {}, 10_000)).rejects.toThrow(/too large/);
    expect(readdirSync(join(p.blobs['cache'].dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ── SQLite synced to a bucket ────────────────────────────────────────────────

describe('SQLite synced to a bucket', () => {
  it('encodes page sets losslessly', async () => {
    const pages = new Map([[3, Buffer.alloc(512, 3)], [1, Buffer.alloc(512, 1)]]);
    const d = decodeDelta(await encodeDelta(512, 9, pages));
    expect(d).toMatchObject({ pageSize: 512, dbSize: 9 });
    expect(d.pages.map(([n, b]) => [n, b[0]])).toEqual([[1, 1], [3, 3]]);
  });

  it("reads only committed, checksummed WAL frames and notices a WAL reset it didn't make", async () => {
    const dir = tmp();
    const file = join(dir, 'w.db');
    const db = await openSqlite(file, ['CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)'], { manualCheckpoints: true });
    await db.run('INSERT INTO t (v) VALUES (?)', 'a');
    const first = readWal(`${file}-wal`, { kind: 'fresh' });
    expect(first.kind).toBe('pages');
    if (first.kind !== 'pages') return;
    expect(readWal(`${file}-wal`, { kind: 'at', pos: first.end }).kind).toBe('none');
    await db.run('INSERT INTO t (v) VALUES (?)', 'b');
    const more = readWal(`${file}-wal`, { kind: 'at', pos: first.end });
    expect(more.kind === 'pages' && more.frames).toBeGreaterThan(0);
    // Someone else checkpoints and the WAL starts over: we must not trust a position in the old one.
    await sqliteControl(db)!.exclusive((raw) => raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'));
    await db.run('INSERT INTO t (v) VALUES (?)', 'c');
    expect(readWal(`${file}-wal`, { kind: 'at', pos: first.end }).kind).toBe('gap');
    await db.close();
  });

  /** A synced SQLite database as the deployment opens it. */
  async function openSynced(root: string, objects: ObjectStore, name = 'kalibra.db') {
    const sync = new SqliteSync(objects, { root, intervalSeconds: 3600, log: () => {} });
    const file = join(root, name);
    await sync.prepare(file);
    const db = await openSqlite(file, PROJECT_MIGRATIONS, { manualCheckpoints: true });
    sync.attach(file, db);
    return { sync, file, raw: db, db: syncedClose(db, sync, file) };
  }

  const rowsOf = async (db: Db) => (await db.all('SELECT id, name, description FROM datasets ORDER BY id')).map((r) => `${r.id}:${r.name}:${r.description}`);

  async function writeSome(db: Db, n: number, tag: string) {
    for (let i = 0; i < n; i++) {
      await db.run(
        "INSERT INTO datasets (id, name, description, schema, created_at, updated_at, created_by) VALUES (?, ?, ?, '[]', '', '', 'test')",
        `ds_${tag}_${i}`, `${tag} ${i}`, 'x'.repeat(200 + ((i * 37) % 900)),
      );
      if (i % 7 === 3) await db.run('UPDATE datasets SET description = ? WHERE id = ?', `changed ${tag}`, `ds_${tag}_${i - 2}`);
      if (i % 11 === 5) await db.run('DELETE FROM datasets WHERE id = ?', `ds_${tag}_${i - 4}`);
    }
  }

  it('ships only changed pages; a new machine restores exactly the same data', async () => {
    const objects = new MemoryObjects();
    const a = await openSynced(tmp(), objects);
    await a.sync.syncAll(); // first sync: a snapshot (nothing in the bucket yet)
    const putsAfterSnapshot = objects.calls.put;
    expect(putsAfterSnapshot).toBe(2); // snapshot + manifest
    for (let round = 0; round < 6; round++) {
      await writeSome(a.db, 25, `r${round}`);
      await a.sync.syncAll();
    }
    expect(objects.calls.put - putsAfterSnapshot).toBe(6); // one upload per sync with changes
    await a.sync.syncAll();
    expect(objects.calls.put - putsAfterSnapshot).toBe(6); // and none when nothing changed
    const expected = await rowsOf(a.db);
    expect(expected.length).toBeGreaterThan(100);
    expect(a.sync.status()[0]).toMatchObject({ seq: 6, uploads: 7 });

    const b = await openSynced(tmp(), objects); // empty disk: restored from the bucket
    expect(await rowsOf(b.db)).toEqual(expected);
    expect((await b.db.all('PRAGMA integrity_check'))[0]).toEqual({ integrity_check: 'ok' });
    await a.db.close();
    await b.db.close();
  });

  it('continues after a clean restart, snapshots after a crash, and restores when the disk is behind', async () => {
    const objects = new MemoryObjects();
    const root = tmp();
    const a = await openSynced(root, objects);
    await writeSome(a.db, 30, 'one');
    await a.sync.syncAll();
    await a.db.close(); // clean: final sync, then the marker says "matches the bucket"
    const putsBefore = objects.calls.put;

    // Clean restart: no new snapshot, the generation goes on.
    const a2 = await openSynced(root, objects);
    await a2.sync.syncAll();
    expect(objects.calls.put).toBe(putsBefore);
    await writeSome(a2.db, 10, 'two');
    await a2.sync.syncAll();
    const gen = a2.sync.status()[0].generation;

    // Crash: unsynced writes stay on disk only; the copied files stand in for the disk after a crash.
    await writeSome(a2.db, 10, 'three');
    const crashed = tmp();
    cpSync(root, crashed, { recursive: true });
    const expected = await rowsOf(a2.db);
    await a2.raw.close(); // (without the final sync)

    const c = await openSynced(crashed, objects);
    await c.sync.syncAll();
    expect(c.sync.status()[0].generation).not.toBe(gen); // local was ahead: a new snapshot
    expect(await rowsOf(c.db)).toEqual(expected);
    await writeSome(c.db, 5, 'four');
    await c.db.close();

    // The old disk (behind the bucket now) is restored rather than trusted.
    const stale = await openSynced(root, objects);
    expect(await rowsOf(stale.db)).toEqual(await rowsOf((await openSynced(tmp(), objects)).db));
    expect(readdirSync(root).some((f) => f.includes('behind-bucket'))).toBe(true);
    await stale.db.close();
  });

  it('falls back to a snapshot when another process resets the WAL or an upload fails', async () => {
    const objects = new MemoryObjects();
    const a = await openSynced(tmp(), objects);
    await a.sync.syncAll();
    await writeSome(a.db, 20, 'x');
    // Another connection (not ours) checkpoints: those changes never pass through our WAL reader.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const other = new DatabaseSync(a.file);
    other.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    other.close();
    await writeSome(a.db, 5, 'y');
    const gen = a.sync.status()[0].generation;
    await a.sync.syncAll();
    expect(a.sync.status()[0].generation).not.toBe(gen);

    await writeSome(a.db, 5, 'z');
    objects.failing = true;
    await a.sync.syncAll();
    expect(a.sync.status()[0].lastError).toMatch(/simulated/);
    objects.failing = false;
    (a.sync as any).dbs.get(a.file).retryAt = 0; // skip the back-off
    await a.sync.syncAll();
    expect(a.sync.status()[0].lastError).toBeUndefined();

    const b = await openSynced(tmp(), objects);
    expect(await rowsOf(b.db)).toEqual(await rowsOf(a.db));
    // Old generations are cleaned up: only the current and the previous one remain.
    const gens = new Set([...objects.objects.keys()].filter((k) => k.includes('/generations/')).map((k) => k.split('/generations/')[1].split('/')[0]));
    expect(gens.size).toBeLessThanOrEqual(2);
    await a.db.close();
    await b.db.close();
  });

  it('survives random writes, restarts and restores (property check)', { timeout: 60_000 }, async () => {
    const objects = new MemoryObjects();
    let root = tmp();
    let cur = await openSynced(root, objects);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let step = 0; step < 40; step++) {
      const r = rand();
      if (r < 0.6) await writeSome(cur.db, 1 + Math.floor(rand() * 15), `s${step}`);
      else if (r < 0.8) await cur.sync.syncAll();
      else if (r < 0.9) {
        await cur.db.close(); // clean restart on the same disk
        cur = await openSynced(root, objects);
      } else {
        await cur.db.close(); // a new machine
        root = tmp();
        cur = await openSynced(root, objects);
      }
    }
    await cur.sync.syncAll();
    const expected = await rowsOf(cur.db);
    const fresh = await openSynced(tmp(), objects);
    expect(await rowsOf(fresh.db)).toEqual(expected);
    await cur.db.close();
    await fresh.db.close();
  });
});

// ── Lease ────────────────────────────────────────────────────────────────────

describe('one instance per bucket', () => {
  it('refuses a second instance, lets it take over a stale lease, and stops the old holder', async () => {
    const objects = new MemoryObjects();
    const lost: string[] = [];
    const a = new BucketLease(objects, { onLost: (w) => lost.push(w), renewMs: 3_600_000, staleMs: 200 });
    await a.acquire();
    const b = new BucketLease(objects, { onLost: () => {}, renewMs: 3_600_000, staleMs: 200 });
    await expect(b.acquire()).rejects.toThrow(/Another Kalibra .* --takeover/s);
    // --takeover waits until the holder stops renewing.
    const slept: number[] = [];
    const c = new BucketLease(objects, { onLost: () => {}, renewMs: 3_600_000, staleMs: 200, handoverWaitMs: 50, sleep: async (ms) => {
        slept.push(ms);
        await new Promise((r) => setTimeout(r, ms));
      } });
    await c.acquire(true);
    expect(slept.length).toBeGreaterThan(0);
    await a.renew(); // the old holder finds out and stops
    expect(lost).toEqual([expect.stringMatching(/another instance took over/)]);
    await c.release();
    expect(leaseIsFree((await objects.get('lease.json'))?.data)).toBe(true);
    await b.acquire(); // free again
    await b.release();
  });
});

// ── Secrets in the database ──────────────────────────────────────────────────

describe('encrypted secrets', () => {
  it('encrypts per value, binds each to its name, and rejects tampering or a different key', async () => {
    const db = await openSqlite(':memory:', PROJECT_MIGRATIONS);
    const key = SecretKey.from(KEY);
    const store = new DbSecretStore(db, key, 'project');
    await store.set('openai', 'sk-live-123');
    await store.set('other', 'x');
    expect(await store.get('openai')).toBe('sk-live-123');
    expect(await store.list()).toEqual(['openai', 'other']);
    const stored = (await db.get('SELECT value FROM secrets WHERE name = ?', 'openai')).value as string;
    expect(stored).not.toContain('sk-live');
    expect(stored).toMatch(/^v1:[0-9a-f]{12}:/);
    // Same plaintext, different ciphertext (fresh nonce).
    await store.set('openai2', 'sk-live-123');
    expect((await db.get('SELECT value FROM secrets WHERE name = ?', 'openai2')).value).not.toBe(stored);
    // Moved to another name: doesn't decrypt.
    await db.run('UPDATE secrets SET value = ? WHERE name = ?', stored, 'other');
    await expect(store.get('other')).rejects.toThrow(/could not be decrypted/);
    // Tampered.
    // Change a character in the middle (the last base64 characters may only carry padding bits).
    const at = Math.floor(stored.length * 0.6);
    const flipped = stored.slice(0, at) + (stored[at] === 'A' ? 'B' : 'A') + stored.slice(at + 1);
    await db.run('UPDATE secrets SET value = ? WHERE name = ?', flipped, 'openai');
    await expect(store.get('openai')).rejects.toThrow(/could not be decrypted/);
    // A different key.
    await expect(new DbSecretStore(db, SecretKey.from('z'.repeat(44)), 'project').get('openai2')).rejects.toThrow(/different KALIBRA_SECRET_KEY/);
    await store.delete('openai2');
    expect(await store.get('openai2')).toBeUndefined();
    expect(() => SecretKey.from('short')).toThrow(/32 random bytes/);
  });

  it('imports an old secrets file once', async () => {
    const dir = tmp();
    const file = join(dir, 'secrets.json');
    writeFileSync(file, JSON.stringify({ a: '1', b: '2' }), { mode: 0o600 });
    const db = await openSqlite(':memory:', PROJECT_MIGRATIONS);
    const store = new DbSecretStore(db, SecretKey.from(KEY), 'project', file);
    expect(await store.list()).toEqual(['a', 'b']);
    expect(existsSync(file)).toBe(false);
    expect(JSON.parse(readFileSync(`${file}.imported`, 'utf8'))).toEqual({ a: '1', b: '2' });
  });
});

// ── The whole hub on a bucket ────────────────────────────────────────────────

describe('a hub whose data folder disappears', () => {
  async function start(dir: string, objects: MemoryObjects) {
    const cfg = deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://unused', KALIBRA_SECRET_KEY: KEY, KALIBRA_SQLITE_SYNC_SECONDS: '3600' });
    const storage = await openStorage(cfg, { dir, objects, log: () => {} });
    const hub = await Hub.open({ dir, mode: 'local', databases: storage.databases, storage: storage.hooks });
    return { hub, storage };
  }

  it('comes back complete on an empty disk: projects, datasets, files and provider secrets', async () => {
    const objects = new MemoryObjects();
    const first = await start(tmp(), objects);
    const principal = first.hub.localPrincipal('user');
    const p = await first.hub.call<any>(principal, 'create_project', { name: 'Speech' });
    await first.hub.callProject(principal, p.id, 'create_dataset', { name: 'Clips', columns: [{ key: 'audio', type: 'audio' }] });
    const file = await first.hub.callProject<any>(principal, p.id, 'upload_file', { name: 'a.wav', base64: Buffer.from('RIFF0000WAVEfmt hi').toString('base64') });
    await first.hub.callProject(principal, p.id, 'set_secret', { name: 'openai', value: 'sk-test-1' });
    expect(first.storage.status()).toMatchObject({ files: 'memory://test', secrets: 'database (encrypted)' });
    await first.hub.close();
    await first.storage.close();
    expect(leaseIsFree((await objects.get('lease.json'))?.data)).toBe(true); // released

    const second = await start(tmp(), objects);
    const again = second.hub.localPrincipal('user');
    const projects = await second.hub.call<any[]>(again, 'list_projects', {});
    const restored = projects.find((x) => x.name === 'Speech');
    expect(restored?.id).toBe(p.id);
    const datasets = await second.hub.callProject<any[]>(again, p.id, 'list_datasets', {});
    expect(datasets.map((d) => d.name)).toContain('Clips');
    const engine = await second.hub.engine(p.id);
    expect((await engine.blobs.get(file.hash)).toString()).toContain('WAVE');
    expect(await engine.secrets.get('openai')).toBe('sk-test-1');
    expect(LOCAL_USER.kind).toBe('user');
    await second.hub.close();
    await second.storage.close();
  });

  it('refuses a second instance on the same bucket', async () => {
    const objects = new MemoryObjects();
    const first = await start(tmp(), objects);
    await expect(start(tmp(), objects)).rejects.toThrow(/Another Kalibra/);
    await first.hub.close();
    await first.storage.close();
  });
});
