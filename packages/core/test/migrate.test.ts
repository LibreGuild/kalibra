import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/db.js';
import { PostgresPool } from '../src/db-postgres.js';
import { deployConfigFrom } from '../src/deploy/config.js';
import { postgresSchemas, sqliteDatabases } from '../src/deploy/databases.js';
import { migrate } from '../src/deploy/migrate.js';
import { MemoryObjects } from '../src/deploy/objects.js';
import { DbSecretStore, SecretKey } from '../src/deploy/secrets.js';
import { openStorage } from '../src/deploy/storage.js';
import { Hub } from '../src/hub/hub.js';
import { HUB_MIGRATIONS } from '../src/hub/schema.js';
import { testDatabaseUrl } from '../../../test-support/database.js';

/*
 * `kalibra migrate`: a data folder (SQLite + files on disk) moved to Postgres or to a bucket, read
 * back through a hub opened on the target.
 */

const KEY = 'm'.repeat(44); // base64 of 33 bytes
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kalibra-migrate-test-'));
  dirs.push(d);
  return d;
};
const WAV = Buffer.from('RIFF0000WAVEfmt migrate me');

/** A data folder in mode "single": a user with a session, a project with a dataset, a file and secrets. */
async function makeSource() {
  const dir = tmp();
  const hub = await Hub.open({ dir, mode: 'local', databases: sqliteDatabases() });
  const p = hub.localPrincipal('user');
  const project = await hub.call<any>(p, 'create_project', { name: 'Speech' });
  await hub.callProject(p, project.id, 'create_dataset', { name: 'Clips', columns: [{ key: 'text', type: 'text' }, { key: 'audio', type: 'audio' }] });
  await hub.callProject(p, project.id, 'add_dataset_rows', { dataset: 'Clips', rows: [{ data: { text: 'one' } }, { data: { text: 'two' } }, { data: { text: 'three' } }] });
  const file = await hub.callProject<any>(p, project.id, 'upload_file', { name: 'a.wav', base64: WAV.toString('base64') });
  await hub.callProject(p, project.id, 'set_secret', { name: 'openai', value: 'sk-project-secret' });
  await hub.callProject(p, 'default', 'set_secret', { name: 'anthropic', value: 'sk-default-secret' });
  const user = await hub.accounts.create({ username: 'ana', password: 'a-long-password-1', role: 'admin' }, 'test');
  await hub.accounts.createSession(user.id, { days: 1 });
  await hub.close();
  writeFileSync(join(dir, 'hub-secrets.json'), JSON.stringify({ 'oidc:corp': 'client-secret-1' }), { mode: 0o600 });
  return { dir, project, file };
}

const sessions = async (hubFile: string) => {
  const db = await openSqlite(hubFile, HUB_MIGRATIONS);
  const n = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))!.n;
  await db.close();
  return Number(n);
};

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('moving a data folder to a bucket (SQLite synced there)', () => {
  const cfg = deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://unused', KALIBRA_SECRET_KEY: KEY, KALIBRA_SQLITE_SYNC_SECONDS: '3600' });

  it('copies databases, files and secrets; a new machine on the bucket has everything; the source is untouched', async () => {
    const src = await makeSource();
    const objects = new MemoryObjects();
    const r = await migrate({ source: src.dir, cfg, objects });
    expect(r.verified).toBe(true);
    expect(r.files).toMatchObject({ total: 1, uploaded: 1, existing: 0, missing: [] });
    expect(r.secrets).toMatchObject({ hub: 1, projects: 2, fromFiles: 3 });
    expect(r.databases.map((d) => d.name)).toEqual(expect.arrayContaining(['hub', 'Speech']));
    expect(await objects.get('lease.json')).toBeUndefined(); // released

    // The source is unchanged: secrets still in plain files, the session still there.
    expect(JSON.parse(readFileSync(join(src.dir, 'projects', src.project.id, 'secrets.json'), 'utf8')).openai).toBe('sk-project-secret');
    expect(existsSync(join(src.dir, 'hub-secrets.json'))).toBe(true);
    expect(await sessions(join(src.dir, 'hub.db'))).toBe(1);

    const dir = tmp();
    const storage = await openStorage(cfg, { dir, objects, log: () => {} });
    const hub = await Hub.open({ dir, mode: 'local', databases: storage.databases, storage: storage.hooks });
    const p = hub.localPrincipal('user');
    expect((await hub.call<any[]>(p, 'list_projects', {})).map((x) => x.name)).toContain('Speech');
    const datasets = await hub.callProject<any[]>(p, src.project.id, 'list_datasets', {});
    expect(datasets.find((d) => d.name === 'Clips')?.rowCount).toBe(3);
    const engine = await hub.engine(src.project.id);
    expect(await engine.blobs.get(src.file.hash)).toEqual(WAV);
    expect(await engine.secrets.get('openai')).toBe('sk-project-secret');
    expect(await (await hub.engine('default')).secrets.get('anthropic')).toBe('sk-default-secret');
    expect(await new DbSecretStore((hub as any).db, SecretKey.from(KEY), 'hub').get('oidc:corp')).toBe('client-secret-1');
    expect(await hub.accounts.find('ana')).toBeTruthy();
    expect(await sessions(join(dir, 'hub.db'))).toBe(0); // everyone signs in again
    await hub.close();
    await storage.close();
  });

  it('refuses a bucket that already has databases unless --force, and a dry run changes nothing', async () => {
    const src = await makeSource();
    const objects = new MemoryObjects();
    const dry = await migrate({ source: src.dir, cfg, objects, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.files.total).toBe(1);
    expect(dry.databases.find((d) => d.name === 'Speech')?.rows.rows).toBe(3);
    expect(objects.calls.put).toBe(0);
    expect(objects.objects.size).toBe(0);

    await migrate({ source: src.dir, cfg, objects });
    await expect(migrate({ source: src.dir, cfg, objects })).rejects.toThrow(/already has data.*--force/s);
    const again = await migrate({ source: src.dir, cfg, objects, force: true });
    expect(again.verified).toBe(true);
    expect(again.files).toMatchObject({ uploaded: 0, existing: 1 }); // content-addressed: not uploaded twice
  });

  it('refuses secrets encrypted with another key, and folders that are not Kalibra data', async () => {
    const src = await makeSource();
    const other = deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://unused', KALIBRA_SECRET_KEY: 'o'.repeat(44) });
    // Encrypt one secret into the source's database with the other key (a source that already used KALIBRA_SECRET_KEY).
    const db = await openSqlite(join(src.dir, 'hub.db'), HUB_MIGRATIONS);
    await new DbSecretStore(db, SecretKey.from(other.secretKey!), 'hub').set('x', 'y');
    await db.close();
    await expect(migrate({ source: src.dir, cfg, objects: new MemoryObjects() })).rejects.toThrow(/different KALIBRA_SECRET_KEY/);
    await expect(migrate({ source: tmp(), cfg, objects: new MemoryObjects() })).rejects.toThrow(/not a Kalibra data folder/);
  });
});

describe('moving a data folder to Postgres', () => {
  let pool: PostgresPool;
  let stop: (() => Promise<void>) | undefined;
  const prefix = `mig${Date.now().toString(36)}`;
  const cfg = deployConfigFrom({ KALIBRA_DATABASE_URL: 'postgres://unused/x', KALIBRA_SECRET_KEY: KEY });

  beforeAll(async () => {
    if (testDatabaseUrl) {
      pool = await PostgresPool.connect({ url: testDatabaseUrl, max: 4 });
      return;
    }
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const db = await PGlite.create();
    const port = 40000 + Math.floor(Math.random() * 20000);
    const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
    await server.start();
    pool = await PostgresPool.connect({ url: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 });
    stop = async () => {
      await server.stop();
      await db.close();
    };
  }, 60_000);

  afterAll(async () => {
    for (const s of (await pool?.schemas(`${prefix}`)) ?? []) await pool.dropSchema(s);
    await pool?.close();
    await stop?.();
  });

  it('copies every table row for row, encrypts plain-file secrets, and refuses a second copy', { timeout: 120_000 }, async () => {
    const src = await makeSource();
    const deployment = `${prefix}a`;
    const databases = postgresSchemas(pool, deployment);

    const dry = await migrate({ source: src.dir, cfg, databases, dryRun: true });
    expect(dry.target.hadData).toEqual([]);
    expect(await pool.schemas(deployment)).toEqual([]); // a dry run creates nothing

    const r = await migrate({ source: src.dir, cfg, databases });
    expect(r.verified).toBe(true);
    expect(r.target.files).toBe('data folder');

    // Opened on the target (files stay in the source folder; secrets come from the database only).
    const key = SecretKey.from(KEY);
    const hub = await Hub.open({ dir: src.dir, mode: 'local', databases, storage: { secrets: (db, _file, scope) => new DbSecretStore(db, key, scope) } });
    const p = hub.localPrincipal('user');
    const engine = await hub.engine(src.project.id);
    const rows = await hub.callProject<any>(p, src.project.id, 'list_rows', { dataset: 'Clips' });
    expect((rows.rows ?? rows).map((x: any) => x.data.text).sort()).toEqual(['one', 'three', 'two']);
    expect(await engine.blobs.get(src.file.hash)).toEqual(WAV);
    expect(await engine.secrets.get('openai')).toBe('sk-project-secret');
    expect(await new DbSecretStore((hub as any).db, key, 'hub').get('oidc:corp')).toBe('client-secret-1');
    expect(Number((await (hub as any).db.get('SELECT COUNT(*) AS n FROM sessions')).n)).toBe(0);
    await hub.close();

    await expect(migrate({ source: src.dir, cfg, databases })).rejects.toThrow(/already has data \(.*the hub\)/);
    const forced = await migrate({ source: src.dir, cfg, databases, force: true });
    expect(forced.verified).toBe(true);
  });
});
