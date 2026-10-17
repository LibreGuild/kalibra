import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { openSqlite, PROJECT_MIGRATIONS, type Db } from '../db.js';
import { HUB_MIGRATIONS } from '../hub/schema.js';
import { fileKey } from './bucket-blobs.js';
import type { DeployConfig } from './config.js';
import { copyDatabase, dependencyOrder } from './copy.js';
import { postgresDatabases, type Databases } from './databases.js';
import { openObjectStore, type ObjectStore } from './objects.js';
import { DbSecretStore, SecretKey } from './secrets.js';
import { SqliteSync } from './sqlite-sync.js';
import { openStorage } from './storage.js';

/*
 * `kalibra migrate`: moves a data folder (SQLite and files on disk) to Postgres, a bucket, or both.
 *
 * The source is never changed: every database is first copied with VACUUM INTO into a work folder
 * (a consistent snapshot, upgraded to this version's schema there), sign-in sessions are dropped
 * (everyone signs in again), and plain-file provider secrets are encrypted into the copy with
 * KALIBRA_SECRET_KEY. Then:
 * - Postgres: each database is copied table by table into its schema (copyDatabase);
 * - SQLite + bucket: each database is uploaded through the bucket sync, as its first snapshot;
 * - with a bucket: every file a project references is uploaded once (content-addressed).
 * Finally the target is read back and its row counts compared with the source's.
 */

export interface MigrateOptions {
  /** The data folder to move (mode "single": SQLite and files on disk). */
  source: string;
  /** Where to: databaseUrl and/or storageUrl, and secretKey. */
  cfg: DeployConfig;
  /** Tests: the target databases (else from cfg.databaseUrl). */
  databases?: Databases;
  /** Tests: the target bucket (else from cfg.storageUrl). */
  objects?: ObjectStore;
  /** Replace a target that already has data (its data is deleted first). */
  force?: boolean;
  /** Only report what would be copied. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface MigratedDatabase {
  /** "hub", or the project's name. */
  name: string;
  projectId?: string;
  deleted?: boolean;
  /** Rows per table in the source (sessions excluded). */
  rows: Record<string, number>;
  /** Tables whose row count in the target differs (after a real migration). */
  mismatches: string[];
}

export interface MigrateReport {
  dryRun: boolean;
  target: { database: 'postgres' | 'sqlite in bucket'; files: 'bucket' | 'data folder'; url?: string; hadData: string[] };
  databases: MigratedDatabase[];
  files: { total: number; bytes: number; uploaded: number; existing: number; missing: string[] };
  secrets: { hub: number; projects: number; fromFiles: number };
  /** True when every copied table has the same number of rows in the target. */
  verified: boolean;
}

interface SourceDb {
  name: string;
  projectId?: string;
  deleted?: boolean;
  /** Path inside the data folder ("hub.db", "kalibra.db", "projects/<id>/kalibra.db"). */
  rel: string;
  scope: 'hub' | 'project';
  /** The snapshot in the work folder. */
  snap: string;
  db?: Db;
  rows: Record<string, number>;
}

const hubRel = 'hub.db';

/** A consistent copy of a SQLite database, safe while another process uses it. */
function snapshot(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(from);
  try {
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

async function countRows(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await db.tables()) out[t.name] = Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`))?.n ?? 0);
  return out;
}

const nonEmpty = (rows: Record<string, number>) => Object.entries(rows).filter(([, n]) => n > 0).map(([t]) => t);

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Can't read ${file}: ${(e as Error).message}`);
  }
}

export async function migrate(opts: MigrateOptions): Promise<MigrateReport> {
  const { cfg } = opts;
  const log = opts.log ?? (() => {});
  if (!cfg.databaseUrl && !cfg.storageUrl) throw new Error('Nothing to move to: set --database-url (Postgres) and/or --storage (a bucket).');
  if (!cfg.secretKey) throw new Error('Set KALIBRA_SECRET_KEY: provider keys are stored encrypted in the target database.');
  const key = SecretKey.from(cfg.secretKey);
  const source = resolve(opts.source);
  if (!existsSync(join(source, hubRel))) throw new Error(`${source} is not a Kalibra data folder (no hub.db). Pass the folder with --dir.`);

  const work = mkdtempSync(join(tmpdir(), 'kalibra-migrate-'));
  const report: MigrateReport = {
    dryRun: !!opts.dryRun,
    target: { database: cfg.databaseUrl ? 'postgres' : 'sqlite in bucket', files: cfg.storageUrl ? 'bucket' : 'data folder', hadData: [] },
    databases: [],
    files: { total: 0, bytes: 0, uploaded: 0, existing: 0, missing: [] },
    secrets: { hub: 0, projects: 0, fromFiles: 0 },
    verified: false,
  };
  const sources: SourceDb[] = [];
  let ownDatabases: Databases | undefined;
  try {
    // ── 1. Snapshot the source into the work folder and prepare the copies ─────────────────────
    const inside = (rel: string) => {
      const abs = resolve(source, rel);
      if (abs !== source && !abs.startsWith(source + sep)) throw new Error(`A project folder points outside the data folder: ${rel}`);
      return abs;
    };
    const hub: SourceDb = { name: 'hub', rel: hubRel, scope: 'hub', snap: join(work, 'src', hubRel), rows: {} };
    snapshot(join(source, hubRel), hub.snap);
    hub.db = await openSqlite(hub.snap, HUB_MIGRATIONS);
    // Sessions and sign-ins in progress don't move: everyone signs in again on the new deployment.
    await hub.db.run('DELETE FROM sessions');
    await hub.db.run('DELETE FROM sso_pending');
    const projects = await hub.db.all<{ id: string; name: string; dir: string; deleted_at: string | null }>('SELECT id, name, dir, deleted_at FROM projects ORDER BY created_at, id');
    const files = new Map<string, { path: string; size: number }>();
    for (const p of projects) {
      const dir = inside(p.dir);
      const rel = relative(source, join(dir, 'kalibra.db')).split(sep).join('/');
      if (!existsSync(join(dir, 'kalibra.db'))) {
        log(`project ${p.name}: never opened, nothing to copy`);
        continue;
      }
      const s: SourceDb = { name: p.name, projectId: p.id, deleted: !!p.deleted_at, rel, scope: 'project', snap: join(work, 'src', rel), rows: {} };
      snapshot(join(dir, 'kalibra.db'), s.snap);
      s.db = await openSqlite(s.snap, PROJECT_MIGRATIONS);
      for (const b of await s.db.all<{ hash: string; size: number }>('SELECT hash, size FROM blobs ORDER BY hash')) {
        if (files.has(b.hash) || !/^[a-f0-9]{64}$/.test(b.hash)) continue;
        files.set(b.hash, { path: join(dir, 'blobs', b.hash.slice(0, 2), b.hash.slice(2, 4), b.hash), size: Number(b.size) });
      }
      if (existsSync(join(dir, 'secrets.enc'))) log(`project ${p.name}: secrets.enc (old desktop app) can't be read and is skipped; add those keys again in Connections`);
      sources.push(s);
    }
    sources.push(hub); // the hub last: a target with a hub is a finished migration

    // Secrets: values already in the database must be readable with this key; plain files are encrypted in.
    for (const s of sources) {
      for (const r of await s.db!.all<{ name: string; value: string }>('SELECT name, value FROM secrets')) {
        if (r.value.split(':')[1] !== key.id) throw new Error(`Secret "${r.name}" in ${s.rel} was encrypted with a different KALIBRA_SECRET_KEY; run migrate with the key the source used.`);
      }
      const legacy = s.scope === 'hub' ? join(source, 'hub-secrets.json') : join(dirname(join(source, s.rel)), 'secrets.json');
      if (existsSync(legacy)) {
        const store = new DbSecretStore(s.db!, key, s.scope);
        const have = new Set(await store.list());
        for (const [name, value] of Object.entries(readJson(legacy))) {
          if (typeof value !== 'string' || have.has(name)) continue;
          await store.set(name, value);
          report.secrets.fromFiles++;
        }
      }
      const n = Number((await s.db!.get<{ n: number }>('SELECT COUNT(*) AS n FROM secrets'))?.n ?? 0);
      if (s.scope === 'hub') report.secrets.hub += n;
      else report.secrets.projects += n;
      s.rows = await countRows(s.db!);
    }
    report.files.total = files.size;
    report.files.bytes = [...files.values()].reduce((a, f) => a + f.size, 0);
    report.files.missing = [...files.entries()].filter(([, f]) => !existsSync(f.path)).map(([h]) => h);

    // ── 2. Is the target empty? ─────────────────────────────────────────────────────────────────
    const objects = cfg.storageUrl ? (opts.objects ?? (await openObjectStore(cfg))) : undefined;
    if (objects) report.target.url = objects.url;
    const databases = cfg.databaseUrl ? (opts.databases ?? (ownDatabases = await postgresDatabases({ url: cfg.databaseUrl, max: Math.min(cfg.databasePool, 4), schema: cfg.databaseSchema }))) : undefined;
    const targets = new Map<SourceDb, Db>();
    if (databases) {
      for (const s of sources) {
        const exists = s.scope === 'hub' ? await databases.exists('hub', undefined, source) : await databases.exists('project', s.projectId, join(source, dirname(s.rel)));
        if (!exists) continue;
        const db = s.scope === 'hub' ? await databases.hub(source) : await databases.project(s.projectId, join(source, dirname(s.rel)));
        targets.set(s, db);
        if (nonEmpty(await countRows(db)).length) report.target.hadData.push(s.scope === 'hub' ? 'the hub' : `project ${s.name}`);
      }
    } else if (objects) {
      if ((await objects.list('sqlite/')).length) report.target.hadData.push(`databases in ${objects.url}`);
    }
    for (const s of sources) report.databases.push({ name: s.name, projectId: s.projectId, deleted: s.deleted, rows: s.rows, mismatches: [] });
    if (report.target.hadData.length && !opts.force && !opts.dryRun) {
      throw new Error(`The target already has data (${report.target.hadData.join(', ')}). Migrate into an empty target, or pass --force to delete the target's data first (it can't be undone).`);
    }
    if (opts.dryRun) {
      for (const db of targets.values()) await db.close();
      return report;
    }

    // ── 3. Files (first, so databases never point at files the bucket doesn't have yet) ─────────
    if (objects) {
      const queue = [...files.entries()].filter(([h]) => !report.files.missing.includes(h));
      let done = 0;
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [hash, f] = next;
          if (await objects.head(fileKey(hash))) report.files.existing++;
          else {
            await objects.putFile(fileKey(hash), f.path, { contentType: 'application/octet-stream' });
            report.files.uploaded++;
          }
          if (++done % 100 === 0) log(`files: ${done}/${files.size}`);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      log(`files: ${report.files.uploaded} uploaded, ${report.files.existing} already there${report.files.missing.length ? `, ${report.files.missing.length} missing in the source` : ''}`);
    }

    // ── 4. Databases ─────────────────────────────────────────────────────────────────────────────
    if (databases) {
      for (const s of sources) {
        const dir = join(source, dirname(s.rel));
        const target = targets.get(s) ?? (s.scope === 'hub' ? await databases.hub(source) : await databases.project(s.projectId, dir));
        targets.set(s, target);
        if (opts.force) await clear(target);
        const r = await copyDatabase(s.db!, target);
        log(`${s.scope === 'hub' ? 'hub' : `project ${s.name}`}: ${r.rows} rows in ${r.tables} tables`);
      }
      for (const s of sources) {
        const got = await countRows(targets.get(s)!);
        report.databases.find((d) => d.name === s.name && d.projectId === s.projectId)!.mismatches = Object.keys(s.rows).filter((t) => got[t] !== s.rows[t]);
      }
    } else if (objects) {
      // SQLite in the bucket: each database becomes the first snapshot of its sync, through the
      // same code (and the same bucket lease) a running Kalibra uses.
      const targetDir = join(work, 'target');
      const storage = await openStorage({ ...cfg, sqliteSyncSeconds: 3600 }, { dir: targetDir, objects, log: (m) => log(`bucket: ${m}`) });
      try {
        if (opts.force) for (const k of await objects.list('sqlite/')) await objects.delete(k);
        for (const s of sources) {
          await s.db!.close();
          s.db = undefined;
          const file = join(targetDir, s.rel);
          snapshot(s.snap, file);
          const db = s.scope === 'hub' ? await storage.databases!.hub(targetDir) : await storage.databases!.project(s.projectId, dirname(file));
          await db.close(); // the final sync uploads it
          log(`${s.scope === 'hub' ? 'hub' : `project ${s.name}`}: uploaded`);
        }
      } finally {
        await storage.close();
      }
      // Read back what a new machine would restore.
      const verifyDir = join(work, 'verify');
      const restore = new SqliteSync(objects, { root: verifyDir, intervalSeconds: 3600, log: () => {} });
      for (const s of sources) {
        const file = join(verifyDir, s.rel);
        await restore.prepare(file);
        const db = await openSqlite(file, s.scope === 'hub' ? HUB_MIGRATIONS : PROJECT_MIGRATIONS);
        const got = await countRows(db);
        await db.close();
        report.databases.find((d) => d.name === s.name && d.projectId === s.projectId)!.mismatches = Object.keys(s.rows).filter((t) => got[t] !== s.rows[t]);
      }
    }
    report.verified = report.databases.every((d) => !d.mismatches.length);
    for (const db of targets.values()) await db.close();
    return report;
  } finally {
    for (const s of sources) await s.db?.close().catch(() => {});
    await ownDatabases?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** Deletes every row of a database, children first (for --force). */
async function clear(db: Db) {
  const tables = dependencyOrder(await db.tables()).reverse();
  await db.tx(async () => {
    for (const t of tables) await db.run(`DELETE FROM ${t.name}`);
  });
}
