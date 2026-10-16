/*
 * Levenshtein alignment over token sequences (words or characters) with a full backtrace.
 * The alignment drives WER/CER and the diff view in the results UI.
 * Memory is O(n·m): fine for utterances and paragraphs; split very long documents first.
 */

export type AlignOpKind = 'equal' | 'sub' | 'del' | 'ins';

export interface AlignOp {
  op: AlignOpKind;
  /** Reference token (absent for insertions). */
  ref?: string;
  /** Hypothesis token (absent for deletions). */
  hyp?: string;
}

export interface Alignment {
  ops: AlignOp[];
  hits: number;
  subs: number;
  dels: number;
  ins: number;
}

export function align(ref: string[], hyp: string[]): Alignment {
  const n = ref.length;
  const m = hyp.length;
  const w = m + 1;
  const d = new Uint32Array((n + 1) * w);
  for (let i = 0; i <= n; i++) d[i * w] = i;
  for (let j = 0; j <= m; j++) d[j] = j;

  for (let i = 1; i <= n; i++) {
    const r = ref[i - 1];
    for (let j = 1; j <= m; j++) {
      const diag = d[(i - 1) * w + (j - 1)] + (r === hyp[j - 1] ? 0 : 1);
      const del = d[(i - 1) * w + j] + 1;
      const ins = d[i * w + (j - 1)] + 1;
      d[i * w + j] = Math.min(diag, del, ins);
    }
  }

  // Backtrace from the end. Ties prefer equal/sub, then deletion, then insertion.
  const ops: AlignOp[] = [];
  let hits = 0, subs = 0, dels = 0, ins = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const cur = d[i * w + j];
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (d[(i - 1) * w + (j - 1)] + (same ? 0 : 1) === cur) {
        if (same) {
          ops.push({ op: 'equal', ref: ref[i - 1], hyp: hyp[j - 1] });
          hits++;
        } else {
          ops.push({ op: 'sub', ref: ref[i - 1], hyp: hyp[j - 1] });
          subs++;
        }
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && d[(i - 1) * w + j] + 1 === cur) {
      ops.push({ op: 'del', ref: ref[i - 1] });
      dels++;
      i--;
    } else {
      ops.push({ op: 'ins', hyp: hyp[j - 1] });
      ins++;
      j--;
    }
  }
  ops.reverse();
  return { ops, hits, subs, dels, ins };
}
