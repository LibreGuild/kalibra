import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A consistent copy of the data folder, safe while a server or the desktop app is running:
 * databases are copied with SQLite's VACUUM INTO (a snapshot, never a half-written file); files
 * are content-addressed and never change, so they are copied as they are. Restore by stopping
 * Kalibra and putting the folder back (or pointing --dir / KALIBRA_DIR at it).
 */
export function backup(dir: string, dest: string) {
  const out = resolve(dest);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; pick a new folder`);
  if (!existsSync(join(dir, 'hub.db')) && !existsSync(join(dir, 'kalibra.db'))) throw new Error(`No Kalibra data in ${dir}`);
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
  const skip = /^(kalibra|hub)\.db(-wal|-shm)?$|^\.engine\.json$/;
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
        walk(src, dst);
      } else if (entry.name === 'kalibra.db' || entry.name === 'hub.db') {
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
  return { out, databases: dbs, files };
}

