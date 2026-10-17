import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { normalizeBatch, INGEST_LIMITS } from '../src/traces/ingest.js';
import { otlpToTraces } from '../src/traces/otlp.js';
import { checkScope, toSources, toToolCalls } from '../src/traces/scope.js';
import { argsHash, canonicalJson } from '../src/traces/hash.js';
import { traceFromProxy } from '../src/traces/proxy.js';

const dirs: string[] = [];
const engines: Engine[] = [];
function engine() {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-traces-'));
  dirs.push(dir);
  const e = new Engine({ dir });
  engines.push(e);
  return e;
}
afterEach(() => {
  engines.splice(0).forEach((e) => e.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const sample = (over: Record<string, unknown> = {}) => ({
  id: 'trace-1',
  name: 'answer_question',
  startedAt: '2026-10-17T10:00:00.000Z',
  durationMs: 120,
  input: { question: 'How do I reset my password?' },
  output: 'Go to Settings',
  metadata: { environment: 'dev', user: 'u1' },
  spans: [
    { id: 's1', name: 'retrieve', kind: 'retrieval', startedAt: '2026-10-17T10:00:00.010Z', durationMs: 20, output: [{ id: 'kb-1', text: 'Reset in Settings' }] },
    { id: 's2', name: 'search_orders', kind: 'tool', startedAt: '2026-10-17T10:00:00.040Z', input: { user: 'u1' }, output: [] },
    { id: 's3', parentId: 's1', name: 'llm', kind: 'llm', startedAt: '2026-10-17T10:00:00.050Z', attributes: { model: 'gpt-x', tokens_in: 10 } },
  ],
  ...over,
});

describe('ingest validation', () => {
  it('normalizes traces and rejects bad ones one by one', () => {
    const { traces, rejected } = normalizeBatch({
      traces: [sample(), { name: '' }, { name: 'ok', spans: 'nope' }, { name: 'weird kind', startedAt: 1792223768471, spans: [{ name: 'x', kind: 'banana' }] }, { name: 'bad id', id: 'has spaces' }],
    });
    expect(traces.map((t) => t.name)).toEqual(['answer_question', 'weird kind']);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 4]);
    expect(rejected[0].error).toMatch(/name is required/);
    const weird = traces[1];
    expect(weird.id).toMatch(/^[0-9a-f]{32}$/);
    expect(weird.startedAt).toBe(new Date(1792223768471).toISOString());
    expect(weird.spans[0].kind).toBe('step');
  });

  it('enforces request limits and truncates huge values', () => {
    expect(() => normalizeBatch({ traces: Array.from({ length: INGEST_LIMITS.tracesPerRequest + 1 }, () => ({ name: 'x' })) })).toThrow(/At most 1000 traces/);
    expect(() => normalizeBatch({ traces: [{ name: 'x', spans: Array.from({ length: INGEST_LIMITS.spansPerRequest + 1 }, () => ({ name: 's' })) }] })).toThrow(/spans per request/);
    expect(() => normalizeBatch({ nope: [] })).toThrow(/traces/);
    const [t] = normalizeBatch({ traces: [{ name: 'big', input: 'x'.repeat(200_000) }] }).traces;
    expect(typeof t.input).toBe('string');
    expect((t.input as string).length).toBeLessThan(70_000);
    expect(t.input).toMatch(/truncated/);
  });
});

describe('trace store', () => {
  it('writes in batches, lists with filters and returns spans in order', async () => {
    const e = engine();
    const r = e.traces.ingestBody({ traces: [sample(), sample({ id: 'trace-2', name: 'other', status: 'error', error: 'boom', metadata: { environment: 'prod' } })] });
    expect(r).toEqual({ accepted: 2, rejected: [] });
    // Queued, then written by the timer (or on read).
    const list = await e.call('list_traces', {});
    expect(list.total).toBe(2);
    expect(list.traces[0]).toMatchObject({ spanCount: expect.any(Number), inputPreview: expect.any(String) });
    expect((await e.call('list_traces', { status: 'error' })).traces.map((t: any) => t.id)).toEqual(['trace-2']);
    expect((await e.call('list_traces', { metadata: { environment: 'dev' } })).traces.map((t: any) => t.id)).toEqual(['trace-1']);
    expect((await e.call('list_traces', { search: 'boom' })).traces.map((t: any) => t.id)).toEqual(['trace-2']);
    const full = await e.call('get_trace', { id: 'trace-1' });
    expect(full.spans.map((s: any) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(full.spans[2]).toMatchObject({ parentId: 's1', attributes: { model: 'gpt-x' } });
    // Sending the same trace again (an SDK retry) replaces it rather than duplicating spans.
    e.traces.ingestBody({ traces: [sample({ spans: [{ id: 's1', name: 'only', kind: 'step' }] })] });
    expect((await e.call('get_trace', { id: 'trace-1' })).spans.length).toBe(1);
    expect((await e.call('delete_traces', { ids: ['trace-1'] })).deleted).toBe(1);
    await expect(e.call('delete_traces', {})).rejects.toThrow(/all: true/);
    expect((await e.call('delete_traces', { all: true, status: 'error' })).deleted).toBe(1);
  });

  it('turns traces into dataset rows', async () => {
    const e = engine();
    await e.call('create_dataset', { name: 'Real questions', columns: [{ key: 'question' }, { key: 'answer' }, { key: 'meta', type: 'json' }] });
    e.traces.ingestBody({ traces: [sample(), sample({ id: 'trace-2', input: { question: 'Can I pay by card?' } })] });
    const res = await e.call('traces_to_dataset', { traceIds: ['trace-1', 'trace-2', 'gone'], dataset: 'Real questions', mapping: { question: 'input.question', answer: 'output', meta: 'metadata' } });
    expect(res.added.length).toBe(2);
    expect(res.missing).toEqual(['gone']);
    const rows = await e.call('list_rows', { dataset: 'Real questions' });
    expect(rows.rows[0].data).toMatchObject({ question: 'How do I reset my password?', answer: 'Go to Settings', meta: { environment: 'dev' } });
    expect(rows.rows[0].status).toBe('needs_review');
    await expect(e.call('traces_to_dataset', { traceIds: ['trace-1'], dataset: 'Real questions', mapping: { nope: 'input' } })).rejects.toThrow(/no column "nope"/);
    await expect(e.call('traces_to_dataset', { traceIds: ['trace-1'], dataset: 'Real questions', mapping: { question: 'secret.x' } })).rejects.toThrow(/Unknown trace field/);
  });

  it('prunes old traces but keeps the ones that belong to runs', async () => {
    const e = engine();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    e.traces.ingestBody({ traces: [sample({ id: 'old', startedAt: old }), sample({ id: 'old-run', startedAt: old, runId: 'run_1', resultId: 'res_1' }), sample({ id: 'new', startedAt: new Date().toISOString() })] });
    e.traces.flush();
    expect(e.traces.prune()).toBe(1);
    expect((await e.call('list_traces', {})).traces.map((t: any) => t.id).sort()).toEqual(['new', 'old-run']);
    await expect(e.call('set_trace_settings', { retentionDays: 0 })).rejects.toThrow();
    await expect(e.call('set_trace_settings', { proxyOpenaiUpstream: 'http://example.com' })).rejects.toThrow(/https/);
    const s = await e.call('set_trace_settings', { retentionDays: 7, proxyOpenaiUpstream: 'https://llm.internal.example/v1/' });
    expect(s).toEqual({ retentionDays: 7, proxyOpenaiUpstream: 'https://llm.internal.example/v1' });
    expect(await e.call('get_trace_settings', {})).toMatchObject({ retentionDays: 7, traces: 2, spans: 6 });
  });

  it('refuses new writes when the queue is full instead of growing without bound', () => {
    const e = engine();
    const batch = { traces: Array.from({ length: 1000 }, (_, i) => ({ name: `t${i}` })) };
    // Hold the timer back: enqueue 20 batches synchronously (the limit is 20 000 queued traces).
    for (let i = 0; i < 20; i++) e.traces.ingestBody(batch);
    expect(() => e.traces.ingestBody(batch)).toThrow(/busy/);
    e.traces.flush();
    expect(e.traces.pending()).toBe(0);
  });
});

describe('OpenTelemetry mapping', () => {
  const ns = (ms: number) => String(BigInt(Date.parse('2026-10-17T10:00:00.000Z') + ms) * 1000000n);
  const kv = (key: string, v: string | number | boolean) => ({ key, value: typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { boolValue: v } });
  const traceId = 'a'.repeat(32);
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', 'support-bot'), kv('deployment.environment.name', 'staging'), kv('service.version', '1.4.2')] },
        scopeSpans: [
          {
            scope: { name: 'opentelemetry.instrumentation.openai' },
            spans: [
              { traceId, spanId: '1111111111111111', name: 'invoke_agent support', startTimeUnixNano: ns(0), endTimeUnixNano: ns(900), attributes: [kv('gen_ai.operation.name', 'invoke_agent'), kv('input.value', 'Refund order A12')] },
              {
                traceId, spanId: '2222222222222222', parentSpanId: '1111111111111111', name: 'chat gpt-4.1', startTimeUnixNano: ns(10), endTimeUnixNano: ns(400),
                attributes: [kv('gen_ai.operation.name', 'chat'), kv('gen_ai.request.model', 'gpt-4.1'), kv('gen_ai.usage.input_tokens', 120), kv('gen_ai.usage.output_tokens', 30), kv('gen_ai.input.messages', JSON.stringify([{ role: 'user', content: 'Refund order A12' }]))],
              },
              {
                traceId, spanId: '3333333333333333', parentSpanId: '1111111111111111', name: 'execute_tool refund_order', startTimeUnixNano: ns(410), endTimeUnixNano: ns(500),
                attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', 'refund_order'), kv('gen_ai.tool.call.arguments', '{"order_id":"A12"}'), kv('gen_ai.tool.call.result', '{"ok":true}')],
              },
              {
                traceId, spanId: '4444444444444444', parentSpanId: '1111111111111111', name: 'retrieve', startTimeUnixNano: ns(510), endTimeUnixNano: ns(600),
                attributes: [kv('openinference.span.kind', 'RETRIEVER'), kv('retrieval.documents.0.document.id', 'kb-1'), kv('retrieval.documents.0.document.content', 'Refunds within 30 days'), kv('retrieval.documents.0.document.score', 0.9)],
                status: { code: 2, message: 'slow index' },
              },
            ],
          },
        ],
      },
    ],
  };

  it('maps GenAI and OpenInference spans to kinds, inputs, outputs and attributes', () => {
    const [t] = otlpToTraces(body);
    expect(t).toMatchObject({ id: traceId, name: 'invoke_agent support', source: 'otel', partial: true, input: 'Refund order A12', metadata: { service: 'support-bot', environment: 'staging', release: '1.4.2' } });
    expect(t.durationMs).toBe(900);
    const byName = Object.fromEntries(t.spans.map((s) => [s.name, s]));
    expect(byName['invoke_agent support'].kind).toBe('agent');
    expect(byName['chat gpt-4.1']).toMatchObject({ kind: 'llm', parentId: '1111111111111111', attributes: { model: 'gpt-4.1', tokens_in: 120, tokens_out: 30 }, input: [{ role: 'user', content: 'Refund order A12' }] });
    expect(byName['execute_tool refund_order']).toMatchObject({ kind: 'tool', input: { order_id: 'A12' }, output: { ok: true }, attributes: { tool: 'refund_order' } });
    expect(byName.retrieve).toMatchObject({ kind: 'retrieval', output: [{ id: 'kb-1', text: 'Refunds within 30 days', score: 0.9 }], error: 'slow index' });
    // What checks see.
    const scope = checkScope({}, t.spans as any);
    expect(scope.tool_calls).toEqual([{ name: 'refund_order', args: { order_id: 'A12' }, output: { ok: true } }]);
    expect(scope.sources).toEqual([{ id: 'kb-1', text: 'Refunds within 30 days', score: 0.9 }]);
  });

  it('accepts base64 ids, merges a trace sent in pieces, and joins to eval rows', async () => {
    const e = engine();
    const { traceparent } = e.traces.joinIds('run_9', 'res_9');
    const runTrace = traceparent.split('-')[1];
    const piece = (spanId: string, parent?: string, name = 'step') => ({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: Buffer.from(runTrace, 'hex').toString('base64'), spanId, ...(parent ? { parentSpanId: parent } : {}), name, startTimeUnixNano: ns(0), endTimeUnixNano: ns(parent ? 50 : 100) }] }] }] });
    e.traces.enqueue(otlpToTraces(piece('5555555555555555', '6666666666666666', 'child')));
    e.traces.enqueue(otlpToTraces(piece('6666666666666666', undefined, 'root')));
    const got = await e.traces.waitForResult('res_9', 1000);
    expect(got.traceIds).toEqual([runTrace]);
    expect(got.steps.map((s) => s.name).sort()).toEqual(['child', 'root']);
    expect((await e.call('get_trace', { id: runTrace })).name).toBe('root');
    expect(() => otlpToTraces({})).toThrow(/resourceSpans/);
  });
});

describe('check scope from what apps return', () => {
  it('normalizes common document and tool-call shapes', () => {
    expect(toSources({ documents: [{ page_content: 'a', metadata: { source: 'doc.md' } }] })).toEqual([{ id: 'doc.md', text: 'a', metadata: { source: 'doc.md' } }]);
    expect(toSources(['plain', 'text']).map((s) => s.id)).toEqual(['1', '2']);
    expect(toToolCalls([{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])).toEqual([{ name: 'lookup', args: { q: 'x' } }]);
    expect(toToolCalls('[{"name":"a","input":{"k":1}}]')).toEqual([{ name: 'a', args: { k: 1 } }]);
    const scope = checkScope({ steps: [{ name: 'search', type: 'tool', args: { q: 1 }, result: 'r' }], sources: ['only this'] }, []);
    expect(scope.steps[0]).toMatchObject({ kind: 'tool', input: { q: 1 }, output: 'r' });
    expect(scope.tool_calls).toEqual([{ name: 'search', args: { q: 1 }, output: 'r' }]);
    expect(scope.sources).toEqual([{ id: '1', text: 'only this' }]);
  });
});

describe('tool recordings', () => {
  it('hash arguments canonically and round-trip', async () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: undefined }], n: 1.0 })).toBe('{"a":[true,null,{"d":"x"}],"b":1,"n":1}');
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }));
    expect(argsHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    const e = engine();
    e.traces.tools.upsert({ tool: 'search_orders', argsHash: argsHash({ user: 'u1' }), args: { user: 'u1' }, output: [{ id: 'A12' }], runId: 'run_1' });
    e.traces.tools.upsert({ tool: 'search_orders', argsHash: argsHash({ user: 'u1' }), args: { user: 'u1' }, output: [{ id: 'A13' }] });
    e.traces.tools.upsert({ tool: 'send_email', argsHash: argsHash({}), args: {}, error: 'smtp down' });
    expect(e.traces.tools.get('search_orders', argsHash({ user: 'u1' }))!.output).toEqual([{ id: 'A13' }]);
    const list = await e.call('list_tool_recordings', {});
    expect(list.total).toBe(2);
    expect(list.tools).toEqual([{ tool: 'search_orders', count: 1 }, { tool: 'send_email', count: 1 }]);
    await expect(e.call('delete_tool_recordings', {})).rejects.toThrow(/all: true/);
    expect((await e.call('delete_tool_recordings', { tool: 'send_email' })).deleted).toBe(1);
    expect((await e.call('delete_tool_recordings', { all: true })).deleted).toBe(1);
  });
});

describe('the OpenAI proxy recording', () => {
  it('records a chat completion with model, messages, answer and tokens', () => {
    const t = traceFromProxy({
      method: 'POST', path: '/v1/chat/completions', requestBody: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }], temperature: 0 },
      status: 200, contentType: 'application/json', responseText: JSON.stringify({ model: 'gpt-4.1-2026', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      startedAt: '2026-10-17T10:00:00.000Z', durationMs: 300, resultId: 'res_1',
    });
    expect(t).toMatchObject({ name: 'openai.chat.completions', source: 'proxy', status: 'ok', output: 'hello', resultId: 'res_1', input: [{ role: 'user', content: 'hi' }] });
    expect(t.spans[0]).toMatchObject({ kind: 'llm', name: 'gpt-4.1-2026', attributes: { model: 'gpt-4.1-2026', tokens_in: 5, tokens_out: 2, status: 200, streamed: false, temperature: 0 } });
  });

  it('records a streamed answer and an error', () => {
    const sse = ['data: {"model":"m","choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":1}}', 'data: [DONE]', ''].join('\n\n');
    const t = traceFromProxy({ method: 'POST', path: '/v1/chat/completions', requestBody: { model: 'm', stream: true }, status: 200, contentType: 'text/event-stream', responseText: sse, startedAt: new Date().toISOString(), durationMs: 10 });
    expect(t.output).toBe('Hello');
    expect(t.spans[0].attributes).toMatchObject({ streamed: true, tokens_in: 3, tokens_out: 1 });
    const err = traceFromProxy({ method: 'POST', path: '/v1/responses', requestBody: { model: 'm', input: 'x' }, status: 401, contentType: 'application/json', responseText: '{"error":{"message":"Incorrect API key"}}', startedAt: new Date().toISOString(), durationMs: 5 });
    expect(err).toMatchObject({ status: 'error', error: 'Incorrect API key', name: 'openai.responses' });
  });
});

describe('joining an app’s trace to eval rows', () => {
  let app: Server;
  afterEach(() => new Promise<void>((r) => (app ? app.close(() => r()) : r())));

  it('sends trace headers, waits for the app’s trace and gives checks its steps, sources and tool calls', async () => {
    const e = engine();
    const seen: Record<string, string | undefined>[] = [];
    // A tiny "app": answers, then reports what it did (like the SDK would) a little later.
    app = createServer((req, res) => {
      const h = { traceparent: req.headers.traceparent as string, run: req.headers['x-kalibra-run'] as string, result: req.headers['x-kalibra-result'] as string, tools: req.headers['x-kalibra-tools'] as string | undefined };
      seen.push(h);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: 'Refunded A12' }));
      setTimeout(() => {
        e.traces.ingestBody({
          traces: [
            {
              id: h.traceparent.split('-')[1], name: 'answer', runId: h.run, resultId: h.result,
              spans: [
                { id: 'r', name: 'search_kb', kind: 'retrieval', output: [{ id: 'kb-1', text: 'Refunds within 30 days' }] },
                { id: 't', name: 'refund_order', kind: 'tool', input: { order_id: 'A12' }, output: { ok: true } },
              ],
            },
          ],
        });
      }, 40);
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(app.address() as any).port}/chat`;

    await e.call('create_dataset', { name: 'Refunds', columns: [{ key: 'question' }, { key: 'order_id' }] });
    await e.call('add_dataset_rows', { dataset: 'Refunds', rows: [{ data: { question: 'Refund my order', order_id: 'A12' } }] });
    await e.call('create_target', { name: 'Agent', spec: { config: { kind: 'http', url, body: { type: 'json', content: '{"q": "{{question}}"}' }, outputs: [{ name: 'output', from: 'json', path: '$.answer' }] } } });
    await e.call('create_suite', { name: 'Agent checks', spec: { checks: [{ id: 'refund', type: 'tool_called', config: { name: 'refund_order', args: '{"order_id": "{{order_id}}"}' } }] } });
    const run = await e.call('start_run', { dataset: 'Refunds', target: 'Agent', suite: 'Agent checks', settings: { collectTraces: true, traceWaitMs: 2000, tools: 'replay' } });
    const done = await e.runner.wait(run.id);
    expect(done.status).toBe('completed');

    const [h] = seen;
    expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(h.run).toBe(run.id);
    expect(h.tools).toBe('replay');
    const { results } = await e.call('query_results', { runId: run.id });
    const result = await e.call('get_result', { resultId: results[0].id });
    expect(h.result).toBe(result.id);
    expect(result.steps.map((s: any) => s.name)).toEqual(['search_kb', 'refund_order']);
    expect(result.checks[0]).toMatchObject({ id: 'refund', status: 'pass' });
    expect(result.passed).toBe(true);
    // The trace itself is listed with its run, and kept by retention.
    expect((await e.call('list_traces', { runId: run.id })).total).toBe(1);
  });

  it('sends no headers when the target turns trace headers off, and does not wait', async () => {
    const e = engine();
    let headers: Record<string, unknown> = {};
    app = createServer((req, res) => {
      headers = req.headers;
      res.end('ok');
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    await e.call('create_dataset', { name: 'D', columns: [{ key: 'q' }] });
    await e.call('add_dataset_rows', { dataset: 'D', rows: [{ data: { q: 'x' } }] });
    await e.call('create_target', { name: 'Quiet', spec: { traces: { send: false }, config: { kind: 'http', url: `http://127.0.0.1:${(app.address() as any).port}/` } } });
    await e.call('create_suite', { name: 'S', spec: { checks: [] } });
    const started = Date.now();
    const run = await e.call('start_run', { dataset: 'D', target: 'Quiet', suite: 'S', settings: { collectTraces: true, traceWaitMs: 5000 } });
    await e.runner.wait(run.id, 50);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(headers.traceparent).toBeUndefined();
    expect(headers['x-kalibra-result']).toBeUndefined();
  });
});
