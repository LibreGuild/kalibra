import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { kalibra, init, trace, step, currentTrace, flush, shutdown, isEnabled } from '../src/index.js';
import { MAX_SPANS_PER_TRACE } from '../src/tracer.js';
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
  delete process.env.KALIBRA_ENABLED;
});

const on = (extra: Parameters<typeof init>[0] = {}) => init({ url: fake.url, key: 'kik_test_key_123456789012345', project: 'Support bot', warnings: false, ...extra });

describe('turning the SDK off', () => {
  it('returns your functions untouched and sends nothing', async () => {
    init({ enabled: false, url: fake.url, key: 'kik_test' });
    const fn = async (q: string) => `answer to ${q}`;
    expect(trace('answer', fn)).toBe(fn);
    expect(kalibra.tool('search', fn)).toBe(fn);
    let got: unknown;
    expect(step('retrieve', (s) => ((got = s), 42))).toBe(42);
    expect(typeof (got as any).setOutput).toBe('function');
    await trace.run('job', async () => 'x');
    await flush();
    expect(fake.requests).toEqual([]);
    expect(isEnabled()).toBe(false);
  });

  it('is off without a key, and KALIBRA_ENABLED=false wins over enabled: true', () => {
    expect(init({ enabled: true, url: fake.url, warnings: false }).enabled).toBe(false);
    process.env.KALIBRA_ENABLED = 'false';
    expect(init({ enabled: true, url: fake.url, key: 'kik_x' }).enabled).toBe(false);
    delete process.env.KALIBRA_ENABLED;
    expect(on().enabled).toBe(true);
  });

  it('checks at call time for functions wrapped before init', async () => {
    // Fresh module state is "undecided" until init; simulate by enabling after wrapping.
    on({ enabled: true });
    const late = trace('late', (x: number) => x + 1);
    expect(late(1)).toBe(2);
    init({ enabled: false, url: fake.url, key: 'kik_x' });
    expect(late(2)).toBe(3); // still works, records nothing
  });
});

describe('recording traces', () => {
  it('records a trace with nested steps in order, linking parents', async () => {
    on({ environment: 'dev', release: '1.2.3' });
    const answer = trace('answer_question', async (question: string) => {
      const docs = await step('retrieve', async () => ['kb-17', 'kb-3'], { kind: 'retrieval', input: question });
      return step(
        'llm',
        async (span) => {
          span.setAttributes({ model: 'gpt-x', tokens_in: 12 });
          const inner = await step('format', () => 'formatted');
          return `${inner}: ${docs.join(',')}`;
        },
        { kind: 'llm' },
      );
    });
    expect(await answer('How do I reset?')).toBe('formatted: kb-17,kb-3');
    await flush();
    const [t] = fake.traces();
    expect(t).toMatchObject({ name: 'answer_question', status: 'ok', input: 'How do I reset?', output: 'formatted: kb-17,kb-3', metadata: { sdk: 'js', environment: 'dev', release: '1.2.3' } });
    expect(t.id).toMatch(/^[0-9a-f]{32}$/);
    expect(t.spans.map((s: any) => [s.name, s.kind])).toEqual([
      ['retrieve', 'retrieval'],
      ['llm', 'llm'],
      ['format', 'step'],
    ]);
    const [retrieve, llm, format] = t.spans;
    expect(retrieve).toMatchObject({ input: 'How do I reset?', output: ['kb-17', 'kb-3'] });
    expect(retrieve.parentId).toBeUndefined();
    expect(format.parentId).toBe(llm.id);
    expect(llm.attributes).toEqual({ model: 'gpt-x', tokens_in: 12 });
    expect(llm.durationMs).toBeGreaterThanOrEqual(0);
    const req = fake.requests.find((r) => r.path.endsWith('/ingest/traces'))!;
    expect(req.path).toBe('/kalibra/api/projects/Support%20bot/ingest/traces');
    expect(req.headers.authorization).toBe('Bearer kik_test_key_123456789012345');
  });

  it('sends to /kalibra/api on the server, whether the URL has /kalibra or not', async () => {
    for (const url of [fake.url, `${fake.url}/`, `${fake.url}/kalibra`, `${fake.url}/kalibra/`]) {
      fake.requests.length = 0;
      on({ url });
      trace('t', () => 1)();
      await flush();
      expect(fake.requests.map((r) => r.path)).toEqual(['/kalibra/api/projects/Support%20bot/ingest/traces']);
    }
  });

  it('keeps sync functions sync, and preserves this and arguments', async () => {
    on();
    const obj = { base: 10, add: trace('add', function (this: { base: number }, a: number, b: number) {
      return this.base + a + b;
    }) };
    const r = obj.add(1, 2);
    expect(r).toBe(13);
    await flush();
    expect(fake.traces()[0]).toMatchObject({ name: 'add', input: [1, 2], output: 13 });
  });

  it('records errors and rethrows them unchanged (sync and async)', async () => {
    on();
    const boom = new Error('kaput');
    const failing = trace('fails', async () => {
      try {
        // A sync step that throws, throws synchronously (like the function itself would).
        step('inner', () => {
          throw new TypeError('bad input');
        });
      } catch {
        /* handled by the app */
      }
      throw boom;
    });
    await expect(failing()).rejects.toBe(boom);
    const syncFail = trace('sync-fails', () => {
      throw boom;
    });
    expect(() => syncFail()).toThrow(boom);
    await flush();
    const [a, b] = fake.traces();
    expect(a).toMatchObject({ name: 'fails', status: 'error', error: 'Error: kaput' });
    expect(a.spans[0]).toMatchObject({ name: 'inner', error: 'TypeError: bad input' });
    expect(b).toMatchObject({ name: 'sync-fails', status: 'error' });
  });

  it('keeps a generator step open while it is consumed, with steps inside it as children', async () => {
    on();
    const tokens = trace('stream_answer', async function* (q: string) {
      const docs = await step('retrieve', async () => [`doc for ${q}`], { kind: 'retrieval' });
      for (const t of ['Refunds ', 'take ', '5 days.']) {
        await new Promise((r) => setTimeout(r, 5));
        yield t;
      }
      return docs.length;
    });
    let text = '';
    for await (const t of tokens('refunds')) text += t;
    expect(text).toBe('Refunds take 5 days.');

    const numbers = trace('numbers', function* () {
      yield 1;
      yield 2;
      yield 3;
    });
    for (const n of numbers()) if (n === 2) break; // an early stop is not an error

    const broken = trace('broken', async function* () {
      yield 'a';
      throw new Error('upstream closed');
    });
    await expect(
      (async () => {
        for await (const _ of broken());
      })(),
    ).rejects.toThrow('upstream closed');

    await flush();
    const [answer, nums, failed] = fake.traces();
    expect(answer).toMatchObject({ name: 'stream_answer', status: 'ok', input: 'refunds', output: 'Refunds take 5 days.' });
    expect(answer.durationMs).toBeGreaterThanOrEqual(10);
    expect(answer.spans).toEqual([expect.objectContaining({ name: 'retrieve', kind: 'retrieval', output: ['doc for refunds'] })]);
    expect(answer.spans[0].parentId).toBeUndefined(); // a direct child of the trace
    expect(nums).toMatchObject({ name: 'numbers', status: 'ok', output: { items: 2, first: [1, 2] } });
    expect(failed).toMatchObject({ name: 'broken', status: 'error', error: 'Error: upstream closed' });
  });

  it('makes a trace inside a trace a child span', async () => {
    on();
    const search = trace('search', async (q: string) => [q], { kind: 'retrieval' });
    const agent = trace('agent', async (q: string) => search(q));
    await agent('hello');
    await flush();
    const traces = fake.traces();
    expect(traces).toHaveLength(1);
    expect(traces[0].spans).toEqual([expect.objectContaining({ name: 'search', kind: 'retrieval', input: 'hello', output: ['hello'] })]);
  });

  it('runs a block now as a trace, with handles for metadata, tags and output', async () => {
    on();
    const out = await trace.run(
      'nightly-job',
      async (t) => {
        currentTrace().setMetadata({ user: 'u-1', session: 's-9' });
        currentTrace().addTags('nightly', 'batch');
        t.setOutput({ processed: 3 });
        return 'ignored as output';
      },
      { input: { day: 'mon' } },
    );
    expect(out).toBe('ignored as output');
    await flush();
    expect(fake.traces()[0]).toMatchObject({ name: 'nightly-job', input: { day: 'mon' }, output: { processed: 3 }, tags: ['nightly', 'batch'], metadata: { user: 'u-1', session: 's-9' } });
  });

  it('lets input/output mappers choose what is recorded', async () => {
    on();
    const fn = trace('mapped', async (big: { text: string; secret: string }) => ({ answer: 'ok', raw: 'x'.repeat(10) }), {
      input: (big) => big.text,
      output: (r) => r.answer,
    });
    await fn({ text: 'hi', secret: 'hidden' });
    const none = trace('none', (x: number) => x, { input: false, output: false });
    none(5);
    await flush();
    const [a, b] = fake.traces();
    expect(a).toMatchObject({ input: 'hi', output: 'ok' });
    expect(b.input).toBeUndefined();
    expect(b.output).toBeUndefined();
  });

  it('starts a trace when step runs outside one', async () => {
    on();
    expect(step('standalone', () => 7, { kind: 'tool' })).toBe(7);
    await flush();
    expect(fake.traces()[0]).toMatchObject({ name: 'standalone', output: 7, spans: [] });
  });

  it(`keeps at most ${MAX_SPANS_PER_TRACE} spans per trace and counts the rest`, async () => {
    on();
    await trace.run('many', async () => {
      for (let i = 0; i < MAX_SPANS_PER_TRACE + 10; i++) step(`s${i}`, () => i);
    });
    await flush();
    const [t] = fake.traces();
    expect(t.spans).toHaveLength(MAX_SPANS_PER_TRACE);
    expect(t.metadata.droppedSpans).toBe(10);
  });
});

describe('sampling', () => {
  it('decides once per trace: an unsampled trace records none of its steps', async () => {
    on({ sampleRate: 0 });
    let stepRan = 0;
    const fn = trace('sampled-out', async () => {
      await step('a', () => stepRan++);
      await step('b', () => stepRan++);
      return 'done';
    });
    for (let i = 0; i < 20; i++) expect(await fn()).toBe('done');
    await flush();
    expect(stepRan).toBe(40);
    expect(fake.traces()).toEqual([]);
  });

  it('an unsampled generator trace stays unsampled while it is consumed', async () => {
    on({ sampleRate: 0.5 });
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.9).mockReturnValue(0.1); // not sampled, then sampled
    const tokens = trace('stream', async function* () {
      yield await step('llm', async () => 'hi', { kind: 'llm' });
    });
    const out: string[] = [];
    for await (const t of tokens()) out.push(t);
    random.mockRestore();
    await flush();
    expect(out).toEqual(['hi']);
    expect(fake.traces()).toEqual([]); // the step did not start a trace of its own
  });

  it('keeps roughly the configured share', async () => {
    on({ sampleRate: 0.3 });
    const fn = trace('maybe', () => 1);
    for (let i = 0; i < 2000; i++) fn();
    await flush();
    const n = fake.traces().length;
    expect(n).toBeGreaterThan(400);
    expect(n).toBeLessThan(800);
  });
});
