/*
 * Turns whatever a traced function took or returned into plain JSON, safely and within a budget:
 * cycles, BigInt, Buffers, Maps/Sets, Errors, Dates and class instances all become something
 * readable, and no field grows beyond MAX_FIELD_BYTES. The walk stops as soon as the budget is
 * spent, so a huge value costs about as much as a 32 KB one.
 *
 * It runs when a step ends (so later mutations of your objects don't change what was recorded);
 * redaction, which is slower, runs later on the background flush (see redact.ts).
 */

export const MAX_FIELD_BYTES = 32 * 1024;
const MAX_DEPTH = 10;
const MAX_ITEMS = 200;
const MAX_STRING = 8 * 1024;

export interface Truncated {
  __truncated: true;
  preview: string;
}

/** A JSON-safe copy of `value`, at most about `budget` bytes once serialized. */
export function toJsonSafe(value: unknown, budget = MAX_FIELD_BYTES): unknown {
  const state = { left: budget, cut: false };
  const seen = new WeakSet<object>();
  const out = walk(value, 0, state, seen);
  if (!state.cut) return out;
  // Over budget: keep a readable preview instead of a half-copied structure.
  let preview = '';
  try {
    preview = JSON.stringify(out) ?? '';
  } catch {
    preview = String(out);
  }
  // Escaping (quotes, backslashes) grows the preview when serialized: trim until it fits.
  let p = preview.slice(0, budget - 64);
  while (p && JSON.stringify(p).length > budget - 32) p = p.slice(0, Math.floor(p.length * 0.9));
  return { __truncated: true, preview: p } satisfies Truncated;
}

function take(state: { left: number; cut: boolean }, n: number) {
  state.left -= n;
  if (state.left < 0) state.cut = true;
}

function walk(v: unknown, depth: number, state: { left: number; cut: boolean }, seen: WeakSet<object>): unknown {
  if (state.cut) return undefined;
  switch (typeof v) {
    case 'string': {
      const s = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… [${v.length - MAX_STRING} more characters]` : v;
      take(state, s.length + 2);
      return s;
    }
    case 'number':
      take(state, 8);
      return Number.isFinite(v) ? v : String(v);
    case 'boolean':
      take(state, 5);
      return v;
    case 'bigint':
      take(state, 20);
      return v.toString();
    case 'undefined':
      return undefined;
    case 'symbol':
      return v.toString();
    case 'function':
      return `[function ${(v as Function).name || 'anonymous'}]`;
  }
  if (v === null) {
    take(state, 4);
    return null;
  }
  const obj = v as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[too deep]';
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString();
  if (obj instanceof Error) return { name: obj.name, message: obj.message };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(obj)) return `[${obj.length} bytes]`;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return `[${(obj as ArrayBuffer).byteLength} bytes]`;
  if (typeof (obj as any).then === 'function') return '[promise]';
  seen.add(obj);
  try {
    if (Array.isArray(obj) || obj instanceof Set) {
      const items = Array.isArray(obj) ? obj : [...obj];
      const out: unknown[] = [];
      for (let i = 0; i < items.length && i < MAX_ITEMS && !state.cut; i++) {
        const x = walk(items[i], depth + 1, state, seen);
        out.push(x === undefined ? null : x);
      }
      if (items.length > MAX_ITEMS) out.push(`… ${items.length - MAX_ITEMS} more items`);
      return out;
    }
    const entries = obj instanceof Map ? [...obj.entries()].map(([k, x]) => [String(k), x] as const) : Object.entries(obj);
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of entries) {
      if (state.cut) break;
      if (n++ >= MAX_ITEMS) {
        out['…'] = `${entries.length - MAX_ITEMS} more keys`;
        break;
      }
      const y = walk(x, depth + 1, state, seen);
      if (y !== undefined) {
        take(state, k.length + 3);
        out[k] = y;
      }
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** A short, safe error description for traces. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 2000);
  if (typeof e === 'string') return e.slice(0, 2000);
  try {
    return JSON.stringify(toJsonSafe(e, 2000)) ?? String(e);
  } catch {
    return String(e);
  }
}
