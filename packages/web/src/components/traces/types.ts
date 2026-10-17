/*
 * Shapes of traces and spans as the engine returns them (docs/design/sdk-and-traces.md §1–§4),
 * plus small helpers shared by the Traces page, the trace sheet and the run result sheet.
 *
 * A trace is one call into the user's app (from the SDK, OpenTelemetry or the OpenAI proxy);
 * its spans are the steps inside it: model calls, tool calls, retrievals, agent loops.
 */

export type SpanKind = 'llm' | 'tool' | 'retrieval' | 'agent' | 'step';
export type TraceSource = 'sdk' | 'otel' | 'proxy';

export interface Span {
  id: string;
  traceId?: string;
  parentId?: string | null;
  name: string;
  kind: SpanKind | string;
  startedAt: string;
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  attributes?: Record<string, unknown>;
}

export interface Trace {
  id: string;
  name: string;
  source: TraceSource | string;
  status: 'ok' | 'error' | string;
  startedAt: string;
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  /** Short text of input / output, in lists (list_traces leaves the full values out). */
  inputPreview?: string;
  outputPreview?: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
  tags?: string[];
  runId?: string | null;
  resultId?: string | null;
  spanCount?: number;
  spans?: Span[];
}

export interface TracePage {
  total: number;
  traces: Trace[];
}

/** Accepts the list shapes an engine may answer with ({ traces, total }, { items }, or a bare array). */
export function normalizeTracePage(data: any): TracePage {
  if (Array.isArray(data)) return { traces: data, total: data.length };
  const traces = (data?.traces ?? data?.items ?? []) as Trace[];
  return { traces, total: typeof data?.total === 'number' ? data.total : traces.length };
}

/** An engine without these operations yet answers "Unknown operation"; screens explain instead of erroring. */
export const isMissingOp = (e: unknown) => (e as any)?.code === 'not_found' && /unknown operation/i.test((e as any)?.message ?? '');

/** A retrieved document, as checks and the UI see it (from retrieval spans or an `outputs.sources` field). */
export interface Source {
  id: string;
  text?: string;
  score?: number;
  [k: string]: unknown;
}

/** A tool call (from tool spans or an `outputs.tool_calls` field). */
export interface ToolCall {
  name: string;
  args?: unknown;
  output?: unknown;
  error?: string | null;
}

/** Normalizes whatever a retrieval returned (strings, {id,text}, {pageContent,metadata}…) into sources. */
export function toSources(value: unknown): Source[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as any).documents) ? (value as any).documents : [];
  return list.map((d: any, i: number): Source => {
    if (typeof d === 'string') return { id: String(i + 1), text: d };
    const id = d?.id ?? d?.doc_id ?? d?.metadata?.id ?? d?.metadata?.source ?? String(i + 1);
    const text = d?.text ?? d?.content ?? d?.pageContent ?? d?.page_content;
    return { ...d, id: String(id), ...(text !== undefined ? { text: String(text) } : {}), ...(typeof d?.score === 'number' ? { score: d.score } : {}) };
  });
}

export function toToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c === 'object')
    .map((c: any) => ({ name: String(c.name ?? c.tool ?? c.function?.name ?? 'tool'), args: c.args ?? c.arguments ?? c.function?.arguments ?? c.input, output: c.output ?? c.result, error: c.error ?? null }));
}

/** Sources and tool calls of a result: from its spans first, else from the app's own output fields. */
export function stepsDigest(steps: Span[] | undefined, outputs: Record<string, unknown> | undefined) {
  const spans = steps ?? [];
  const fromSpans = spans.filter((s) => s.kind === 'retrieval').flatMap((s) => toSources(s.output));
  const sources = fromSpans.length ? fromSpans : toSources(outputs?.sources);
  const toolSpans = spans.filter((s) => s.kind === 'tool').map((s): ToolCall => ({ name: s.name, args: s.input ?? (s.attributes as any)?.args, output: s.output, error: s.error ?? null }));
  const toolCalls = toolSpans.length ? toolSpans : toToolCalls(outputs?.tool_calls);
  return { sources, toolCalls };
}

/** Value at a dotted path ("input.question", "output.answer", "metadata.user"). */
export function pathValue(root: unknown, path: string): unknown {
  let cur: any = root;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Paths a column can be filled from: input, output and their fields (two levels deep). */
export function candidatePaths(trace: Pick<Trace, 'input' | 'output' | 'metadata'> | undefined): string[] {
  const out: string[] = ['input', 'output'];
  const walk = (prefix: string, v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 2) return;
    for (const [k, x] of Object.entries(v)) {
      const p = `${prefix}.${k}`;
      out.push(p);
      walk(p, x, depth + 1);
    }
  };
  walk('input', trace?.input, 1);
  walk('output', trace?.output, 1);
  walk('metadata', trace?.metadata, 1);
  return [...new Set(out)];
}
