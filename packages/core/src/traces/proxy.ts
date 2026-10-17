import { limitValue, newSpanId, newTraceId } from './ingest.js';
import type { TraceWithSpans } from './types.js';

/*
 * The OpenAI-compatible proxy (server: /api/projects/:p/proxy/openai/*) forwards calls to the
 * upstream unchanged and records each exchange as a trace with one `llm` span. This module turns
 * one exchange into that trace: model, messages/input, the answer text (also from a streamed
 * SSE response), token usage and status. The caller's Authorization header is never part of it.
 */

export interface ProxyExchange {
  method: string;
  /** Path after /proxy/openai, e.g. /v1/chat/completions. */
  path: string;
  requestBody: unknown;
  status: number;
  contentType: string;
  /** Response body as text (possibly truncated); SSE for streamed calls. */
  responseText: string;
  startedAt: string;
  durationMs: number;
  runId?: string;
  resultId?: string;
}

/** Concatenates the text of a streamed response: Chat Completions deltas or Responses API events. */
function fromSse(text: string): { output: string; usage?: Record<string, unknown>; model?: string } {
  let output = '';
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let e: any;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    model ??= e.model ?? e.response?.model;
    const delta = e.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') output += delta;
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') output += e.delta;
    if (e.usage) usage = e.usage;
    if (e.type === 'response.completed' && e.response?.usage) usage = e.response.usage;
  }
  return { output, usage, model };
}

/** The answer text of a non-streamed response (Chat Completions, Responses API, legacy completions). */
function fromJson(body: any): string | undefined {
  const choice = body?.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (choice?.message?.tool_calls) return JSON.stringify(choice.message.tool_calls);
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof body?.output_text === 'string') return body.output_text;
  const parts = Array.isArray(body?.output) ? body.output.flatMap((o: any) => (Array.isArray(o?.content) ? o.content : [])).filter((c: any) => typeof c?.text === 'string') : [];
  return parts.length ? parts.map((c: any) => c.text).join('') : undefined;
}

export function traceFromProxy(x: ProxyExchange): TraceWithSpans {
  const req = (x.requestBody && typeof x.requestBody === 'object' ? x.requestBody : {}) as Record<string, any>;
  const streamed = /text\/event-stream/i.test(x.contentType);
  let output: unknown;
  let usage: Record<string, any> | undefined;
  let model: string | undefined = typeof req.model === 'string' ? req.model : undefined;
  let error: string | undefined;
  if (streamed) {
    const s = fromSse(x.responseText);
    output = s.output;
    usage = s.usage;
    model = s.model ?? model;
  } else {
    let body: any;
    try {
      body = JSON.parse(x.responseText);
    } catch {
      body = x.responseText;
    }
    output = fromJson(body) ?? body;
    usage = body?.usage;
    model = body?.model ?? model;
    if (x.status >= 400) error = body?.error?.message ?? `HTTP ${x.status}`;
  }
  if (x.status >= 400 && !error) error = `HTTP ${x.status}`;
  const input = req.messages ?? req.input ?? req.prompt;
  const endpoint = x.path.replace(/^\/v\d+\//, '').replace(/\//g, '.') || 'request';
  const tokensIn = usage?.prompt_tokens ?? usage?.input_tokens;
  const tokensOut = usage?.completion_tokens ?? usage?.output_tokens;
  const traceId = newTraceId();
  return {
    id: traceId,
    name: `openai.${endpoint}`,
    source: 'proxy',
    status: error ? 'error' : 'ok',
    startedAt: x.startedAt,
    durationMs: x.durationMs,
    input: limitValue(input),
    output: limitValue(output),
    ...(error ? { error } : {}),
    metadata: { endpoint: x.path, ...(model ? { model } : {}) },
    tags: [],
    ...(x.runId ? { runId: x.runId } : {}),
    ...(x.resultId ? { resultId: x.resultId } : {}),
    spans: [
      {
        id: newSpanId(),
        traceId,
        name: model ?? endpoint,
        kind: 'llm',
        startedAt: x.startedAt,
        durationMs: x.durationMs,
        input: limitValue(input),
        output: limitValue(output),
        ...(error ? { error } : {}),
        attributes: {
          ...(model ? { model } : {}),
          ...(tokensIn !== undefined ? { tokens_in: tokensIn } : {}),
          ...(tokensOut !== undefined ? { tokens_out: tokensOut } : {}),
          status: x.status,
          streamed,
          ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
          ...(Array.isArray(req.tools) ? { tools: req.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean) } : {}),
        },
      },
    ],
  };
}
