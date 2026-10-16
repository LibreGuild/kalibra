import { randomUUID } from 'node:crypto';
import { getPath } from './util.js';

/*
 * Templates use {{ path | filter | filter(arg) }}.
 *   {{question}}            row column (also {{row.question}})
 *   {{vars.base_url}}       target variable
 *   {{secret.my_key}}       secret value (never stored in definitions)
 *   {{output}}, {{outputs.x}}, {{response.status}}, {{metrics.latency_ms}} inside checks
 *   {{$uuid}} {{$timestamp}} {{$isoTimestamp}} {{$randomInt}}
 * Filters: json, raw, string, base64, dataurl, text, urlencode, upper, lower, trim, default(x), join(sep), first, last, length
 */

export interface TemplateEnv {
  /** Resolves {{secret.name}}. */
  secret?: (name: string) => Promise<string | undefined>;
  /** Loads the bytes of a file value ({blob: hash}). */
  loadFile?: (value: any) => Promise<Buffer>;
}

export type RenderMode = 'text' | 'json' | 'url';

const TAG = /\{\{\s*([\s\S]+?)\s*\}\}/g;

interface Expr {
  path: string;
  filters: { name: string; args: string[] }[];
}

function parseExpr(src: string): Expr {
  const segments = splitTopLevel(src, '|');
  const path = segments.shift()!.trim();
  const filters = segments.map((f) => {
    const m = f.trim().match(/^([A-Za-z_][\w]*)\s*(?:\((.*)\))?$/s);
    if (!m) return { name: f.trim(), args: [] };
    const args = m[2] != null ? splitTopLevel(m[2], ',').map((a) => unquote(a.trim())) : [];
    return { name: m[1], args };
  });
  return { path, filters };
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = (s: string) => (/^(['"]).*\1$/s.test(s) ? s.slice(1, -1) : s);

const isFileValue = (v: unknown): v is { blob: string } =>
  !!v && typeof v === 'object' && typeof (v as any).blob === 'string' && /^[a-f0-9]{64}$/.test((v as any).blob);

async function resolvePath(path: string, scope: Record<string, unknown>, env: TemplateEnv): Promise<unknown> {
  switch (path) {
    case '$uuid':
      return randomUUID();
    case '$timestamp':
      return Math.floor(Date.now() / 1000);
    case '$timestampMs':
      return Date.now();
    case '$isoTimestamp':
      return new Date().toISOString();
    case '$randomInt':
      return Math.floor(Math.random() * 1000);
  }
  if (/^(['"]).*\1$/s.test(path)) return path.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  if (path.startsWith('secret.')) {
    const name = path.slice(7);
    const v = await env.secret?.(name);
    if (v === undefined) throw new Error(`Secret "${name}" is not set`);
    return v;
  }
  return getPath(scope, path);
}

async function applyFilter(value: unknown, f: { name: string; args: string[] }, env: TemplateEnv): Promise<unknown> {
  switch (f.name) {
    case 'json':
    case 'raw':
    case 'string':
      return value;
    case 'base64':
      if (isFileValue(value)) return (await loadFile(value, env)).toString('base64');
      return Buffer.from(toText(value), 'utf8').toString('base64');
    case 'dataurl': {
      if (!isFileValue(value)) return `data:text/plain;base64,${Buffer.from(toText(value)).toString('base64')}`;
      const mime = (value as any).mime || 'application/octet-stream';
      return `data:${mime};base64,${(await loadFile(value, env)).toString('base64')}`;
    }
    case 'text':
      return isFileValue(value) ? (await loadFile(value, env)).toString('utf8') : toText(value);
    case 'urlencode':
      return encodeURIComponent(toText(value));
    case 'upper':
      return toText(value).toUpperCase();
    case 'lower':
      return toText(value).toLowerCase();
    case 'trim':
      return toText(value).trim();
    case 'default':
      return value === undefined || value === null || value === '' ? f.args[0] ?? '' : value;
    case 'join':
      return Array.isArray(value) ? value.map(toText).join(f.args[0] ?? ', ') : value;
    case 'first':
      return Array.isArray(value) ? value[0] : value;
    case 'last':
      return Array.isArray(value) ? value[value.length - 1] : value;
    case 'length':
      return Array.isArray(value) || typeof value === 'string' ? value.length : 0;
    default:
      throw new Error(`Unknown template filter "${f.name}"`);
  }
}

async function loadFile(value: unknown, env: TemplateEnv): Promise<Buffer> {
  if (!env.loadFile) throw new Error('File values are not available here');
  return env.loadFile(value);
}

export function toText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

async function evaluate(src: string, scope: Record<string, unknown>, env: TemplateEnv): Promise<{ value: unknown; raw: boolean }> {
  const expr = parseExpr(src);
  let value = await resolvePath(expr.path, scope, env);
  let raw = false;
  for (const f of expr.filters) {
    value = await applyFilter(value, f, env);
    raw = f.name === 'json' || f.name === 'raw';
  }
  return { value, raw };
}

/**
 * Renders a template to a string.
 * mode "json": interpolations are escaped for use inside a JSON string literal,
 * unless the last filter is `json`/`raw`, which inserts the value as raw JSON.
 */
export async function render(template: string, scope: Record<string, unknown>, env: TemplateEnv = {}, mode: RenderMode = 'text'): Promise<string> {
  if (!template.includes('{{')) return template;
  const parts: string[] = [];
  let last = 0;
  for (const m of template.matchAll(TAG)) {
    parts.push(template.slice(last, m.index));
    const { value, raw } = await evaluate(m[1], scope, env);
    if (mode === 'json') {
      parts.push(raw ? JSON.stringify(value ?? null) : JSON.stringify(toText(value)).slice(1, -1));
    } else if (mode === 'url') {
      parts.push(raw ? toText(value) : encodeURIComponent(toText(value)));
    } else {
      parts.push(toText(value));
    }
    last = m.index! + m[0].length;
  }
  parts.push(template.slice(last));
  return parts.join('');
}

/** Like render, but a template that is exactly one `{{expr}}` returns the value with its type intact. */
export async function renderValue(template: string, scope: Record<string, unknown>, env: TemplateEnv = {}): Promise<unknown> {
  const m = template.match(/^\s*\{\{\s*([\s\S]+?)\s*\}\}\s*$/);
  if (m && !m[1].includes('}}')) return (await evaluate(m[1], scope, env)).value;
  return render(template, scope, env);
}

/** Root variable names used by a template (to warn about unmapped placeholders). */
export function placeholders(template: string): string[] {
  const names = new Set<string>();
  for (const m of template.matchAll(TAG)) {
    const path = parseExpr(m[1]).path;
    if (/^(['"]).*\1$/s.test(path) || /^-?\d/.test(path)) continue;
    names.add(path.split(/[.[]/)[0]);
  }
  return [...names];
}
