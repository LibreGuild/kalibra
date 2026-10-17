/*
 * Tools your agent calls (search, refunds, emails…), wrapped so evals can run them safely:
 *
 *   live            call the real function (default)
 *   record          call it and save the arguments and result in Kalibra
 *   replay          return the saved result for the same arguments; call for real if none
 *   replay-strict   return the saved result; fail if there is none
 *   fault:timeout | fault:error | fault:empty    fail on purpose, without calling
 *
 * The mode comes from the `x-kalibra-tools` header of the request Kalibra made (see headers.ts),
 * else `KALIBRA_TOOLS`, else live. Each call is also recorded as a `tool` span.
 *
 * Recordings are found by (tool name, sha256 of the canonical JSON of the arguments): see
 * `canonicalJson` — the Python SDK and the server compute exactly the same string.
 */

import { createHash } from 'node:crypto';
import { envToolMode } from './config.js';
import { current } from './context.js';
import { describeError } from './serialize.js';
import { getConfig, isEnabled, offForGood, onFlush, runSpan } from './tracer.js';
import { warnOnce } from './warn.js';

export type ToolMode = 'live' | 'record' | 'replay' | 'replay-strict' | 'fault:timeout' | 'fault:error' | 'fault:empty';

const MODES = new Set<string>(['live', 'record', 'replay', 'replay-strict', 'fault:timeout', 'fault:error', 'fault:empty']);

/** The tool mode for the current call. */
export function toolMode(): ToolMode {
  const m = current()?.link?.tools ?? envToolMode() ?? 'live';
  if (MODES.has(m)) return m as ToolMode;
  warnOnce(`tool-mode-${m}`, `Unknown tool mode "${m}"; using live`);
  return 'live';
}

/**
 * Canonical JSON: like JSON.stringify without spaces, with object keys sorted (by UTF-16 code
 * units), `undefined`/functions left out of objects and turned into null in arrays, non-finite
 * numbers as null, BigInt as a string, Dates as ISO strings. Numbers use JavaScript's shortest
 * form, so `1.0` is written `1`: pass integers or strings as arguments for hashes that match
 * across languages.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (v: unknown, inArray: boolean): string | undefined => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'string':
        return JSON.stringify(v);
      case 'number':
        return Number.isFinite(v) ? JSON.stringify(v) : 'null';
      case 'boolean':
        return v ? 'true' : 'false';
      case 'bigint':
        return JSON.stringify(v.toString());
      case 'undefined':
      case 'function':
      case 'symbol':
        return inArray ? 'null' : undefined;
    }
    const o = v as any;
    if (typeof o.toJSON === 'function') return enc(o.toJSON(), inArray);
    if (seen.has(o)) throw new TypeError('Tool arguments contain a cycle');
    seen.add(o);
    try {
      if (Array.isArray(o)) return `[${o.map((x) => enc(x, true)).join(',')}]`;
      const keys = Object.keys(o).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const x = enc(o[k], false);
        if (x !== undefined) parts.push(`${JSON.stringify(k)}:${x}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(o);
    }
  };
  return enc(value, false) ?? 'null';
}

/** sha256 (hex) of the canonical JSON of the arguments. */
export const argsHash = (args: unknown) => createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');

/** The arguments as recorded: the single argument when there is one, else the argument list. */
export const argsValue = (args: unknown[]) => (args.length === 1 ? args[0] : args);

// ── Talking to Kalibra ────────────────────────────────────────────────────────

const cache = new Map<string, { found: boolean; output?: unknown; error?: string }>();
const pending = new Set<Promise<void>>();
onFlush(async () => void (await Promise.allSettled([...pending])));

function endpoint(query?: Record<string, string>) {
  const c = getConfig();
  const url = `${c.url}/api/projects/${encodeURIComponent(c.project)}/ingest/tools`;
  return query ? `${url}?${new URLSearchParams(query)}` : url;
}

const headers = () => ({ 'content-type': 'application/json', authorization: `Bearer ${getConfig().key}` });

async function lookup(tool: string, hash: string) {
  const key = `${tool}\u0000${hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await fetch(endpoint({ tool, argsHash: hash }), { headers: headers(), signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`Kalibra answered HTTP ${res.status} for the recording of ${tool}`);
  const body: any = await res.json();
  const d = body?.data ?? body;
  const found = { found: !!d?.found, output: d?.output, error: d?.error ?? undefined };
  if (found.found) cache.set(key, found);
  return found;
}

/** A value as plain JSON data, in full (BigInt as a string). Throws on cycles. */
function plainJson(value: unknown): unknown {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return text === undefined ? undefined : JSON.parse(text);
}

function record(tool: string, args: unknown, hash: string, output: unknown, error?: string) {
  // Exact values, not the shortened copies traces keep (serialize.ts): the server stores the
  // recording under its own hash of `args`, and replay must hand back the real result.
  let body: string;
  try {
    body = JSON.stringify({ tool, args: JSON.parse(canonicalJson(args)), argsHash: hash, output: plainJson(output), error });
  } catch (e: any) {
    warnOnce(`record-json-${tool}`, `Could not save a recording of ${tool}: its result is not plain JSON (${e?.message ?? e})`);
    return;
  }
  const p = fetch(endpoint(), { method: 'POST', headers: headers(), body, signal: AbortSignal.timeout(10_000) })
    .then((res) => {
      if (!res.ok) warnOnce(`record-${res.status}`, `Kalibra did not save a tool recording (HTTP ${res.status})`);
    })
    .catch((e) => warnOnce('record-net', `Could not save a tool recording: ${e?.message ?? e}`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

class ToolFault extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

// ── The wrapper ───────────────────────────────────────────────────────────────

/**
 * Wraps a tool so evals can record, replay or break it on purpose.
 *
 *   const searchOrders = kalibra.tool('search_orders', realSearchOrders);
 *
 * In `live` mode the function runs as before (sync stays sync). The other modes return a Promise.
 * With the SDK off (after `init`), returns `fn` itself.
 */
export function tool<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  if (offForGood()) return fn;
  const wrapped = function (this: unknown, ...args: A): R {
    if (!isEnabled()) return fn.apply(this, args);
    const mode = toolMode();
    const value = argsValue(args);
    const attrs = { tool: name, mode };
    const live = () => fn.apply(this, args);
    if (mode === 'live') return runSpan(name, 'tool', () => value, undefined, live, { attributes: attrs });
    return runSpan(name, 'tool', () => value, undefined, (span) => run(name, mode, value, live, span) as R, { attributes: attrs });
  };
  try {
    Object.defineProperty(wrapped, 'name', { value: fn.name || name });
  } catch {
    /* cosmetic only */
  }
  return wrapped;
}

async function run(name: string, mode: ToolMode, value: unknown, live: () => unknown, span: { setAttributes(a: Record<string, unknown>): void }): Promise<unknown> {
  if (mode === 'fault:timeout') throw new ToolFault('TimeoutError', `${name} timed out (simulated by Kalibra)`);
  if (mode === 'fault:error') throw new ToolFault('ToolError', `${name} failed (simulated by Kalibra)`);
  if (mode === 'fault:empty') return null;

  let hash: string;
  try {
    hash = argsHash(value);
  } catch (e: any) {
    warnOnce('hash', `Could not hash the arguments of ${name}: ${e?.message ?? e}; calling it for real`);
    return live();
  }

  if (mode === 'record') {
    try {
      const out = await live();
      record(name, value, hash, out);
      return out;
    } catch (e) {
      record(name, value, hash, undefined, describeError(e));
      throw e;
    }
  }

  // replay / replay-strict
  let found: { found: boolean; output?: unknown; error?: string } = { found: false };
  try {
    found = await lookup(name, hash);
  } catch (e: any) {
    if (mode === 'replay-strict') throw new ToolFault('ReplayError', `No recording of ${name} available: ${e?.message ?? e}`);
    warnOnce('replay-net', `Could not read tool recordings (${e?.message ?? e}); calling tools for real`);
  }
  if (found.found) {
    span.setAttributes({ replayed: true });
    if (found.error) throw new ToolFault('ToolError', found.error);
    return found.output;
  }
  if (mode === 'replay-strict') throw new ToolFault('ReplayError', `No recording of ${name} for these arguments (sha256 ${hash.slice(0, 12)}…)`);
  span.setAttributes({ replayed: false });
  return live();
}

/** For tests. */
export function clearToolCache() {
  cache.clear();
}
