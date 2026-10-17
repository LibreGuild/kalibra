import type { Engine } from '../engine.js';
import type { GitInfo, RunRecord } from '../repo/runs.js';
import { notFound } from '../util.js';

/*
 * "Did this change make things better or worse?" for CI and evals run from code: compares a run
 * with a baseline run row by row and renders a short PR-friendly report.
 *
 * The default baseline is the latest completed run on the run's base branch (git.baseBranch, else
 * "main") with the same dataset and suite, and the same target when the run has one. Runs record
 * their branch when started by CI, the CLI or the SDK (git details), so `main` builds become the
 * baseline for pull requests.
 */

export interface EvalReport {
  run: {
    id: string;
    number: number;
    name: string;
    status: string;
    kind: string;
    passRate: number | null;
    passRateCi: [number, number] | null;
    passed: number;
    failed: number;
    errors: number;
    total: number;
    git: GitInfo | null;
  };
  baseline: { id: string; number: number; name: string; passRate: number | null; git: GitInfo | null } | null;
  /** Pass-rate change against the baseline (run − baseline), when both have one. */
  delta: number | null;
  /** Rows failing now that passed in the baseline, or are new and failing (most important first). */
  newFailures: { rowId: string; resultId: string; reason: string; wasInBaseline: boolean }[];
  /** Rows that failed in the baseline and pass now. */
  fixed: { rowId: string; resultId: string }[];
  /** Rows failing in both. */
  stillFailing: number;
}

/** Up to this many rows are listed in newFailures / fixed (the counts stay exact). */
const MAX_LISTED = 50;

const failed = (r: { passed: boolean | null; status: string; error: string | null }) => r.passed === false || r.status === 'error';

/** Why a row failed, in one line: its first failing check's reason, or the error. */
function failureReason(r: { error: string | null; checks: any[] }): string {
  const c = (r.checks ?? []).find((x) => x.status === 'fail' || x.status === 'error');
  if (c) return `${c.name}: ${c.reason ?? c.status}`;
  return r.error ?? 'failed';
}

/** Picks the baseline run for `run` (explicit id, or the latest on the base branch). */
export function pickBaseline(engine: Engine, run: RunRecord, baselineRunId?: string): RunRecord | undefined {
  if (baselineRunId) {
    const b = engine.repos.runs.get(baselineRunId);
    if (b.id === run.id) throw notFound('Baseline run (other than this one)', baselineRunId);
    return b;
  }
  const branch = run.git?.baseBranch || 'main';
  // A run on the base branch itself is compared with the previous run there.
  return engine.repos.runs.findBaseline({ datasetId: run.datasetId, suiteId: run.suiteId, targetId: run.targetId, branch, beforeNumber: run.number });
}

export function compareToBaseline(engine: Engine, runId: string, baselineRunId?: string): EvalReport {
  const { runs } = engine.repos;
  const run = runs.get(runId);
  const base = pickBaseline(engine, run, baselineRunId);
  const now = runs.allLite(run.id);
  const s = run.summary ?? {};
  const report: EvalReport = {
    run: {
      id: run.id,
      number: run.number,
      name: run.name,
      status: run.status,
      kind: run.kind,
      passRate: s.passRate ?? null,
      passRateCi: s.passRateCi ?? null,
      passed: s.passed ?? now.filter((r) => r.passed === true).length,
      failed: s.failed ?? now.filter((r) => r.passed === false).length,
      errors: now.filter((r) => r.status === 'error' || !!r.error).length,
      total: run.total,
      git: run.git,
    },
    baseline: base ? { id: base.id, number: base.number, name: base.name, passRate: base.summary?.passRate ?? null, git: base.git } : null,
    delta: null,
    newFailures: [],
    fixed: [],
    stillFailing: 0,
  };
  const key = (r: { rowId: string; rep: number }) => `${r.rowId}#${r.rep}`;
  const before = new Map((base ? runs.allLite(base.id) : []).map((r) => [key(r), r]));
  const newFailures: EvalReport['newFailures'] = [];
  for (const r of now) {
    const b = before.get(key(r));
    const isFail = failed(r);
    if (isFail && (!b || !failed(b))) newFailures.push({ rowId: r.rowId, resultId: r.id, reason: failureReason(r), wasInBaseline: !!b });
    else if (isFail) report.stillFailing++;
    else if (b && failed(b) && r.passed === true) report.fixed.push({ rowId: r.rowId, resultId: r.id });
  }
  // Regressions of rows the baseline had come before failures of rows that are new.
  newFailures.sort((a, b) => Number(b.wasInBaseline) - Number(a.wasInBaseline));
  report.newFailures = newFailures;
  if (report.baseline && report.run.passRate !== null && report.baseline.passRate !== null) {
    report.delta = Math.round((report.run.passRate - report.baseline.passRate) * 10_000) / 10_000;
  }
  return report;
}

/** Shortens the lists for API answers; counts are kept by the caller via the full arrays' lengths. */
export function trimReport(r: EvalReport): EvalReport & { counts: { newFailures: number; fixed: number } } {
  return { ...r, newFailures: r.newFailures.slice(0, MAX_LISTED), fixed: r.fixed.slice(0, MAX_LISTED), counts: { newFailures: r.newFailures.length, fixed: r.fixed.length } };
}

const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`);
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v * 100).toFixed(1)} pts`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160);

/** Marker so CI can find and update its own comment instead of adding a new one each push. */
export const REPORT_MARKER = '<!-- kalibra-eval -->';

/**
 * A short markdown report for pull requests and terminals: pass rate with its 95% interval, the
 * change against the baseline, and the first new failures with reasons.
 */
export function renderEvalReport(r: EvalReport & { counts?: { newFailures: number; fixed: number } }, opts: { url?: string; marker?: boolean; title?: string } = {}): string {
  const lines: string[] = [];
  if (opts.marker) lines.push(REPORT_MARKER);
  const counts = r.counts ?? { newFailures: r.newFailures.length, fixed: r.fixed.length };
  const status = r.run.status !== 'completed' ? ` (${r.run.status})` : '';
  const verdict = !r.baseline ? '' : counts.newFailures ? '⚠️ ' : (r.delta ?? 0) >= 0 ? '✅ ' : '';
  lines.push(`### ${verdict}${opts.title ?? 'Kalibra eval'}: ${r.run.name}${status}`);
  lines.push('');
  const ci = r.run.passRateCi ? ` (95% CI ${pct(r.run.passRateCi[0], 0)}–${pct(r.run.passRateCi[1], 0)})` : '';
  const judged = r.run.passed + r.run.failed;
  lines.push(`**Pass rate ${pct(r.run.passRate)}**${ci} · ${r.run.passed}/${judged} rows passed${r.run.errors ? ` · ${r.run.errors} errors` : ''}`);
  if (r.baseline) {
    const delta = r.delta === null ? '' : `: **${signed(r.delta)}**`;
    const where = r.baseline.git?.branch ? ` on \`${r.baseline.git.branch}\`` : '';
    lines.push(`Compared with run #${r.baseline.number}${where} (${pct(r.baseline.passRate)})${delta} · ${counts.newFailures} new failure${counts.newFailures === 1 ? '' : 's'} · ${counts.fixed} fixed`);
  } else {
    lines.push('No baseline yet: run the same dataset and suite on the base branch to compare future changes.');
  }
  if (r.newFailures.length) {
    lines.push('');
    lines.push('| Row | Why it fails |');
    lines.push('|---|---|');
    for (const f of r.newFailures.slice(0, 10)) lines.push(`| \`${f.rowId}\`${f.wasInBaseline ? '' : ' (new)'} | ${cell(f.reason)} |`);
    if (counts.newFailures > 10) lines.push(`| … | ${counts.newFailures - 10} more |`);
  }
  if (opts.url) {
    lines.push('');
    lines.push(`[Open run #${r.run.number} in Kalibra](${opts.url})`);
  }
  return `${lines.join('\n')}\n`;
}
