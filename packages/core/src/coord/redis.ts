import { randomBytes } from 'node:crypto';
import type { Redis, RedisOptions } from 'ioredis';
import { newInstanceId, type Coordinator, type Lock } from './coordinator.js';

/*
 * Several instances: shared state in Redis (Memorystore, ElastiCache, Azure Cache, Upstash, self-run).
 * Every key and channel starts with "kalibra:", so Kalibra can share a Redis with other apps.
 * Two connections: one for commands, one for subscriptions (a subscribed connection can't do both).
 */

const PREFIX = 'kalibra:';

const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisCoordinator implements Coordinator {
  readonly kind = 'redis' as const;
  readonly instanceId: string;
  private handlers = new Map<string, Set<(message: string) => void>>();
  private lastError = 0;

  /** Connects to `url` (redis:// or rediss:// for TLS) and checks it answers. */
  static async connect(url: string, opts: { instanceId?: string; timeoutMs?: number } = {}): Promise<RedisCoordinator> {
    const mod: any = await import('ioredis');
    const RedisClass = mod.default ?? mod.Redis;
    const options: RedisOptions = {
      lazyConnect: true,
      connectTimeout: opts.timeoutMs ?? 10_000,
      // Commands fail after a few reconnect attempts instead of waiting forever while Redis is down.
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    };
    const client: Redis = new RedisClass(url, options);
    const subscriber: Redis = new RedisClass(url, options);
    // At startup an unreachable Redis is an error to report, not something to retry quietly.
    let cause: any;
    const capture = (e: any) => (cause ??= e);
    client.on('error', capture);
    subscriber.on('error', capture);
    try {
      await Promise.all([client.connect(), subscriber.connect()]);
      await client.ping();
    } catch (e: any) {
      client.disconnect();
      subscriber.disconnect();
      throw new Error(`Could not connect to Redis (KALIBRA_REDIS_URL): ${(cause ?? e)?.message ?? e}`);
    } finally {
      client.off('error', capture);
      subscriber.off('error', capture);
    }
    return new RedisCoordinator(client, subscriber, opts.instanceId);
  }

  /** Takes connected clients (tests pass ioredis-mock). */
  constructor(
    private client: Redis,
    private subscriber: Redis,
    instanceId = newInstanceId(),
  ) {
    this.instanceId = instanceId;
    const onError = (e: any) => {
      // Reconnects happen on their own; say so now and then, not on every retry.
      if (Date.now() - this.lastError < 30_000) return;
      this.lastError = Date.now();
      console.error(`Redis: ${e?.message ?? e} (retrying)`);
    };
    client.on('error', onError);
    subscriber.on('error', onError);
    subscriber.on('message', (channel: string, message: string) => {
      for (const fn of [...(this.handlers.get(channel.slice(PREFIX.length)) ?? [])]) {
        try {
          fn(message);
        } catch (e: any) {
          console.error(`Message handler failed on ${channel}: ${e?.message ?? e}`);
        }
      }
    });
  }

  async publish(channel: string, message: string) {
    await this.client.publish(PREFIX + channel, message);
  }

  subscribe(channel: string, fn: (message: string) => void) {
    let set = this.handlers.get(channel);
    if (!set) {
      this.handlers.set(channel, (set = new Set()));
      this.subscriber.subscribe(PREFIX + channel).catch((e) => console.error(`Redis: could not subscribe to ${channel}: ${e?.message ?? e}`));
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size && this.handlers.get(channel) === set) {
        this.handlers.delete(channel);
        this.subscriber.unsubscribe(PREFIX + channel).catch(() => {});
      }
    };
  }

  async get(key: string) {
    return (await this.client.get(PREFIX + key)) ?? undefined;
  }

  async getMany(keys: string[]) {
    if (!keys.length) return [];
    return (await this.client.mget(...keys.map((k) => PREFIX + k))).map((v) => v ?? undefined);
  }

  async set(key: string, value: string, ttlMs: number) {
    await this.client.set(PREFIX + key, value, 'PX', Math.max(1, Math.round(ttlMs)));
  }

  async del(...keys: string[]) {
    if (keys.length) await this.client.del(...keys.map((k) => PREFIX + k));
  }

  async incr(key: string) {
    return await this.client.incr(PREFIX + key);
  }

  async listPush(key: string, value: string, max: number, ttlMs: number) {
    const k = PREFIX + key;
    await this.client.multi().lpush(k, value).ltrim(k, 0, max - 1).pexpire(k, Math.round(ttlMs)).exec();
  }

  async listRange(key: string, count: number) {
    return await this.client.lrange(PREFIX + key, 0, count - 1);
  }

  async windowAdd(key: string, windowMs: number) {
    const k = PREFIX + key;
    const now = Date.now();
    const res = await this.client
      .multi()
      .zremrangebyscore(k, '-inf', now - windowMs)
      .zadd(k, now, `${now}-${randomBytes(6).toString('hex')}`)
      .zcard(k)
      .pexpire(k, windowMs)
      .exec();
    return Number(res?.[2]?.[1] ?? 0);
  }

  async windowCount(key: string, windowMs: number) {
    const k = PREFIX + key;
    const res = await this.client.multi().zremrangebyscore(k, '-inf', Date.now() - windowMs).zcard(k).exec();
    return Number(res?.[1]?.[1] ?? 0);
  }

  async tryLock(key: string, ttlMs: number): Promise<Lock | undefined> {
    const k = PREFIX + key;
    const mine = randomBytes(12).toString('base64url');
    const ok = await this.client.set(k, mine, 'PX', Math.round(ttlMs), 'NX');
    if (ok !== 'OK') return undefined;
    return {
      key,
      renew: async (ms) => Number(await this.client.eval(RENEW, 1, k, mine, String(Math.round(ms)))) === 1,
      release: async () => {
        await this.client.eval(RELEASE, 1, k, mine);
      },
    };
  }

  async close() {
    this.handlers.clear();
    await Promise.allSettled([this.client.quit(), this.subscriber.quit()]);
  }
}
