import { render, renderValue, toText } from '../template.js';
import { evalExpression, runScript } from '../script.js';
import type { HttpTargetConfig, TargetSpec } from '../specs.js';
import { withTraceHeaders, type TargetCallContext, type TargetCallResult } from './types.js';
import {
  applyExtractors,
  capText,
  describeError,
  failure,
  headersToObject,
  isFileValue,
  isRetryableStatus,
  jsonPathValue,
  makeLogger,
  MASK,
  now,
  requestScope,
  trackSecrets,
  tryParseJson,
} from './common.js';

/*
 * HTTP target: renders a request template for one dataset row, sends it, and turns the response
 * into named outputs. Hooks (beforeRequest / afterResponse) cover anything the form can't express.
 */

/** The request handed to scripts and recorded with the result. */
export interface HttpRequestDraft {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** string for json/text, URLSearchParams for form, FormData for multipart, Buffer for binary. */
  body?: string | URLSearchParams | FormData | Buffer;
}

const BINARY_TYPES = /^(audio|image|video)\/|application\/(octet-stream|pdf|zip)/;
const MAX_STREAM_EVENTS = 500;

export async function executeHttp(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  const cfg = spec.config as HttpTargetConfig;
  const secrets = trackSecrets(ctx.env);
  const { logs, log } = makeLogger(secrets.mask);
  const env = secrets.env;
  const scope = requestScope(ctx);
  const started = now();

  // ── Build the request ────────────────────────────────────────────────────
  let draft: HttpRequestDraft;
  let bodySummary: unknown;
  try {
    const built = await buildRequest(cfg, scope, env, secrets.add, log);
    draft = built.draft;
    // Before the hook, so a beforeRequest script can see (or drop) them.
    withTraceHeaders(draft.headers, ctx.traceHeaders);
    bodySummary = built.summary;
  } catch (e) {
    return failure(`Could not build the request: ${(e as Error).message}`, logs);
  }

  if (cfg.scripts.beforeRequest.trim()) {
    try {
      const returned = await runScript(cfg.scripts.beforeRequest, { request: draft, row: ctx.row, vars: ctx.vars, log }, {
        log,
        timeoutMs: 10000,
        requireFrom: ctx.workspaceDir,
        filename: 'beforeRequest.js',
      });
      if (returned && typeof returned === 'object') draft = returned as HttpRequestDraft;
      if (typeof draft.body === 'string') bodySummary = draft.body;
    } catch (e) {
      return failure(`beforeRequest script failed: ${(e as Error).message}`, logs);
    }
  }

  const recorded = secrets.maskDeep({ method: draft.method, url: draft.url, headers: maskAuthHeaders(draft.headers), body: bodySummary });

  // ── Send ─────────────────────────────────────────────────────────────────
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeoutSignal]);
  let res: Response;
  try {
    res = await fetch(draft.url, {
      method: draft.method,
      headers: draft.headers,
      body: ['GET', 'HEAD'].includes(draft.method.toUpperCase()) ? undefined : (draft.body as any),
      redirect: cfg.followRedirects ? 'follow' : 'manual',
      signal,
    });
  } catch (e) {
    const { message, retryable } = describeError(e, cfg.timeoutMs, ctx.signal);
    return failure(message, logs, { request: recorded, retryable, metrics: { latency_ms: Math.round(now() - started) } });
  }
  const ttfb = now() - started;
  const headers = headersToObject(res.headers);
  const contentType = headers['content-type'] ?? '';
  const metrics: Record<string, number> = { ttfb_ms: Math.round(ttfb) };

  // ── Read the body ────────────────────────────────────────────────────────
  let text = '';
  let body: unknown;
  let streamText: string | undefined;
  let messages: { t: number; dir: 'in'; kind: string; data: unknown }[] | undefined;
  try {
    const streaming = cfg.streaming.mode !== 'none' && res.body && res.ok;
    if (streaming) {
      const out = await readStream(res, cfg, started, log);
      text = out.raw;
      messages = out.events;
      streamText = out.text;
      body = out.events.map((e) => e.data);
      if (out.ttft !== undefined) metrics.ttft_ms = Math.round(out.ttft);
      metrics.event_count = out.events.length;
    } else {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (BINARY_TYPES.test(contentType) && !contentType.includes('json')) {
        const info = await ctx.blobs.put(bytes, { mime: contentType.split(';')[0] });
        body = { blob: info.hash, mime: info.mime, size: info.size };
        log('info', `Saved ${info.size} byte ${info.mime} response as a file`);
      } else {
        text = bytes.toString('utf8');
        body = tryParseJson(text) ?? text;
      }
    }
  } catch (e) {
    const { message, retryable } = describeError(e, cfg.timeoutMs, ctx.signal);
    return failure(`Reading the response failed: ${message}`, logs, {
      request: recorded,
      retryable,
      response: { status: res.status, headers },
      metrics: { ...metrics, latency_ms: Math.round(now() - started) },
    });
  }
  metrics.latency_ms = Math.round(now() - started);
  metrics.status = res.status;

  // ── Outputs ──────────────────────────────────────────────────────────────
  const src = { body, text: streamText ?? text, raw: text, status: res.status, headers, messages };
  let outputs = applyExtractors(cfg.outputs, src, log);

  const response = { status: res.status, headers, body, text: capText(text), messages };
  if (cfg.scripts.afterResponse.trim()) {
    try {
      const extra = await runScript(cfg.scripts.afterResponse, { response, outputs, row: ctx.row, vars: ctx.vars, log }, {
        log,
        timeoutMs: 10000,
        requireFrom: ctx.workspaceDir,
        filename: 'afterResponse.js',
      });
      if (extra && typeof extra === 'object') outputs = { ...outputs, ...(extra as Record<string, unknown>) };
    } catch (e) {
      log('error', `afterResponse script failed: ${(e as Error).message}`);
      return { ok: true, request: recorded, response, outputs, metrics, logs, error: `afterResponse script failed: ${(e as Error).message}` };
    }
  }

  return {
    ok: true,
    request: recorded,
    response,
    outputs,
    metrics,
    logs,
    retryable: isRetryableStatus(res.status),
  };
}

async function buildRequest(
  cfg: HttpTargetConfig,
  scope: Record<string, unknown>,
  env: ReturnType<typeof trackSecrets>['env'],
  addSecret: (v: string) => unknown,
  log: (l: 'info' | 'warn' | 'error', m: string) => void,
): Promise<{ draft: HttpRequestDraft; summary: unknown }> {
  const urlText = (await render(cfg.url, scope, env)).trim();
  if (!urlText) throw new Error('URL is empty');
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error(`Invalid URL: ${urlText}`);
  }
  for (const q of cfg.query) {
    if (!q.enabled || !q.key) continue;
    url.searchParams.append(await render(q.key, scope, env), await render(q.value, scope, env));
  }

  const headers: Record<string, string> = {};
  for (const h of cfg.headers) {
    if (!h.enabled || !h.key) continue;
    headers[await render(h.key, scope, env)] = await render(h.value, scope, env);
  }

  // Auth
  const auth = cfg.auth;
  if (auth.type === 'bearer') {
    const token = await render(auth.token, scope, env);
    addSecret(token);
    headers['Authorization'] = `Bearer ${token}`;
  } else if (auth.type === 'api_key') {
    const value = await render(auth.value, scope, env);
    addSecret(value);
    if (auth.in === 'query') url.searchParams.set(auth.name, value);
    else headers[auth.name] = value;
  } else if (auth.type === 'basic') {
    const user = await render(auth.username, scope, env);
    const pass = await render(auth.password, scope, env);
    addSecret(pass);
    const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
    addSecret(encoded);
    headers['Authorization'] = `Basic ${encoded}`;
  }

  const hasHeader = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  const dropHeader = (name: string) => {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) delete headers[k];
  };

  // Body
  const b = cfg.body;
  let body: HttpRequestDraft['body'];
  let summary: unknown;
  switch (b.type) {
    case 'none':
      break;
    case 'json': {
      const rendered = await render(b.content, scope, env, 'json');
      try {
        JSON.parse(rendered);
      } catch (e) {
        log('warn', `Body is not valid JSON after rendering (${(e as Error).message}); sending it as-is`);
      }
      body = rendered;
      summary = tryParseJson(rendered) ?? rendered;
      if (!hasHeader('content-type')) headers['Content-Type'] = b.contentType || 'application/json';
      break;
    }
    case 'text': {
      body = await render(b.content, scope, env);
      summary = body;
      if (!hasHeader('content-type')) headers['Content-Type'] = b.contentType || 'text/plain; charset=utf-8';
      break;
    }
    case 'form': {
      const params = new URLSearchParams();
      for (const f of b.form) if (f.enabled && f.key) params.append(await render(f.key, scope, env), await render(f.value, scope, env));
      body = params;
      summary = Object.fromEntries(params);
      break;
    }
    case 'multipart': {
      const form = new FormData();
      const parts: unknown[] = [];
      for (const p of b.parts) {
        if (!p.name) continue;
        if (p.kind === 'file') {
          const value = await renderValue(p.value, scope, env);
          if (!isFileValue(value)) throw new Error(`Multipart part "${p.name}": ${p.value || '(empty)'} did not resolve to a file`);
          const bytes = await env.loadFile!(value);
          const filename = (await render(p.filename, scope, env)) || value.name || 'file';
          const type = p.contentType || value.mime || 'application/octet-stream';
          form.append(p.name, new Blob([new Uint8Array(bytes)], { type }), filename);
          parts.push({ name: p.name, file: filename, type, size: bytes.byteLength });
        } else {
          const value = await render(p.value, scope, env);
          form.append(p.name, value);
          parts.push({ name: p.name, value });
        }
      }
      if (hasHeader('content-type')) {
        log('warn', 'Removed the Content-Type header: multipart requests need the boundary the client generates');
        dropHeader('content-type');
      }
      body = form;
      summary = { multipart: parts };
      break;
    }
    case 'binary': {
      const value = await renderValue(b.binary, scope, env);
      if (!isFileValue(value)) throw new Error(`Binary body: ${b.binary || '(empty)'} did not resolve to a file`);
      body = await env.loadFile!(value);
      summary = { file: value.name ?? value.blob.slice(0, 12), size: body.byteLength };
      if (!hasHeader('content-type')) headers['Content-Type'] = b.contentType || value.mime || 'application/octet-stream';
      break;
    }
  }

  return { draft: { method: (cfg.method || 'GET').toUpperCase(), url: url.toString(), headers, body }, summary };
}

function maskAuthHeaders(headers: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? v.replace(/^(\w+)\s+.+$/, `$1 ${MASK}`) : v;
  }
  return out;
}

/** Reads SSE or NDJSON, concatenating the text at `textPath` from every event. */
async function readStream(res: Response, cfg: HttpTargetConfig, started: number, log: (l: 'info' | 'warn' | 'error', m: string) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { t: number; dir: 'in'; kind: string; data: unknown }[] = [];
  let raw = '';
  let buffer = '';
  let text = '';
  let ttft: number | undefined;
  let done = false;

  const handle = (data: string, kind: string) => {
    if (data === '[DONE]') {
      done = true;
      return;
    }
    const parsed = tryParseJson(data) ?? data;
    const t = now() - started;
    if (events.length < MAX_STREAM_EVENTS) events.push({ t: Math.round(t), dir: 'in', kind, data: parsed });
    const piece = cfg.streaming.textPath ? jsonPathValue(cfg.streaming.textPath, parsed) : typeof parsed === 'string' ? parsed : undefined;
    if (piece !== undefined && piece !== null && toText(piece) !== '') {
      if (ttft === undefined) ttft = t;
      text += toText(piece);
    }
    if (cfg.streaming.doneWhen.trim()) {
      try {
        if (evalExpression(cfg.streaming.doneWhen, { event: parsed })) done = true;
      } catch (e) {
        log('warn', `doneWhen expression failed: ${(e as Error).message}`);
      }
    }
  };

  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    if (cfg.streaming.mode === 'sse') {
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const dataLines = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''));
        const eventName = block.split(/\r?\n/).find((l) => l.startsWith('event:'))?.slice(6).trim() || 'message';
        if (dataLines.length) handle(dataLines.join('\n'), eventName);
        if (done) break;
      }
    } else {
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handle(line, 'line');
        if (done) break;
      }
    }
  }
  if (!done && buffer.trim() && cfg.streaming.mode === 'ndjson') handle(buffer.trim(), 'line');
  await reader.cancel().catch(() => undefined);
  return { raw, events, text, ttft };
}
