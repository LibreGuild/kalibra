import { describe, expect, it } from 'vitest';
import { BucketLease, HANDOVER_KEY, LEASE_KEY, leaseIsFree } from '../src/deploy/lease.js';
import { MemoryObjects } from '../src/deploy/objects.js';

/** Fast timings: renewals far apart (only explicit), handover requests checked every 10 ms. */
const fast = { renewMs: 3_600_000, staleMs: 400, handoverPollMs: 10, handoverWaitMs: 150 };
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const holderOf = async (objects: MemoryObjects) => JSON.parse((await objects.get(LEASE_KEY))!.data.toString('utf8'));

/** A sleep that can be called off, so a test can stop an instance that would wait forever. */
function stoppable() {
  let stopped = false;
  return {
    sleep: async (ms: number) => {
      if (stopped) throw new Error('stopped');
      await tick(Math.min(ms, 20));
    },
    stop: () => (stopped = true),
  };
}

describe('handing the bucket over to a new instance', () => {
  it('the holder hands over when asked; the new instance takes the lease at once', async () => {
    const objects = new MemoryObjects();
    const logs: string[] = [];
    let asked = 0;
    const old = new BucketLease(objects, {
      ...fast,
      onLost: () => {
        throw new Error('the old holder must not see its lease "lost" after handing over');
      },
      onHandover: () => {
        asked++;
        // What the app does: stop writing, final sync, then give the lease back.
        void tick(30).then(() => old.release());
        return true;
      },
    });
    await old.acquire();
    const fresh = new BucketLease(objects, { ...fast, log: (m) => logs.push(m), onLost: () => {} });
    const started = Date.now();
    await fresh.acquire(true);
    expect(Date.now() - started).toBeLessThan(fast.staleMs); // didn't wait for the old lease to expire
    expect(asked).toBe(1);
    expect((await holderOf(objects)).owner).toBe(fresh.owner);
    expect(logs.join('\n')).toMatch(/Asked it to hand over[\s\S]*which handed it over/);
    expect(await objects.get(HANDOVER_KEY)).toBeUndefined(); // the request was cleaned up
    expect(await old.takenByOther()).toBe(true);
    await old.renew(); // a late renewal after the release changes nothing
    expect((await holderOf(objects)).owner).toBe(fresh.owner);
    await fresh.release();
    expect(leaseIsFree((await objects.get(LEASE_KEY))?.data)).toBe(true);
  });

  it('on a slow bucket (reads slower than the poll interval) the holder hands over once', async () => {
    class SlowObjects extends MemoryObjects {
      override async get(key: string) {
        await tick(60); // 6× the 10 ms poll interval: checks overlap
        return super.get(key);
      }
    }
    const objects = new SlowObjects();
    let asked = 0;
    const old: BucketLease = new BucketLease(objects, {
      ...fast,
      onLost: () => {},
      onHandover: () => {
        asked++;
        void tick(100).then(() => old.release());
        return true;
      },
    });
    await old.acquire();
    const fresh = new BucketLease(objects, { ...fast, handoverWaitMs: 5000, onLost: () => {} });
    await fresh.acquire(true);
    await tick(200);
    expect(asked).toBe(1);
    expect((await holderOf(objects)).owner).toBe(fresh.owner);
    await fresh.release();
  });

  it('a holder that is still starting answers once it is ready', async () => {
    const objects = new MemoryObjects();
    let ready = false;
    const old: BucketLease = new BucketLease(objects, {
      ...fast,
      onLost: () => {},
      onHandover: () => {
        if (!ready) return false;
        void old.release();
        return true;
      },
    });
    await old.acquire();
    const fresh = new BucketLease(objects, { ...fast, handoverWaitMs: 2000, onLost: () => {} });
    const taking = fresh.acquire(true);
    await tick(100);
    expect((await holderOf(objects)).owner).toBe(old.owner);
    ready = true;
    await taking;
    expect((await holderOf(objects)).owner).toBe(fresh.owner);
    await fresh.release();
  });

  it("falls back to waiting for the old lease to expire when the holder doesn't answer", async () => {
    const objects = new MemoryObjects();
    // An older Kalibra (no handover) that crashed: it neither answers nor renews.
    const old = new BucketLease(objects, { ...fast, onLost: () => {} });
    await old.acquire();
    const logs: string[] = [];
    const fresh = new BucketLease(objects, { ...fast, log: (m) => logs.push(m), onLost: () => {}, sleep: (ms) => tick(Math.min(ms, 20)) });
    const started = Date.now();
    await fresh.acquire(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(fast.handoverWaitMs);
    expect(logs.join('\n')).toMatch(/did not hand over/);
    expect((await holderOf(objects)).owner).toBe(fresh.owner);
    await fresh.release();
  });

  it('two new instances racing for the bucket: exactly one gets it', async () => {
    const objects = new MemoryObjects();
    const old: BucketLease = new BucketLease(objects, {
      ...fast,
      onLost: () => {},
      onHandover: () => {
        void old.release();
        return true;
      },
    });
    await old.acquire();
    const sa = stoppable();
    const sb = stoppable();
    const a = new BucketLease(objects, { ...fast, onLost: () => {}, sleep: sa.sleep });
    const b = new BucketLease(objects, { ...fast, onLost: () => {}, sleep: sb.sleep });
    const results = await Promise.race([
      Promise.allSettled([a.acquire(true), b.acquire(true)]),
      tick(300).then(() => {
        // The loser keeps waiting for the winner's lease; stop it.
        sa.stop();
        sb.stop();
        return 'timeout' as const;
      }),
    ]);
    const owner = (await holderOf(objects)).owner;
    expect([a.owner, b.owner]).toContain(owner);
    // Only the winner's acquire finished; the other was still waiting until stopped.
    await tick(50);
    expect(results === 'timeout' || (Array.isArray(results) && results.filter((r) => r.status === 'fulfilled').length === 1)).toBe(true);
    expect((await holderOf(objects)).owner).toBe(owner); // nobody overwrote the winner
    await (owner === a.owner ? a : b).release();
  });

  it("doesn't ask a holder that started after it to step aside", async () => {
    const objects = new MemoryObjects();
    const older = new BucketLease(objects, { ...fast, onLost: () => {}, sleep: async () => { throw new Error('stopped'); } });
    await tick(5);
    const newer = new BucketLease(objects, { ...fast, onLost: () => {}, onHandover: () => true });
    await newer.acquire();
    await expect(older.acquire(true)).rejects.toThrow('stopped');
    expect(await objects.get(HANDOVER_KEY)).toBeUndefined();
    await newer.release();
  });

  it('without takeover a held bucket is refused, as before', async () => {
    const objects = new MemoryObjects();
    const old = new BucketLease(objects, { ...fast, onLost: () => {}, onHandover: () => true });
    await old.acquire();
    await expect(new BucketLease(objects, { ...fast, onLost: () => {} }).acquire()).rejects.toThrow(/--takeover/);
    expect(await objects.get(HANDOVER_KEY)).toBeUndefined();
    await old.release();
  });
});
