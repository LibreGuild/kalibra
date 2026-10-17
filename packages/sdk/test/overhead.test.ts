/*
 * Overhead budgets. Generous enough for slow CI machines, tight enough to catch a regression
 * (e.g. something doing network or heavy work in the call path). Numbers go to stdout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, trace, step, flush, shutdown } from '../src/index.js';
import { fakeKalibra, type FakeKalibra } from './fake-kalibra.js';

let fake: FakeKalibra;
beforeAll(async () => {
  fake = await fakeKalibra();
});
afterAll(async () => {
  await shutdown();
  await fake.close();
});

const time = (fn: () => void) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('overhead', () => {
  it('costs nothing when off: 100 000 calls', () => {
    init({ enabled: false, url: fake.url, key: 'kik_x' });
    const work = (x: number) => x * 2;
    const wrapped = trace('hot', work);
    expect(wrapped).toBe(work);
    let sum = 0;
    const plain = time(() => {
      for (let i = 0; i < 100_000; i++) sum += work(i);
    });
    const off = time(() => {
      for (let i = 0; i < 100_000; i++) sum += wrapped(i) + step('s', () => 1);
    });
    process.stdout.write(`[overhead] off: 100k calls ${off.toFixed(1)} ms (plain ${plain.toFixed(1)} ms)\n`);
    expect(off).toBeLessThan(50);
    expect(sum).toBeGreaterThan(0);
  });

  it('records 10 000 traces with two steps each quickly, and sends them in the background', async () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false });
    const answer = trace('answer', (q: string) => {
      const docs = step('retrieve', () => [q, q], { kind: 'retrieval', input: q });
      return step('llm', () => `${docs.length} docs for ${q}`, { kind: 'llm' });
    });
    // Like a real app: work arrives over time, so the background sender gets turns in between.
    // Every third chunk waits for the sender, so at most 4 500 spans are queued however slow the
    // machine is (more than 10 000 queued spans drops the oldest by design; see exporter tests).
    let ms = 0;
    for (let chunk = 0; chunk < 20; chunk++) {
      ms += time(() => {
        for (let i = 0; i < 500; i++) answer(`question ${chunk * 500 + i}`);
      });
      await new Promise((r) => setImmediate(r));
      if (chunk % 3 === 2) await flush();
    }
    process.stdout.write(`[overhead] on: 10k traces (3 spans each) ${ms.toFixed(0)} ms → ${((ms / 10_000) * 1000).toFixed(1)} µs per trace\n`);
    expect(ms).toBeLessThan(1500);
    const t0 = performance.now();
    await flush();
    process.stdout.write(`[overhead] sending 10k traces: ${(performance.now() - t0).toFixed(0)} ms (background)\n`);
    expect(fake.traces().length).toBe(10_000);
  }, 30_000);

  it('unsampled traces cost little', () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false, sampleRate: 0 });
    const answer = trace('answer', (q: string) => step('llm', () => q));
    const ms = time(() => {
      for (let i = 0; i < 100_000; i++) answer('q');
    });
    process.stdout.write(`[overhead] unsampled: 100k traces ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(500);
  });
});
