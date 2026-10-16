import { z } from 'zod';
import { toText } from '../template.js';
import { levenshteinSimilarity } from '../metrics/text.js';
import {
  ACTUAL_FIELD, actualSchema, asJson, deepEqual, defineCheck, errorOutcome, fail, round, text, toList, toNumber, value, verdict,
} from './common.js';
import type { CheckField } from './types.js';

/* Layer 3: content comparisons that need no model — exact, contains, regex, numeric, fuzzy. */

const caseField: CheckField = {
  key: 'caseInsensitive',
  label: 'Ignore case',
  kind: 'boolean',
  default: false,
  help: 'Treat upper- and lower-case letters as the same.',
};

function prepText(s: string, o: { trim?: boolean; caseInsensitive?: boolean; normalizeWhitespace?: boolean }) {
  let t = s;
  if (o.normalizeWhitespace) t = t.replace(/\s+/g, ' ');
  if (o.trim) t = t.trim();
  if (o.caseInsensitive) t = t.toLowerCase();
  return t;
}

export const equalsCheck = defineCheck({
  type: 'equals',
  label: 'Equals',
  category: 'content',
  layer: 3,
  description: 'Passes when the value exactly equals the expected value (objects are compared deeply).',
  config: z.object({
    actual: actualSchema,
    expected: z.string().default('{{expected}}'),
    trim: z.boolean().default(true),
    caseInsensitive: z.boolean().default(false),
    normalizeWhitespace: z.boolean().default(false),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'expected', label: 'Expected value', kind: 'template', default: '{{expected}}', help: 'What the value must equal. Usually a dataset column, e.g. {{expected}}.' },
    { key: 'trim', label: 'Trim spaces', kind: 'boolean', default: true, help: 'Ignore spaces and line breaks at the start and end.' },
    { ...caseField },
    { key: 'normalizeWhitespace', label: 'Collapse whitespace', kind: 'boolean', default: false, help: 'Treat runs of spaces, tabs and line breaks as a single space.' },
  ],
  async run(cfg, ctx) {
    const a = await value(cfg.actual, ctx);
    const e = await value(cfg.expected, ctx);
    if (a !== null && typeof a === 'object' && e !== null && typeof e === 'object') {
      return verdict(deepEqual(a, e), { reason: deepEqual(a, e) ? 'Equal' : 'Objects differ' });
    }
    if (a !== null && typeof a === 'object' && typeof e === 'string') {
      const pe = asJson(e);
      if (pe.ok) return verdict(deepEqual(a, pe.value), { reason: deepEqual(a, pe.value) ? 'Equal' : 'Objects differ' });
    }
    const at = prepText(toText(a), cfg);
    const et = prepText(toText(e), cfg);
    const ok = at === et;
    return verdict(ok, { reason: ok ? 'Equal' : `Got "${at.slice(0, 80)}", expected "${et.slice(0, 80)}"` });
  },
});

export const containsCheck = defineCheck({
  type: 'contains',
  label: 'Contains',
  category: 'content',
  layer: 3,
  description: 'Checks that the value contains any, all or none of a list of phrases.',
  config: z.object({
    actual: actualSchema,
    values: z.array(z.string()).default([]),
    mode: z.enum(['any', 'all', 'none']).default('any'),
    caseInsensitive: z.boolean().default(true),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'values', label: 'Phrases', kind: 'list', default: [], help: 'One phrase per item. An item like {{keywords}} can expand to a whole list from a dataset column.' },
    {
      key: 'mode',
      label: 'Must contain',
      kind: 'select',
      default: 'any',
      options: [
        { value: 'any', label: 'at least one' },
        { value: 'all', label: 'all of them' },
        { value: 'none', label: 'none of them' },
      ],
      help: '"none" is useful for forbidden phrases, e.g. internal names or apologies you never want to see.',
    },
    { ...caseField, default: true },
  ],
  async run(cfg, ctx) {
    const hay = prepText(await text(cfg.actual, ctx), cfg);
    const phrases: string[] = [];
    for (const item of cfg.values) phrases.push(...toList(await value(item, ctx)));
    if (phrases.length === 0) return errorOutcome('No phrases to look for');
    const found = phrases.filter((p) => hay.includes(prepText(p, cfg)));
    const missing = phrases.filter((p) => !found.includes(p));
    const ok = cfg.mode === 'any' ? found.length > 0 : cfg.mode === 'all' ? missing.length === 0 : found.length === 0;
    const reason =
      cfg.mode === 'none'
        ? found.length ? `Contains forbidden: ${found.join(', ')}` : 'None found'
        : cfg.mode === 'all' && missing.length ? `Missing: ${missing.join(', ')}` : `Found: ${found.join(', ') || 'none'}`;
    return verdict(ok, { score: cfg.mode === 'all' ? found.length / phrases.length : ok ? 1 : 0, reason, details: { found, missing } });
  },
});

export const regexCheck = defineCheck({
  type: 'regex',
  label: 'Regex',
  category: 'content',
  layer: 3,
  description: 'Checks the value against a regular expression.',
  config: z.object({
    actual: actualSchema,
    pattern: z.string().default(''),
    flags: z.string().default('i'),
    mustMatch: z.boolean().default(true),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'pattern', label: 'Pattern', kind: 'template', default: '', placeholder: '^\\d{4}-\\d{2}-\\d{2}$', help: 'A JavaScript regular expression. Can include dataset values, e.g. {{order_id}}.' },
    { key: 'flags', label: 'Flags', kind: 'text', default: 'i', help: 'Regex flags: i = ignore case, m = multi-line, s = dot matches newlines.' },
    { key: 'mustMatch', label: 'Must match', kind: 'boolean', default: true, help: 'Turn off to require that the pattern does NOT appear.' },
  ],
  async run(cfg, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(await text(cfg.pattern, ctx), cfg.flags.replace(/g/g, ''));
    } catch (e) {
      return errorOutcome(`Invalid regex: ${(e as Error).message}`);
    }
    const m = (await text(cfg.actual, ctx)).match(re);
    const ok = cfg.mustMatch ? !!m : !m;
    return verdict(ok, {
      reason: m ? `Matched "${m[0].slice(0, 80)}"` : 'No match',
      details: m ? { match: m[0], groups: m.slice(1) } : undefined,
    });
  },
});

export const numericCheck = defineCheck({
  type: 'numeric',
  label: 'Number',
  category: 'content',
  layer: 3,
  description: 'Compares a number with an expected value (with tolerance) or checks that it lies in a range.',
  config: z.object({
    actual: actualSchema,
    expected: z.string().default(''),
    tolerance: z.number().nonnegative().default(0),
    toleranceType: z.enum(['absolute', 'relative']).default('absolute'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'expected', label: 'Expected number', kind: 'template', default: '', help: 'Leave empty to only check the range. Can be a column, e.g. {{expected_total}}.' },
    { key: 'tolerance', label: 'Tolerance', kind: 'number', default: 0, help: 'How far the value may be from the expected number and still pass.' },
    {
      key: 'toleranceType',
      label: 'Tolerance type',
      kind: 'select',
      default: 'absolute',
      options: [
        { value: 'absolute', label: 'absolute (± units)' },
        { value: 'relative', label: 'relative (fraction, 0.05 = 5%)' },
      ],
      help: 'Absolute: ±tolerance. Relative: ±tolerance × expected.',
    },
    { key: 'min', label: 'Minimum', kind: 'number', help: 'Optional lower bound (inclusive).' },
    { key: 'max', label: 'Maximum', kind: 'number', help: 'Optional upper bound (inclusive).' },
  ],
  async run(cfg, ctx) {
    const raw = await value(cfg.actual, ctx);
    const a = toNumber(raw);
    if (a === undefined) return fail({ reason: `Not a number: ${toText(raw).slice(0, 80)}` });
    const problems: string[] = [];
    const expText = (await text(cfg.expected, ctx)).trim();
    if (expText) {
      const e = toNumber(expText);
      if (e === undefined) return errorOutcome(`Expected value is not a number: ${expText}`);
      const allowed = cfg.toleranceType === 'relative' ? cfg.tolerance * Math.abs(e) : cfg.tolerance;
      if (Math.abs(a - e) > allowed) problems.push(`${a} ≠ ${e} ± ${round(allowed)}`);
    }
    if (cfg.min !== undefined && a < cfg.min) problems.push(`${a} < min ${cfg.min}`);
    if (cfg.max !== undefined && a > cfg.max) problems.push(`${a} > max ${cfg.max}`);
    return verdict(problems.length === 0, { value: a, reason: problems.join('; ') || `${a}` });
  },
});

export const similarityCheck = defineCheck({
  type: 'similarity',
  label: 'Fuzzy match',
  category: 'content',
  layer: 3,
  description: 'Character-level similarity (Levenshtein) to the expected text. 1 = identical.',
  config: z.object({
    actual: actualSchema,
    expected: z.string().default('{{expected}}'),
    threshold: z.number().min(0).max(1).default(0.8),
    caseInsensitive: z.boolean().default(true),
    trim: z.boolean().default(true),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'expected', label: 'Expected text', kind: 'template', default: '{{expected}}', help: 'The text to compare with, usually a dataset column.' },
    { key: 'threshold', label: 'Minimum similarity', kind: 'number', default: 0.8, help: 'From 0 to 1. 0.8 means about 80% of characters match in order.' },
    { ...caseField, default: true },
    { key: 'trim', label: 'Trim spaces', kind: 'boolean', default: true, help: 'Ignore spaces at the start and end.' },
  ],
  async run(cfg, ctx) {
    const a = prepText(await text(cfg.actual, ctx), cfg);
    const e = prepText(await text(cfg.expected, ctx), cfg);
    const sim = levenshteinSimilarity(a, e);
    return verdict(sim >= cfg.threshold, { score: sim, value: round(sim), threshold: cfg.threshold, reason: `Similarity ${round(sim, 3)}` });
  },
});
