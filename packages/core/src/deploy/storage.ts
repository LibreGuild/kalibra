import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openSqlite, PROJECT_MIGRATIONS, type Db } from '../db.js';
import { HUB_MIGRATIONS } from '../hub/schema.js';
import type { BlobStore, SecretStore } from '../storage.js';
import { BucketBlobStore, FileCache } from './bucket-blobs.js';
import type { DeployConfig } from './config.js';
import { sqliteDatabases, type Databases } from './databases.js';
import { BucketLease } from './lease.js';
import { openObjectStore, PreconditionFailed, type ObjectStore } from './objects.js';
import { DbSecretStore, SecretKey } from './secrets.js';
import { SqliteSync, syncedClose, type DbSyncStatus } from './sqlite-sync.js';

/*
 * Where files and secrets live for a deployment (see docs/design/storage-and-scaling.md):
 * - files in the data folder, or in a bucket (KALIBRA_STORAGE_URL) through a local cache;
 * - with a bucket and SQLite, the databases are restored from and synced to the bucket, and a lease
 *   keeps a second instance from writing to the same bucket;
 * - with KALIBRA_SECRET_KEY, secrets are stored in the database, encrypted.
 * The hub and every engine get their stores through `hooks`.
 */

/** How the hub and engines get their file and secret stores (defaults: files and secrets in the data folder). */
export interface StorageHooks {
  blobs?(db: Db, projectDir: string): BlobStore;
  /** `legacyFile` is the old 0600 secrets file of that folder, imported on first use. */
  secrets?(db: Db, legacyFile: string, scope: 'hub' | 'project'): SecretStore;
}

export interface StorageStatus {
  files: string;
  cache?: { dir: string; bytes: number; maxBytes: number };
  sqliteSync?: { intervalSeconds: number; databases: DbSyncStatus[] };
  secrets: 'database (encrypted)' | 'data folder';
}

export interface StorageRuntime {
  hooks: StorageHooks;
  /** SQLite databases restored from and synced to the bucket (mode "single + bucket"). */
  databases?: Databases;
  objects?: ObjectStore;
  status(): StorageStatus;
  /** After the hub closed (its databases had their final sync): releases the bucket lease. */
  close(): Promise<void>;
}

export interface StorageOptions {
  /** The data folder (hub folder). */
  dir: string;
  /** Wait for another instance's lease on the bucket to expire instead of refusing to start. */
  takeover?: boolean;
  /** Called when another instance took the bucket over: stop writing (the CLI exits). */
  onLeaseLost?: (why: string) => void;
  log?: (msg: string) => void;
  /** Tests: an object store instead of KALIBRA_STORAGE_URL. */
  objects?: ObjectStore;
}

export async function openStorage(cfg: DeployConfig, opts: StorageOptions): Promise<StorageRuntime> {
  const log = opts.log ?? ((m: string) => console.log(`  [storage] ${m}`));
  const key = cfg.secretKey ? SecretKey.from(cfg.secretKey) : undefined;
  const hooks: StorageHooks = {};
  if (key) hooks.secrets = (db, legacyFile, scope) => new DbSecretStore(db, key, scope, legacyFile);

  const objects = opts.objects ?? (cfg.storageUrl ? await openObjectStore(cfg) : undefined);
  if (!objects) {
    return { hooks, status: () => ({ files: 'data folder', secrets: key ? 'database (encrypted)' : 'data folder' }), close: async () => {} };
  }
  try {
    await objects.head('lease.json'); // credentials and bucket checked before anything else starts
  } catch (e: any) {
    throw new Error(`Can't use ${objects.url}: ${e?.message ?? e}. Check the bucket name and that this machine's credentials may read and write it.`);
  }
  const cache = new FileCache(join(opts.dir, 'cache', 'files'), cfg.cacheMaxMb * 1024 * 1024);
  hooks.blobs = (db) => new BucketBlobStore(objects, db, cache);

  let sync: SqliteSync | undefined;
  let lease: BucketLease | undefined;
  let databases: Databases | undefined;
  if (!cfg.databaseUrl) {
    if (!(await conditionalWritesWork(objects))) {
      log(`warning: ${objects.url} ignores conditional writes (some S3-compatible stores do), so the lease can't stop two instances starting at the same moment. Make sure only one Kalibra uses this bucket.`);
    }
    lease = new BucketLease(objects, {
      log,
      onLost: (why) => (opts.onLeaseLost ?? ((w) => log(`lease lost: ${w}`)))(why),
    });
    await lease.acquire(!!opts.takeover);
    sync = new SqliteSync(objects, { root: opts.dir, intervalSeconds: cfg.sqliteSyncSeconds, log });
    const open = async (file: string, migrations: string[]) => {
      mkdirSync(dirname(file), { recursive: true });
      await sync!.prepare(file);
      const db = await openSqlite(file, migrations, { manualCheckpoints: true });
      sync!.attach(file, db);
      return syncedClose(db, sync!, file);
    };
    // The usual SQLite files, opened through the sync.
    databases = {
      ...sqliteDatabases({ manualCheckpoints: true }),
      hub: (dir: string) => open(join(dir, 'hub.db'), HUB_MIGRATIONS),
      project: (_id: string | undefined, dir: string) => open(join(dir, 'kalibra.db'), PROJECT_MIGRATIONS),
    };
  }

  return {
    hooks,
    databases,
    objects,
    status: () => ({
      files: objects.url,
      cache: { dir: cache.dir, bytes: cache.size, maxBytes: cfg.cacheMaxMb * 1024 * 1024 },
      ...(sync ? { sqliteSync: { intervalSeconds: cfg.sqliteSyncSeconds, databases: sync.status() } } : {}),
      secrets: key ? 'database (encrypted)' : 'data folder',
    }),
    async close() {
      sync?.stop();
      await lease?.release();
    },
  };
}

/** Whether the bucket refuses a second "create only if absent" write, which the lease relies on. */
async function conditionalWritesWork(objects: ObjectStore): Promise<boolean> {
  const key = `probe/conditional-${randomBytes(6).toString('hex')}`;
  try {
    await objects.put(key, Buffer.from('1'), { ifAbsent: true });
    await objects.put(key, Buffer.from('2'), { ifAbsent: true });
    return false;
  } catch (e) {
    if (e instanceof PreconditionFailed) return true;
    throw e;
  } finally {
    await objects.delete(key).catch(() => {});
  }
}
