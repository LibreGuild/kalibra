import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Engine } from '../engine.js';
import { ToolRecordingRepo, TraceRepo } from '../repo/traces.js';
import { invalid, KalibraError, parseJson } from '../util.js';
import { normalizeBatch } from './ingest.js';
import { checkScope, stepsFromSpans, type InsideScope } from './scope.js';
import type { Step, TraceSource, TraceWithSpans } from './types.js';

/*
 * Everything a project does with traces, in one place (engine.traces):
 *
 *   ingest()          validate and queue; a timer writes the queue in batches (one transaction),
 *                     so the ingest endpoint answers in microseconds whatever the database does
 *   joinIds()         the trace id and headers the runner sends with each eval row's call, so the
 *                     app's trace (SDK, OpenTelemetry, proxy) is joined back to that row
 *   waitForResult()   the runner waits briefly after a call for the app's trace to arrive
 *   prune()           drops old traces (run traces are kept with their run)
 *   settings()        retention days and the OpenAI proxy's upstream
 */

export interface TraceSettings {
  /** Traces older than this (not part of a run) are removed. */
  retentionDays: number;
  /** Where the OpenAI-compatible proxy forwards calls. */
  proxyOpenaiUpstream: string;
}

export const DEFAULT_TRACE_SETTINGS: TraceSettings = { retentionDays: 30, proxyOpenaiUpstream: 'https://api.openai.com' };

/** Traces waiting to be written; past this the ingest endpoint answers "busy" instead of growing memory. */
const MAX_QUEUE = 20_000;
/** Writes are grouped for this long (bursts from many SDK clients become one transaction). */
const FLUSH_DELAY_MS = 20;
/** How long the runner's trace ids are remembered for joining OpenTelemetry spans back to rows. */
const JOIN_TTL_MS = 30 * 60_000;
const MAX_JOINS = 50_000;
const PRUNE_EVERY_MS = 6 * 3600_000;

export class TraceStore {
  readonly repo: TraceRepo;
  readonly tools: ToolRecordingRepo;
  private queue: TraceWithSpans[] = [];
  private writing = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** Fires 'written' with the result ids of each written batch (for waitForResult). */
  private written = new EventEmitter();
  /** W3C trace id the runner sent → the eval row it belongs to. */
  private joins = new Map<string, { runId: string; resultId: string; at: number }>();
  private lastPrune = 0;
  private closed = false;

  constructor(private engine: Engine) {
    this.repo = new TraceRepo(engine.db);
    this.tools = new ToolRecordingRepo(engine.db);
    this.written.setMaxListeners(0);
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async settings(): Promise<TraceSettings> {
    return { ...DEFAULT_TRACE_SETTINGS, ...parseJson<Partial<TraceSettings>>((await this.engine.db.get("SELECT value FROM meta WHERE key = 'traces'"))?.value, {}) };
  }

  async setSettings(patch: Partial<TraceSettings>): Promise<TraceSettings> {
    return this.engine.db.tx(async () => {
      const next = { ...(await this.settings()), ...patch };
      if (!Number.isInteger(next.retentionDays) || next.retentionDays < 1 || next.retentionDays > 3650) throw invalid('Keep traces between 1 and 3650 days');
      next.proxyOpenaiUpstream = checkUpstream(next.proxyOpenaiUpstream);
      await this.engine.db.run("INSERT INTO meta (key, value) VALUES ('traces', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
      return next;
    });
  }

  // ── Ingest ───────────────────────────────────────────────────────────────

  /** Validates a POST /ingest/traces body and queues the good traces. */
  ingestBody(body: unknown, source: TraceSource = 'sdk') {
    const { traces, rejected } = normalizeBatch(body, source);
    this.enqueue(traces);
    return { accepted: traces.length, rejected };
  }

  /** Queues already-normalized traces (OTLP mapping, proxy). Joins them to eval rows when they carry a trace id the runner sent. */
  enqueue(traces: TraceWithSpans[]) {
    if (this.closed) throw new KalibraError('unavailable', 'This project is closing; try again');
    if (this.queue.length + traces.length > MAX_QUEUE) throw new KalibraError('unavailable', 'Kalibra is busy writing traces; try again shortly');
    for (const t of traces) {
      if (!t.resultId) {
        const join = this.joins.get(t.id);
        if (join) Object.assign(t, { runId: t.runId ?? join.runId, resultId: join.resultId });
      }
      this.queue.push(t);
    }
    if (traces.length && !this.timer) {
      this.timer = setTimeout(() => void this.flush().catch((e) => console.error(`Could not store traces: ${e?.message ?? e}`)), FLUSH_DELAY_MS);
      this.timer.unref?.();
    }
  }

  /** Writes everything queued now (also on engine close). */
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.writing += batch.length;
    try {
      await this.repo.write(batch);
    } catch (e: any) {
      // A closed database (app quitting) drops the batch.
      if (/not open/i.test(e?.message ?? '')) return;
      // Otherwise one bad trace must not drop everyone else's: write them one by one.
      for (const t of batch) {
        try {
          await this.repo.write([t]);
        } catch (err: any) {
          console.error(`Could not store trace ${t.id}: ${err?.message ?? err}`);
        }
      }
    } finally {
      this.writing -= batch.length;
    }
    const resultIds = [...new Set(batch.map((t) => t.resultId).filter((x): x is string => !!x))];
    this.written.emit('written', resultIds);
    this.engine.events.emit({ type: 'traces.ingested', count: batch.length, ...(resultIds.length ? { resultIds } : {}) });
    if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) await this.prune();
  }

  /** Traces queued or being written (the engine stays open until they are stored). */
  pending() {
    return this.queue.length + this.writing;
  }

  async close() {
    await this.flush();
    this.closed = true;
    this.written.removeAllListeners();
  }

  // ── Joining traces to eval rows ──────────────────────────────────────────

  /**
   * The trace context the runner sends with one eval row's call. The trace id is derived from the
   * row, so the same row always gets the same id; it is remembered so OpenTelemetry spans that only
   * carry `traceparent` (no Kalibra attributes) are still joined to the row.
   */
  joinIds(runId: string, resultId: string) {
    const traceId = createHash('sha256').update(`${runId}:${resultId}`).digest('hex').slice(0, 32);
    const spanId = createHash('sha256').update(`span:${resultId}`).digest('hex').slice(0, 16);
    if (this.joins.size >= MAX_JOINS) this.forgetOldJoins();
    this.joins.set(traceId, { runId, resultId, at: Date.now() });
    return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
  }

  /** Drops expired ids, and the oldest tenth when that is not enough (a Map keeps insertion order). */
  private forgetOldJoins() {
    const cutoff = Date.now() - JOIN_TTL_MS;
    const keep = MAX_JOINS * 0.9;
    for (const [k, v] of this.joins) {
      if (v.at >= cutoff && this.joins.size <= keep) break;
      this.joins.delete(k);
    }
  }

  /**
   * Waits up to `ms` for the app to report the trace of one eval row, then a short moment more for
   * any further traces of the same row (a conversation sends one per turn). Resolves with what
   * arrived; an app that sends nothing just costs the wait.
   */
  async waitForResult(resultId: string, ms: number, signal?: AbortSignal): Promise<{ steps: Step[]; traceIds: string[] }> {
    await this.flush();
    const found = async () => await this.repo.byResult(resultId);
    if (!(await found()).length && ms > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.written.off('written', onWritten);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const onWritten = (ids: string[]) => ids.includes(resultId) && done();
        const timer = setTimeout(done, ms);
        this.written.on('written', onWritten);
        signal?.addEventListener('abort', done, { once: true });
      });
      // Let the rest of a multi-trace row land (bounded; most apps send one trace per call).
      if ((await found()).length && !signal?.aborted) await new Promise((r) => setTimeout(r, Math.min(150, ms)));
      await this.flush();
    }
    const traces = await found();
    return { steps: stepsFromSpans(traces.flatMap((t) => t.spans)), traceIds: traces.map((t) => t.id) };
  }

  /** `steps`, `sources` and `tool_calls` for one result's check scope. */
  scopeFor(outputs: Record<string, unknown>, steps: Step[]): InsideScope {
    return checkScope(outputs, steps);
  }

  // ── Retention ────────────────────────────────────────────────────────────

  async prune() {
    this.lastPrune = Date.now();
    const before = new Date(Date.now() - (await this.settings()).retentionDays * 86_400_000).toISOString();
    try {
      return await this.repo.prune(before);
    } catch {
      return 0;
    }
  }
}

/** The proxy only forwards to https (or http on this machine), and never to Kalibra itself by accident. */
export function checkUpstream(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid('The proxy upstream must be a web address, e.g. https://api.openai.com');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw invalid('The proxy upstream must use https (http only on this machine)');
  if (u.username || u.password) throw invalid('Leave credentials out of the upstream address');
  return u.origin + u.pathname.replace(/\/+$/, '');
}
