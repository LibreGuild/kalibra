import { afterEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import { LocalCoordinator, type Coordinator } from '../src/coord/coordinator.js';
import { RedisCoordinator } from '../src/coord/redis.js';
import { HubCache } from '../src/coord/cache.js';
import { openSqlite } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two coordinators that share state: two instances of one deployment. */
const pairs: [string, () => [Coordinator, Coordinator]][] = [
  ['local (one process)', () => { const c = new LocalCoordinator('a'); return [c, c]; }],
  [
    'redis',
    () => {
      // ioredis-mock instances share one in-memory Redis, like two servers sharing Memorystore.
      const make = (id: string) => new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, id);
      return [make('a'), make('b')];
    },
  ],
];

describe.each(pairs)('coordinator: %s', (_name, make) => {
  let open: Coordinator[] = [];
  const both = () => {
    const [a, b] = make();
    open.push(a, b);
    return [a, b] as const;
  };
  afterEach(async () => {
    for (const c of new Set(open)) await c.close();
    open = [];
    await new RedisMock().flushall();
  });

  it('delivers messages to every subscriber, the sender included', async () => {
    const [a, b] = both();
    const got: string[] = [];
    const stop = b.subscribe('chan', (m) => got.push(`b:${m}`));
    a.subscribe('chan', (m) => got.push(`a:${m}`));
    await sleep(10);
    await a.publish('chan', 'one');
    await a.publish('chan', 'two');
    await sleep(30);
    expect(got.filter((g) => g.startsWith('b:'))).toEqual(['b:one', 'b:two']);
    expect(got.filter((g) => g.startsWith('a:'))).toEqual(['a:one', 'a:two']);
    stop();
    await a.publish('chan', 'three');
    await sleep(30);
    expect(got).not.toContain('b:three');
  });

  it('caches with a time to live, and shares the cache', async () => {
    const [a, b] = both();
    await a.set('k', 'v', 60_000);
    expect(await b.get('k')).toBe('v');
    expect(await b.getMany(['k', 'missing'])).toEqual(['v', undefined]);
    await b.del('k');
    expect(await a.get('k')).toBeUndefined();
    await a.set('short', 'x', 20);
    await sleep(40);
    expect(await b.get('short')).toBeUndefined();
  });

  it('counts, keeps bounded lists, and counts hits in a sliding window', async () => {
    const [a, b] = both();
    expect(await a.incr('n')).toBe(1);
    expect(await b.incr('n')).toBe(2);
    for (let i = 0; i < 5; i++) await (i % 2 ? a : b).listPush('l', `x${i}`, 3, 60_000);
    expect(await a.listRange('l', 10)).toEqual(['x4', 'x3', 'x2']);
    expect(await a.windowAdd('w', 60)).toBe(1);
    expect(await b.windowAdd('w', 60)).toBe(2);
    expect(await a.windowCount('w', 60)).toBe(2);
    await sleep(80);
    expect(await b.windowCount('w', 60)).toBe(0);
  });

  it('DEL and SET replace a key whatever it holds, as Redis does', async () => {
    const [a, b] = both();
    await a.incr('c');
    await b.del('c');
    expect(await a.get('c')).toBeUndefined();
    expect(await a.incr('c')).toBe(1);
    await a.set('c', 'text', 60_000);
    expect(await b.get('c')).toBe('text');
    await a.listPush('l2', 'x', 3, 60_000);
    await b.del('l2');
    expect(await a.listRange('l2', 10)).toEqual([]);
  });

  it('gives a lock to one holder at a time; only the holder renews or releases it', async () => {
    const [a, b] = both();
    const l1 = await a.tryLock('job', 200);
    expect(l1).toBeDefined();
    expect(await b.tryLock('job', 200)).toBeUndefined();
    expect(await l1!.renew(200)).toBe(true);
    await l1!.release();
    const l2 = await b.tryLock('job', 30);
    expect(l2).toBeDefined();
    await sleep(60);
    // Expired: someone else may take it, and the old holder can neither renew nor release it.
    const l3 = await a.tryLock('job', 500);
    expect(l3).toBeDefined();
    expect(await l2!.renew(500)).toBe(false);
    await l2!.release();
    expect(await b.tryLock('job', 500)).toBeUndefined();
  });
});

describe('hub cache', () => {
  it('serves lookups until any hub write commits, on every instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-cache-'));
    try {
      const raw = await openSqlite(join(dir, 'x.db'), ['CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE audit (at TEXT);']);
      const redisA = new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, 'a');
      const redisB = new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, 'b');
      const cacheA = new HubCache(redisA, true);
      const cacheB = new HubCache(redisB, true);
      const dbA = cacheA.watch(raw);
      await dbA.run("INSERT INTO users VALUES ('u1', 'Ann')");
      let loads = 0;
      const load = async () => {
        loads++;
        return (await raw.get('SELECT name FROM users WHERE id = ?', 'u1'))?.name as string | undefined;
      };
      expect(await cacheB.lookup('user:u1', load)).toBe('Ann');
      expect(await cacheB.lookup('user:u1', load)).toBe('Ann');
      expect(loads).toBe(1);
      // Bookkeeping writes leave the cache alone.
      await dbA.run('INSERT INTO audit (at) VALUES (?)', 'now');
      expect(await cacheB.lookup('user:u1', load)).toBe('Ann');
      expect(loads).toBe(1);
      // A write on instance A makes instance B reload.
      await dbA.tx(async () => {
        await dbA.run("UPDATE users SET name = 'Bea' WHERE id = 'u1'");
        // Inside the transaction lookups read the database (the write isn't committed yet).
        expect(await cacheA.lookup('user:u1', load)).toBe('Bea');
      });
      expect(await cacheB.lookup('user:u1', load)).toBe('Bea');
      // A rolled-back transaction changes nothing and needn't invalidate.
      await expect(
        dbA.tx(async () => {
          await dbA.run("UPDATE users SET name = 'Cy' WHERE id = 'u1'");
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      expect(await cacheB.lookup('user:u1', load)).toBe('Bea');
      await raw.close();
      await redisA.close();
      await redisB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new RedisMock().flushall();
    }
  });
});

describe('hub cache security', () => {
  it('ignores entries planted in Redis without a valid signature', async () => {
    const redis = new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, 'a');
    try {
      const cache = new HubCache(redis, true, 60_000, Buffer.alloc(32, 7));
      let loads = 0;
      const load = async () => (loads++, { user: { id: 'u1', role: 'member' } });
      expect(await cache.lookup('ses:abc', load)).toEqual({ user: { id: 'u1', role: 'member' } });
      expect(loads).toBe(1);
      // Someone with access to Redis (no password by default on Memorystore) writes an admin session.
      const forged = JSON.stringify({ user: { id: 'evil', role: 'admin' } });
      await redis.set('hub:c:ses:abc', JSON.stringify({ e: '0', v: forged }), 60_000);
      expect(await cache.lookup('ses:abc', load)).toEqual({ user: { id: 'u1', role: 'member' } });
      await redis.set('hub:c:ses:abc', JSON.stringify({ e: '0', v: forged, s: 'not-the-signature' }), 60_000);
      expect(await cache.lookup('ses:abc', load)).toEqual({ user: { id: 'u1', role: 'member' } });
      // A valid entry signed for another key can't be moved onto this one.
      await cache.lookup('ses:other', async () => ({ user: { id: 'evil', role: 'admin' } }));
      await redis.set('hub:c:ses:abc', (await redis.get('hub:c:ses:other'))!, 60_000);
      expect(await cache.lookup('ses:abc', load)).toEqual({ user: { id: 'u1', role: 'member' } });
      expect(loads).toBe(4);
      // Its own entries are still served from the cache.
      expect(await cache.lookup('ses:abc', load)).toEqual({ user: { id: 'u1', role: 'member' } });
      expect(loads).toBe(4);
    } finally {
      await redis.close();
      await new RedisMock().flushall();
    }
  });

  it("doesn't let a refresh bring back a value a hub write has since invalidated", async () => {
    const local = new LocalCoordinator('a');
    const cache = new HubCache(local, true);
    let valid = true;
    const load = async () => (valid ? { id: 'ses1', touchedAt: 't0' } : undefined);
    const s = (await cache.lookup('ses:x', load))!;
    // A sign-out commits on another instance between this request's lookup and its "last seen" refresh.
    valid = false;
    await cache.invalidate();
    await cache.refresh('ses:x', { ...s, touchedAt: 't1' }, s);
    expect(await cache.lookup('ses:x', load)).toBeUndefined();
    await local.close();
  });
});

describe('shared job records', () => {
  it('shows a job whose instance stopped beating as failed', async () => {
    const { Jobs } = await import('../src/jobs.js');
    const { EventBus } = await import('../src/events.js');
    const coordinator = new LocalCoordinator('b');
    const jobs = new Jobs(new EventBus(), { coordinator, project: 'p' });
    const base = { id: 'job_x', kind: 'images', title: 'Images', status: 'running', done: 1, total: 5, message: '', errors: [], createdAt: new Date().toISOString() };
    await coordinator.set('job:p:job_x', JSON.stringify({ ...base, owner: 'a', heartbeat: Date.now() }), 60_000);
    await coordinator.listPush('jobs:p', 'job_x', 200, 60_000);
    expect((await jobs.find('job_x'))?.status).toBe('running');
    await coordinator.set('job:p:job_x', JSON.stringify({ ...base, owner: 'a', heartbeat: Date.now() - 120_000 }), 60_000);
    expect(await jobs.find('job_x')).toMatchObject({ status: 'failed', error: expect.stringMatching(/instance running this job stopped/) });
    expect((await jobs.listAll()).map((j) => j.id)).toEqual(['job_x']);
  });
});
