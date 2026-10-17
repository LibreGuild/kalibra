import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/*
 * What several Kalibra instances share besides the database: messages (live events, cancel
 * requests), a short-lived cache, counters, sliding-window rate limits and locks. One instance uses
 * LocalCoordinator (in memory, today's behaviour); several use RedisCoordinator (coord/redis.ts).
 * See docs/design/storage-and-scaling.md, "Several instances".
 */

export interface Lock {
  readonly key: string;
  /** Extends the lock; false when it was lost (it expired and someone else holds it now). */
  renew(ttlMs: number): Promise<boolean>;
  /** Releases the lock if this holder still has it. */
  release(): Promise<void>;
}

export interface Coordinator {
  readonly kind: 'local' | 'redis';
  /** This process, unique per start: host, pid and a random part. */
  readonly instanceId: string;
  /** Sends `message` to the subscribers of `channel` on every instance, this one included. */
  publish(channel: string, message: string): Promise<void>;
  /** Listens on `channel`; returns the function that stops listening. */
  subscribe(channel: string, fn: (message: string) => void): () => void;
  get(key: string): Promise<string | undefined>;
  getMany(keys: string[]): Promise<(string | undefined)[]>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Adds one to a counter (created at 0) and returns the new value. */
  incr(key: string): Promise<number>;
  /** Adds `value` at the front of a list, keeps the first `max` entries, and expires the list after `ttlMs` without changes. */
  listPush(key: string, value: string, max: number, ttlMs: number): Promise<void>;
  /** The first `count` entries of a list, newest first. */
  listRange(key: string, count: number): Promise<string[]>;
  /** Records one hit in a sliding window and returns how many hits fall inside it, this one included. */
  windowAdd(key: string, windowMs: number): Promise<number>;
  /** How many hits fall inside the window now. */
  windowCount(key: string, windowMs: number): Promise<number>;
  /** Takes a lock for `ttlMs` unless someone holds it. */
  tryLock(key: string, ttlMs: number): Promise<Lock | undefined>;
  close(): Promise<void>;
}

export function newInstanceId() {
  const host = hostname().replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 40) || 'host';
  return `${host}-${process.pid}-${randomBytes(4).toString('hex')}`;
}

const token = () => randomBytes(12).toString('base64url');

/** One process: everything in memory. Messages are delivered asynchronously, like Redis. */
export class LocalCoordinator implements Coordinator {
  readonly kind = 'local' as const;
  readonly instanceId: string;
  private channels = new Map<string, Set<(message: string) => void>>();
  private values = new Map<string, { value: string; until: number }>();
  private counters = new Map<string, number>();
  private lists = new Map<string, { items: string[]; until: number }>();
  private windows = new Map<string, number[]>();
  private locks = new Map<string, { token: string; until: number }>();

  constructor(instanceId = newInstanceId()) {
    this.instanceId = instanceId;
  }

  async publish(channel: string, message: string) {
    const subs = this.channels.get(channel);
    if (!subs?.size) return;
    queueMicrotask(() => {
      for (const fn of [...subs]) {
        try {
          fn(message);
        } catch (e: any) {
          console.error(`Message handler failed on ${channel}: ${e?.message ?? e}`);
        }
      }
    });
  }

  subscribe(channel: string, fn: (message: string) => void) {
    let subs = this.channels.get(channel);
    if (!subs) this.channels.set(channel, (subs = new Set()));
    subs.add(fn);
    return () => void subs!.delete(fn);
  }

  async get(key: string) {
    const v = this.values.get(key);
    // Like Redis, a counter (incr) reads back as its number.
    if (!v) return this.counters.has(key) ? String(this.counters.get(key)) : undefined;
    if (v.until <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return v.value;
  }

  async getMany(keys: string[]) {
    return Promise.all(keys.map((k) => this.get(k)));
  }

  async set(key: string, value: string, ttlMs: number) {
    this.values.set(key, { value, until: Date.now() + ttlMs });
    if (this.values.size > 50_000) this.prune();
  }

  async del(...keys: string[]) {
    for (const k of keys) this.values.delete(k);
  }

  async incr(key: string) {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }

  async listPush(key: string, value: string, max: number, ttlMs: number) {
    const now = Date.now();
    const cur = this.lists.get(key);
    const items = cur && cur.until > now ? cur.items : [];
    items.unshift(value);
    if (items.length > max) items.length = max;
    this.lists.set(key, { items, until: now + ttlMs });
  }

  async listRange(key: string, count: number) {
    const cur = this.lists.get(key);
    if (!cur || cur.until <= Date.now()) return [];
    return cur.items.slice(0, count);
  }

  async windowAdd(key: string, windowMs: number) {
    const now = Date.now();
    const hits = [...(this.windows.get(key) ?? []).filter((t) => now - t < windowMs), now];
    this.windows.set(key, hits);
    if (this.windows.size > 10_000) this.pruneWindows(now, windowMs);
    return hits.length;
  }

  async windowCount(key: string, windowMs: number) {
    const now = Date.now();
    const hits = (this.windows.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length) this.windows.set(key, hits);
    else this.windows.delete(key);
    return hits.length;
  }

  async tryLock(key: string, ttlMs: number): Promise<Lock | undefined> {
    const now = Date.now();
    const held = this.locks.get(key);
    if (held && held.until > now) return undefined;
    const mine = token();
    this.locks.set(key, { token: mine, until: now + ttlMs });
    return {
      key,
      renew: async (ms) => {
        const cur = this.locks.get(key);
        if (!cur || cur.token !== mine || cur.until <= Date.now()) return false;
        cur.until = Date.now() + ms;
        return true;
      },
      release: async () => {
        if (this.locks.get(key)?.token === mine) this.locks.delete(key);
      },
    };
  }

  async close() {
    this.channels.clear();
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.values) if (v.until <= now) this.values.delete(k);
  }

  private pruneWindows(now: number, windowMs: number) {
    for (const [k, v] of this.windows) if (!v.some((t) => now - t < windowMs)) this.windows.delete(k);
  }
}
