/*
 * Sends finished traces to Kalibra in the background. Nothing in your code waits for it:
 *
 *   - finished traces go into an in-memory queue, bounded at MAX_QUEUED_SPANS (oldest dropped);
 *   - a timer (unref'd: it never keeps your process alive) sends them every second, or sooner once
 *     FLUSH_AT_SPANS are waiting;
 *   - each request retries twice with backoff, then the batch is dropped with a one-time warning;
 *   - redaction happens here, off the call path;
 *   - pending traces are sent when the process is about to exit (`beforeExit`), and `flush()` /
 *     `shutdown()` let serverless code send them before returning.
 *
 *   POST {url}/api/projects/{project}/ingest/traces   Authorization: Bearer kik_…
 *   { "traces": [TraceIn, …] }                         (docs/design/sdk-and-traces.md §2)
 */

import type { ResolvedConfig } from './config.js';
import { redactorFor } from './redact.js';
import { warnOnce } from './warn.js';

export interface SpanIn {
  id: string;
  parentId?: string;
  name: string;
  kind: 'llm' | 'tool' | 'retrieval' | 'agent' | 'step';
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  attributes?: Record<string, unknown>;
}

export interface TraceIn {
  id: string;
  name: string;
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: 'ok' | 'error';
  metadata: Record<string, unknown>;
  tags: string[];
  runId?: string;
  resultId?: string;
  spans: SpanIn[];
}

export const MAX_QUEUED_SPANS = 10_000;
export const FLUSH_AT_SPANS = 200;
/** Server limits per request (§2): 1000 traces, 5000 spans, 2 MB. */
const MAX_TRACES_PER_REQUEST = 1000;
const MAX_SPANS_PER_REQUEST = 5000;
const MAX_BYTES_PER_REQUEST = 1.8 * 1024 * 1024;
const RETRY_DELAYS_MS = [250, 1000];

/** A trace counts as one span plus its child spans. */
const weight = (t: TraceIn) => 1 + t.spans.length;

export class Exporter {
  private queue: TraceIn[] = [];
  private queued = 0;
  private timer?: ReturnType<typeof setInterval>;
  private sending?: Promise<void>;
  private dropped = 0;
  /** Traces ever queued, and traces sent or dropped: flush() waits until the second catches up. */
  private enqueuedTotal = 0;
  private settledTotal = 0;
  private exitHook = false;
  private redact: (v: unknown) => unknown;

  constructor(
    private config: ResolvedConfig,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.redact = redactorFor(config.redact);
  }

  /** How many spans are waiting (for tests and diagnostics). */
  get pendingSpans() {
    return this.queued;
  }

  get droppedTraces() {
    return this.dropped;
  }

  enqueue(trace: TraceIn) {
    this.queue.push(trace);
    this.queued += weight(trace);
    this.enqueuedTotal++;
    while (this.queued > MAX_QUEUED_SPANS && this.queue.length > 1) {
      const old = this.queue.shift()!;
      this.queued -= weight(old);
      this.dropped++;
      this.settledTotal++;
      warnOnce('queue-full', `Kalibra is not keeping up (or unreachable); dropping the oldest traces (queue limit ${MAX_QUEUED_SPANS} spans)`);
    }
    this.start();
    // A trace from a Kalibra eval row is sent at once: the run waits only briefly for it.
    if (this.queued >= FLUSH_AT_SPANS || trace.resultId) void this.flush();
  }

  private start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
      this.timer.unref?.();
    }
    if (!this.exitHook && typeof process !== 'undefined' && process.once) {
      this.exitHook = true;
      // beforeExit runs when the event loop is empty; sending keeps it alive until done.
      const onExit = () => {
        this.exitHook = false;
        if (this.queue.length) void this.flush();
      };
      process.once('beforeExit', onExit);
    }
  }

  /**
   * Sends everything queued so far, one request at a time. Resolves (never rejects) once every
   * trace queued before the call is sent or dropped, even if another flush started the sending.
   */
  async flush(): Promise<void> {
    const target = this.enqueuedTotal;
    while (this.settledTotal < target) {
      if (this.sending) {
        await this.sending;
        continue;
      }
      if (!this.queue.length) break;
      const batch = this.queue;
      this.queue = [];
      this.queued = 0;
      this.sending = this.sendAll(batch).finally(() => {
        this.settledTotal += batch.length;
        this.sending = undefined;
      });
    }
  }

  /** Sends what is queued and stops the timer. */
  async shutdown() {
    await this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sendAll(batch: TraceIn[]) {
    for (const chunk of this.chunks(batch.map((t) => this.prepare(t)))) {
      await this.post(chunk);
    }
  }

  /** Redaction and the last safety net before sending. */
  private prepare(t: TraceIn): TraceIn {
    const r = this.redact;
    return {
      ...t,
      input: r(t.input),
      output: r(t.output),
      error: t.error === undefined ? undefined : (r(t.error) as string),
      metadata: r(t.metadata) as Record<string, unknown>,
      spans: t.spans.map((s) => ({
        ...s,
        input: r(s.input),
        output: r(s.output),
        error: s.error === undefined ? undefined : (r(s.error) as string),
        attributes: s.attributes ? (r(s.attributes) as Record<string, unknown>) : undefined,
      })),
    };
  }

  /** Splits into request bodies within the server's limits. */
  private *chunks(traces: TraceIn[]): Generator<string> {
    let part: string[] = [];
    let bytes = 0;
    let spans = 0;
    for (const t of traces) {
      let json: string;
      try {
        json = JSON.stringify(t);
      } catch {
        continue;
      }
      // Bytes, not characters: non-Latin text takes 2–4 bytes per character in the UTF-8 body.
      const size = Buffer.byteLength(json, 'utf8');
      if (size > MAX_BYTES_PER_REQUEST) {
        warnOnce('trace-too-big', `Dropped a trace over ${Math.round(MAX_BYTES_PER_REQUEST / 1024)} KB ("${t.name}")`);
        continue;
      }
      const w = weight(t);
      if (part.length && (part.length >= MAX_TRACES_PER_REQUEST || spans + w > MAX_SPANS_PER_REQUEST || bytes + size > MAX_BYTES_PER_REQUEST)) {
        yield `{"traces":[${part.join(',')}]}`;
        part = [];
        bytes = 0;
        spans = 0;
      }
      part.push(json);
      bytes += size + 1;
      spans += w;
    }
    if (part.length) yield `{"traces":[${part.join(',')}]}`;
  }

  private async post(body: string) {
    const url = `${this.config.url}/api/projects/${encodeURIComponent(this.config.project)}/ingest/traces`;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.key}` },
          body,
          keepalive: true,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return;
        // Wrong key or project: retrying will not help.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          warnOnce(`http-${res.status}`, `Kalibra refused traces (HTTP ${res.status}) at ${url}. Check KALIBRA_KEY and KALIBRA_PROJECT.`);
          return;
        }
        if (res.status < 500 && res.status !== 429) {
          warnOnce(`http-${res.status}`, `Kalibra refused traces (HTTP ${res.status}).`);
          return;
        }
      } catch (e: any) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          warnOnce('unreachable', `Could not send traces to ${this.config.url} (${e?.message ?? e}). Is Kalibra running? Traces are dropped meanwhile.`);
          return;
        }
      }
      if (attempt >= RETRY_DELAYS_MS.length) return;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]).unref?.());
    }
  }
}
