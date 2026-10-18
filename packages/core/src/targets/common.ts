import { JSONPath } from 'jsonpath-plus';
import { evalExpression, type LogEntry } from '../script.js';
import { placeholders, renderValue, type TemplateEnv } from '../template.js';
import type { BlobStore } from '../storage.js';
import type { MediaFile } from '../providers/types.js';
import type { Extractor } from '../specs.js';
import type { TargetCallContext, TargetCallResult } from './types.js';

/** Shared plumbing for target executors: logging, secret masking, scopes, extractors. */

export const MASK = '••••';

/** Collects the call's log lines (returned in `TargetCallResult.logs`), masking secret values rendered so far. */
export function makeLogger(mask: (text: string) => string = (t) => t) {
  const logs: LogEntry[] = [];
  const log = (level: LogEntry['level'], message: string) => {
    logs.push({ at: Date.now(), level, message: mask(message) });
  };
  return { logs, log };
}

/** Wraps the template env so every secret value rendered during this call can be masked in records. */
export function trackSecrets(env: TemplateEnv) {
  const values = new Set<string>();
  const tracked: TemplateEnv = {
    ...env,
    secret: async (name) => {
      const v = await env.secret?.(name);
      if (v) values.add(v);
      return v;
    },
  };
  const mask = (text: string): string => {
    let out = text;
    for (const v of values) if (v.length >= 3) out = out.split(v).join(MASK);
    return out;
  };
  const maskDeep = <T>(value: T): T => {
    if (values.size === 0 || value == null) return value;
    if (typeof value === 'string') return mask(value) as T;
    if (Array.isArray(value)) return value.map(maskDeep) as T;
    if (typeof value === 'object' && !(value instanceof Uint8Array)) {
      return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, maskDeep(v)])) as T;
    }
    return value;
  };
  return { env: tracked, add: (v: string) => v && values.add(v), mask, maskDeep };
}

/** Template scope for request rendering: row columns at top level plus row, vars, row_id. */
export function requestScope(ctx: TargetCallContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...ctx.row, row: ctx.row, vars: ctx.vars, row_id: ctx.rowId, ...extra };
}

export const isFileValue = (v: unknown): v is { blob: string; name?: string; mime?: string; size?: number } =>
  !!v && typeof v === 'object' && typeof (v as any).blob === 'string' && /^[a-f0-9]{64}$/.test((v as any).blob);

/**
 * Files (images, audio, PDFs) that a prompt refers to, e.g. `{{image}}` or `{{photos}}` for a list of
 * files: they are sent to the model as attachments, and the template sees a short note in their
 * place (`[attached file: cat.png]`), so the text still reads naturally. Returns the scope to render
 * with and the files in the order they appear.
 */
export async function attachPromptFiles(
  templates: (string | undefined)[],
  scope: Record<string, unknown>,
  blobs: BlobStore,
  opts: { extra?: string[]; env?: TemplateEnv } = {},
): Promise<{ scope: Record<string, unknown>; files: (MediaFile & { name?: string; blob: string })[] }> {
  const out = { ...scope };
  const files: (MediaFile & { name?: string; blob: string })[] = [];
  const add = async (f: { blob: string; name?: string; mime?: string }) => {
    if (files.some((x) => x.blob === f.blob)) return;
    const bytes = await blobs.get(f.blob);
    files.push({ data: new Uint8Array(bytes), mime: f.mime || (await blobs.info(f.blob))?.mime || 'application/octet-stream', name: f.name, blob: f.blob });
  };
  const used = new Set(templates.flatMap((t) => (t ? placeholders(t) : [])));
  for (const key of used) {
    const v = scope[key];
    const list = Array.isArray(v) && v.length && v.every(isFileValue) ? v : isFileValue(v) ? [v] : undefined;
    if (!list) continue;
    for (const f of list) await add(f);
    out[key] = list.map((f, i) => `[attached file: ${f.name ?? (list.length > 1 ? `${key} ${i + 1}` : key)}]`).join(' ');
  }
  // Explicit attachments (a mapping of file columns to message parts), not mentioned in the text.
  for (const tpl of (opts.extra ?? []).map((t) => t.trim()).filter(Boolean)) {
    const v = await renderValue(tpl, scope, opts.env);
    // A row without that file (an optional column) simply sends nothing for it.
    const list = (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && x !== '');
    if (!list.every(isFileValue)) throw new Error(`Attachment "${tpl}" did not resolve to a file (use a file column, e.g. {{image}})`);
    for (const f of list) await add(f);
  }
  return { scope: out, files };
}

/** JSONPath that can match several nodes returns an array; a plain path returns the single value. */
export function jsonPathValue(path: string, json: unknown): unknown {
  const p = path.trim();
  if (!p || p === '$') return json;
  if (json === undefined || json === null || typeof json !== 'object') return undefined;
  const multi = /\*|\.\.|\?\(|\[[^\]]*[,:][^\]]*\]/.test(p);
  const found = JSONPath({ path: p.startsWith('$') ? p : `$.${p}`, json: json as object, wrap: true }) as unknown[];
  if (multi) return found;
  return found.length ? found[0] : undefined;
}

export function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (!t || !(t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || /^-?\d/.test(t) || t === 'true' || t === 'false' || t === 'null')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

export interface ExtractSource {
  body: unknown;
  text: string;
  status?: number;
  headers?: Record<string, string>;
  messages?: unknown[];
  [key: string]: unknown;
}

export function applyExtractors(extractors: Extractor[], src: ExtractSource, log: (l: LogEntry['level'], m: string) => void) {
  const outputs: Record<string, unknown> = {};
  for (const ex of extractors) {
    try {
      outputs[ex.name] = extractOne(ex, src);
    } catch (e) {
      log('warn', `Output "${ex.name}" (${ex.from} ${ex.path}) failed: ${(e as Error).message}`);
      outputs[ex.name] = undefined;
    }
  }
  return outputs;
}

function extractOne(ex: Extractor, src: ExtractSource): unknown {
  switch (ex.from) {
    case 'json': {
      const body = src.body !== undefined && typeof src.body !== 'string' ? src.body : tryParseJson(src.text);
      return jsonPathValue(ex.path, body);
    }
    case 'text':
      return isFileValue(src.body) ? src.body : src.text;
    case 'header':
      return src.headers?.[ex.path.toLowerCase()];
    case 'status':
      return src.status;
    case 'regex': {
      const m = src.text.match(new RegExp(ex.path));
      return m ? (m[1] ?? m[0]) : undefined;
    }
    case 'expression':
      return evalExpression(ex.path, { ...src });
  }
}

export function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

export const now = () => performance.now();

export function failure(error: string, logs: LogEntry[], extra: Partial<TargetCallResult> = {}): TargetCallResult {
  return { ok: false, outputs: {}, metrics: {}, error, logs, retryable: false, ...extra };
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

/** Describes why a fetch/socket failed in plain words and whether a retry might help. */
export function describeError(e: unknown, timeoutMs: number, signal: AbortSignal): { message: string; retryable: boolean } {
  const err = e as any;
  if (signal.aborted) return { message: 'Cancelled', retryable: false };
  if (err?.name === 'TimeoutError') return { message: `Timed out after ${timeoutMs} ms`, retryable: true };
  if (err?.name === 'AbortError') return { message: 'Aborted', retryable: true };
  const cause = err?.cause?.code || err?.cause?.message || err?.code;
  const msg = err?.message ?? String(e);
  return { message: cause && !msg.includes(cause) ? `${msg} (${cause})` : msg, retryable: true };
}

export const capText = (s: string, max = 2_000_000) => (s.length > max ? s.slice(0, max) : s);
