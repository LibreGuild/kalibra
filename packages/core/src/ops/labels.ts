import { z } from 'zod';
import type { Engine } from '../engine.js';
import { defineOp, type OpDef } from '../registry.js';
import { LabelRepo, type Label, type LabelRecord } from '../repo/labels.js';
import { invalid, parseJson } from '../util.js';

/*
 * Judge calibration. People label a sample of results; we compare the labels with what a check
 * (usually an LLM judge) decided: agreement, Cohen's kappa, TPR/TNR, a confusion matrix, and the
 * pass rate corrected for the check's known error rates.
 */

type Verdict = 'pass' | 'fail';

interface ScopedResult {
  id: string;
  runId: string;
  seq: number;
  verdict: Verdict | null; // null = skipped / not applicable
}

/** The check's verdict for a result. checkId '' = the row's overall pass/fail. Errors count as fail. */
function verdictOf(row: { passed: number | null; checks: string | null }, checkId: string): Verdict | null {
  if (!checkId) return row.passed === null ? null : row.passed ? 'pass' : 'fail';
  const c = parseJson<any[]>(row.checks, []).find((x) => x.id === checkId);
  if (!c || c.status === 'skip') return null;
  return c.status === 'pass' ? 'pass' : 'fail';
}

function scopeRuns(engine: Engine, i: { runId?: string; suiteId?: string }): string[] {
  if (i.suiteId) {
    const suite = engine.repos.defs.get('suite', i.suiteId);
    return engine.db.all('SELECT id FROM runs WHERE suite_id = ? AND deleted_at IS NULL', suite.id).map((r) => r.id as string);
  }
  if (i.runId) return [engine.repos.runs.get(i.runId).id];
  throw invalid('Pass runId or suiteId');
}

function scopedResults(engine: Engine, runIds: string[], checkId: string): ScopedResult[] {
  if (!runIds.length) return [];
  const marks = runIds.map(() => '?').join(',');
  return engine.db
    .all(`SELECT id, run_id, seq, passed, checks FROM results WHERE run_id IN (${marks}) AND status IN ('done','error') ORDER BY run_id, seq`, ...runIds)
    .map((r) => ({ id: r.id, runId: r.run_id, seq: r.seq, verdict: verdictOf(r, checkId) }));
}

const isHuman = (l: LabelRecord, includeAgents: boolean) => l.actor?.kind === 'user' || (includeAgents && (l.actor?.kind === 'agent' || l.actor?.kind === 'cli'));

export function kappaBand(k: number | null): string {
  if (k === null) return 'not enough data';
  if (k < 0) return 'poor (worse than chance)';
  if (k <= 0.2) return 'slight';
  if (k <= 0.4) return 'fair';
  if (k <= 0.6) return 'moderate';
  if (k <= 0.8) return 'substantial';
  return 'almost perfect';
}

/** Confusion counts with "pass" as the positive class. judge = the check, human = the label. */
export function confusion(pairs: { judge: Verdict; human: Verdict }[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of pairs) {
    if (p.judge === 'pass' && p.human === 'pass') tp++;
    else if (p.judge === 'pass' && p.human === 'fail') fp++;
    else if (p.judge === 'fail' && p.human === 'pass') fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

export function cohensKappa(c: { tp: number; fp: number; fn: number; tn: number }): number | null {
  const n = c.tp + c.fp + c.fn + c.tn;
  if (n === 0) return null;
  const po = (c.tp + c.tn) / n;
  const pe = ((c.tp + c.fp) * (c.tp + c.fn) + (c.fn + c.tn) * (c.fp + c.tn)) / (n * n);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

/** Rogan–Gladen correction: the true pass rate given an observed rate and the check's TPR/TNR. */
export function correctedRate(observed: number, tpr: number, tnr: number): number | null {
  const denom = tpr + tnr - 1;
  if (denom <= 0.05) return null;
  return Math.min(1, Math.max(0, (observed + tnr - 1) / denom));
}

/** Small seeded PRNG so bootstrap intervals are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x: number | null, d = 4) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function agreementStats(pairs: { judge: Verdict; human: Verdict; resultId?: string }[], observedPassRate: number | null, opts: { resamples?: number; seed?: number } = {}) {
  const c = confusion(pairs);
  const n = pairs.length;
  const humanPass = c.tp + c.fn;
  const humanFail = c.fp + c.tn;
  const tpr = humanPass ? c.tp / humanPass : null;
  const tnr = humanFail ? c.tn / humanFail : null;
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const kappa = cohensKappa(c);

  let corrected: number | null = null;
  let ci: [number, number] | null = null;
  let correctionNote = '';
  if (observedPassRate === null || tpr === null || tnr === null) {
    correctionNote = 'Needs labels on both passing and failing rows.';
  } else if (tpr + tnr <= 1.05) {
    correctionNote = 'The check is barely better than a coin flip on your labels, so its pass rate cannot be corrected.';
  } else {
    corrected = correctedRate(observedPassRate, tpr, tnr);
    const rand = mulberry32(opts.seed ?? 42);
    const samples: number[] = [];
    const B = opts.resamples ?? 1000;
    for (let b = 0; b < B; b++) {
      const boot = Array.from({ length: n }, () => pairs[Math.floor(rand() * n)]);
      const bc = confusion(boot);
      const bp = bc.tp + bc.fn;
      const bf = bc.fp + bc.tn;
      if (!bp || !bf) continue;
      const v = correctedRate(observedPassRate, bc.tp / bp, bc.tn / bf);
      if (v !== null) samples.push(v);
    }
    if (samples.length >= B * 0.5) {
      samples.sort((a, b) => a - b);
      ci = [samples[Math.floor(samples.length * 0.025)], samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.975) - 1)]];
    }
  }

  const warnings: string[] = [];
  if (n < 30) warnings.push(`Only ${n} labeled ${n === 1 ? 'row' : 'rows'}. Label at least 30, ideally about 50 passing and 50 failing, before trusting these numbers.`);
  else if (humanPass < 15 || humanFail < 15) warnings.push('Labels are lopsided. Add more of the rarer outcome (ideally ~50 of each) for stable TPR/TNR.');

  return {
    n,
    agreement: n ? round((c.tp + c.tn) / n) : null,
    kappa: round(kappa),
    kappaBand: kappaBand(kappa === null ? null : round(kappa)),
    tpr: round(tpr),
    tnr: round(tnr),
    precision: round(precision),
    confusion: c,
    humanPassRate: n ? round(humanPass / n) : null,
    observedPassRate: round(observedPassRate),
    correctedPassRate: round(corrected),
    correctedPassRateCi: ci ? ([round(ci[0])!, round(ci[1])!] as [number, number]) : null,
    correctionNote,
    warnings,
  };
}

/** Pairs of (check verdict, human label) for labeled rows in scope. */
function labeledPairs(engine: Engine, runIds: string[], checkId: string, includeAgents: boolean) {
  const results = new Map(scopedResults(engine, runIds, checkId).map((r) => [r.id, r]));
  const labels = new LabelRepo(engine.db).list(runIds, checkId).filter((l) => isHuman(l, includeAgents));
  const pairs: { judge: Verdict; human: Verdict; resultId: string; runId: string; note: string }[] = [];
  for (const l of labels) {
    const r = results.get(l.resultId);
    if (!r?.verdict) continue;
    pairs.push({ judge: r.verdict, human: l.label, resultId: l.resultId, runId: l.runId, note: l.note });
  }
  return { results: [...results.values()], pairs, labels };
}

function shuffle<T>(a: T[], rand = Math.random) {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const labelOps: OpDef<any, any>[] = [
  defineOp({
    name: 'label_result',
    title: 'Label a result',
    description:
      'Records a human pass/fail label on one result, either for one check (checkId) or for the whole row (no checkId). Labels are the ground truth used to measure how well a check or LLM judge agrees with people. Pass label null to remove a label.',
    category: 'runs',
    input: z.object({
      resultId: z.string(),
      checkId: z.string().default('').describe('Check id from the suite; empty = label the whole row'),
      label: z.enum(['pass', 'fail']).nullable(),
      note: z.string().default('').describe('Optional reason, useful when you disagree with the check'),
    }),
    handler: ({ engine, actor }, i) => {
      const result = engine.repos.runs.getResult(i.resultId);
      if (i.checkId && !result.checks.some((c: any) => c.id === i.checkId)) throw invalid(`Check "${i.checkId}" did not run on this result`);
      const repo = new LabelRepo(engine.db);
      const out = i.label === null ? (repo.clear(result.id, i.checkId), null) : repo.set({ runId: result.runId, resultId: result.id, checkId: i.checkId, label: i.label as Label, note: i.note }, actor);
      engine.events.emit({ type: 'result.updated', runId: result.runId, resultId: result.id });
      return { label: out };
    },
  }),

  defineOp({
    name: 'list_labels',
    title: 'List labels',
    description: 'Human labels recorded on a run\'s results, optionally for one check.',
    category: 'runs',
    readOnly: true,
    input: z.object({ runId: z.string(), checkId: z.string().optional() }),
    handler: ({ engine }, i) => new LabelRepo(engine.db).list([engine.repos.runs.get(i.runId).id], i.checkId),
  }),

  defineOp({
    name: 'next_to_label',
    title: 'Pick results to label',
    description:
      'Suggests results a person should label next for one check. "balanced" alternates rows the check passed and failed (best for calibration), "random" samples evenly, "unlabeled_failures" shows only rows the check failed, "disagreements" returns already-labeled rows where the label and the check disagree.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      runId: z.string(),
      checkId: z.string().default(''),
      strategy: z.enum(['balanced', 'random', 'disagreements', 'unlabeled_failures']).default('balanced'),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler: ({ engine }, i) => {
      const runIds = scopeRuns(engine, { runId: i.runId });
      const results = scopedResults(engine, runIds, i.checkId).filter((r) => r.verdict);
      const labels = new LabelRepo(engine.db).list(runIds, i.checkId).filter((l) => isHuman(l, false));
      const labeled = new Map(labels.map((l) => [l.resultId, l]));
      const shape = (r: ScopedResult) => ({ resultId: r.id, seq: r.seq, verdict: r.verdict, label: labeled.get(r.id)?.label ?? null });

      if (i.strategy === 'disagreements') {
        return { items: results.filter((r) => labeled.has(r.id) && labeled.get(r.id)!.label !== r.verdict).slice(0, i.limit).map(shape), remaining: 0 };
      }
      const open = results.filter((r) => !labeled.has(r.id));
      let picked: ScopedResult[];
      if (i.strategy === 'unlabeled_failures') picked = open.filter((r) => r.verdict === 'fail');
      else if (i.strategy === 'random') picked = shuffle(open);
      else {
        // Balanced: alternate between what the check passed and failed, starting with the rarer outcome.
        const passes = open.filter((r) => r.verdict === 'pass');
        const fails = open.filter((r) => r.verdict === 'fail');
        const [a, b] = fails.length < passes.length ? [fails, passes] : [passes, fails];
        picked = [];
        for (let k = 0; k < Math.max(a.length, b.length); k++) {
          if (a[k]) picked.push(a[k]);
          if (b[k]) picked.push(b[k]);
        }
      }
      return { items: picked.slice(0, i.limit).map(shape), remaining: picked.length };
    },
  }),

  defineOp({
    name: 'judge_agreement',
    title: 'Check vs human agreement',
    description:
      'Compares human labels with a check\'s verdicts (errors count as fail, skipped rows are ignored): agreement, Cohen\'s kappa, TPR, TNR, precision, a confusion matrix, the check\'s observed pass rate, and that pass rate corrected for the check\'s error rates with a 95% bootstrap interval. Scope is one run (runId) or every run of a suite (suiteId).',
    category: 'runs',
    readOnly: true,
    input: z.object({
      runId: z.string().optional(),
      suiteId: z.string().optional(),
      checkId: z.string().default(''),
      includeAgentLabels: z.boolean().default(false).describe('Also count labels made by coding agents or the CLI'),
    }),
    handler: ({ engine }, i) => {
      const runIds = scopeRuns(engine, i);
      const { results, pairs } = labeledPairs(engine, runIds, i.checkId, i.includeAgentLabels);
      const judged = results.filter((r) => r.verdict);
      const observed = judged.length ? judged.filter((r) => r.verdict === 'pass').length / judged.length : null;
      const stats = agreementStats(pairs, observed);
      return {
        scope: i.suiteId ? 'suite' : 'run',
        runs: runIds.length,
        checkId: i.checkId,
        judged: judged.length,
        ...stats,
        disagreements: pairs.filter((p) => p.judge !== p.human).map((p) => ({ resultId: p.resultId, runId: p.runId, check: p.judge, human: p.human, note: p.note })),
      };
    },
  }),
];
