import { invalid } from '../util.js';
import { INGEST_LIMITS, limitValue, newSpanId } from './ingest.js';
import type { Span, SpanKind, TraceWithSpans } from './types.js';

/*
 * OpenTelemetry → Kalibra traces. Accepts OTLP/HTTP JSON (ExportTraceServiceRequest), the format
 * every OTel SDK can send with OTEL_EXPORTER_OTLP_PROTOCOL=http/json. Many AI frameworks already
 * emit GenAI spans (Vercel AI SDK, LangChain/LangGraph, LlamaIndex, OpenAI Agents SDK, OpenLLMetry,
 * OpenInference), so pointing their exporter at Kalibra needs no code change.
 *
 * Mapping (first match wins):
 *   kind       gen_ai.operation.name (chat, text_completion, generate_content, embeddings → llm;
 *              execute_tool → tool; invoke_agent, create_agent → agent), gen_ai.tool.name → tool,
 *              openinference.span.kind (LLM, TOOL, RETRIEVER, AGENT, CHAIN, EMBEDDING),
 *              retrieval/vector attributes → retrieval, otherwise step
 *   input      gen_ai.input.messages, gen_ai.prompt, input.value, gen_ai.tool.call.arguments,
 *              span events gen_ai.content.prompt / gen_ai.user.message
 *   output     gen_ai.output.messages, gen_ai.completion, output.value, gen_ai.tool.call.result,
 *              retrieval.documents.N.document.{id,content,score}, events gen_ai.content.completion / gen_ai.choice
 *   attributes model, tokens_in, tokens_out, tool, plus every other attribute as-is
 *   join       resource or span attribute kalibra.result_id / kalibra.run_id, or a trace id the
 *              runner sent in traceparent (TraceStore.joinIds)
 *
 * OTel sends a trace in pieces as its spans end, so mapped traces are marked partial and merged.
 */

type AnyValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number; arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] }; bytesValue?: string };
type KeyValue = { key: string; value?: AnyValue };

function value(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(value);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  if (v.bytesValue !== undefined) return v.bytesValue;
  return undefined;
}

function attrs(list: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) if (kv?.key) out[kv.key] = value(kv.value);
  return out;
}

/** OTLP JSON uses hex ids; some exporters send base64. Both become lowercase hex. */
function hexId(id: unknown, bytes: number): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(id)) return id.toLowerCase();
  try {
    const b = Buffer.from(id, 'base64');
    if (b.length === bytes) return b.toString('hex');
  } catch {
    /* not base64 */
  }
  return undefined;
}

const nanosToIso = (n: unknown) => {
  const ns = typeof n === 'string' ? Number(BigInt(n) / 1000000n) : typeof n === 'number' ? Math.floor(n / 1e6) : NaN;
  return Number.isFinite(ns) && ns > 0 ? new Date(ns).toISOString() : new Date().toISOString();
};
const nanosMs = (start: unknown, end: unknown) => {
  try {
    const d = Number(BigInt(String(end)) - BigInt(String(start))) / 1e6;
    return Number.isFinite(d) && d >= 0 ? d : undefined;
  } catch {
    return undefined;
  }
};

/** JSON strings in attributes (messages, arguments) become values. */
function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

const LLM_OPS = new Set(['chat', 'text_completion', 'generate_content', 'completion', 'embeddings']);
const OPENINFERENCE: Record<string, SpanKind> = { LLM: 'llm', EMBEDDING: 'llm', TOOL: 'tool', RETRIEVER: 'retrieval', RERANKER: 'retrieval', AGENT: 'agent', CHAIN: 'step', GUARDRAIL: 'step', EVALUATOR: 'step' };

function kindOf(a: Record<string, unknown>, name: string): SpanKind {
  const op = String(a['gen_ai.operation.name'] ?? '');
  if (LLM_OPS.has(op)) return 'llm';
  if (op === 'execute_tool' || a['gen_ai.tool.name'] !== undefined) return 'tool';
  if (op === 'invoke_agent' || op === 'create_agent') return 'agent';
  const oi = OPENINFERENCE[String(a['openinference.span.kind'] ?? '').toUpperCase()];
  if (oi) return oi;
  if (Object.keys(a).some((k) => k.startsWith('retrieval.') || k.startsWith('db.vector') || k === 'db.system' && /vector|pinecone|qdrant|weaviate|chroma|milvus|pgvector/i.test(String(a[k])))) return 'retrieval';
  if (a['gen_ai.request.model'] !== undefined || a['gen_ai.system'] !== undefined || /^(chat|llm|completion)/i.test(name)) return 'llm';
  return 'step';
}

/** retrieval.documents.0.document.content … → [{ id, text, score }] (OpenInference flattens lists). */
function documents(a: Record<string, unknown>) {
  const docs = new Map<number, Record<string, unknown>>();
  for (const [k, v] of Object.entries(a)) {
    const m = /^retrieval\.documents\.(\d+)\.document\.(\w+)$/.exec(k);
    if (!m) continue;
    const d = docs.get(Number(m[1])) ?? {};
    d[m[2] === 'content' ? 'text' : m[2]] = v;
    docs.set(Number(m[1]), d);
  }
  return docs.size ? [...docs.entries()].sort((x, y) => x[0] - y[0]).map(([, d]) => d) : undefined;
}

function eventValue(events: any[], names: string[], keys: string[]) {
  const e = (events ?? []).filter((x) => names.includes(x?.name));
  if (!e.length) return undefined;
  const vals = e.map((x) => {
    const a = attrs(x.attributes);
    for (const k of keys) if (a[k] !== undefined) return maybeJson(a[k]);
    return a;
  });
  return vals.length === 1 ? vals[0] : vals;
}

function spanFrom(raw: any, traceId: string): Span {
  const a = attrs(raw.attributes);
  const name = String(raw.name ?? 'span').slice(0, 200);
  const kind = kindOf(a, name);
  const input =
    maybeJson(a['gen_ai.input.messages'] ?? a['gen_ai.prompt'] ?? a['input.value'] ?? a['gen_ai.tool.call.arguments'] ?? a['ai.prompt'] ?? a['ai.prompt.messages']) ??
    eventValue(raw.events, ['gen_ai.content.prompt', 'gen_ai.user.message', 'gen_ai.system.message'], ['gen_ai.prompt', 'content']);
  const output =
    maybeJson(a['gen_ai.output.messages'] ?? a['gen_ai.completion'] ?? a['output.value'] ?? a['gen_ai.tool.call.result'] ?? a['ai.response.text']) ??
    documents(a) ??
    eventValue(raw.events, ['gen_ai.content.completion', 'gen_ai.choice'], ['gen_ai.completion', 'message', 'content']);
  const tokensIn = a['gen_ai.usage.input_tokens'] ?? a['gen_ai.usage.prompt_tokens'] ?? a['llm.token_count.prompt'];
  const tokensOut = a['gen_ai.usage.output_tokens'] ?? a['gen_ai.usage.completion_tokens'] ?? a['llm.token_count.completion'];
  const model = a['gen_ai.response.model'] ?? a['gen_ai.request.model'] ?? a['llm.model_name'];
  const tool = a['gen_ai.tool.name'] ?? a['tool.name'];
  const statusCode = raw.status?.code;
  const error = statusCode === 2 || statusCode === 'STATUS_CODE_ERROR' ? String(raw.status?.message || 'error') : undefined;
  const attributes: Record<string, unknown> = { ...a };
  if (model !== undefined) attributes.model = model;
  if (tokensIn !== undefined) attributes.tokens_in = Number(tokensIn);
  if (tokensOut !== undefined) attributes.tokens_out = Number(tokensOut);
  if (tool !== undefined) attributes.tool = tool;
  return {
    id: hexId(raw.spanId, 8) ?? (typeof raw.spanId === 'string' && raw.spanId ? raw.spanId.slice(0, 64) : newSpanId()),
    traceId,
    ...(hexId(raw.parentSpanId, 8) ? { parentId: hexId(raw.parentSpanId, 8) } : {}),
    name,
    kind,
    startedAt: nanosToIso(raw.startTimeUnixNano),
    durationMs: nanosMs(raw.startTimeUnixNano, raw.endTimeUnixNano),
    ...(input !== undefined ? { input: limitValue(input) } : {}),
    ...(output !== undefined ? { output: limitValue(output) } : {}),
    ...(error ? { error } : {}),
    attributes: limitAttributes(attributes),
  };
}

/** Attributes within the stored size: when too big, keep the mapped ones and a truncated copy of the rest. */
function limitAttributes(a: Record<string, unknown>): Record<string, unknown> {
  const limited = limitValue(a);
  if (typeof limited !== 'string') return a;
  const keep: Record<string, unknown> = {};
  for (const k of ['model', 'tokens_in', 'tokens_out', 'tool', 'gen_ai.operation.name', 'gen_ai.system']) if (a[k] !== undefined) keep[k] = a[k];
  return { ...keep, _truncated: limited };
}

/** An OTLP/HTTP JSON body → partial traces (one per trace id in the request). */
export function otlpToTraces(body: unknown): TraceWithSpans[] {
  const rs = (body as any)?.resourceSpans;
  if (!Array.isArray(rs)) throw invalid('Expected an OTLP ExportTraceServiceRequest in JSON ({ "resourceSpans": [...] })');
  const byTrace = new Map<string, { spans: Span[]; resource: Record<string, unknown>; joins: Record<string, unknown> }>();
  let count = 0;
  for (const r of rs) {
    const resource = attrs(r?.resource?.attributes);
    for (const ss of r?.scopeSpans ?? r?.instrumentationLibrarySpans ?? []) {
      for (const raw of ss?.spans ?? []) {
        if (++count > INGEST_LIMITS.spansPerRequest) throw invalid(`At most ${INGEST_LIMITS.spansPerRequest} spans per request`);
        const traceId = hexId(raw?.traceId, 16);
        if (!traceId) continue;
        const span = spanFrom(raw, traceId);
        const entry = byTrace.get(traceId) ?? { spans: [], resource, joins: {} };
        entry.spans.push(span);
        for (const k of ['kalibra.result_id', 'kalibra.run_id']) {
          const v = span.attributes[k] ?? resource[k];
          if (typeof v === 'string' && v) entry.joins[k] = v;
        }
        byTrace.set(traceId, entry);
      }
    }
  }
  return [...byTrace.entries()].map(([id, { spans, resource, joins }]) => {
    const ids = new Set(spans.map((s) => s.id));
    // The root of this piece: a span without a parent, or whose parent is not in this request.
    const roots = spans.filter((s) => !s.parentId).length ? spans.filter((s) => !s.parentId) : spans.filter((s) => !ids.has(s.parentId!));
    const root = roots.sort((x, y) => (x.startedAt < y.startedAt ? -1 : 1))[0] ?? spans[0];
    const start = spans.reduce((m, s) => (s.startedAt < m ? s.startedAt : m), spans[0].startedAt);
    const end = Math.max(...spans.map((s) => Date.parse(s.startedAt) + (s.durationMs ?? 0)));
    const metadata: Record<string, unknown> = {};
    if (resource['service.name']) metadata.service = resource['service.name'];
    if (resource['service.version']) metadata.release = resource['service.version'];
    const env = resource['deployment.environment.name'] ?? resource['deployment.environment'];
    if (env) metadata.environment = env;
    const resultId = typeof joins['kalibra.result_id'] === 'string' ? (joins['kalibra.result_id'] as string) : undefined;
    const runId = typeof joins['kalibra.run_id'] === 'string' ? (joins['kalibra.run_id'] as string) : undefined;
    return {
      id,
      name: root.name,
      source: 'otel' as const,
      status: spans.some((s) => s.error && !s.parentId) || root.error ? ('error' as const) : ('ok' as const),
      startedAt: start,
      durationMs: end - Date.parse(start),
      ...(root.input !== undefined ? { input: root.input } : {}),
      ...(root.output !== undefined ? { output: root.output } : {}),
      ...(root.error ? { error: root.error } : {}),
      metadata,
      tags: [],
      ...(runId ? { runId } : {}),
      ...(resultId ? { resultId } : {}),
      spans,
      partial: true,
    };
  });
}
