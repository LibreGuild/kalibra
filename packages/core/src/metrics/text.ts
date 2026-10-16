/*
 * Reference-based text metrics. All scores are 0..1 (higher is better).
 *   levenshteinSimilarity – 1 − edit distance / longer length (code points)
 *   sentenceBleu          – BLEU-4, 13a-like tokenization, sacreBLEU "exp" smoothing, effective order
 *   rougeL                – token LCS precision/recall/F1 (rouge-score style tokenization)
 *   tokenF1 / exactMatch  – SQuAD-style normalization (lowercase, no punctuation/articles)
 *   chrF                  – character n-gram F-score (n = 6, β = 2, whitespace ignored)
 */

export function levenshteinDistance(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = new Uint32Array(t.length + 1);
  let cur = new Uint32Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

export function levenshteinSimilarity(a: string, b: string): number {
  const len = Math.max(Array.from(a).length, Array.from(b).length);
  return len === 0 ? 1 : 1 - levenshteinDistance(a, b) / len;
}

// ── BLEU ──────────────────────────────────────────────────────────────────

/** Approximation of sacreBLEU's 13a tokenizer: punctuation split off, except , and . between digits. */
export function tokenize13a(text: string, lowercase = false): string[] {
  let s = ` ${lowercase ? text.toLowerCase() : text} `;
  s = s.replace(/<skipped>/g, '').replace(/-\n/g, '').replace(/\n/g, ' ');
  s = s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/([{-~[-` -&(-+:-@/])/g, ' $1 ');
  s = s.replace(/([^0-9])([.,])/g, '$1 $2 ');
  s = s.replace(/([.,])([^0-9])/g, ' $1 $2');
  s = s.replace(/([0-9])(-)/g, '$1 $2 ');
  return s.split(/\s+/).filter(Boolean);
}

function ngramCounts(tokens: string[], n: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const key = tokens.slice(i, i + n).join('\u0001');
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

export interface BleuResult {
  score: number;
  precisions: number[];
  brevityPenalty: number;
  hypLength: number;
  refLength: number;
}

export function sentenceBleu(ref: string | string[], hyp: string, opts: { maxN?: number; lowercase?: boolean } = {}): BleuResult {
  const maxN = opts.maxN ?? 4;
  const refs = (Array.isArray(ref) ? ref : [ref]).map((r) => tokenize13a(r ?? '', opts.lowercase));
  const h = tokenize13a(hyp ?? '', opts.lowercase);
  const hypLength = h.length;
  // Closest reference length (ties → shorter), as in sacreBLEU.
  const refLength = refs
    .map((r) => r.length)
    .reduce((best, len) => {
      const d = Math.abs(len - hypLength);
      const bd = Math.abs(best - hypLength);
      return d < bd || (d === bd && len < best) ? len : best;
    }, refs[0]?.length ?? 0);

  if (hypLength === 0) return { score: refLength === 0 ? 1 : 0, precisions: [], brevityPenalty: 0, hypLength, refLength };

  const precisions: number[] = [];
  let logSum = 0;
  let order = 0;
  let smooth = 1;
  for (let n = 1; n <= maxN; n++) {
    const hc = ngramCounts(h, n);
    let total = 0;
    for (const c of hc.values()) total += c;
    if (total === 0) break; // effective order: skip orders longer than the hypothesis
    const maxRef = new Map<string, number>();
    for (const r of refs) for (const [k, c] of ngramCounts(r, n)) maxRef.set(k, Math.max(maxRef.get(k) ?? 0, c));
    let correct = 0;
    for (const [k, c] of hc) correct += Math.min(c, maxRef.get(k) ?? 0);
    let p: number;
    if (correct === 0) {
      smooth *= 2;
      p = 1 / (smooth * total);
    } else p = correct / total;
    precisions.push(p);
    logSum += Math.log(p);
    order++;
  }
  const brevityPenalty = hypLength >= refLength ? 1 : Math.exp(1 - refLength / hypLength);
  const score = order === 0 ? 0 : brevityPenalty * Math.exp(logSum / order);
  return { score: Math.min(1, score), precisions, brevityPenalty, hypLength, refLength };
}

// ── ROUGE-L ───────────────────────────────────────────────────────────────

const rougeTokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);

function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}

export interface PRF {
  precision: number;
  recall: number;
  f1: number;
}

export function rougeL(ref: string, hyp: string): PRF {
  const r = rougeTokens(ref ?? '');
  const h = rougeTokens(hyp ?? '');
  if (r.length === 0 && h.length === 0) return { precision: 1, recall: 1, f1: 1 };
  const lcs = lcsLength(r, h);
  const precision = h.length ? lcs / h.length : 0;
  const recall = r.length ? lcs / r.length : 0;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

// ── Token F1 / exact match (SQuAD) ────────────────────────────────────────

export function squadNormalize(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenF1(ref: string, hyp: string): PRF & { exactMatch: boolean } {
  const r = squadNormalize(ref).split(' ').filter(Boolean);
  const h = squadNormalize(hyp).split(' ').filter(Boolean);
  const exactMatch = r.join(' ') === h.join(' ');
  if (r.length === 0 || h.length === 0) {
    const v = r.length === h.length ? 1 : 0;
    return { precision: v, recall: v, f1: v, exactMatch };
  }
  const counts = new Map<string, number>();
  for (const t of r) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of h) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      common++;
      counts.set(t, c - 1);
    }
  }
  if (common === 0) return { precision: 0, recall: 0, f1: 0, exactMatch };
  const precision = common / h.length;
  const recall = common / r.length;
  return { precision, recall, f1: (2 * precision * recall) / (precision + recall), exactMatch };
}

export const exactMatch = (ref: string, hyp: string) => squadNormalize(ref) === squadNormalize(hyp);

// ── chrF ──────────────────────────────────────────────────────────────────

export function chrF(ref: string, hyp: string, opts: { order?: number; beta?: number } = {}): number {
  const order = opts.order ?? 6;
  const beta = opts.beta ?? 2;
  const r = Array.from((ref ?? '').replace(/\s+/g, ''));
  const h = Array.from((hyp ?? '').replace(/\s+/g, ''));
  if (r.length === 0 && h.length === 0) return 1;
  let pSum = 0;
  let rSum = 0;
  let effective = 0;
  for (let n = 1; n <= order; n++) {
    const rc = ngramCounts(r, n);
    const hc = ngramCounts(h, n);
    let rTotal = 0;
    let hTotal = 0;
    for (const c of rc.values()) rTotal += c;
    for (const c of hc.values()) hTotal += c;
    if (rTotal === 0 || hTotal === 0) continue;
    let match = 0;
    for (const [k, c] of hc) match += Math.min(c, rc.get(k) ?? 0);
    pSum += match / hTotal;
    rSum += match / rTotal;
    effective++;
  }
  if (effective === 0) return 0;
  const p = pSum / effective;
  const rec = rSum / effective;
  if (p === 0 && rec === 0) return 0;
  const b2 = beta * beta;
  return ((1 + b2) * p * rec) / (b2 * p + rec);
}
