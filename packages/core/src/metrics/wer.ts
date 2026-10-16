import { align, type AlignOp } from './align.js';
import { normalizeText, type NormalizeOptions, type NormalizerProfile } from './normalize.js';

/*
 * Word- and character-level error rates (same definitions as jiwer):
 *   N = H+S+D (reference units), P = H+S+I (hypothesis units)
 *   WER = (S+D+I)/N   MER = (S+D+I)/(H+S+D+I)   WIP = (H/N)·(H/P)   WIL = 1 − WIP
 * Empty reference: WER/MER = 1 if the hypothesis has any units, else 0; WIP = 1 when both are empty.
 * Corpus-level rates are Σerrors / ΣN over utterances — not the mean of per-utterance rates.
 */

export interface ErrorRateOptions {
  /** Normalizer applied to both sides first (default `none`: inputs are compared as given). */
  profile?: NormalizerProfile;
  normalize?: NormalizeOptions;
}

export interface ErrorCounts {
  hits: number;
  subs: number;
  dels: number;
  ins: number;
  ops: AlignOp[];
  normalizedRef: string;
  normalizedHyp: string;
}

export interface WordErrorResult extends ErrorCounts {
  wer: number;
  mer: number;
  wil: number;
  wip: number;
  refWords: number;
  hypWords: number;
}

export interface CharErrorResult extends ErrorCounts {
  cer: number;
  refChars: number;
  hypChars: number;
}

export const tokenizeWords = (text: string) => text.split(/\s+/).filter(Boolean);

function rates(h: number, s: number, d: number, i: number) {
  const n = h + s + d;
  const p = h + s + i;
  const errors = s + d + i;
  const er = n === 0 ? (p > 0 ? 1 : 0) : errors / n;
  const mer = h + errors === 0 ? 0 : errors / (h + errors);
  const wip = n === 0 && p === 0 ? 1 : n === 0 || p === 0 ? 0 : (h / n) * (h / p);
  return { er, mer, wip, wil: 1 - wip, n, p };
}

export function wordErrors(ref: string, hyp: string, opts: ErrorRateOptions = {}): WordErrorResult {
  const normalizedRef = normalizeText(ref ?? '', opts.profile ?? 'none', opts.normalize);
  const normalizedHyp = normalizeText(hyp ?? '', opts.profile ?? 'none', opts.normalize);
  const a = align(tokenizeWords(normalizedRef), tokenizeWords(normalizedHyp));
  const r = rates(a.hits, a.subs, a.dels, a.ins);
  return {
    ...a,
    wer: r.er,
    mer: r.mer,
    wip: r.wip,
    wil: r.wil,
    refWords: r.n,
    hypWords: r.p,
    normalizedRef,
    normalizedHyp,
  };
}

export function charErrors(ref: string, hyp: string, opts: ErrorRateOptions & { ignoreSpaces?: boolean } = {}): CharErrorResult {
  const prep = (t: string) => {
    const s = normalizeText(t ?? '', opts.profile ?? 'none', opts.normalize).replace(/\s+/g, ' ').trim();
    return opts.ignoreSpaces ? s.replace(/\s+/g, '') : s;
  };
  const normalizedRef = prep(ref);
  const normalizedHyp = prep(hyp);
  const a = align(Array.from(normalizedRef), Array.from(normalizedHyp));
  const r = rates(a.hits, a.subs, a.dels, a.ins);
  return { ...a, cer: r.er, refChars: r.n, hypChars: r.p, normalizedRef, normalizedHyp };
}

export interface Confusion {
  op: 'sub' | 'del' | 'ins';
  ref?: string;
  hyp?: string;
  count: number;
}

/** Most frequent substitutions, deletions and insertions across one or many alignments. */
export function topConfusions(opsList: AlignOp[] | AlignOp[][], limit = 20): Confusion[] {
  const lists = (Array.isArray(opsList[0]) ? opsList : [opsList]) as AlignOp[][];
  const counts = new Map<string, Confusion>();
  for (const ops of lists) {
    for (const o of ops) {
      if (o.op === 'equal') continue;
      const key = `${o.op}\u0000${o.ref ?? ''}\u0000${o.hyp ?? ''}`;
      const c = counts.get(key);
      if (c) c.count++;
      else counts.set(key, { op: o.op, ref: o.ref, hyp: o.hyp, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
