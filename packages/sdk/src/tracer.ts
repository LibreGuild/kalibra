/*
 * Traces and spans: `trace` wraps a function so each call becomes a trace (or a child span when it
 * runs inside another trace), `step` records one part of the work, and handles let your code add
 * metadata or set what a step returned.
 *
 * Cost when off: `trace()` returns your function itself and `step()` calls it directly. When on:
 * one AsyncLocalStorage context per trace/step, a JSON-safe copy of inputs and outputs (bounded,
 * see serialize.ts), and a push onto the export queue when the trace ends. Unsampled traces skip
 * the copying entirely. Nothing waits on the network.
 */

import { resolveConfig, killSwitch, type KalibraOptions, type ResolvedConfig } from './config.js';
import { current, storage, type Ctx, type RunLink } from './context.js';
import { Exporter, type SpanIn, type TraceIn } from './exporter.js';
import { newSpanId, newTraceId, nowIso } from './ids.js';
import { describeError, MAX_FIELD_BYTES, toJsonSafe } from './serialize.js';
import { setWarnings, warnOnce } from './warn.js';

declare const __KALIBRA_SDK_VERSION__: string | undefined;
export const SDK_VERSION = typeof __KALIBRA_SDK_VERSION__ !== 'undefined' ? __KALIBRA_SDK_VERSION__ : '0.0.0-dev';

export type SpanKind = SpanIn['kind'];

/** At most this many spans per trace; later ones are counted (metadata.droppedSpans) but not kept. */
export const MAX_SPANS_PER_TRACE = 256;

export interface TraceState {
  id: string;
  name: string;
  startedAt: string;
  t0: number;
  input?: unknown;
  output?: unknown;
  outputSet?: boolean;
  metadata: Record<string, unknown>;
  tags: string[];
  runId?: string;
  resultId?: string;
  spans: SpanIn[];
  droppedSpans: number;
}

export interface SpanState {
  record: SpanIn;
  trace: TraceState;
  t0: number;
  outputSet?: boolean;
}

/** What `step` callbacks receive and `currentSpan()` returns. */
export interface SpanHandle {
  readonly id: string;
  /** Record what this step worked on (replaces the captured input). */
  setInput(value: unknown): void;
  /** Record what this step produced (instead of its return value). */
  setOutput(value: unknown): void;
  /** Extra details: model, tokens_in, tokens_out, cost, documents… */
  setAttributes(attributes: Record<string, unknown>): void;
}

/** What `currentTrace()` returns. */
export interface TraceHandle extends SpanHandle {
  /** Set when this request came from a Kalibra eval run. */
  readonly runId?: string;
  readonly resultId?: string;
  setMetadata(metadata: Record<string, unknown>): void;
  addTags(...tags: string[]): void;
}

export interface TraceOptions<A extends unknown[] = unknown[], R = unknown> {
  /** Span kind when this call runs inside another trace. Default `step`. */
  kind?: SpanKind;
  /** What to record as input. Default: the single argument, or the argument list. `false` records none. */
  input?: ((...args: A) => unknown) | false;
  /** What to record as output. Default: the return value. `false` records none. */
  output?: ((result: Awaited<R>) => unknown) | false;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StepOptions<R = unknown> {
  kind?: SpanKind;
  /** What this step works on (e.g. the query). */
  input?: unknown;
  attributes?: Record<string, unknown>;
  /** What to record as output. Default: the return value. `false` records none. */
  output?: ((result: Awaited<R>) => unknown) | false;
}

// ── State ─────────────────────────────────────────────────────────────────────

interface State {
  config: ResolvedConfig;
  /** `init()` was called (or the kill switch is set): an "off" decision is final for wrapping. */
  decided: boolean;
  exporter?: Exporter;
}

const state: State = { config: resolveConfig(), decided: killSwitch() };
/** Exporters replaced by a later init(), still sending what they had. */
const retiring = new Set<Promise<void>>();

/** Whether traces are being recorded. */
export const isEnabled = () => state.config.enabled;

/** The active settings (read-only copy). */
export const getConfig = (): Readonly<ResolvedConfig> => ({ ...state.config });

/**
 * Configures the SDK. Call it once at startup, before wrapping functions: with the SDK off,
 * `trace()` and `tool()` then return your functions untouched.
 */
export function init(options: KalibraOptions = {}): { enabled: boolean } {
  const old = state.exporter;
  state.config = resolveConfig(options);
  state.decided = true;
  state.exporter = undefined;
  setWarnings(state.config.warnings);
  // Traces recorded before this init still go out with the old settings; flush() waits for them.
  if (old) {
    const done = old.shutdown().finally(() => retiring.delete(done));
    retiring.add(done);
  }
  if (options.enabled !== false && !state.config.enabled && !killSwitch() && !state.config.key) {
    warnOnce('no-key', 'No ingest key (KALIBRA_KEY), so tracing is off. Create one in Kalibra → Traces → Connect your app.');
  }
  return { enabled: state.config.enabled };
}

export function exporter(): Exporter {
  return (state.exporter ??= new Exporter(state.config));
}

/** True when wrapping should return the function untouched. */
export const offForGood = () => state.decided && !state.config.enabled;

// ── Handles ───────────────────────────────────────────────────────────────────

const NOOP_SPAN: TraceHandle = Object.freeze({
  id: '',
  setInput() {},
  setOutput() {},
  setAttributes() {},
  setMetadata() {},
  addTags() {},
});

function spanHandle(s: SpanState): SpanHandle {
  return {
    id: s.record.id,
    setInput: (v) => guard(() => (s.record.input = toJsonSafe(v))),
    setOutput: (v) => guard(() => ((s.record.output = toJsonSafe(v)), (s.outputSet = true))),
    setAttributes: (a) => guard(() => (s.record.attributes = { ...s.record.attributes, ...(toJsonSafe(a) as object) })),
  };
}

function traceHandle(t: TraceState): TraceHandle {
  return {
    id: t.id,
    runId: t.runId,
    resultId: t.resultId,
    setInput: (v) => guard(() => (t.input = toJsonSafe(v))),
    setOutput: (v) => guard(() => ((t.output = toJsonSafe(v)), (t.outputSet = true))),
    setAttributes: (a) => guard(() => Object.assign(t.metadata, toJsonSafe(a) as object)),
    setMetadata: (m) => guard(() => Object.assign(t.metadata, toJsonSafe(m) as object)),
    addTags: (...tags) => guard(() => t.tags.push(...tags.map(String).slice(0, 50))),
  };
}

const guard = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    warnOnce('handle', `Could not record a value: ${e?.message ?? e}`);
  }
};

/** The trace the current code runs in (a no-op handle outside traces or when off). */
export function currentTrace(): TraceHandle {
  const ctx = current();
  return ctx?.trace ? traceHandle(ctx.trace) : NOOP_SPAN;
}

/** The innermost open step (or the trace itself), as a handle. */
export function currentSpan(): SpanHandle {
  const ctx = current();
  if (ctx?.span) return spanHandle(ctx.span);
  return ctx?.trace ? traceHandle(ctx.trace) : NOOP_SPAN;
}

// ── Running code as a trace or a span ─────────────────────────────────────────

type Frame = { kind: 'trace'; t: TraceState } | { kind: 'span'; s: SpanState };

/**
 * Runs `call` as a new trace (no trace open) or as a child span of the open one. All SDK work is
 * guarded: if anything in it fails, `call` still runs exactly once and its result is untouched.
 */
export function runSpan<R>(name: string, kind: SpanKind, input: () => unknown, output: ((r: any) => unknown) | false | undefined, call: (h: SpanHandle) => R, extra?: { metadata?: Record<string, unknown>; tags?: string[]; attributes?: Record<string, unknown> }): R {
  if (!state.config.enabled) return call(NOOP_SPAN);
  const ctx = current();
  if (ctx?.unsampled) return call(NOOP_SPAN);

  let frame: Frame | undefined;
  let next: Ctx | undefined;
  try {
    if (!ctx?.trace) {
      const link = ctx?.link;
      const sampled = !!(link?.resultId || link?.rowId) || state.config.sampleRate >= 1 || Math.random() < state.config.sampleRate;
      if (!sampled) {
        const quiet: Ctx = { ...ctx, unsampled: true };
        return storage.run(quiet, () => {
          const result = call(NOOP_SPAN);
          const gen = generatorKind(result);
          // A generator's body runs later: it needs the "not sampled" context then, too.
          return gen ? (traceGenerator(result, gen, quiet) as R) : result;
        });
      }
      const t = newTrace(name, link, input, extra);
      frame = { kind: 'trace', t };
      next = { ...ctx, trace: t, span: undefined };
    } else {
      const t = ctx.trace;
      if (t.spans.length >= MAX_SPANS_PER_TRACE) {
        t.droppedSpans++;
        return call(NOOP_SPAN);
      }
      const record: SpanIn = { id: newSpanId(), name, kind, startedAt: nowIso(), input: safeInput(input) };
      if (ctx.span) record.parentId = ctx.span.record.id;
      if (extra?.attributes) record.attributes = toJsonSafe(extra.attributes) as Record<string, unknown>;
      t.spans.push(record);
      const s: SpanState = { record, trace: t, t0: performance.now() };
      frame = { kind: 'span', s };
      next = { ...ctx, span: s };
    }
  } catch (e: any) {
    warnOnce('setup', `Tracing failed and was skipped: ${e?.message ?? e}`);
    return call(NOOP_SPAN);
  }

  const f = frame;
  const scope = next!;
  const handle = f.kind === 'trace' ? traceHandle(f.t) : spanHandle(f.s);
  return storage.run(scope, () => {
    let result: R;
    try {
      result = call(handle);
    } catch (e) {
      end(f, undefined, e, output);
      throw e;
    }
    if (isThenable(result)) {
      return (result as any).then(
        (v: unknown) => {
          end(f, v, undefined, output);
          return v;
        },
        (e: unknown) => {
          end(f, undefined, e, output);
          throw e;
        },
      ) as R;
    }
    const gen = generatorKind(result);
    if (gen) return traceGenerator(result, gen, scope, f, output) as R;
    end(f, result, undefined, output);
    return result;
  });
}

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function';

const generatorKind = (v: unknown): 'sync' | 'async' | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const tag = Object.prototype.toString.call(v);
  return tag === '[object AsyncGenerator]' ? 'async' : tag === '[object Generator]' ? 'sync' : undefined;
};

/** What a generator yielded, as its step's output: text chunks joined (LLM streams), else a count and the first items. */
class Yielded {
  private count = 0;
  private text: string[] | undefined = [];
  private size = 0;
  private first: unknown[] = [];

  add(v: unknown) {
    this.count++;
    if (this.first.length < 5) this.first.push(toJsonSafe(v, 4096));
    if (!this.text) return;
    if (typeof v !== 'string') this.text = undefined;
    else if (this.size < MAX_FIELD_BYTES) (this.text.push(v), (this.size += v.length));
  }

  summary(): unknown {
    if (!this.count) return { items: 0 };
    return this.text ? this.text.join('') : { items: this.count, first: this.first };
  }
}

/**
 * A generator runs its body only while it is consumed, so its step stays open (with the trace
 * context set for each resume) until iteration ends: done, an error, or an early `return()` (a
 * `break` in `for await`, not an error). Without a frame (an unsampled trace) it only carries the
 * context. Native generators only; other iterables (e.g. SDK stream objects) are returned as they
 * are, so their own methods keep working.
 */
function traceGenerator(gen: any, kind: 'sync' | 'async', ctx: Ctx, f?: Frame, output?: ((r: any) => unknown) | false): unknown {
  const seen = new Yielded();
  let open = !!f;
  const finish = (error?: unknown) => {
    if (!open) return;
    open = false;
    end(f!, seen.summary(), error, output);
  };
  const settle = (r: IteratorResult<unknown>) => {
    if (!open) return r;
    try {
      if (r.done) finish();
      else seen.add(r.value);
    } catch {
      /* recording only; the value goes to the caller regardless */
    }
    return r;
  };
  const fail = (e: unknown): never => {
    finish(e ?? new Error('generator threw undefined'));
    throw e;
  };
  const resume = (method: 'next' | 'return' | 'throw', arg: unknown) => storage.run(ctx, () => gen[method](arg));
  if (kind === 'async') {
    const it: AsyncGenerator = {
      next: (v?: unknown) => resume('next', v).then(settle, fail),
      return: (v?: unknown) => resume('return', v).then(settle, fail),
      throw: (e?: unknown) => resume('throw', e).then(settle, fail),
      [Symbol.asyncIterator]: () => it,
    } as unknown as AsyncGenerator;
    return it;
  }
  const step = (method: 'next' | 'return' | 'throw', arg: unknown) => {
    let r: IteratorResult<unknown>;
    try {
      r = resume(method, arg);
    } catch (e) {
      return fail(e);
    }
    return settle(r);
  };
  const it: Generator = {
    next: (v?: unknown) => step('next', v),
    return: (v?: unknown) => step('return', v),
    throw: (e?: unknown) => step('throw', e),
    [Symbol.iterator]: () => it,
  } as unknown as Generator;
  return it;
}

function safeInput(input: () => unknown): unknown {
  try {
    return toJsonSafe(input());
  } catch {
    return undefined;
  }
}

function newTrace(name: string, link: RunLink | undefined, input: () => unknown, extra?: { metadata?: Record<string, unknown>; tags?: string[] }): TraceState {
  const c = state.config;
  let id = newTraceId();
  // The first trace of a request Kalibra made keeps Kalibra's trace id (traceparent).
  if (link?.traceId && !link.usedTraceId) {
    id = link.traceId;
    link.usedTraceId = true;
  }
  if (link?.rowId) (link.traceIds ??= []).push(id);
  const metadata: Record<string, unknown> = { sdk: 'js', sdkVersion: SDK_VERSION };
  if (c.environment) metadata.environment = c.environment;
  if (c.release) metadata.release = c.release;
  if (link?.parentSpanId) metadata.parentSpanId = link.parentSpanId;
  if (link?.tools) metadata.tools = link.tools;
  if (extra?.metadata) Object.assign(metadata, toJsonSafe(extra.metadata));
  return {
    id,
    name,
    startedAt: nowIso(),
    t0: performance.now(),
    input: safeInput(input),
    metadata,
    tags: extra?.tags ? [...extra.tags] : [],
    runId: link?.runId,
    resultId: link?.resultId,
    spans: [],
    droppedSpans: 0,
  };
}

function end(f: Frame, result: unknown, error: unknown, output: ((r: any) => unknown) | false | undefined) {
  try {
    const now = performance.now();
    if (f.kind === 'span') {
      const r = f.s.record;
      r.durationMs = round(now - f.s.t0);
      if (error !== undefined) r.error = describeError(error);
      else if (!f.s.outputSet && output !== false) r.output = toJsonSafe(output ? output(result) : result);
      return;
    }
    const t = f.t;
    const trace: TraceIn = {
      id: t.id,
      name: t.name,
      startedAt: t.startedAt,
      durationMs: round(now - t.t0),
      input: t.input,
      output: error === undefined && !t.outputSet && output !== false ? toJsonSafe(output ? output(result) : result) : t.output,
      status: error === undefined ? 'ok' : 'error',
      metadata: t.droppedSpans ? { ...t.metadata, droppedSpans: t.droppedSpans } : t.metadata,
      tags: t.tags,
      spans: t.spans.slice(),
    };
    if (error !== undefined) trace.error = describeError(error);
    if (t.runId) trace.runId = t.runId;
    if (t.resultId) trace.resultId = t.resultId;
    exporter().enqueue(trace);
  } catch (e: any) {
    warnOnce('end', `Could not record a trace: ${e?.message ?? e}`);
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100;

// ── Public helpers ────────────────────────────────────────────────────────────

/**
 * Wraps a function so each call is recorded: as a trace, or as a child span inside another trace.
 *
 *   export const answer = kalibra.trace('answer_question', async (q: string) => { … });
 *
 * With the SDK off (after `init`), returns `fn` itself.
 */
function traceImpl<A extends unknown[], R>(name: string, fn: (...args: A) => R, options: TraceOptions<A, R> = {}): (...args: A) => R {
  if (offForGood()) return fn;
  const kind = options.kind ?? 'step';
  const pick = options.input;
  const wrapped = function (this: unknown, ...args: A): R {
    if (!state.config.enabled) return fn.apply(this, args);
    const input = pick === false ? () => undefined : pick ? () => pick(...args) : () => (args.length === 1 ? args[0] : args);
    return runSpan(name, kind, input, options.output as any, () => fn.apply(this, args), options);
  };
  try {
    Object.defineProperty(wrapped, 'name', { value: fn.name || name });
    Object.defineProperty(wrapped, 'length', { value: fn.length });
  } catch {
    /* cosmetic only */
  }
  return wrapped;
}

/** Runs `fn` now as a trace (or a child span inside one): `kalibra.trace.run('nightly', async (t) => …)`. */
function traceRun<R>(name: string, fn: (handle: SpanHandle) => R, options: Omit<StepOptions<R>, 'attributes'> & { metadata?: Record<string, unknown>; tags?: string[] } = {}): R {
  const input = options.input;
  return runSpan(name, options.kind ?? 'step', () => input, options.output as any, fn, options);
}

export const trace = Object.assign(traceImpl, { run: traceRun });

/**
 * Records one part of the work, e.g. retrieval or the model call. Outside a trace it starts one.
 *
 *   const docs = await kalibra.step('retrieve', () => search(q), { kind: 'retrieval', input: q });
 */
export function step<R>(name: string, fn: (span: SpanHandle) => R, options: StepOptions<R> = {}): R {
  if (!state.config.enabled) return fn(NOOP_SPAN);
  const input = options.input;
  return runSpan(name, options.kind ?? 'step', () => input, options.output as any, fn, { attributes: options.attributes });
}

/** Other background senders (tool recordings) that `flush()` should wait for. */
const flushHooks: (() => Promise<void>)[] = [];
export const onFlush = (fn: () => Promise<void>) => void flushHooks.push(fn);

/** Sends every finished trace now (e.g. before a serverless function returns). Never rejects. */
export async function flush(): Promise<void> {
  await Promise.all([state.exporter?.flush(), ...retiring, ...flushHooks.map((f) => f().catch(() => {}))]);
}

/** Sends what is queued and stops background work. */
export async function shutdown(): Promise<void> {
  await flush();
  await state.exporter?.shutdown();
}
