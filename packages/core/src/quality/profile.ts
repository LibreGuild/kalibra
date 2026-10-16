import { deflateRawSync } from 'node:zlib';
import { sentenceBleu } from '../metrics/text.js';
import type { ColumnSpec } from '../specs.js';
import { percentile } from '../util.js';

/*
 * Dataset health report: is every column filled, are the categories balanced, and do the texts
 * actually vary? Pure functions over rows so they are cheap to test.
 */

export interface QualityRow {
  id: string;
  data: Record<string, unknown>;
  tags: string[];
  status: string;
}

export interface ColumnQuality {
  key: string;
  type: string;
  filled: number;
  empty: number;
  fillRate: number;
  distinct: number;
  categorical: boolean;
  topValues?: { value: string; count: number; share: number }[];
  /** Allowed values (enum) that no row uses yet. */
  missingValues?: string[];
  length?: { min: number; median: number; p90: number; max: number; histogram: { from: number; to: number; count: number }[] };
  diversity?: { distinct1: number; distinct2: number; compressionRatio: number; selfBleu: number | null; sampled: number };
}

export interface QualityFlag {
  level: 'info' | 'warn';
  kind: 'empty' | 'imbalanced' | 'missing_values' | 'low_variety' | 'duplicates' | 'small';
  column?: string;
  message: string;
  suggestion: string;
}

export interface QualityReport {
  rows: number;
  statuses: Record<string, number>;
  tags: { tag: string; count: number }[];
  columns: ColumnQuality[];
  exactDuplicateRows: number;
  flags: QualityFlag[];
}

const FILE_TYPES = new Set(['audio', 'image', 'file']);
const TEXT_TYPES = new Set(['text']);
const MAX_CATEGORIES = 30;

export const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Stable text form of any cell, for counting and comparing. */
export function cellText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof (v as any).blob === 'string') return `blob:${(v as any).blob}`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export const normalizeForCompare = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const words = (s: string) => normalizeForCompare(s).split(/[^\p{L}\p{N}']+/u).filter(Boolean);

/** Share of unique word n-grams across all texts (1 = every n-gram is new). */
export function distinctN(texts: string[], n: number): number {
  let total = 0;
  const seen = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + n <= w.length; i++) {
      seen.add(w.slice(i, i + n).join(' '));
      total++;
    }
  }
  return total ? seen.size / total : 1;
}

/** Raw size ÷ compressed size of all texts together. Repetitive, templated text compresses more (higher). */
export function compressionRatio(texts: string[]): number {
  const raw = Buffer.from(texts.join('\n'), 'utf8');
  if (raw.length < 64) return 1;
  return raw.length / Math.max(1, deflateRawSync(raw, { level: 9 }).length);
}

/** Average BLEU of each text against all the others (higher = more alike). Sampled for speed. */
export function selfBleu(texts: string[], sample = 200): number | null {
  const t = texts.filter((x) => x.trim()).slice(0, sample);
  if (t.length < 3) return null;
  let sum = 0;
  for (let i = 0; i < t.length; i++) {
    const refs = t.filter((_, j) => j !== i);
    sum += sentenceBleu(refs, t[i], { lowercase: true }).score;
  }
  return sum / t.length;
}

function histogram(values: number[], buckets = 8) {
  if (!values.length) return [];
  // A loop, not Math.min(...values): spreading 100k+ arguments overflows the call stack.
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) return [{ from: min, to: max, count: values.length }];
  const width = Math.ceil((max - min + 1) / buckets);
  const out = Array.from({ length: buckets }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width - 1, count: 0 }));
  for (const v of values) out[Math.min(buckets - 1, Math.floor((v - min) / width))].count++;
  return out.filter((b, i) => b.count > 0 || i < buckets - 1);
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function profileColumn(col: ColumnSpec, rows: QualityRow[]): ColumnQuality {
  const values = rows.map((r) => r.data[col.key]);
  const filledValues = values.filter((v) => !isEmpty(v));
  const n = rows.length;
  const out: ColumnQuality = {
    key: col.key,
    type: col.type,
    filled: filledValues.length,
    empty: n - filledValues.length,
    fillRate: n ? round(filledValues.length / n) : 1,
    distinct: new Set(filledValues.map(cellText)).size,
    categorical: false,
  };

  // Counted items: list columns count their items, everything else counts whole values.
  const items = col.type === 'list' ? filledValues.flatMap((v) => (Array.isArray(v) ? v.map(cellText) : [cellText(v)])) : filledValues.map(cellText);
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it, (counts.get(it) ?? 0) + 1);
  const categoricalType = !FILE_TYPES.has(col.type) && col.type !== 'json' && col.type !== 'messages';
  // A column is a category when its values repeat (on average ≥ 2 rows per value) and stay short;
  // unique free text (answers, prompts) is not, even when the dataset is small.
  const avgLen = items.length ? items.reduce((s, x) => s + x.length, 0) / items.length : 0;
  const repeats = counts.size > 0 && items.length / counts.size >= 2;
  out.categorical = !!col.enum?.length || (categoricalType && counts.size >= 1 && counts.size <= MAX_CATEGORIES && repeats && avgLen <= 40);
  if (out.categorical) {
    const allValues = new Set([...counts.keys(), ...(col.enum ?? [])]);
    out.topValues = [...allValues]
      .map((value) => ({ value, count: counts.get(value) ?? 0, share: items.length ? round((counts.get(value) ?? 0) / items.length) : 0 }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    if (col.enum?.length) out.missingValues = col.enum.filter((e) => !counts.has(e));
  }

  if (TEXT_TYPES.has(col.type) || col.type === 'json' || col.type === 'messages') {
    const lengths = filledValues.map((v) => cellText(v).length).sort((a, b) => a - b);
    if (lengths.length) {
      out.length = { min: lengths[0], median: percentile(lengths, 50)!, p90: percentile(lengths, 90)!, max: lengths[lengths.length - 1], histogram: histogram(lengths) };
    }
  }
  if (TEXT_TYPES.has(col.type) && !out.categorical && filledValues.length >= 2) {
    const texts = filledValues.map(cellText);
    out.diversity = {
      distinct1: round(distinctN(texts, 1)),
      distinct2: round(distinctN(texts, 2)),
      compressionRatio: round(compressionRatio(texts), 2),
      selfBleu: (() => {
        const s = selfBleu(texts);
        return s === null ? null : round(s);
      })(),
      sampled: Math.min(texts.length, 200),
    };
  }
  return out;
}

/** Rows whose data is identical to an earlier row (after trimming/case/whitespace normalization). */
export function countExactDuplicates(rows: QualityRow[]): number {
  const seen = new Set<string>();
  let dups = 0;
  for (const r of rows) {
    const key = JSON.stringify(Object.keys(r.data).sort().map((k) => [k, normalizeForCompare(cellText(r.data[k]))]));
    if (seen.has(key)) dups++;
    else seen.add(key);
  }
  return dups;
}

export function buildReport(columns: ColumnSpec[], allRows: QualityRow[]): QualityReport {
  const statuses: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  for (const r of allRows) {
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  // Rejected rows never run, so they don't count towards coverage or variety.
  const rows = allRows.filter((r) => r.status !== 'rejected');
  const cols = columns.map((c) => profileColumn(c, rows));
  const exactDuplicateRows = countExactDuplicates(rows);
  const flags: QualityFlag[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  if (rows.length > 0 && rows.length < 20) {
    flags.push({ level: 'info', kind: 'small', message: `Only ${rows.length} usable row${rows.length === 1 ? '' : 's'}`, suggestion: 'Small sets make pass rates jumpy. Aim for at least 30–50 rows per thing you want to measure.' });
  }
  if (exactDuplicateRows > 0) {
    flags.push({ level: 'warn', kind: 'duplicates', message: `${exactDuplicateRows} row${exactDuplicateRows === 1 ? ' is a copy' : 's are copies'} of other rows`, suggestion: 'Copies count the same case twice and inflate pass rates. Find duplicates and keep one of each.' });
  }
  for (const c of cols) {
    const spec = columns.find((x) => x.key === c.key)!;
    if (rows.length && c.empty > 0 && (spec.required || c.fillRate < 0.9)) {
      flags.push({ level: spec.required ? 'warn' : 'info', kind: 'empty', column: c.key, message: `${pct(1 - c.fillRate)} of rows have no ${c.key}`, suggestion: spec.required ? 'This column is required. Fill or remove those rows.' : 'Checks that use this column will skip those rows.' });
    }
    if (c.categorical && c.topValues && c.topValues.length >= 2 && c.topValues[0].share >= 0.8 && rows.length >= 5) {
      flags.push({ level: 'warn', kind: 'imbalanced', column: c.key, message: `"${c.topValues[0].value}" covers ${pct(c.topValues[0].share)} of ${c.key}`, suggestion: 'Results will mostly reflect one case. Fill gaps to add rows for the other values.' });
    }
    if (c.missingValues?.length) {
      flags.push({ level: 'warn', kind: 'missing_values', column: c.key, message: `No rows yet for ${c.key}: ${c.missingValues.slice(0, 5).join(', ')}${c.missingValues.length > 5 ? '…' : ''}`, suggestion: 'These allowed values are never tested. Fill gaps to add some.' });
    }
    const d = c.diversity;
    if (d && rows.length >= 10 && ((d.selfBleu ?? 0) >= 0.5 || d.distinct2 < 0.3 || d.compressionRatio >= 5)) {
      flags.push({ level: 'warn', kind: 'low_variety', column: c.key, message: `Rows in ${c.key} use very similar phrasing`, suggestion: 'Real users vary a lot. Generate more varied rows (different tone, length, wording) or add real examples.' });
    }
  }
  flags.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1));
  return {
    rows: allRows.length,
    statuses,
    tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 50),
    columns: cols,
    exactDuplicateRows,
    flags,
  };
}
