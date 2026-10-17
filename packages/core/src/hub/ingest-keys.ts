import { HubCache } from '../coord/cache.js';
import { LocalCoordinator } from '../coord/coordinator.js';
import type { Db } from '../db.js';
import { invalid, newId, notFound, nowIso } from '../util.js';
import { randomSecret, sha256 } from './passwords.js';

/*
 * Ingest keys (`kik_…`) let an app send traces to ONE project and use its tool recordings, and do
 * nothing else: they can't read datasets, runs or other traces, and can't call operations. Apps
 * run in their own process (and often on another machine), so they need a key even in local
 * mode. Only a SHA-256 of each key is stored; the key is shown once when created.
 */

export const INGEST_KEY_PREFIX = 'kik_';
const TOUCH_MS = 60_000;

export interface IngestKeyInfo {
  id: string;
  projectId: string;
  name: string;
  /** First characters, to recognise a key in a list. */
  prefix: string;
  createdAt: string;
  createdBy: string;
  lastUsedAt?: string;
}

const toKey = (r: any): IngestKeyInfo => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  createdBy: r.created_by,
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
});

export class IngestKeys {
  constructor(
    private db: Db,
    private cache = new HubCache(new LocalCoordinator(), false),
  ) {}

  async create(projectId: string, name: string, createdBy: string): Promise<IngestKeyInfo & { key: string }> {
    return this.db.tx(async () => {
      const clean = name.trim();
      if (!clean) throw invalid('Give the key a name, e.g. "support-bot dev"');
      const key = `${INGEST_KEY_PREFIX}${randomSecret(30)}`;
      const id = newId('ikey');
      await this.db.run(
        'INSERT INTO ingest_keys (id, project_id, name, prefix, token_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, projectId, clean.slice(0, 100), key.slice(0, INGEST_KEY_PREFIX.length + 6), sha256(key), nowIso(), createdBy,
      );
      return { ...toKey(await this.db.get('SELECT * FROM ingest_keys WHERE id = ?', id)), key };
    });
  }

  async list(projectId: string): Promise<IngestKeyInfo[]> {
    return (await this.db.all('SELECT * FROM ingest_keys WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', projectId)).map(toKey);
  }

  async revoke(projectId: string, id: string): Promise<IngestKeyInfo> {
    return this.db.tx(async () => {
      const r = await this.db.get('SELECT * FROM ingest_keys WHERE id = ? AND project_id = ? AND revoked_at IS NULL', id, projectId);
      if (!r) throw notFound('Ingest key', id);
      await this.db.run('UPDATE ingest_keys SET revoked_at = ? WHERE id = ?', nowIso(), id);
      return toKey(r);
    });
  }

  /** The project a key may send to, if the key is valid and its project still exists. */
  async resolve(key: string): Promise<{ keyId: string; projectId: string } | undefined> {
    if (!key.startsWith(INGEST_KEY_PREFIX)) return undefined;
    const cacheKey = `ingest:${sha256(key)}`;
    const r = await this.cache.lookup<{ id: string; project_id: string; last_used_at: string | null }>(cacheKey, async () =>
      this.db.get(
        `SELECT k.id, k.project_id, k.last_used_at FROM ingest_keys k JOIN projects p ON p.id = k.project_id
          WHERE k.token_hash = ? AND k.revoked_at IS NULL AND p.deleted_at IS NULL`,
        sha256(key),
      ),
    );
    if (!r) return undefined;
    if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > TOUCH_MS) {
      const now = nowIso();
      await this.db.run('UPDATE ingest_keys SET last_used_at = ? WHERE id = ?', now, r.id);
      await this.cache.refresh(cacheKey, { ...r, last_used_at: now });
    }
    return { keyId: r.id, projectId: r.project_id };
  }
}
