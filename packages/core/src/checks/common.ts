import { z } from 'zod';
import { render, renderValue, toText } from '../template.js';
import type { CheckField, CheckOutcome, CheckScope, CheckType } from './types.js';

/*
 * Helpers shared by the check implementations. `defineCheck` parses the config inside `run`, so a
 * check works the same whether the caller passes a raw config (API/MCP) or an already-parsed one.
 */

export function defineCheck<S extends z.ZodType>(def: {
  type: string;
  label: string;
  category: CheckType['category'];
  layer: number;
  description: string;
  config: S;
  fields: CheckField[];
  run: (config: z.output<S>, ctx: CheckScope) => Promise<CheckOutcome>;
}): CheckType<z.output<S>> {
  return {
    ...def,
    config: def.config as unknown as z.ZodType<z.output<S>>,
    run: async (cfg, ctx) => def.run(def.config.parse(cfg ?? {}) as z.output<S>, ctx),
  };
}

export const pass = (extra: Omit<CheckOutcome, 'status'> = {}): CheckOutcome => ({ status: 'pass', score: 1, ...extra });
export const fail = (extra: Omit<CheckOutcome, 'status'> = {}): CheckOutcome => ({ status: 'fail', score: 0, ...extra });
export const skip = (reason: string): CheckOutcome => ({ status: 'skip', reason });
export const errorOutcome = (reason: string, details?: Record<string, unknown>): CheckOutcome => ({ status: 'error', reason, details });
export const verdict = (ok: boolean, extra: Omit<CheckOutcome, 'status'> = {}) => (ok ? pass(extra) : fail(extra));

/** Resolves a template keeping types when it is a single {{expr}}. */
export const value = (template: string, ctx: CheckScope) => renderValue(template, ctx.scope, ctx.env);
/** Resolves a template to text. */
export const text = async (template: string, ctx: CheckScope) => toText(await renderValue(template, ctx.scope, ctx.env));
export const renderText = (template: string, ctx: CheckScope) => render(template, ctx.scope, ctx.env);

/** Parses JSON text; objects/arrays pass through. Returns `undefined` for non-JSON. */
export function asJson(v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (v !== null && typeof v === 'object') return { ok: true, value: v };
  if (typeof v === 'number' || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v !== 'string') return { ok: false, error: 'Value is empty' };
  const s = v.trim();
  if (!s) return { ok: false, error: 'Value is empty' };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

/** Turns a value into a list: arrays pass through, JSON arrays are parsed, other text splits on commas/newlines. */
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => toText(x).trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  const s = toText(v).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => toText(x).trim()).filter(Boolean);
    } catch {
      /* fall through to splitting */
    }
  }
  return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export const ACTUAL_FIELD: CheckField = {
  key: 'actual',
  label: 'Value to check',
  kind: 'template',
  default: '{{output}}',
  help: 'Which value is checked. {{output}} is the main output of your app; use {{outputs.name}} for other extracted fields.',
};

export const actualSchema = z.string().default('{{output}}');

export const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
