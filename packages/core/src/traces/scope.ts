import { limitValue, newSpanId, toIso } from './ingest.js';
import { SPAN_KINDS, type Source, type Span, type SpanKind, type Step, type ToolCall } from './types.js';

/*
 * What checks see of an app's insides, whichever way it was reported:
 *
 *   steps       every span of the row's trace(s), in start order (or `outputs.steps` that a script,
 *               model target or API returned itself)
 *   sources     retrieved documents [{ id, text, score? }] — from `outputs.sources`, else from the
 *               outputs of retrieval spans
 *   tool_calls  [{ name, args, output, error }] — from `outputs.tool_calls`, else from tool spans
 *
 * Apps without the SDK can return `sources` / `tool_calls` fields and map them with extractors.
 * Common shapes are accepted: OpenAI tool calls ({ function: { name, arguments } }), LangChain
 * documents ({ page_content, metadata }), plain strings.
 */

const asObject = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);

/** JSON strings (e.g. OpenAI's tool `arguments`) become values; anything else stays as it is. */
function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

/** Spans in start order. */
export function stepsFromSpans(spans: Span[]): Step[] {
  return [...spans]
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
    .map(({ id, traceId, parentId, name, kind, startedAt, durationMs, input, output, error, attributes }) => ({
      id,
      traceId,
      ...(parentId ? { parentId } : {}),
      name,
      kind,
      startedAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      attributes,
    }));
}

/** Steps a target returned itself (`outputs.steps`): loosely shaped, so normalize what we can. */
export function stepsFromOutputs(value: unknown, traceId = 'outputs'): Step[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2000).flatMap((raw, i): Step[] => {
    const o = asObject(raw);
    if (!o) return [];
    const kind: SpanKind = SPAN_KINDS.includes(o.kind) ? o.kind : o.type === 'tool' || o.tool ? 'tool' : 'step';
    return [
      {
        id: typeof o.id === 'string' ? o.id : `${i}-${newSpanId()}`,
        traceId,
        ...(typeof o.parentId === 'string' ? { parentId: o.parentId } : {}),
        name: String(o.name ?? o.tool ?? o.type ?? `step ${i + 1}`).slice(0, 200),
        kind,
        startedAt: toIso(o.startedAt),
        ...(typeof o.durationMs === 'number' ? { durationMs: o.durationMs } : {}),
        ...(o.input !== undefined || o.args !== undefined ? { input: limitValue(o.input ?? o.args) } : {}),
        ...(o.output !== undefined || o.result !== undefined ? { output: limitValue(o.output ?? o.result) } : {}),
        ...(o.error ? { error: String(o.error) } : {}),
        attributes: asObject(o.attributes) ?? {},
      },
    ];
  });
}

/** One retrieved document in any common shape. */
function toSource(raw: unknown, index: number): Source | undefined {
  // Plain texts are numbered from 1, like citations ([1], [2]).
  if (typeof raw === 'string') return { id: String(index + 1), text: raw };
  const o = asObject(raw);
  if (!o) return undefined;
  const meta = asObject(o.metadata) ?? asObject(o.document?.metadata);
  const id = o.id ?? o.document_id ?? o.doc_id ?? o.document?.id ?? meta?.id ?? meta?.source ?? index + 1;
  const text = o.text ?? o.content ?? o.page_content ?? o.pageContent ?? o.document?.content ?? o.document?.text ?? o.chunk ?? '';
  const score = typeof o.score === 'number' ? o.score : typeof o.document?.score === 'number' ? o.document.score : undefined;
  return {
    id: String(id),
    text: typeof text === 'string' ? text : JSON.stringify(text),
    ...(score !== undefined ? { score } : {}),
    ...(meta ? { metadata: meta } : {}),
  };
}

/** A list of documents, or an object holding one ({ documents }, { results }, { sources }). */
export function toSources(value: unknown): Source[] {
  const v = parseMaybeJson(value);
  const list = Array.isArray(v) ? v : asObject(v) ? (asObject(v)!.documents ?? asObject(v)!.results ?? asObject(v)!.sources ?? asObject(v)!.matches) : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((d, i) => {
    const s = toSource(d, i);
    return s ? [s] : [];
  });
}

/** One tool call in any common shape (OpenAI, Anthropic, plain). */
function toToolCall(raw: unknown): ToolCall | undefined {
  const o = asObject(raw);
  if (!o) return undefined;
  const fn = asObject(o.function);
  const name = o.name ?? o.tool ?? o.tool_name ?? fn?.name;
  if (typeof name !== 'string' || !name) return undefined;
  const args = parseMaybeJson(o.args ?? o.arguments ?? o.input ?? o.parameters ?? fn?.arguments ?? {});
  return {
    name,
    args,
    ...(o.output !== undefined || o.result !== undefined ? { output: o.output ?? o.result } : {}),
    ...(o.error ? { error: String(o.error) } : {}),
  };
}

export function toToolCalls(value: unknown): ToolCall[] {
  const v = parseMaybeJson(value);
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => {
    const t = toToolCall(c);
    return t ? [t] : [];
  });
}

/** `steps`, `sources` and `tool_calls` for the check scope of one result. */
export function checkScope(outputs: Record<string, unknown>, spanSteps: Step[]): { steps: Step[]; sources: Source[]; tool_calls: ToolCall[] } {
  const steps = [...spanSteps, ...stepsFromOutputs(outputs.steps)];
  const sources =
    outputs.sources !== undefined
      ? toSources(outputs.sources)
      : steps.filter((s) => s.kind === 'retrieval').flatMap((s) => toSources(s.output));
  const tool_calls =
    outputs.tool_calls !== undefined
      ? toToolCalls(outputs.tool_calls)
      : steps
          .filter((s) => s.kind === 'tool')
          .map((s) => ({ name: String(s.attributes.tool ?? s.name), args: parseMaybeJson(s.input ?? s.attributes.args ?? {}), ...(s.output !== undefined ? { output: s.output } : {}), ...(s.error ? { error: s.error } : {}) }));
  return { steps, sources, tool_calls };
}
