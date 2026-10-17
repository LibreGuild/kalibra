import { createHash } from 'node:crypto';

/*
 * Tool recordings are looked up by (tool name, hash of the arguments). The SDKs compute the same
 * hash, so the rule must stay identical everywhere (JS SDK, Python SDK, server):
 *
 *   canonical JSON = JSON with object keys sorted (recursively), arrays in order, no whitespace,
 *                    `undefined` object values dropped; non-finite numbers become null
 *   argsHash       = lowercase hex SHA-256 of the canonical JSON as UTF-8
 */

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as object)
      .filter((k) => (value as any)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return 'null';
}

export const argsHash = (args: unknown) => createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
