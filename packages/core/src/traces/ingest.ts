import { randomBytes } from 'node:crypto';
import { invalid } from '../util.js';
import { SPAN_KINDS, type Span, type SpanKind, type TraceSource, type TraceWithSpans } from './types.js';

/*
 * Validates and normalizes traces sent by apps (POST /ingest/traces, the OTLP mapping and the
 * proxy all end here). Lenient where it can be (unknown span kinds become "step", missing ids are
 * generated, numbers or ISO strings both work as times) and strict on size, so a buggy or hostile
 * client cannot fill the disk or stall the server. Bad traces are rejected one by one; the rest
 * of the batch still goes in.
 */

export const INGEST_LIMITS = {
  /** Request body size (checked by the server before parsing). */
  bodyBytes: 2 * 1024 * 1024,
  tracesPerRequest: 1000,
  spansPerRequest: 5000,
  spansPerTrace: 2000,
  /** One input/output/attribute value, as JSON. Bigger values are kept as a truncated string. */
  valueBytes: 64 * 1024,
  metadataBytes: 16 * 1024,
  tags: 20,
} as const;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

/** JSON-safe, size-limited copy of a value from a client. */
export function limitValue(v: unknown, max: number = INGEST_LIMITS.valueBytes): unknown {
  if (v === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(v) ?? 'null';
  } catch {
    return String(v).slice(0, max);
  }
  if (s.length <= max) return v;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/** Dates are valid within ±8.64e15 ms of 1970; past that toISOString() throws. */
const MAX_DATE_MS = 8.64e15;

/** An ISO time from an ISO string or epoch milliseconds; falls back to now. */
export function toIso(v: unknown): string {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN;
  return new Date(Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : Date.now()).toISOString();
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const duration = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const record = (v: unknown, max: number): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const limited = limitValue(v, max);
  return typeof limited === 'string' ? { _truncated: limited } : (limited as Record<string, unknown>);
};
const kindOf = (v: unknown): SpanKind => (SPAN_KINDS.includes(v as SpanKind) ? (v as SpanKind) : 'step');
const optId = (v: unknown, what: string) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !ID.test(v)) throw new Error(`${what} must be 1–128 letters, digits, "_", "-", "." or ":"`);
  return v;
};

function normalizeSpan(raw: any, traceId: string, index: number): Span {
  if (!raw || typeof raw !== 'object') throw new Error(`span ${index} is not an object`);
  const name = str(raw.name, 200)?.trim();
  if (!name) throw new Error(`span ${index} has no name`);
  return {
    id: optId(raw.id, `span ${index} id`) ?? newSpanId(),
    traceId,
    parentId: optId(raw.parentId, `span ${index} parentId`),
    name,
    kind: kindOf(raw.kind),
    startedAt: toIso(raw.startedAt),
    durationMs: duration(raw.durationMs),
    input: limitValue(raw.input),
    output: limitValue(raw.output),
    error: str(raw.error, 4000),
    attributes: record(raw.attributes, INGEST_LIMITS.valueBytes),
  };
}

/** One trace from a client, normalized. Throws with a readable reason when it can't be stored. */
export function normalizeTrace(raw: any, source: TraceSource): TraceWithSpans {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  const name = str(raw.name, 200)?.trim();
  if (!name) throw new Error('name is required');
  const id = optId(raw.id, 'id') ?? newTraceId();
  const spansIn = raw.spans === undefined ? [] : raw.spans;
  if (!Array.isArray(spansIn)) throw new Error('spans must be a list');
  if (spansIn.length > INGEST_LIMITS.spansPerTrace) throw new Error(`at most ${INGEST_LIMITS.spansPerTrace} spans per trace`);
  const spans = spansIn.map((s: any, i: number) => normalizeSpan(s, id, i));
  const error = str(raw.error, 4000);
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t: unknown) => typeof t === 'string' && t).slice(0, INGEST_LIMITS.tags).map((t: string) => t.slice(0, 60)) : [];
  return {
    id,
    name,
    source,
    status: raw.status === 'error' || (raw.status !== 'ok' && !!error) ? 'error' : 'ok',
    startedAt: toIso(raw.startedAt),
    durationMs: duration(raw.durationMs),
    input: limitValue(raw.input),
    output: limitValue(raw.output),
    error,
    metadata: record(raw.metadata, INGEST_LIMITS.metadataBytes),
    tags,
    runId: optId(raw.runId, 'runId'),
    resultId: optId(raw.resultId, 'resultId'),
    spans,
  };
}

/**
 * The body of POST /ingest/traces: `{ traces: [...] }`. Request-level limits throw (the whole
 * request is refused); a bad trace is listed in `rejected` and the rest are kept.
 */
export function normalizeBatch(body: unknown, source: TraceSource = 'sdk'): { traces: TraceWithSpans[]; rejected: { index: number; error: string }[] } {
  const list = (body as any)?.traces;
  if (!Array.isArray(list)) throw invalid('Send { "traces": [...] }');
  if (list.length > INGEST_LIMITS.tracesPerRequest) throw invalid(`At most ${INGEST_LIMITS.tracesPerRequest} traces per request`);
  const spanCount = list.reduce((n: number, t: any) => n + (Array.isArray(t?.spans) ? t.spans.length : 0), 0);
  if (spanCount > INGEST_LIMITS.spansPerRequest) throw invalid(`At most ${INGEST_LIMITS.spansPerRequest} spans per request`);
  const traces: TraceWithSpans[] = [];
  const rejected: { index: number; error: string }[] = [];
  list.forEach((raw: unknown, index: number) => {
    try {
      traces.push(normalizeTrace(raw, source));
    } catch (e: any) {
      rejected.push({ index, error: e?.message ?? String(e) });
    }
  });
  return { traces, rejected };
}
