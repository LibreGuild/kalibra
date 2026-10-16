import type { Engine } from '../engine.js';
import type { LogEntry } from '../script.js';
import { SuiteSpec, TargetSpec } from '../specs.js';
import { executeTarget } from '../targets/index.js';
import type { TargetCallResult } from '../targets/types.js';
import { sleep, truncate } from '../util.js';
import type { ResultRecord, RunRecord } from '../repo/runs.js';
import { evaluateChecks } from './evaluate.js';
import { summarize } from './summary.js';

const MAX_TEXT = 256 * 1024;

/**
 * Executes runs in-process: bounded concurrency, retries with backoff (honouring Retry-After),
 * per-row state saved as it goes so a crash or cancel can resume where it stopped.
 * Server mode can move this behind a durable queue with separate workers.
 */
export class Runner {
  private active = new Map<string, AbortController>();

  constructor(private engine: Engine) {}

  /** Runs left running by a crash or app quit become "interrupted" and can be resumed. */
  recover() {
    const { db } = this.engine;
    for (const r of db.all("SELECT id FROM runs WHERE status IN ('running','queued') AND deleted_at IS NULL")) {
      this.engine.repos.runs.resetRunning(r.id);
      this.engine.repos.runs.setStatus(r.id, 'interrupted');
    }
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  start(runId: string) {
    if (this.active.has(runId)) return;
    const ac = new AbortController();
    this.active.set(runId, ac);
    void this.execute(runId, ac.signal).finally(() => this.active.delete(runId));
  }

  cancel(runId: string) {
    this.active.get(runId)?.abort(new Error('Run cancelled'));
  }

  /** Waits until a run is no longer executing (used by the CLI and tests). */
  async wait(runId: string, pollMs = 200) {
    while (this.active.has(runId)) await sleep(pollMs);
    return this.engine.repos.runs.get(runId);
  }

  private emitProgress(runId: string) {
    const p = this.engine.repos.runs.progress(runId);
    this.engine.events.emit({ type: 'run.updated', runId, status: p.status, done: p.done, total: p.total });
  }

  private async execute(runId: string, signal: AbortSignal) {
    const { runs, defs } = this.engine.repos;
    const run = runs.get(runId);
    runs.setStatus(run.id, 'running');
    this.emitProgress(run.id);
    try {
      const suite = SuiteSpec.parse(defs.getVersion('suite', run.suiteId!, run.suiteVersion!).spec);
      const target = run.kind === 'live' ? TargetSpec.parse(defs.getVersion('target', run.targetId!, run.targetVersion!).spec) : null;
      const vars = target ? Object.fromEntries(target.variables.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value])) : {};
      const queue = runs.pending(run.id);
      let next = 0;
      let lastEmit = 0;
      let lastSummary = Date.now();

      const worker = async () => {
        while (!signal.aborted) {
          const item = queue[next++];
          if (!item) return;
          await this.processItem(run, item, target, suite, vars, signal);
          if (Date.now() - lastEmit > 200) {
            lastEmit = Date.now();
            this.emitProgress(run.id);
          }
          // Live summary so pass rates and latency fill in while the run is still going.
          if (Date.now() - lastSummary > 2000) {
            lastSummary = Date.now();
            runs.setSummary(run.id, summarize(runs.allLite(run.id), run.total || queue.length));
          }
          if (run.settings.delayMs) await sleep(run.settings.delayMs, signal).catch(() => {});
        }
      };
      const workers = Math.max(1, Math.min(run.settings.concurrency, queue.length));
      await Promise.all(Array.from({ length: workers }, worker));

      if (signal.aborted) runs.resetRunning(run.id);
      const summary = summarize(runs.allLite(run.id), runs.get(run.id).total);
      runs.setStatus(run.id, signal.aborted ? 'cancelled' : 'completed', { summary });
    } catch (e: any) {
      runs.resetRunning(run.id);
      const summary = summarize(runs.allLite(run.id), runs.get(run.id).total);
      runs.setStatus(run.id, 'failed', { error: e?.message ?? String(e), summary });
    }
    this.emitProgress(run.id);
  }

  private async processItem(run: RunRecord, item: ResultRecord, target: TargetSpec | null, suite: SuiteSpec, vars: Record<string, string>, signal: AbortSignal) {
    const { runs } = this.engine.repos;
    runs.markRunning(item.id);
    const logs: LogEntry[] = [];
    const log = (level: LogEntry['level'], message: string) => logs.push({ at: Date.now(), level, message });
    const env = this.engine.templateEnv();

    let call: TargetCallResult;
    let attempts = 0;
    if (target) {
      for (;;) {
        attempts++;
        call = await executeTarget(target, {
          row: item.input,
          rowId: item.rowId,
          vars,
          env,
          blobs: this.engine.blobs,
          llm: this.engine.llm,
          signal,
          log,
          workspaceDir: this.engine.dir,
        });
        if (!call.retryable || attempts > run.settings.retries || signal.aborted) break;
        const retryAfter = Number(call.response?.headers?.['retry-after']);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempts - 1) + Math.random() * 250;
        log('warn', `Attempt ${attempts} failed (${call.error ?? `HTTP ${call.response?.status}`}); retrying in ${Math.round(wait)} ms`);
        await sleep(Math.min(wait, 30000), signal).catch(() => {});
      }
    } else {
      call = { ok: !item.error, outputs: item.outputs ?? {}, metrics: item.metrics ?? {}, error: item.error ?? undefined, logs: [] };
    }
    if (signal.aborted) return; // left as "running"; reset to pending when the run stops

    const scope: Record<string, unknown> = {
      ...item.input,
      row: item.input,
      row_id: item.rowId,
      output: call.outputs.output,
      outputs: call.outputs,
      response: call.response ?? {},
      metrics: call.metrics,
      vars,
      error: call.error ?? '',
    };
    const evaluated = await evaluateChecks(suite, { scope, env, llm: this.engine.llm, log, workspaceDir: this.engine.dir, signal });

    runs.saveResult(run.id, item.id, {
      status: call.ok ? 'done' : 'error',
      passed: evaluated.passed,
      score: evaluated.score,
      request: call.request,
      response: trimResponse(call.response),
      outputs: call.outputs,
      checks: evaluated.checks,
      metrics: call.metrics,
      error: call.error ?? null,
      logs: [...call.logs, ...logs].slice(0, 500),
      attempts,
    });
    this.engine.events.emit({ type: 'result.updated', runId: run.id, resultId: item.id });
  }
}

function trimResponse(r: TargetCallResult['response']) {
  if (!r) return r;
  const out: any = { ...r };
  if (typeof out.text === 'string') out.text = truncate(out.text, MAX_TEXT);
  if (out.body !== undefined) {
    const s = JSON.stringify(out.body);
    if (s && s.length > MAX_TEXT) out.body = truncate(s, MAX_TEXT);
  }
  return out;
}
