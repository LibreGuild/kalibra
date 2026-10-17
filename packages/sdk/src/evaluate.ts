/*
 * Evals as code: run your own function over a Kalibra dataset and score the results with a Kalibra
 * suite, from vitest/jest/node scripts or CI. No API or server of yours needs to be running.
 *
 *   import { evaluate } from 'kalibra-sdk/eval';
 *   const run = await evaluate({ dataset: 'Support questions', suite: 'Chat checks', task: (row) => answer(row.question) });
 *   expect(run.passRate).toBeGreaterThan(0.9);
 *
 * Steps (docs/design/sdk-and-traces.md §3): start_code_run → your task per row (with concurrency,
 * timing latency_ms, catching errors) → submit_code_results in batches → finish_code_run, which
 * scores the run and compares it with a baseline (the latest run on your base branch).
 *
 * Auth: KALIBRA_TOKEN (an access token `kal_…` from Account → Access tokens) for a team server,
 * or nothing on your own computer: the running Kalibra app's address and launch token are read
 * from <KALIBRA_DIR or ~/Kalibra/default>/.engine.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { storage, current, type RunLink } from './context.js';
import { toJsonSafe, describeError } from './serialize.js';
import { flush, SDK_VERSION } from './tracer.js';
import type { ToolMode } from './tools.js';

export interface EvalRow {
  id: string;
  data: Record<string, unknown>;
}

/** What a task may return: the output itself, or an object with `output` (plus other fields and `metrics`). */
export type TaskResult = unknown;

export interface EvaluateOptions {
  /** Dataset id or name. */
  dataset: string;
  /** Suite id or name: the checks that score each output. */
  suite: string;
  /** Your code under test, called once per row. */
  task: (data: Record<string, any>, row: EvalRow) => TaskResult | Promise<TaskResult>;
  /** Run name shown in Kalibra. Default: "<dataset> · code". */
  name?: string;
  /** Project id or name (KALIBRA_PROJECT, default `default`). */
  project?: string;
  /** Kalibra address (KALIBRA_URL, or the running app on this computer). */
  url?: string;
  /** Access token `kal_…` (KALIBRA_TOKEN). Not needed for the app on this computer. */
  token?: string;
  /** Rows at a time. Default 4. */
  concurrency?: number;
  /** Only the first N rows. */
  limit?: number;
  /** Only rows with any of these tags. */
  tags?: string[];
  /** Fail a row whose task takes longer (it keeps running, but its result is not used). */
  timeoutMs?: number;
  /** Run id to compare with; default: the latest run on your base branch. */
  baseline?: string;
  /** Tools of your code during this run (see kalibra.tool). Default live. */
  tools?: ToolMode;
  /** Git details for the comparison; read from GITHUB_* variables when not given. */
  git?: { branch?: string; commit?: string; pr?: number; baseBranch?: string };
  /** Called after each row. */
  onResult?: (row: EvalRow, result: { outputs?: Record<string, unknown>; error?: string; latencyMs: number }) => void;
}

export interface EvaluateResult {
  runId: string;
  /** Share of rows that passed every check (0..1). */
  passRate: number | null;
  passed: number;
  failed: number;
  /** Rows that passed in the baseline and fail now. */
  newFailures: { rowId: string; reason?: string }[];
  /** Rows that failed in the baseline and pass now. */
  fixed: string[];
  baseline?: { runId: string; passRate: number | null; number?: number; name?: string };
  /** Open the run in Kalibra. */
  url: string;
  summary: any;
  run: any;
}

export class KalibraEvalError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'KalibraEvalError';
  }
}

const SUBMIT_BATCH = 50;

/** Address and token to use: explicit, environment, or the Kalibra app running on this computer. */
export function resolveConnection(opts: { url?: string; token?: string; project?: string }) {
  const env = process.env;
  let url = opts.url ?? env.KALIBRA_URL;
  let token = opts.token ?? env.KALIBRA_TOKEN;
  if (!token) {
    const dir = env.KALIBRA_DIR ?? join(homedir(), 'Kalibra', 'default');
    const file = join(dir, '.engine.json');
    if (existsSync(file)) {
      try {
        const info = JSON.parse(readFileSync(file, 'utf8'));
        if (!url || url.replace(/\/+$/, '') === String(info.url).replace(/\/+$/, '')) {
          url = info.url;
          token = info.token;
        }
      } catch {
        /* fall through to the error below */
      }
    }
  }
  if (!url) throw new KalibraEvalError('Set KALIBRA_URL (and KALIBRA_TOKEN for a team server), or open the Kalibra app on this computer.');
  return { url: url.replace(/\/+$/, ''), token, project: opts.project ?? env.KALIBRA_PROJECT ?? 'default' };
}

function gitFromEnv(): EvaluateOptions['git'] {
  const env = process.env;
  if (!env.GITHUB_ACTIONS) return undefined;
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
  return {
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
    commit: env.GITHUB_SHA,
    ...(pr ? { pr: Number(pr) } : {}),
    ...(env.GITHUB_BASE_REF ? { baseBranch: env.GITHUB_BASE_REF } : {}),
  };
}

/** Splits a task's return value into outputs and metrics. */
export function toOutputs(result: TaskResult): { outputs: Record<string, unknown>; metrics: Record<string, number> } {
  if (result && typeof result === 'object' && !Array.isArray(result) && 'output' in (result as object)) {
    const { metrics, ...rest } = result as Record<string, unknown>;
    const m: Record<string, number> = {};
    if (metrics && typeof metrics === 'object') for (const [k, v] of Object.entries(metrics)) if (typeof v === 'number' && Number.isFinite(v)) m[k] = v;
    return { outputs: toJsonSafe(rest) as Record<string, unknown>, metrics: m };
  }
  return { outputs: { output: toJsonSafe(result) }, metrics: {} };
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const conn = resolveConnection(options);
  const call = async <T = any>(op: string, input: unknown): Promise<T> => {
    const res = await fetch(`${conn.url}/api/projects/${encodeURIComponent(conn.project)}/ops/${op}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kalibra-actor': JSON.stringify({ kind: 'cli', id: 'kalibra-sdk', client: `kalibra-sdk/${SDK_VERSION}` }),
        ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
      },
      body: JSON.stringify(input),
    }).catch((e) => {
      throw new KalibraEvalError(`Could not reach Kalibra at ${conn.url}: ${e?.message ?? e}`);
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new KalibraEvalError(body?.error?.message ?? `Kalibra answered HTTP ${res.status} to ${op}`, body?.error?.code);
    return body.data as T;
  };

  const git = options.git ?? gitFromEnv();
  const started = await call<{ runId: string; rows: EvalRow[] }>('start_code_run', {
    dataset: options.dataset,
    suite: options.suite,
    ...(options.name ? { name: options.name } : {}),
    ...(git ? { git } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.tags?.length ? { tags: options.tags } : {}),
  });
  const { runId, rows } = started;

  let batch: any[] = [];
  let sending = Promise.resolve();
  // Batches go out one after another while rows keep running; a failure surfaces at the end.
  // Kalibra links a row to its trace when the results arrive, so the traces go first.
  const send = (results: any[]) => {
    sending = sending.then(() => flush()).then(() => call('submit_code_results', { runId, results }).then(() => undefined));
    sending.catch(() => {});
  };

  const runRow = async (row: EvalRow) => {
    // Traces your task produces are linked to this row.
    const link: RunLink = { runId, rowId: row.id, ...(options.tools ? { tools: options.tools } : {}) };
    const t0 = performance.now();
    let outputs: Record<string, unknown> | undefined;
    let metrics: Record<string, number> = {};
    let error: string | undefined;
    try {
      const work = storage.run({ ...current(), trace: undefined, span: undefined, unsampled: undefined, link }, () => Promise.resolve(options.task(row.data, row)));
      const result = options.timeoutMs ? await withTimeout(work, options.timeoutMs) : await work;
      ({ outputs, metrics } = toOutputs(result));
    } catch (e) {
      error = describeError(e);
    }
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    options.onResult?.(row, { outputs, error, latencyMs });
    batch.push({ rowId: row.id, ...(outputs ? { outputs } : {}), metrics: { latency_ms: latencyMs, ...metrics }, ...(error ? { error } : {}), ...(link.traceIds?.[0] ? { traceId: link.traceIds[0] } : {}) });
    if (batch.length >= SUBMIT_BATCH) {
      const full = batch;
      batch = [];
      void send(full);
    }
  };

  const queue = [...rows];
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 64, queue.length || 1)) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) await runRow(row);
  });
  await Promise.all(workers);
  if (batch.length) void send(batch);
  await sending;

  const done = await call<any>('finish_code_run', { runId, ...(options.baseline ? { baselineRunId: options.baseline } : {}) });
  const summary = done?.summary ?? done?.run?.summary ?? {};
  return {
    runId,
    passRate: summary.passRate ?? null,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    newFailures: done?.newFailures ?? [],
    fixed: done?.fixed ?? [],
    // The server names the baseline run `id`; results expose it as `runId` like the run itself.
    ...(done?.baseline ? { baseline: { runId: done.baseline.id ?? done.baseline.runId, passRate: done.baseline.passRate ?? null, number: done.baseline.number, name: done.baseline.name } } : {}),
    url: `${conn.url}/p/${encodeURIComponent(done?.run?.projectId ?? conn.project)}/runs/${runId}`,
    summary,
    run: done?.run,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
