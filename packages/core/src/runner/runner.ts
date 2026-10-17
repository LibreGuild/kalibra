import type { Engine } from '../engine.js';
import type { LogEntry } from '../script.js';
import { SuiteSpec, TargetSpec } from '../specs.js';
import { executeTarget } from '../targets/index.js';
import type { TargetCallResult } from '../targets/types.js';
import { sleep, truncate } from '../util.js';
import type { ResultRecord, RunRecord } from '../repo/runs.js';
import { evaluateChecks } from './evaluate.js';
import { applyOverrides } from './overrides.js';
import { runConversation } from './conversation.js';
import { summarize } from './summary.js';

const MAX_TEXT = 256 * 1024;
/** Steps kept per row (a runaway agent can produce thousands). */
const MAX_STEPS = 500;

/** How long a run's lease lasts, how often it is renewed, and how often orphaned runs are looked for. */
export interface LeaseTiming {
  leaseMs: number;
  renewMs: number;
  sweepMs: number;
}
export const DEFAULT_LEASE: LeaseTiming = { leaseMs: 45_000, renewMs: 15_000, sweepMs: 30_000 };

/** Why an execution stops early: a cancel, handing the run to another instance, or having lost it to one. */
type StopReason = 'cancel' | 'handoff' | 'lost';

/**
 * Executes runs in-process: bounded concurrency, retries with backoff (honouring Retry-After),
 * per-row state saved as it goes so a crash or cancel can resume where it stopped.
 *
 * Several instances (Redis coordinator): the instance executing a run holds a lease on it in the
 * database and renews it. When an instance stops (shutdown hands its runs back; a crash lets the
 * lease expire), another instance's sweep resumes the run from its last saved row. A cancel can be
 * asked on any instance: it is stored on the run and announced, and the executing instance stops.
 */
export class Runner {
  private active = new Map<string, AbortController>();
  private reasons = new Map<string, StopReason>();
  private executions = new Map<string, Promise<void>>();
  private sweeper?: ReturnType<typeof setInterval>;
  private readonly timing: LeaseTiming;

  constructor(
    private engine: Engine,
    timing: Partial<LeaseTiming> = {},
  ) {
    this.timing = { ...DEFAULT_LEASE, ...timing };
  }

  /** Whether runs are shared with other instances. */
  private get shared() {
    return this.engine.coordinator.kind !== 'local';
  }

  private get owner() {
    return this.engine.coordinator.instanceId;
  }

  private leaseUntil() {
    return new Date(Date.now() + this.timing.leaseMs).toISOString();
  }

  /**
   * One instance: runs left running by a crash or app quit become "interrupted" and can be resumed.
   * Several instances: runs nobody holds are resumed here, and from now on looked for regularly.
   */
  async recover() {
    if (this.shared) {
      await this.sweep();
      this.sweeper ??= setInterval(() => void this.sweep().catch((e) => console.error(`Looking for orphaned runs failed: ${e?.message ?? e}`)), this.timing.sweepMs);
      this.sweeper.unref?.();
      return;
    }
    const { db } = this.engine;
    // Leases left by the previous process (one instance: nobody else can hold them).
    await db.run('UPDATE runs SET lease_owner = NULL, lease_until = NULL WHERE lease_owner IS NOT NULL');
    for (const r of await db.all("SELECT id FROM runs WHERE status IN ('running','queued') AND deleted_at IS NULL")) {
      await this.engine.repos.runs.resetRunning(r.id);
      await this.engine.repos.runs.setStatus(r.id, 'interrupted');
    }
  }

  /** Resumes runs whose instance stopped (lease expired or handed back); one instance at a time per project. */
  async sweep() {
    const lock = await this.engine.coordinator.tryLock(`sweep:${this.engine.projectKey}`, this.timing.sweepMs);
    if (!lock) return;
    try {
      const { runs } = this.engine.repos;
      const queuedBefore = new Date(Date.now() - this.timing.leaseMs).toISOString();
      for (const r of await runs.orphaned(queuedBefore)) {
        if (this.active.has(r.id)) continue;
        if (r.cancelRequested) {
          await runs.resetRunning(r.id);
          const summary = summarize(await runs.summaryRows(r.id), (await runs.get(r.id)).total);
          await runs.setStatus(r.id, 'cancelled', { summary });
          await runs.requestCancel(r.id, false);
          await this.emitProgress(r.id);
          continue;
        }
        this.start(r.id);
      }
    } finally {
      await lock.release();
    }
  }

  /** Executing here. */
  isLocal(runId: string) {
    return this.active.has(runId);
  }

  /** Executing here or, with several instances, on another instance that holds its lease. */
  async isActive(runId: string) {
    if (this.active.has(runId)) return true;
    return this.shared && (await this.engine.repos.runs.leaseActive(runId));
  }

  activeCount() {
    return this.active.size;
  }

  start(runId: string) {
    if (this.active.has(runId)) return;
    const ac = new AbortController();
    this.active.set(runId, ac);
    const execution = this.execute(runId, ac.signal)
      .catch((e: any) => {
        // Only storage failing gets here. When the engine closed its database mid-run (app quit),
        // the run is still "running" on disk; recover() marks it "interrupted" (resumable) next start.
        if (!/not open/i.test(e?.message ?? '')) console.error(`Run ${runId} stopped: ${e?.message ?? e}`);
      })
      .finally(() => {
        this.active.delete(runId);
        this.reasons.delete(runId);
        this.executions.delete(runId);
      });
    this.executions.set(runId, execution);
  }

  /** Stops a run. With several instances the one executing it may be another: it is told to stop. */
  async cancel(runId: string) {
    if (this.stop(runId, 'cancel')) return;
    if (!this.shared) return;
    await this.engine.repos.runs.requestCancel(runId);
    await this.engine.coordinator.publish('control', JSON.stringify({ type: 'cancel-run', project: this.engine.projectKey, runId }));
  }

  /** A cancel announced by another instance (see Hub): stops the run if it executes here. */
  cancelLocal(runId: string) {
    this.stop(runId, 'cancel');
  }

  private stop(runId: string, reason: StopReason) {
    const ac = this.active.get(runId);
    if (!ac) return false;
    if (!this.reasons.has(runId)) this.reasons.set(runId, reason);
    ac.abort(new Error(reason === 'cancel' ? 'Run cancelled' : 'Run moved to another instance'));
    return true;
  }

  /**
   * Shutting down with several instances: stops executing and hands the runs back (rows not finished
   * go back to pending, the lease is released), so another instance resumes them right away.
   */
  async handOff(timeoutMs = 10_000) {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    const running = [...this.executions.values()];
    for (const id of [...this.active.keys()]) this.stop(id, 'handoff');
    await Promise.race([Promise.allSettled(running), sleep(timeoutMs)]);
  }

  /** Stops looking for orphaned runs (the engine is closing). */
  stopSweeping() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Waits until a run is no longer executing (used by the CLI and tests), here or on another instance. */
  async wait(runId: string, pollMs = 200) {
    while (this.active.has(runId)) await sleep(pollMs);
    if (this.shared) {
      for (;;) {
        const run = await this.engine.repos.runs.get(runId);
        if ((run.status !== 'running' && run.status !== 'queued') || !(await this.engine.repos.runs.leaseActive(runId))) break;
        await sleep(pollMs);
      }
    }
    return await this.engine.repos.runs.get(runId);
  }

  private async emitProgress(runId: string) {
    const p = await this.engine.repos.runs.progress(runId);
    this.engine.events.emit({ type: 'run.updated', runId, status: p.status, done: p.done, total: p.total });
  }

  private async execute(runId: string, signal: AbortSignal) {
    const { runs, defs } = this.engine.repos;
    // The lease says which instance executes the run; another instance's valid lease means it is
    // already running there. Rows a previous holder left "running" go back to pending.
    if (!(await runs.acquireLease(runId, this.owner, this.leaseUntil()))) return;
    await runs.resetRunning(runId);
    const renew = setInterval(() => {
      runs
        .renewLease(runId, this.owner, this.leaseUntil())
        .then(({ held, cancel }) => {
          if (!held) this.stop(runId, 'lost');
          else if (cancel) this.stop(runId, 'cancel');
        })
        .catch((e) => console.error(`Could not renew the lease of run ${runId}: ${e?.message ?? e}`));
    }, this.timing.renewMs);
    renew.unref?.();
    try {
      await this.executeHeld(runId, signal);
    } finally {
      clearInterval(renew);
      // A run lost to another instance belongs to it now; anything else frees its lease.
      if (this.reasons.get(runId) !== 'lost') await runs.releaseLease(runId, this.owner);
    }
  }

  private async executeHeld(runId: string, signal: AbortSignal) {
    const { runs, defs } = this.engine.repos;
    const run = await runs.get(runId);
    await runs.setStatus(run.id, 'running');
    await this.emitProgress(run.id);
    try {
      const suite = SuiteSpec.parse((await defs.getVersion('suite', run.suiteId!, run.suiteVersion!)).spec);
      const target = run.kind === 'live' ? applyOverrides(TargetSpec.parse((await defs.getVersion('target', run.targetId!, run.targetVersion!)).spec), run.settings.overrides) : null;
      const vars = target ? Object.fromEntries(target.variables.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value])) : {};
      const queue = await runs.pending(run.id);
      let next = 0;
      let lastEmit = 0;
      let lastSummary = Date.now();
      // The live summary re-reads every result; on big runs it gets slower, so it runs less often
      // (at most ~10% of the time) instead of every 2 s regardless.
      let summaryEvery = 2000;

      const worker = async () => {
        while (!signal.aborted) {
          const item = queue[next++];
          if (!item) return;
          try {
            await this.processItem(run, item, target, suite, vars, signal);
          } catch (e: any) {
            // One bad row (an unexpected throw, an unstorable output) must not fail the run while
            // the other workers keep going.
            if (!signal.aborted) await this.saveCrash(run.id, item.id, e);
          }
          if (Date.now() - lastEmit > 200) {
            lastEmit = Date.now();
            await this.emitProgress(run.id);
          }
          // Live summary so pass rates and latency fill in while the run is still going.
          if (Date.now() - lastSummary > summaryEvery) {
            const started = Date.now();
            await runs.setSummary(run.id, summarize(await runs.summaryRows(run.id), run.total || queue.length));
            lastSummary = Date.now();
            summaryEvery = Math.max(2000, (lastSummary - started) * 10);
          }
          if (run.settings.delayMs) await sleep(run.settings.delayMs, signal).catch(() => {});
        }
      };
      const workers = Math.max(1, Math.min(run.settings.concurrency, queue.length));
      await Promise.all(Array.from({ length: workers }, worker));

      const reason = signal.aborted ? (this.reasons.get(run.id) ?? 'cancel') : undefined;
      // Lost to another instance: it owns the run now, touch nothing.
      if (reason === 'lost') return;
      if (signal.aborted) await runs.resetRunning(run.id);
      // Handed back on shutdown: stays "running" (unfinished rows pending) for another instance to resume.
      if (reason === 'handoff') return;
      const summary = summarize(await runs.summaryRows(run.id), (await runs.get(run.id)).total);
      await runs.setStatus(run.id, signal.aborted ? 'cancelled' : 'completed', { summary });
      if (signal.aborted) await runs.requestCancel(run.id, false);
    } catch (e: any) {
      if (this.reasons.get(run.id) === 'lost') return;
      await runs.resetRunning(run.id);
      const summary = summarize(await runs.summaryRows(run.id), (await runs.get(run.id)).total);
      await runs.setStatus(run.id, 'failed', { error: e?.message ?? String(e), summary });
    }
    await this.emitProgress(run.id);
  }

  private async processItem(run: RunRecord, item: ResultRecord, target: TargetSpec | null, suite: SuiteSpec, vars: Record<string, string>, signal: AbortSignal) {
    const { runs } = this.engine.repos;
    await runs.markRunning(item.id);
    const logs: LogEntry[] = [];
    const log = (level: LogEntry['level'], message: string) => logs.push({ at: Date.now(), level, message });
    const env = this.engine.templateEnv();

    let call: TargetCallResult;
    let attempts = 0;
    const conv = run.settings.conversation;
    // Trace headers let the app report what it did for this row (docs/design/sdk-and-traces.md §4).
    const sendTraces = !!target && target.traces?.send !== false;
    const traceHeaders = sendTraces ? this.traceHeaders(run, item.id) : undefined;
    if (target) {
      const callOnce = (row: Record<string, unknown>) =>
        callTarget(this.engine, target, { row, rowId: item.rowId, vars, retries: run.settings.retries, signal, log, traceHeaders });
      const out = conv && conv.mode !== 'off'
        ? await runConversation(conv, item.input, { call: callOnce, llm: this.engine.llm, env, signal, log })
        : await callOnce(item.input);
      call = out.result;
      attempts = out.attempts;
    } else {
      call = { ok: !item.error, outputs: item.outputs ?? {}, metrics: item.metrics ?? {}, error: item.error ?? undefined, logs: [] };
    }
    if (signal.aborted) return; // left as "running"; reset to pending when the run stops

    // The app's trace for this row: waited for when the run collects traces (or the target asks to),
    // otherwise whatever already arrived. Traces of code runs carry the row id themselves.
    const waitMs = target?.traces?.wait || (run.settings.collectTraces ? (run.settings.traceWaitMs ?? 1500) : 0);
    const reported = sendTraces || !target ? await this.engine.traces.waitForResult(item.id, waitMs, signal) : { steps: [], traceIds: [] };
    if (signal.aborted) return;
    const inside = this.engine.traces.scopeFor(call.outputs, reported.steps);

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
      steps: inside.steps,
      sources: inside.sources,
      tool_calls: inside.tool_calls,
    };
    const evaluated = await evaluateChecks(suite, { scope, env, llm: this.engine.llm, embed: this.engine.embeddings, log, workspaceDir: this.engine.dir, signal });

    await runs.saveResult(run.id, item.id, {
      status: call.ok ? 'done' : 'error',
      // A call that got no response can't pass, even when every check happens to accept empty output.
      passed: call.ok && evaluated.passed,
      score: evaluated.score,
      request: call.request,
      response: trimResponse(call.response),
      outputs: call.outputs,
      checks: evaluated.checks,
      metrics: call.metrics,
      error: call.error ?? null,
      logs: [...call.logs, ...logs].slice(0, 500),
      attempts,
      steps: inside.steps?.slice(0, MAX_STEPS) ?? null,
    });
    this.engine.events.emit({ type: 'result.updated', runId: run.id, resultId: item.id });
  }

  /** traceparent + x-kalibra-run / x-kalibra-result (+ x-kalibra-tools) for one row's calls. */
  private traceHeaders(run: RunRecord, resultId: string): Record<string, string> {
    const { traceparent } = this.engine.traces.joinIds(run.id, resultId);
    const tools = run.settings.tools ?? 'live';
    return {
      traceparent,
      'x-kalibra-run': run.id,
      'x-kalibra-result': resultId,
      ...(tools !== 'live' ? { 'x-kalibra-tools': tools } : {}),
    };
  }

  private async saveCrash(runId: string, resultId: string, e: any) {
    const message = `Unexpected error: ${e?.message ?? String(e)}`;
    try {
      await this.engine.repos.runs.saveResult(runId, resultId, {
        status: 'error',
        passed: false,
        score: null,
        outputs: {},
        checks: [],
        metrics: {},
        error: message,
        logs: [{ at: Date.now(), level: 'error', message: e?.stack ?? message }],
        attempts: 0,
      });
      this.engine.events.emit({ type: 'result.updated', runId, resultId });
    } catch {
      // Storage itself is failing; the row stays "running" and is retried when the run resumes.
    }
  }
}

/** One target call with retries and backoff (honours Retry-After). Shared by runs, conversations and tryouts. */
export async function callTarget(
  engine: Engine,
  target: TargetSpec,
  opts: {
    row: Record<string, unknown>;
    rowId: string;
    vars: Record<string, string>;
    retries: number;
    signal: AbortSignal;
    log: (level: LogEntry['level'], message: string) => void;
    /** Runs only: lets the app report its trace for this row. */
    traceHeaders?: Record<string, string>;
  },
): Promise<{ result: TargetCallResult; attempts: number }> {
  let attempts = 0;
  for (;;) {
    attempts++;
    const result = await executeTarget(target, {
      row: opts.row,
      rowId: opts.rowId,
      vars: opts.vars,
      env: engine.templateEnv(),
      blobs: engine.blobs,
      llm: engine.llm,
      signal: opts.signal,
      workspaceDir: engine.dir,
      traceHeaders: opts.traceHeaders,
    });
    if (!result.retryable || attempts > opts.retries || opts.signal.aborted) return { result, attempts };
    const retryAfter = Number(result.response?.headers?.['retry-after']);
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempts - 1) + Math.random() * 250;
    opts.log('warn', `Attempt ${attempts} failed (${result.error ?? `HTTP ${result.response?.status}`}); retrying in ${Math.round(wait)} ms`);
    await sleep(Math.min(wait, 30000), opts.signal).catch(() => {});
    // Cancelled while waiting: don't call the app again (a script target would still run).
    if (opts.signal.aborted) return { result, attempts };
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
