import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db.js';
import type { Coordinator } from './coordinator.js';

/*
 * A short-lived cache for the lookups every request makes (session or token → user, the user's role
 * in a project, the project, server settings), shared by all instances through the coordinator.
 *
 * Invalidation is deliberately coarse so no write path can be forgotten: every write to the hub
 * database (except bookkeeping like "last seen" and the audit log) bumps one epoch after it commits,
 * and an entry only counts while the epoch it was read under is still current. Entries are tagged
 * with the epoch read *before* loading, so a write racing a load can only make the entry stale-tagged,
 * never stale-but-trusted. Hub writes are rare (sign-ins, account and member changes), reads are not.
 */

const EPOCH = 'hub:epoch';
const PREFIX = 'hub:c:';

/** Writes that change nothing a cached lookup returns. */
const BOOKKEEPING = [
  /^\s*INSERT\s+INTO\s+audit\b/i,
  /^\s*UPDATE\s+sessions\s+SET\s+last_seen_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s*$/i,
  /^\s*UPDATE\s+tokens\s+SET\s+last_used_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s*$/i,
  /^\s*UPDATE\s+ingest_keys\s+SET\s+last_used_at\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s*$/i,
  /^\s*(INSERT\s+INTO|DELETE\s+FROM)\s+sso_pending\b/i,
];

const isRead = (sql: string) => /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql);
const changesCache = (sql: string) => !isRead(sql) && !BOOKKEEPING.some((re) => re.test(sql));

export class HubCache {
  private writes = new AsyncLocalStorage<{ dirty: boolean }>();

  constructor(
    private coord: Coordinator,
    readonly enabled: boolean,
    private ttlMs = 60_000,
  ) {}

  /** The value for `key`, from the cache while no hub write happened since it was stored. */
  async lookup<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    // Inside a hub transaction the cache can't know about writes not committed yet: read the database.
    if (!this.enabled || this.writes.getStore()) return load();
    let epoch: string | undefined;
    let raw: string | undefined;
    try {
      [epoch, raw] = await this.coord.getMany([EPOCH, PREFIX + key]);
    } catch {
      return load(); // the cache is an optimisation: an unreachable Redis must not block sign-ins
    }
    const current = epoch ?? '0';
    if (raw) {
      try {
        const hit = JSON.parse(raw) as { e: string; v: T | null };
        if (hit.e === current) return hit.v ?? undefined;
      } catch {
        /* unreadable entry: reload */
      }
    }
    const value = await load();
    await this.store(key, value, current);
    return value;
  }

  /** Replaces an entry (e.g. a refreshed "last seen") without invalidating anything else. */
  async refresh<T>(key: string, value: T | undefined) {
    if (!this.enabled) return;
    try {
      const [epoch] = await this.coord.getMany([EPOCH]);
      await this.store(key, value, epoch ?? '0');
    } catch {
      /* best effort */
    }
  }

  /** Makes every cached lookup stale, on every instance. */
  async invalidate() {
    if (!this.enabled) return;
    try {
      await this.coord.incr(EPOCH);
    } catch (e: any) {
      console.error(`Could not invalidate the shared cache: ${e?.message ?? e}`);
    }
  }

  /**
   * The hub database, with every committed write that could change a cached lookup invalidating the
   * cache. Writes inside a transaction invalidate once, after it commits.
   */
  watch(db: Db): Db {
    if (!this.enabled) return db;
    const writes = this.writes;
    const after = async (sql: string) => {
      if (!changesCache(sql)) return;
      const ctx = writes.getStore();
      if (ctx) ctx.dirty = true;
      else await this.invalidate();
    };
    const overrides: Partial<Db> = {
      run: async (sql: string, ...params: unknown[]) => {
        const out = await db.run(sql, ...params);
        await after(sql);
        return out;
      },
      get: async (sql: string, ...params: unknown[]) => {
        const out = await db.get(sql, ...params);
        await after(sql);
        return out;
      },
      all: async (sql: string, ...params: unknown[]) => {
        const out = await db.all(sql, ...params);
        await after(sql);
        return out;
      },
      exec: async (sql: string) => {
        await db.exec(sql);
        await after(sql);
      },
      tx: async <T>(fn: () => Promise<T>) => {
        if (writes.getStore()) return db.tx(fn);
        const ctx = { dirty: false };
        const out = await writes.run(ctx, () => db.tx(fn));
        if (ctx.dirty) await this.invalidate();
        return out;
      },
    };
    // Everything else (dialect, close, anything a driver adds) goes straight to the database.
    return new Proxy(db, {
      get: (target, prop) => {
        if (prop in overrides) return (overrides as any)[prop];
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  private async store<T>(key: string, value: T | undefined, epoch: string) {
    try {
      await this.coord.set(PREFIX + key, JSON.stringify({ e: epoch, v: value ?? null }), this.ttlMs);
    } catch {
      /* best effort */
    }
  }
}
