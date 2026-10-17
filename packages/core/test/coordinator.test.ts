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
