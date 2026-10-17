import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { init, trace, flush, shutdown } from '../src/index.js';
import { Exporter, MAX_QUEUED_SPANS, type TraceIn } from '../src/exporter.js';
import { resolveConfig } from '../src/config.js';
import { fakeKalibra, type FakeKalibra } from './fake-kalibra.js';

let fake: FakeKalibra;
beforeAll(async () => {
  fake = await fakeKalibra();
});
afterAll(async () => {
  await shutdown();
  await fake.close();
});
afterEach(async () => {
  await flush();
  fake.requests.length = 0;
});

const cfg = (extra = {}) => resolveConfig({ url: fake.url, key: 'kik_test_key_123456789012345', project: 'p1', warnings: false, flushIntervalMs: 60_000, ...extra });
const mk = (i: number, spans = 0, extra: Partial<TraceIn> = {}): TraceIn => ({
  id: `t${i}`,
  name: `trace-${i}`,
  startedAt: new Date().toISOString(),
  status: 'ok',
  metadata: {},
  tags: [],
  spans: Array.from({ length: spans }, (_, j) => ({ id: `s${j}`, name: `s${j}`, kind: 'step' as const, startedAt: new Date().toISOString() })),
  ...extra,
});
const ingest = () => fake.requests.filter((r) => r.path.endsWith('/ingest/traces'));

describe('sending', () => {
  it('sends on its own once 200 spans are waiting, without flush()', async () => {
    const ex = new Exporter(cfg());
    for (let i = 0; i < 199; i++) ex.enqueue(mk(i));
    await new Promise((r) => setTimeout(r, 50));
    expect(ingest()).toHaveLength(0);
    ex.enqueue(mk(199));
    for (let i = 0; i < 50 && !ingest().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ingest()[0].body.traces).toHaveLength(200);
    await ex.shutdown();
  });

  it('sends every second from a timer', async () => {
    const ex = new Exporter(cfg({ flushIntervalMs: 100 }));
    ex.enqueue(mk(1));
    for (let i = 0; i < 50 && !ingest().length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(fake.traces().map((t) => t.id)).toEqual(['t1']);
    await ex.shutdown();
  });

  it('retries server errors twice, then drops the batch', async () => {
    const ex = new Exporter(cfg());
    fake.failIngest(503, 2);
    ex.enqueue(mk(1));
    await ex.flush();
    expect(ingest().map((r) => r.body.traces.length)).toEqual([1, 1, 1]);
    expect(fake.traces()).toHaveLength(3); // the third attempt went through
    fake.requests.length = 0;
    fake.failIngest(500, 5);
    ex.enqueue(mk(2));
    await ex.flush();
    expect(ingest()).toHaveLength(3); // first try + 2 retries, then dropped
    await ex.shutdown();
  });

  it('does not retry a wrong key or project', async () => {
    const ex = new Exporter(cfg());
    fake.failIngest(401, 5);
    ex.enqueue(mk(1));
    await ex.flush();
    expect(ingest()).toHaveLength(1);
    fake.failIngest(202, 0);
    await ex.shutdown();
  });

  it('survives Kalibra being down', async () => {
    const ex = new Exporter(resolveConfig({ url: 'http://127.0.0.1:9', key: 'kik_x', warnings: false }));
    ex.enqueue(mk(1));
    await expect(ex.flush()).resolves.toBeUndefined();
    await ex.shutdown();
  }, 15_000);

  it('drops the oldest traces when more than 10 000 spans wait', async () => {
    const ex = new Exporter(resolveConfig({ url: 'http://127.0.0.1:9', key: 'kik_x', warnings: false, flushIntervalMs: 60_000 }));
    // Sending fails slowly (nobody listens), so the queue fills up behind it.
    for (let i = 0; i < 120; i++) ex.enqueue(mk(i, 99)); // 100 spans each
    expect(ex.pendingSpans).toBeLessThanOrEqual(MAX_QUEUED_SPANS);
    expect(ex.droppedTraces).toBeGreaterThan(0);
  });

  it('splits big batches within the server limits (1000 traces, 5000 spans per request)', async () => {
    const ex = new Exporter(cfg());
    for (let i = 0; i < 2500; i++) ex.enqueue(mk(i));
    await ex.flush();
    const sizes = ingest().map((r) => r.body.traces.length);
    expect(sizes.every((n) => n <= 1000)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(2500);
    fake.requests.length = 0;
    for (let i = 0; i < 30; i++) ex.enqueue(mk(i, 255));
    await ex.flush();
    for (const r of ingest()) expect(r.body.traces.reduce((n: number, t: any) => n + 1 + t.spans.length, 0)).toBeLessThanOrEqual(5000);
    await ex.shutdown();
  });

  it('flush() waits for a send another flush already started', async () => {
    const ex = new Exporter(cfg());
    for (let i = 0; i < 700; i++) ex.enqueue(mk(i)); // starts sends on its own at 200, 400, 600
    await ex.flush();
    expect(fake.traces()).toHaveLength(700);
    await ex.shutdown();
  });
});

describe('redaction', () => {
  it('runs when sending, not while your code runs', async () => {
    let calls = 0;
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false, redact: (v) => (calls++, v) });
    const fn = trace('t', (x: string) => x);
    for (let i = 0; i < 5; i++) fn('hello');
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBeGreaterThan(0);
  });

  it('removes personal data and keys from inputs, outputs, errors, metadata and spans by default', async () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false });
    const fn = trace('support', async (msg: string) => {
      await trace.run('lookup', async (s) => s.setOutput({ email: 'jane.doe@example.com', note: 'card 4111 1111 1111 1111' }));
      throw new Error(`Key sk-proj-abcdefghijklmnopqrstuvwx leaked for +1 415 555 0134`);
    });
    await expect(fn('Hi, I am jane.doe@example.com, call me at (415) 555-0134')).rejects.toThrow();
    await flush();
    const [t] = fake.traces();
    const text = JSON.stringify(t);
    for (const s of ['jane.doe@example.com', '4111 1111 1111 1111', 'sk-proj-abcdefghijklmnopqrstuvwx', '555-0134', '555 0134']) expect(text).not.toContain(s);
    expect(t.input).toBe('Hi, I am [redacted], call me at [redacted]');
  });

  it('can be turned off', async () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false, redact: false });
    trace('raw', (x: string) => x)('jane.doe@example.com');
    await flush();
    expect(fake.traces()[0].input).toBe('jane.doe@example.com');
  });
});

describe('process exit', () => {
  it('sends pending traces before the process exits, without flush()', async () => {
    const script = `
      import { kalibra } from ${JSON.stringify(join(__dirname, '..', 'src', 'index.ts'))};
      kalibra.init({ url: ${JSON.stringify(fake.url)}, key: 'kik_exit_key_123456789012', warnings: false });
      kalibra.trace('at-exit', (x) => x * 2)(21);
    `;
    await new Promise<void>((resolve, reject) =>
      execFile(join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx'), ['--eval', script], { timeout: 20_000 }, (err) => (err ? reject(err) : resolve())),
    );
    expect(fake.traces().map((t) => [t.name, t.output])).toEqual([['at-exit', 42]]);
  }, 30_000);
});
