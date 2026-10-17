import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { copyDatabase, defaultDatabases, fileKey, sqliteDatabases, type Databases, type ObjectStore } from '@kalibra/core';

/**
 * A consistent copy of the data folder, safe while Kalibra is running. It always comes out as a
 * plain SQLite data folder that `kalibra --dir <copy>` opens as-is:
 * - SQLite databases are copied with VACUUM INTO (a snapshot, never a half-written file);
 * - with Postgres (KALIBRA_DATABASE_URL), the hub and every project are copied table by table into
 *   SQLite files at the same places;
 * - files are content-addressed and never change, so they are copied as they are; with a bucket
 *   (KALIBRA_STORAGE_URL) every file a project references is downloaded into the copy;
 * - the bucket sync's local state (markers, the file cache) is left out: the copy belongs to no bucket.
 * Provider keys stored encrypted (KALIBRA_SECRET_KEY) stay encrypted: open the copy with the same key.
 * Restore by stopping Kalibra and putting the folder back (or pointing --dir / KALIBRA_DIR at it).
 */
export async function backup(dir: string, dest: string, opts: { databases?: Databases; objects?: ObjectStore } = {}) {
  const out = resolve(dest);
  const databases = opts.databases ?? defaultDatabases(dir);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; pick a new folder`);
  if (!(await databases.exists('hub', undefined, dir)) && !(await databases.exists('project', undefined, dir))) throw new Error(`No Kalibra data in ${dir}`);
  const fromPostgres = databases.dialect === 'postgres';
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const copyDb = (from: string, to: string) => {
    mkdirSync(dirname(to), { recursive: true });
    const db = new DatabaseSync(from);
    try {
      db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  };
  // Everything else (blobs, secret files, project folders) is copied; database files are snapshotted.
  const skip = /^(kalibra|hub)\.db(-wal|-shm)?$|^\.(engine|server)\.json$|\.sync\.json(\.tmp)?$|\.(snapshot|restore)\.tmp|\.bak$/;
  let dbs = 0;
  let files = 0;
  const walk = (from: string, to: string) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      // Never copy the backup into itself (a backup folder inside the data folder).
      if (entry.isSymbolicLink() || resolve(src) === out) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'models') continue; // the local embedding model is re-downloadable
        if (from === dir && entry.name === 'cache') continue; // files read from a bucket; refetched as needed
        walk(src, dst);
      } else if (!fromPostgres && (entry.name === 'kalibra.db' || entry.name === 'hub.db')) {
        copyDb(src, dst);
        dbs++;
      } else if (!skip.test(entry.name)) {
        copyFileSync(src, dst);
        chmodSync(dst, statSync(src).mode & 0o777);
        files++;
      }
    }
  };
  walk(dir, out);
  if (fromPostgres) dbs += await exportPostgres(databases, dir, out);
  if (opts.objects) files += await downloadFiles(opts.objects, out);
  return { out, databases: dbs, files };
}

/** With a bucket: puts every file the copied projects reference where a plain data folder keeps them. */
async function downloadFiles(objects: ObjectStore, out: string) {
  const { DatabaseSync } = (process as any).getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const read = <T>(file: string, sql: string): T[] => {
    if (!existsSync(file)) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  const projectDirs = read<{ dir: string }>(join(out, 'hub.db'), 'SELECT dir FROM projects').map((p) => resolve(out, p.dir));
  if (existsSync(join(out, 'kalibra.db'))) projectDirs.push(out); // a single-project folder
  let n = 0;
  for (const projectDir of projectDirs) {
    for (const { hash } of read<{ hash: string }>(join(projectDir, 'kalibra.db'), 'SELECT hash FROM blobs')) {
      const dst = join(projectDir, 'blobs', hash.slice(0, 2), hash.slice(2, 4), hash);
      if (existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      const tmp = `${dst}.download`;
      try {
        await pipeline(await objects.stream(fileKey(hash)), createWriteStream(tmp));
        renameSync(tmp, dst);
        n++;
      } catch (e: any) {
        rmSync(tmp, { force: true });
        console.warn(`Could not copy file ${hash} from ${objects.url}: ${e?.message ?? e}`);
      }
    }
  }
  return n;
}

/** Writes the hub and every project that has data from Postgres into SQLite files under `out`. */
async function exportPostgres(databases: Databases, dir: string, out: string) {
  const sqlite = sqliteDatabases();
  let n = 0;
  const copy = async (from: () => Promise<import('@kalibra/core').Db>, to: () => Promise<import('@kalibra/core').Db>) => {
    const [a, b] = [await from(), await to()];
    try {
      await copyDatabase(a, b);
      n++;
    } finally {
      await a.close();
      await b.close();
    }
  };
  if (await databases.exists('hub', undefined, dir)) {
    await copy(() => databases.hub(dir), () => sqlite.hub(out));
    const hub = await databases.hub(dir);
    const projects = await hub.all<{ id: string; dir: string }>('SELECT id, dir FROM projects').finally(() => hub.close());
    for (const p of projects) {
      if (!(await databases.exists('project', p.id, resolve(dir, p.dir)))) continue;
      await copy(() => databases.project(p.id, resolve(dir, p.dir)), () => sqlite.project(p.id, resolve(out, p.dir)));
    }
  } else if (await databases.exists('project', undefined, dir)) {
    await copy(() => databases.project(undefined, dir), () => sqlite.project(undefined, out));
  }
  return n;
}
