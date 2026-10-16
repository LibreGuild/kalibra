import { createHash } from 'node:crypto';
import { cosine } from '../providers/embeddings.js';
import { cellText, normalizeForCompare, type QualityRow } from './profile.js';

/*
 * Duplicate finders. exact = same text after normalising case/spacing/unicode; near = MinHash
 * estimate of character-shingle overlap (catches small edits and reorderings); semantic =
 * embeddings (catches paraphrases). All return groups of row ids; the first id is the oldest row.
 */

export interface DuplicateGroup {
  rowIds: string[];
  similarity: number;
  previews: string[];
}

export const NEAR_LIMIT = 5000;
export const SEMANTIC_LIMIT = 1500;
const EXHAUSTIVE_LIMIT = 1000;

/** The text a row is compared on: chosen columns (or every column) joined in a fixed order. */
export function rowText(row: QualityRow, columns?: string[]): string {
  const keys = columns?.length ? columns : Object.keys(row.data).sort();
  return keys.map((k) => cellText(row.data[k])).filter(Boolean).join(' ␞ ');
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

function toGroups(rows: QualityRow[], texts: string[], uf: UnionFind, sim: (members: number[]) => number): DuplicateGroup[] {
  const buckets = new Map<number, number[]>();
  rows.forEach((_, i) => {
    const r = uf.find(i);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r)!.push(i);
  });
  return [...buckets.values()]
    .filter((m) => m.length > 1)
    .map((m) => ({ rowIds: m.map((i) => rows[i].id), similarity: Math.round(sim(m) * 1000) / 1000, previews: m.map((i) => texts[i].slice(0, 140)) }))
    .sort((a, b) => b.rowIds.length - a.rowIds.length || b.similarity - a.similarity);
}

export function exactDuplicates(rows: QualityRow[], columns?: string[]): DuplicateGroup[] {
  const texts = rows.map((r) => rowText(r, columns));
  const uf = new UnionFind(rows.length);
  const first = new Map<string, number>();
  texts.forEach((t, i) => {
    const key = normalizeForCompare(t);
    if (!key) return;
    const j = first.get(key);
    if (j === undefined) first.set(key, i);
    else uf.union(j, i);
  });
  return toGroups(rows, texts, uf, () => 1);
}

// ── Near duplicates: MinHash over character 5-grams with LSH banding ────────

const K = 5;
const HASHES = 64;
const BANDS = 16; // 16 bands × 4 rows: pairs above ~0.6 Jaccard are very likely to become candidates

export function shingles(text: string): Set<string> {
  const t = normalizeForCompare(text).replace(/[^\p{L}\p{N} ]+/gu, '');
  const s = new Set<string>();
  if (t.length <= K) {
    if (t) s.add(t);
    return s;
  }
  for (let i = 0; i + K <= t.length; i++) s.add(t.slice(i, i + K));
  return s;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function hash32(s: string, seed: number): number {
  return createHash('md5').update(`${seed}:${s}`).digest().readUInt32LE(0);
}

function minhash(sh: Set<string>, base: Map<string, number>): number[] {
  const sig = new Array(HASHES).fill(0xffffffff);
  for (const g of sh) {
    let h = base.get(g);
    if (h === undefined) {
      h = hash32(g, 0);
      base.set(g, h);
    }
    // Cheap family of hash functions derived from one base hash (a·h + b mod prime).
    for (let i = 0; i < HASHES; i++) {
      const v = (Math.imul(h ^ (i * 0x9e3779b1), 0x85ebca6b) + i * 0xc2b2ae35) >>> 0;
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/** Large sets: MinHash signatures + LSH banding propose candidate pairs (pairs above ~0.6 are very likely found). */
function addBandCandidates(sets: Set<string>[], candidates: Set<string>) {
  const base = new Map<string, number>();
  const sigs = sets.map((s) => minhash(s, base));
  const per = HASHES / BANDS;
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map<string, number[]>();
    sigs.forEach((sig, i) => {
      if (!sets[i].size) return;
      const key = sig.slice(b * per, (b + 1) * per).join(',');
      const list = buckets.get(key);
      if (list) {
        for (const j of list) candidates.add(j < i ? `${j}:${i}` : `${i}:${j}`);
        list.push(i);
      } else buckets.set(key, [i]);
    });
  }
}

export function nearDuplicates(rows: QualityRow[], threshold = 0.8, columns?: string[]): { groups: DuplicateGroup[]; truncated: boolean } {
  const truncated = rows.length > NEAR_LIMIT;
  const use = rows.slice(0, NEAR_LIMIT);
  const texts = use.map((r) => rowText(r, columns));
  const sets = texts.map(shingles);
  const uf = new UnionFind(use.length);
  const pairSim = new Map<string, number>();
  const consider = (i: number, j: number) => {
    if (!sets[i].size || !sets[j].size) return;
    const s = jaccard(sets[i], sets[j]);
    if (s >= threshold) {
      uf.union(i, j);
      pairSim.set(`${i}:${j}`, s);
    }
  };
  if (use.length <= EXHAUSTIVE_LIMIT) {
    // Small sets: compare every pair exactly (MinHash banding can miss pairs at low thresholds).
    for (let i = 0; i < use.length; i++) for (let j = i + 1; j < use.length; j++) consider(i, j);
  } else {
    const candidates = new Set<string>();
    addBandCandidates(sets, candidates);
    for (const c of candidates) {
      const [i, j] = c.split(':').map(Number);
      consider(i, j);
    }
  }
  const groups = toGroups(use, texts, uf, (all) => {
    const m = all.slice(0, 30); // bounded: huge groups of copies would otherwise be quadratic
    let min = 1;
    for (let a = 0; a < m.length; a++) for (let b = a + 1; b < m.length; b++) min = Math.min(min, pairSim.get(`${m[a]}:${m[b]}`) ?? jaccard(sets[m[a]], sets[m[b]]));
    return min;
  });
  return { groups, truncated };
}

/** Paraphrase detection from embedding vectors (normalised cosine), single-link grouping. */
export function semanticDuplicates(rows: QualityRow[], vectors: number[][], threshold = 0.92, columns?: string[]): DuplicateGroup[] {
  const texts = rows.map((r) => rowText(r, columns));
  const uf = new UnionFind(rows.length);
  const sims = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    if (!texts[i].trim()) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (!texts[j].trim()) continue;
      const s = cosine(vectors[i], vectors[j]);
      if (s >= threshold) {
        uf.union(i, j);
        sims.set(`${i}:${j}`, s);
      }
    }
  }
  return toGroups(rows, texts, uf, (all) => {
    const m = all.slice(0, 30);
    const vals = [];
    for (let a = 0; a < m.length; a++) for (let b = a + 1; b < m.length; b++) vals.push(sims.get(`${m[a]}:${m[b]}`) ?? cosine(vectors[m[a]], vectors[m[b]]));
    return vals.length ? Math.min(...vals) : 1;
  });
}

/** Which row of a group to keep: the first (oldest) or the one with the most content. */
export function pickKeeper(group: string[], rowsById: Map<string, QualityRow>, keep: 'first' | 'longest'): string {
  if (keep === 'first') return group[0];
  return [...group].sort((a, b) => rowText(rowsById.get(b)!).length - rowText(rowsById.get(a)!).length)[0];
}
