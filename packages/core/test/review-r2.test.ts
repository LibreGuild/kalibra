import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { executeTarget, parseCurl, type TargetCallContext } from '../src/targets/index.js';
import { TargetSpec, type ConversationSettings } from '../src/specs.js';
import { normalizeText } from '../src/metrics/normalize.js';
import { align, MAX_ALIGN_CELLS } from '../src/metrics/align.js';
import { runConversation } from '../src/runner/conversation.js';
import { callTarget } from '../src/runner/runner.js';
import type { LlmClient } from '../src/providers/types.js';
import type { TargetCallResult } from '../src/targets/types.js';

/* Regression tests for the code review of targets, runner, metrics and audio. */

let engine: Engine;
let dir: string;

async function runAndWait(input: Record<string, unknown>) {
  const run = await engine.call<any>('start_run', input);
  await engine.runner.wait(run.id, 20);
  const done = await engine.call<any>('get_run', { runId: run.id });
  const { results } = await engine.call<any>('query_results', { runId: run.id, limit: 100 });
  const full = await Promise.all(results.map((r: any) => engine.call<any>('get_result', { resultId: r.id })));
  return { run: done, results: full };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kalibra-r2-'));
  engine = new Engine({ dir });
  await engine.call('create_dataset', { name: 'Qs', columns: [{ key: 'q' }] });
  await engine.call('add_dataset_rows', { dataset: 'Qs', rows: [{ data: { q: 'good' } }, { data: { q: 'bad' } }] });
  await engine.call('create_suite', { name: 'Lenient', spec: { checks: [{ id: 'any', type: 'expression', config: { expression: 'true' } }] } });
});

afterAll(() => {
  engine?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runner', () => {
  it('records each target log line once, in runs and in test_target', async () => {
    await engine.call('create_target', { name: 'Logs once', spec: { config: { kind: 'script', code: 'log("info", "hello " + row.q); return "ok";' } } });
    const { results } = await runAndWait({ dataset: 'Qs', target: 'Logs once', suite: 'Lenient', settings: { retries: 0 } });
    for (const r of results) expect(r.logs.filter((l: any) => l.message.startsWith('hello')).length).toBe(1);
    const t = await engine.call<any>('test_target', { target: 'Logs once', values: { q: 'x' } });
    expect(t.logs.filter((l: any) => l.message === 'hello x').length).toBe(1);
  });

  it('never counts a row whose call failed as passed', async () => {
    await engine.call('create_target', { name: 'Always throws', spec: { config: { kind: 'script', code: 'throw new Error("backend down");' } } });
    const { run, results } = await runAndWait({ dataset: 'Qs', target: 'Always throws', suite: 'Lenient', settings: { retries: 0 } });
    expect(results.every((r: any) => r.status === 'error' && r.passed === false)).toBe(true);
    expect(run.summary.passRate).toBe(0);
  });

  it('keeps the run going when one row throws unexpectedly', async () => {
    // A BigInt output can't be stored as JSON: that row errors, the other row and the run complete.
    await engine.call('create_target', { name: 'BigInt on bad', spec: { config: { kind: 'script', code: 'return { output: row.q === "bad" ? 10n : "fine" };' } } });
    const { run, results } = await runAndWait({ dataset: 'Qs', target: 'BigInt on bad', suite: 'Lenient', settings: { retries: 0, concurrency: 1 } });
    expect(run.status).toBe('completed');
    const bad = results.find((r: any) => r.input.q === 'bad');
    const good = results.find((r: any) => r.input.q === 'good');
    expect(bad.status).toBe('error');
    expect(bad.passed).toBe(false);
    expect(bad.error).toMatch(/Unexpected error: .*BigInt/);
    expect(good.status).toBe('done');
    expect(good.outputs.output).toBe('fine');
  });

  it('does not call the app again when cancelled during a retry wait', async () => {
    // The script counts its calls in `vars` (shared by reference) and always times out, so it is retryable.
    const spec = TargetSpec.parse({ config: { kind: 'script', timeoutMs: 20, code: 'vars.calls = String(Number(vars.calls || 0) + 1); await new Promise((r) => setTimeout(r, 200)); return "late";' } });
    const vars: Record<string, string> = {};
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const { result, attempts } = await callTarget(engine, spec, { row: {}, rowId: 'r', vars, retries: 3, signal: ac.signal, log: () => {} });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(vars.calls).toBe('1');
  });
});

describe('engine shutdown during a run', () => {
  it('stops quietly and leaves the run resumable', async () => {
    const own = mkdtempSync(join(tmpdir(), 'kalibra-r2-close-'));
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      let e1 = new Engine({ dir: own });
      await e1.call('create_dataset', { name: 'D', columns: [{ key: 'q' }] });
      await e1.call('add_dataset_rows', { dataset: 'D', rows: [1, 2, 3, 4].map((n) => ({ data: { q: String(n) } })) });
      await e1.call('create_target', { name: 'Slow', spec: { config: { kind: 'script', code: 'await new Promise((r) => setTimeout(r, 150)); return "ok";' } } });
      await e1.call('create_suite', { name: 'S', spec: { checks: [] } });
      const run = await e1.call<any>('start_run', { dataset: 'D', target: 'Slow', suite: 'S', settings: { concurrency: 1, retries: 0 } });
      await new Promise((r) => setTimeout(r, 200)); // first row done, second in flight
      e1.close();
      await new Promise((r) => setTimeout(r, 400)); // let the in-flight row and the run loop wind down
      expect(rejections).toEqual([]);

      e1 = new Engine({ dir: own });
      expect((await e1.call<any>('get_run', { runId: run.id })).status).toBe('interrupted');
      await e1.call('resume_run', { runId: run.id });
      const done = await e1.runner.wait(run.id, 20);
      expect(done.status).toBe('completed');
      expect(done.summary.completed).toBe(4);
      e1.close();
    } finally {
      process.off('unhandledRejection', onRejection);
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('conversations', () => {
  const settings = (extra: Partial<ConversationSettings> = {}) =>
    ({ mode: 'scripted', turnsColumn: 'turns', personaTemplate: '{{persona}}', goalTemplate: '{{goal}}', connectionId: '', model: '', maxTurns: 6, stopPhrase: '', ...extra }) as ConversationSettings;
  const reply = (output: string): TargetCallResult => ({ ok: true, outputs: { output }, metrics: { latency_ms: 5 }, logs: [] });
  const deps = (call: (n: number) => { result: TargetCallResult; attempts: number }, llm: Partial<LlmClient> = {}) => {
    let n = 0;
    return { call: async () => call(n++), llm: llm as LlmClient, env: {}, signal: new AbortController().signal, log: () => {} };
  };

  it('counts attempts like a single call: 1 plus retries, not one per turn', async () => {
    const three = await runConversation(settings(), { turns: ['a', 'b', 'c'] }, deps(() => ({ result: reply('ok'), attempts: 1 })));
    expect(three.result.outputs.turns).toBe(3);
    expect(three.attempts).toBe(1);
    const retried = await runConversation(settings(), { turns: ['a', 'b'] }, deps((n) => ({ result: reply('ok'), attempts: n === 0 ? 3 : 1 })));
    expect(retried.attempts).toBe(3);
  });

  it('turns a failing simulated-user model into a row error instead of throwing', async () => {
    const llm = { json: async () => { throw new Error('429 rate limited'); } };
    const res = await runConversation(settings({ mode: 'simulated', connectionId: 'c' }), { persona: 'p', goal: 'g' }, deps(() => ({ result: reply('ok'), attempts: 1 }), llm));
    expect(res.result.ok).toBe(false);
    expect(res.result.error).toMatch(/Simulated user \(turn 1\): 429 rate limited/);
    expect(res.result.outputs.stop_reason).toBe('error');
    expect(res.attempts).toBe(0);
  });
});

describe('websocket targets', () => {
  let wss: WebSocketServer;
  let url: string;
  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    wss.on('connection', (ws, req) => {
      if (req.url?.startsWith('/hello-then-close')) {
        ws.send('hello');
        setTimeout(() => ws.close(1000), 20);
      } else if (req.url?.startsWith('/greet')) {
        ws.send(JSON.stringify({ type: 'ready' })); // in the same packet as the handshake
        ws.on('message', () => ws.send(JSON.stringify({ text: 'done', is_final: true })));
      } else ws.on('message', () => ws.close(1000));
    });
  });
  afterAll(() => new Promise<void>((r) => wss.close(() => r())));

  const ctx = (): TargetCallContext => ({
    row: {},
    rowId: 'r',
    vars: {},
    env: { secret: async (n) => (n === 'key' ? 'sk-super-secret' : undefined) },
    blobs: {} as any,
    llm: {} as any,
    signal: new AbortController().signal,
    workspaceDir: process.cwd(),
  });

  it('ends a session script promptly when the server closes the socket', async () => {
    const code = 'const got = []; for (;;) { const m = await nextMessage(5000); if (m === undefined) break; got.push(m); } return { output: got.join(",") };';
    const spec = TargetSpec.parse({ config: { kind: 'websocket', url: `${url}/hello-then-close`, incoming: { format: 'text' }, scripts: { session: code } } });
    const res = await executeTarget(spec, ctx());
    expect(res.outputs.output).toBe('hello');
    expect(res.metrics.latency_ms).toBeLessThan(2000);
  });

  it('keeps a greeting sent right after the handshake (waitForOpenAck sees it)', async () => {
    const spec = TargetSpec.parse({
      config: {
        kind: 'websocket',
        url: `${url}/greet`,
        connectTimeoutMs: 1000,
        waitForOpenAck: 'msg.type === "ready"',
        afterAudio: [{ type: 'json', content: '{"type": "go"}' }],
        incoming: { textPath: '$.text', isFinal: 'msg.is_final === true' },
      },
    });
    const res = await executeTarget(spec, ctx());
    expect(res.error).toBeUndefined();
    expect(res.outputs.output).toBe('done');
    expect((res.response?.messages ?? []).find((m) => m.dir === 'in')?.data).toEqual({ type: 'ready' });
  });

  it('masks secrets in log lines', async () => {
    const spec = TargetSpec.parse({
      config: { kind: 'websocket', url, onOpen: [{ type: 'json', content: 'not json {{secret.key}}' }], incoming: { doneWhen: 'close' } },
    });
    const res = await executeTarget(spec, ctx());
    const logs = JSON.stringify(res.logs);
    expect(logs).toMatch(/not valid JSON/);
    expect(logs).not.toContain('sk-super-secret');
    expect(JSON.stringify(res.response)).not.toContain('sk-super-secret');
  });
});

describe('metrics', () => {
  it('english normalizer leaves words that are Object.prototype keys alone', () => {
    expect(normalizeText('The constructor said valueOf twenty five', 'english')).toBe('the constructor said valueof 25');
    expect(normalizeText('my favourite colour', 'english')).toBe('my favorite color');
  });

  it('refuses alignments too large to hold in memory', () => {
    const side = Math.ceil(Math.sqrt(MAX_ALIGN_CELLS)) + 1;
    const big = Array.from({ length: side }, (_, i) => `w${i}`);
    expect(() => align(big, big)).toThrow(/too long to align/);
    expect(align(['a', 'b'], ['a', 'c']).subs).toBe(1);
  });
});

describe('cURL import', () => {
  it('keeps "=" inside query, form and -G values', () => {
    const q = parseCurl(`curl 'https://api.example.com/x?token=abc==&sig=a=b'`);
    expect(q.query).toEqual([
      { key: 'token', value: 'abc==', enabled: true },
      { key: 'sig', value: 'a=b', enabled: true },
    ]);
    const f = parseCurl(`curl https://api.example.com/x -d 'cursor=eyJ9==&n=1'`);
    expect(f.body.type).toBe('form');
    expect(f.body.form.map((p) => [p.key, p.value])).toEqual([['cursor', 'eyJ9=='], ['n', '1']]);
    const g = parseCurl(`curl -G https://api.example.com/s --data-urlencode 'q=a&b=c'`);
    expect(g.query).toEqual([{ key: 'q', value: 'a&b=c', enabled: true }]);
  });
});
