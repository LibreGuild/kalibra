import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { kalibra, init, trace, step, tool, flush, shutdown, fromRequest, middleware, currentTrace, canonicalJson, argsHash, linkFromHeaders } from '../src/index.js';
import { clearToolCache } from '../src/tools.js';
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
  fake.recordings.clear();
  clearToolCache();
  delete process.env.KALIBRA_TOOLS;
});
const on = () => init({ url: fake.url, key: 'kik_test_key_123456789012345', project: 'p', warnings: false });

const KALIBRA_HEADERS = {
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  'x-kalibra-run': 'run_abc',
  'x-kalibra-result': 'res_123',
  'x-kalibra-tools': 'replay',
};

describe('linking traces to Kalibra eval rows', () => {
  it('reads the headers from Node requests, fetch Requests, Headers and plain objects', () => {
    const expected = { traceId: '0af7651916cd43dd8448eb211c80319c', parentSpanId: 'b7ad6b7169203331', runId: 'run_abc', resultId: 'res_123', tools: 'replay' };
    expect(linkFromHeaders({ headers: KALIBRA_HEADERS })).toEqual(expected);
    expect(linkFromHeaders(new Request('http://x', { headers: KALIBRA_HEADERS }))).toEqual(expected);
    expect(linkFromHeaders(new Headers(KALIBRA_HEADERS))).toEqual(expected);
    expect(linkFromHeaders({ 'X-Kalibra-Result': ['res_9'] })).toEqual({ resultId: 'res_9' });
    // Plain distributed tracing is not a Kalibra run.
    expect(linkFromHeaders({ traceparent: KALIBRA_HEADERS.traceparent })).toBeUndefined();
    // Junk is ignored.
    expect(linkFromHeaders({ 'x-kalibra-result': 'a b; DROP TABLE', 'x-kalibra-tools': '<script>' })).toBeUndefined();
  });

  it('middleware links every trace of the request (Express/Connect style) over real HTTP', async () => {
    on();
    const answer = trace('answer', async (q: string) => {
      await step('llm', async () => 'hi', { kind: 'llm' });
      return `${q}!`;
    });
    const mw = middleware();
    const server = createServer((req, res) =>
      mw(req as any, res, async () => {
        const out = await answer('ping');
        res.end(JSON.stringify({ out, runId: currentTrace().runId }));
      }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const body: any = await fetch(url, { headers: KALIBRA_HEADERS }).then((r) => r.json());
    const plain: any = await fetch(url).then((r) => r.json());
    server.close();
    expect(body.out).toBe('ping!');
    await flush();
    const [linked, unlinked] = fake.traces();
    expect(linked).toMatchObject({ id: '0af7651916cd43dd8448eb211c80319c', runId: 'run_abc', resultId: 'res_123', metadata: { parentSpanId: 'b7ad6b7169203331', tools: 'replay' } });
    expect(unlinked.runId).toBeUndefined();
    expect(unlinked.id).not.toBe(linked.id);
    expect(plain.out).toBe('ping!');
  });

  it('fromRequest runs a handler linked (Next.js route style), and only the first trace takes the traceparent id', async () => {
    on();
    const a = trace('a', () => 1);
    const b = trace('b', () => 2);
    const req = new Request('http://x/api', { headers: KALIBRA_HEADERS });
    await fromRequest(req, async () => {
      a();
      b();
    });
    await flush();
    const [ta, tb] = fake.traces();
    expect(ta.id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(tb.id).not.toBe(ta.id);
    expect([ta.resultId, tb.resultId]).toEqual(['res_123', 'res_123']);
  });

  it('always keeps traces of eval rows, even when sampling would drop them', async () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', warnings: false, sampleRate: 0 });
    const fn = trace('rare', () => 'x');
    fn();
    await fromRequest({ 'x-kalibra-result': 'res_1' }, async () => fn());
    await flush();
    expect(fake.traces().map((t) => t.resultId)).toEqual(['res_1']);
  });
});

describe('tools', () => {
  const search = async (q: string) => ({ hits: [`${q}-1`, `${q}-2`], at: Math.random() });

  it('hashes arguments as canonical JSON (sorted keys, no spaces)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x', undefined], c: { z: 2, '10': 3, '2': 4 }, d: undefined })).toBe('{"a":[true,null,"x",null],"b":1,"c":{"10":3,"2":4,"z":2}}');
    expect(canonicalJson(['é', 1.5, 1e21, Infinity, 10n])).toBe('["é",1.5,1e+21,null,"10"]');
    expect(argsHash({ order: 'A12' })).toBe(createHash('sha256').update('{"order":"A12"}').digest('hex'));
    expect(argsHash({ b: 2, a: 1 })).toBe(argsHash({ a: 1, b: 2 }));
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });

  it('live: runs the real function, sync stays sync, and records a tool span', async () => {
    on();
    const add = tool('add', (a: number, b: number) => a + b);
    await trace.run('agent', async () => {
      expect(add(2, 3)).toBe(5);
    });
    await flush();
    expect(fake.traces()[0].spans).toEqual([expect.objectContaining({ name: 'add', kind: 'tool', input: [2, 3], output: 5, attributes: { tool: 'add', mode: 'live' } })]);
  });

  it('record then replay returns the recorded result without calling the tool', async () => {
    on();
    let calls = 0;
    const tracked = tool('search_orders', async (q: string) => (calls++, search(q)));
    process.env.KALIBRA_TOOLS = 'record';
    const recorded = await tracked('refund');
    await flush(); // recordings are sent in the background
    expect(calls).toBe(1);
    expect(fake.recordings.size).toBe(1);
    const [rec] = [...fake.recordings.values()];
    expect(rec.args).toBe('refund');

    process.env.KALIBRA_TOOLS = 'replay';
    expect(await tracked('refund')).toEqual(recorded);
    expect(await tracked('refund')).toEqual(recorded); // second time from the in-memory cache
    expect(calls).toBe(1);
    expect(fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/ingest/tools'))).toHaveLength(1);

    // No recording for other arguments: replay calls for real, replay-strict fails.
    await tracked('other');
    expect(calls).toBe(2);
    process.env.KALIBRA_TOOLS = 'replay-strict';
    await expect(tracked('third')).rejects.toThrow(/No recording of search_orders/);
    expect(calls).toBe(2);
  });

  it('replays recorded errors as errors', async () => {
    on();
    const failing = tool('charge', async (_id: string) => {
      throw new Error('card declined');
    });
    process.env.KALIBRA_TOOLS = 'record';
    await expect(failing('c1')).rejects.toThrow('card declined');
    await flush();
    process.env.KALIBRA_TOOLS = 'replay-strict';
    await expect(failing('c1')).rejects.toThrow('Error: card declined');
  });

  it('fault modes fail on purpose without calling the tool', async () => {
    on();
    let calls = 0;
    const t = tool('send_email', async () => (calls++, 'sent'));
    process.env.KALIBRA_TOOLS = 'fault:timeout';
    await expect(t()).rejects.toMatchObject({ name: 'TimeoutError' });
    process.env.KALIBRA_TOOLS = 'fault:error';
    await expect(t()).rejects.toMatchObject({ name: 'ToolError' });
    process.env.KALIBRA_TOOLS = 'fault:empty';
    expect(await t()).toBeNull();
    expect(calls).toBe(0);
  });

  it('takes the mode from the request Kalibra made over the environment', async () => {
    on();
    process.env.KALIBRA_TOOLS = 'fault:error';
    const t = tool('lookup', async () => 'real');
    await expect(fromRequest({ 'x-kalibra-tools': 'live' }, () => t())).resolves.toBe('real');
    await expect(t()).rejects.toThrow(/simulated/);
  });

  it('keeps working (calls for real) when Kalibra is unreachable in replay mode', async () => {
    init({ url: 'http://127.0.0.1:9', key: 'kik_x', warnings: false });
    process.env.KALIBRA_TOOLS = 'replay';
    const t = tool('lookup', async (x: string) => `real ${x}`);
    expect(await t('a')).toBe('real a');
    process.env.KALIBRA_TOOLS = 'replay-strict';
    await expect(t('a')).rejects.toThrow(/No recording/);
  });

  it('is the kalibra.tool method too', () => {
    expect(kalibra.tool).toBe(tool);
  });
});
