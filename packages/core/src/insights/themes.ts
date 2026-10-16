import { cosine } from '../providers/embeddings.js';

/*
 * Failure themes. Two layers:
 *  - free grouping: failed rows grouped by their first failing check and a normalised reason
 *    (numbers, ids and quoted values stripped), available instantly for every run;
 *  - AI themes: compact failure summaries clustered by embeddings (when available) or assigned
 *    by an LLM, then named with an explanation, a likely cause and a suggested fix.
 */

export interface FailureLite {
  id: string;
  status: string;
  passed: boolean | null;
  error: string | null;
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  checks: any[];
}

export interface FreeGroup {
  key: string;
  checkId: string;
  checkName: string;
  checkType: string;
  pattern: string;
  title: string;
  count: number;
  share: number;
  resultIds: string[];
  examples: { resultId: string; input: string; output: string; reason: string }[];
}

export interface Theme {
  id: string;
  title: string;
  explanation: string;
  cause: string;
  fix: string;
  severity: 'low' | 'medium' | 'high';
  count: number;
  resultIds: string[];
  examples: { resultId: string; input: string; output: string; reason: string }[];
}

const TEXT_LIMIT = 300;

export const isFailure = (r: FailureLite) => (r.status === 'done' || r.status === 'error') && (r.passed === false || r.status === 'error');

/** Strips the parts of a reason that vary per row so similar failures share one pattern. */
export function normalizeReason(reason: string): string {
  return (reason || '')
    .replace(/(["'“‘`])(?:(?!\1).){0,200}\1/g, '…') // quoted values
    .replace(/\b[a-z]{2,6}_[a-z0-9]{8,}\b/gi, '<id>') // kalibra-style ids (res_…, row_…)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>') // uuids
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>') // long hex
    .replace(/-?\d+(?:[.,]\d+)*\s*%?/g, '#') // numbers, percentages
    .replace(/#(?:\s*[-/x×]\s*#)+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Short, single-line preview of any value. */
export function preview(v: unknown, max = TEXT_LIMIT): string {
  if (v === undefined || v === null) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object' && typeof (v as any).blob === 'string') s = `[file: ${(v as any).name ?? 'file'}]`;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The most useful text of a row: text-like columns first, file columns by name. */
export function inputPreview(input: Record<string, unknown>, max = TEXT_LIMIT): string {
  const entries = Object.entries(input ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const strings = entries.filter(([, v]) => typeof v === 'string');
  const pick = (strings.length ? strings : entries).slice(0, 3);
  return preview(pick.map(([k, v]) => `${k}: ${preview(v, max)}`).join(' | '), max);
}

/** First failing check of a result, or a synthetic one for transport errors. */
export function firstFailure(r: FailureLite): { checkId: string; checkName: string; checkType: string; reason: string } {
  const c = (r.checks ?? []).find((x) => x.status === 'fail' || x.status === 'error');
  if (c) return { checkId: c.id, checkName: c.name || c.type, checkType: c.type, reason: c.reason ?? '' };
  if (r.error) return { checkId: '__error__', checkName: 'Target error', checkType: 'error', reason: r.error };
  return { checkId: '__score__', checkName: 'Score below threshold', checkType: 'score', reason: 'Weighted score below the pass threshold' };
}

export function failingReasons(r: FailureLite, max = 4): string[] {
  const out = (r.checks ?? [])
    .filter((x) => x.status === 'fail' || x.status === 'error')
    .slice(0, max)
    .map((x) => `${x.name || x.type}: ${preview(x.reason ?? '', 150)}`);
  if (!out.length && r.error) out.push(`Target error: ${preview(r.error, 150)}`);
  return out;
}

export function example(r: FailureLite) {
  return { resultId: r.id, input: inputPreview(r.input, 200), output: preview(r.outputs?.output ?? r.error ?? '', 200), reason: preview(firstFailure(r).reason, 200) };
}

/** Instant, free grouping of failures by first failing check + normalised reason. */
export function freeGroups(results: FailureLite[]): { total: number; groups: FreeGroup[] } {
  const failures = results.filter(isFailure);
  const map = new Map<string, FreeGroup>();
  for (const r of failures) {
    const f = firstFailure(r);
    const pattern = normalizeReason(f.reason) || 'no reason given';
    const key = `${f.checkId}|${pattern}`;
    let g = map.get(key);
    if (!g) {
      g = { key, checkId: f.checkId, checkName: f.checkName, checkType: f.checkType, pattern, title: `${f.checkName}: ${pattern}`, count: 0, share: 0, resultIds: [], examples: [] };
      map.set(key, g);
    }
    g.count++;
    g.resultIds.push(r.id);
    if (g.examples.length < 3) g.examples.push(example(r));
  }
  const groups = [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  for (const g of groups) g.share = failures.length ? Math.round((g.count / failures.length) * 10000) / 10000 : 0;
  return { total: failures.length, groups };
}

/** Compact text the embedder and the LLM see for one failure. */
export function summarize(r: FailureLite): string {
  return [`Input: ${inputPreview(r.input)}`, `Output: ${preview(r.outputs?.output ?? '', TEXT_LIMIT)}`, `Failed: ${failingReasons(r).join('; ')}`].join('\n');
}

/**
 * Centroid-linkage agglomerative clustering on cosine similarity. Merges the closest pair while it
 * is at least `threshold` similar, and keeps merging past the threshold until at most `maxClusters`
 * remain. Returns clusters as lists of item indexes, biggest first.
 */
export function agglomerate(vectors: number[][], threshold: number, maxClusters: number): number[][] {
  const clusters = vectors.map((v, i) => ({ members: [i], sum: [...v] }));
  for (;;) {
    if (clusters.length <= 1) break;
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = cosine(clusters[i].sum, clusters[j].sum);
        if (s > best) {
          best = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < threshold && clusters.length <= maxClusters) break;
    const a = clusters[bi];
    const b = clusters[bj];
    a.members.push(...b.members);
    for (let k = 0; k < a.sum.length; k++) a.sum[k] += b.sum[k];
    clusters.splice(bj, 1);
  }
  return clusters.map((c) => c.members).sort((x, y) => y.length - x.length);
}

export const THEME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'At most 6 words' },
    explanation: { type: 'string', description: 'What goes wrong, in one or two sentences' },
    cause: { type: 'string', description: 'Most likely cause' },
    fix: { type: 'string', description: 'Suggested fix' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['title', 'explanation', 'cause', 'fix', 'severity'],
};

export const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, ...THEME_SCHEMA.properties },
        required: ['id', 'title', 'explanation', 'cause', 'fix', 'severity'],
      },
    },
  },
  required: ['themes'],
};

export const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: { type: 'object', properties: { resultId: { type: 'string' }, themeId: { type: 'string' } }, required: ['resultId', 'themeId'] },
    },
  },
  required: ['assignments'],
};

export const clampTitle = (t: string) => {
  const words = (t || 'Untitled theme').trim().split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(' ')}…` : words.join(' ');
};

export const asSeverity = (s: unknown): Theme['severity'] => (s === 'high' || s === 'medium' || s === 'low' ? s : 'medium');
