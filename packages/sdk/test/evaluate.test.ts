import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { init, trace, step, tool, flush, shutdown } from '../src/index.js';
import { evaluate, KalibraEvalError, toOutputs } from '../src/eval.js';
import { resolveConnection } from '../src/evaluate.js';
import { fakeKalibra, type FakeKalibra } from './fake-kalibra.js';

let fake: FakeKalibra;
let submitted: any[];
let started: any;
let finished: any;

beforeAll(async () => {
  fake = await fakeKalibra();
});
afterAll(async () => {
  await shutdown();
  await fake.close();
});
beforeEach(() => {
  submitted = [];
  fake.ops.start_code_run = (input) => {
    started = input;
    if (input.dataset === 'missing') throw new Error('Dataset not found: missing');
    const n = input.limit ?? 120;
    return { runId: 'run_code_1', rows: Array.from({ length: n }, (_, i) => ({ id: `row_${i}`, data: { question: `q${i}`, n: i } })) };
  };
  fake.ops.submit_code_results = (input) => {
    expect(input.runId).toBe('run_code_1');
    submitted.push(input.results);
    return { accepted: input.results.length };
  };
  fake.ops.finish_code_run = (input) => {
    finished = input;
    const all = submitted.flat();
    const failed = all.filter((r) => r.error || r.outputs?.output === 'wrong').length;
    return {
      run: { id: 'run_code_1', projectId: 'prj_1', status: 'completed' },
      summary: { passRate: (all.length - failed) / all.length, passed: all.length - failed, failed },
      baseline: { runId: 'run_base', passRate: 1 },
      newFailures: [{ rowId: 'row_3', reason: 'contains: missing "block"' }],
      fixed: ['row_9'],
    };
  };
});
afterEach(async () => {
  await flush();
  fake.requests.length = 0;
});

const base = () => ({ url: fake.url, token: 'kal_token_for_tests', project: 'Support bot', dataset: 'Support questions', suite: 'Chat checks' });

describe('evaluate (evals as code)', () => {
  it('runs the task over every row, submits in batches, and returns the scored result', async () => {
    let inFlight = 0;
    let peak = 0;
    const run = await evaluate({
      ...base(),
      concurrency: 8,
      git: { branch: 'feature/x', commit: 'abc123', baseBranch: 'main' },
      task: async (row) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        if (row.n === 3) return 'wrong';
        if (row.n === 4) throw new Error('model timeout');
        if (row.n === 5) return { output: 'detailed', sources: ['kb-1'], metrics: { tokens: 42, bad: 'x' } };
        return `answer ${row.question}`;
      },
    });
    expect(started).toEqual({ dataset: 'Support questions', suite: 'Chat checks', git: { branch: 'feature/x', commit: 'abc123', baseBranch: 'main' } });
    const all = submitted.flat();
    expect(all).toHaveLength(120);
    expect(submitted.every((b) => b.length <= 50)).toBe(true);
    expect(new Set(all.map((r) => r.rowId)).size).toBe(120);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
    const byRow = Object.fromEntries(all.map((r) => [r.rowId, r]));
    expect(byRow.row_0.outputs).toEqual({ output: 'answer q0' });
    expect(byRow.row_4).toMatchObject({ error: 'Error: model timeout' });
    expect(byRow.row_4.outputs).toBeUndefined();
    expect(byRow.row_5.outputs).toEqual({ output: 'detailed', sources: ['kb-1'] });
    expect(byRow.row_5.metrics).toMatchObject({ tokens: 42 });
    expect(byRow.row_5.metrics.bad).toBeUndefined();
    for (const r of all) expect(r.metrics.latency_ms).toBeGreaterThanOrEqual(0);
    expect(run).toMatchObject({ runId: 'run_code_1', passed: 118, failed: 2, newFailures: [{ rowId: 'row_3' }], fixed: ['row_9'], baseline: { runId: 'run_base' } });
    expect(run.url).toBe(`${fake.url}/p/prj_1/runs/run_code_1`);
    const req = fake.requests.find((r) => r.path.endsWith('/ops/start_code_run'))!;
    expect(req.path).toBe('/api/projects/Support%20bot/ops/start_code_run');
    expect(req.headers.authorization).toBe('Bearer kal_token_for_tests');
    expect(JSON.parse(String(req.headers['x-kalibra-actor']))).toMatchObject({ kind: 'cli', id: 'kalibra-sdk' });
  });

  it('links traces the task produces to their rows and runs tools in the chosen mode', async () => {
    init({ url: fake.url, key: 'kik_test_key_123456789012345', project: 'Support bot', warnings: false, sampleRate: 0 });
    let toolCalls = 0;
    const lookup = tool('lookup', async () => (toolCalls++, 'real'));
    const answer = trace('answer', async (q: string) => {
      const ctx = await step('lookup', () => lookup(), { kind: 'tool' }).catch((e) => `fault: ${e.name}`);
      return `${q} → ${ctx}`;
    });
    await evaluate({ ...base(), limit: 3, tools: 'fault:timeout', baseline: 'run_explicit', task: (row) => answer(row.question) });
    const all = submitted.flat();
    expect(all.map((r) => r.outputs.output)).toEqual(['q0 → fault: TimeoutError', 'q1 → fault: TimeoutError', 'q2 → fault: TimeoutError']);
    expect(toolCalls).toBe(0);
    // Eval rows are always traced (sampling 0 notwithstanding) and their trace ids are submitted.
    const traces = fake.traces();
    expect(traces).toHaveLength(3);
    expect(new Set(all.map((r) => r.traceId))).toEqual(new Set(traces.map((t) => t.id)));
    expect(traces.every((t) => t.runId === 'run_code_1')).toBe(true);
    expect(finished).toEqual({ runId: 'run_code_1', baselineRunId: 'run_explicit' });
    init({ enabled: false });
  });

  it('fails rows that take too long, without stopping the run', async () => {
    const run = await evaluate({ ...base(), limit: 4, timeoutMs: 30, task: async (row) => (row.n === 1 ? new Promise(() => {}) : 'ok') });
    expect(submitted.flat().find((r) => r.rowId === 'row_1').error).toBe('Error: Timed out after 30 ms');
    expect(run.runId).toBe('run_code_1');
  });

  it('reports Kalibra errors clearly', async () => {
    await expect(evaluate({ ...base(), dataset: 'missing', task: () => 'x' })).rejects.toThrow(KalibraEvalError);
    await expect(evaluate({ ...base(), dataset: 'missing', task: () => 'x' })).rejects.toThrow('Dataset not found: missing');
    await expect(evaluate({ ...base(), url: 'http://127.0.0.1:9', task: () => 'x' })).rejects.toThrow(/Could not reach Kalibra/);
  });

  it('reads git details from GitHub Actions', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/pull/42/merge', GITHUB_HEAD_REF: 'feature/y', GITHUB_BASE_REF: 'main', GITHUB_SHA: 'deadbeef' });
    try {
      await evaluate({ ...base(), limit: 1, task: () => 'x' });
      expect(started.git).toEqual({ branch: 'feature/y', commit: 'deadbeef', pr: 42, baseBranch: 'main' });
    } finally {
      for (const k of ['GITHUB_ACTIONS', 'GITHUB_REF', 'GITHUB_HEAD_REF', 'GITHUB_BASE_REF', 'GITHUB_SHA']) if (!(k in saved)) delete process.env[k];
    }
  });
});

describe('connecting', () => {
  it('uses the Kalibra app running on this computer when no token is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-sdk-'));
    const saved = { ...process.env };
    try {
      writeFileSync(join(dir, '.engine.json'), JSON.stringify({ url: 'http://127.0.0.1:50123', token: 'launch-token', pid: process.pid }));
      process.env.KALIBRA_DIR = dir;
      delete process.env.KALIBRA_URL;
      delete process.env.KALIBRA_TOKEN;
      expect(resolveConnection({})).toEqual({ url: 'http://127.0.0.1:50123', token: 'launch-token', project: 'default' });
      // A different server in KALIBRA_URL does not get the local app's token.
      process.env.KALIBRA_URL = 'https://kalibra.example.com/';
      expect(resolveConnection({})).toEqual({ url: 'https://kalibra.example.com', token: undefined, project: 'default' });
      process.env.KALIBRA_TOKEN = 'kal_x';
      expect(resolveConnection({ project: 'P' })).toEqual({ url: 'https://kalibra.example.com', token: 'kal_x', project: 'P' });
      delete process.env.KALIBRA_URL;
      delete process.env.KALIBRA_TOKEN;
      process.env.KALIBRA_DIR = join(dir, 'nothing-here');
      expect(() => resolveConnection({})).toThrow(/KALIBRA_URL/);
    } finally {
      for (const k of ['KALIBRA_DIR', 'KALIBRA_URL', 'KALIBRA_TOKEN']) {
        if (k in saved) process.env[k] = saved[k];
        else delete process.env[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits task results into outputs and numeric metrics', () => {
    expect(toOutputs('plain')).toEqual({ outputs: { output: 'plain' }, metrics: {} });
    expect(toOutputs({ output: 'x', tool_calls: [], metrics: { cost: 0.01, n: NaN } })).toEqual({ outputs: { output: 'x', tool_calls: [] }, metrics: { cost: 0.01 } });
    expect(toOutputs({ answer: 'no output key' })).toEqual({ outputs: { output: { answer: 'no output key' } }, metrics: {} });
    expect(toOutputs(undefined)).toEqual({ outputs: { output: undefined }, metrics: {} });
  });
});
