import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, TxOptions } from '../db.js';
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
 *
 * Entries decide who is signed in, so with a signing key (derived from KALIBRA_SECRET_KEY) each one
 * carries an HMAC: whoever can write to Redis (Memorystore has no password by default) can't plant
 * a session or a role. An entry without a valid signature is ignored and loaded again.
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
  /** The epoch each value handed out was valid for, so refresh() can't re-tag an old value as current. */
  private readAt = new WeakMap<object, string>();

  constructor(
    private coord: Coordinator,
    readonly enabled: boolean,
    private ttlMs = 60_000,
    private signingKey?: Buffer,
  ) {}

  private sign(key: string, epoch: string, json: string) {
    return createHmac('sha256', this.signingKey!).update(`${key}\n${epoch}\n${json}`).digest('base64url');
  }

  private signed(key: string, epoch: string, json: string, sig: unknown) {
    if (!this.signingKey) return true;
    if (typeof sig !== 'string') return false;
    const want = Buffer.from(this.sign(key, epoch, json));
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private remember<T>(value: T, epoch: string): T {
    if (value && typeof value === 'object') this.readAt.set(value, epoch);
    return value;
  }

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
        const hit = JSON.parse(raw) as { e: string; v: string; s?: string };
        if (hit.e === current && typeof hit.v === 'string' && this.signed(key, hit.e, hit.v, hit.s)) {
          const value = JSON.parse(hit.v) as T | null;
          return this.remember(value ?? undefined, current);
        }
      } catch {
        /* unreadable entry: reload */
      }
    }
    const value = await load();
    await this.store(key, value, current);
    return this.remember(value, current);
  }

  /**
   * Replaces an entry (e.g. a refreshed "last seen") without invalidating anything else. `from` is
   * the value lookup() returned: if a hub write happened since (a sign-out, a revoked token), the
   * new value is stored under that older epoch, so it isn't trusted and the next lookup reloads.
   */
  async refresh<T>(key: string, value: T | undefined, from: object) {
    if (!this.enabled) return;
    const epoch = this.readAt.get(from);
    if (epoch === undefined) return;
    await this.store(key, value, epoch);
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
      tx: async <T>(fn: () => Promise<T>, opts?: TxOptions) => {
        if (writes.getStore()) return db.tx(fn, opts);
        const ctx = { dirty: false };
        const out = await writes.run(ctx, () => db.tx(fn, opts));
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
      const v = JSON.stringify(value ?? null);
      await this.coord.set(PREFIX + key, JSON.stringify({ e: epoch, v, ...(this.signingKey ? { s: this.sign(key, epoch, v) } : {}) }), this.ttlMs);
    } catch {
      /* best effort */
    }
  }
}
