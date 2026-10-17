/*
 * Shapes of traces and spans: what apps send (SDK, OpenTelemetry, the proxy) and what Kalibra
 * stores. A trace is one interaction with the app (e.g. answering one question); spans are its
 * steps (a model call, a tool call, a retrieval). See docs/design/sdk-and-traces.md.
 */

export const SPAN_KINDS = ['llm', 'tool', 'retrieval', 'agent', 'step'] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];
export type TraceSource = 'sdk' | 'otel' | 'proxy';

/** A span as stored, after validation. Values are already JSON-safe and size-limited. */
export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  attributes: Record<string, unknown>;
}

/** A trace as stored, after validation. */
export interface Trace {
  id: string;
  name: string;
  source: TraceSource;
  status: 'ok' | 'error';
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  runId?: string;
  resultId?: string;
  createdAt: string;
}

/** One ingested trace with its spans, ready to write. */
export interface TraceWithSpans extends Omit<Trace, 'createdAt'> {
  spans: Span[];
  /** OTLP sends a trace in pieces as its spans end: merge with what is stored instead of replacing it. */
  partial?: boolean;
}

/** A step as checks see it (`steps` in the check scope): a span, in start order. */
export interface Step {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  attributes: Record<string, unknown>;
}

/** A retrieved document as checks see it (`sources`). */
export interface Source {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

/** A tool call as checks see it (`tool_calls`). */
export interface ToolCall {
  name: string;
  args: unknown;
  output?: unknown;
  error?: string;
}
