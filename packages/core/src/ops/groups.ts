import { z } from 'zod';
import { defineOp, type OpDef } from '../registry.js';
import { RunOverrides, RunSettings, TargetSpec } from '../specs.js';
import { applyOverrides } from '../runner/overrides.js';
import { invalid } from '../util.js';
import type { Engine } from '../engine.js';
import type { RunRecord } from '../repo/runs.js';
import { mcnemarExact, prepareRun, runPreflight } from './runs.js';

/*
 * Comparisons: one dataset and suite, several variants (targets, or one target with different
 * models / prompts / variables via run overrides). Each variant is an ordinary run tagged with the
 * comparison id, all pinned to the same dataset version, so rows pair up for significance tests.
 */

const Variant = z.object({
  target: z.string().describe('Target id or name'),
  label: z.string().default('').describe('Short name shown in the leaderboard'),
  overrides: RunOverrides.optional(),
});

const BaseSettings = RunSettings.omit({ overrides: true });

const ACTIVE = new Set(['queued', 'running']);

function variantSummary(engine: Engine, run: RunRecord) {
  const s = run.summary ?? {};
  const lat = s.metrics?.latency_ms;
  const out = s.metrics?.output_tokens;
  let targetName: string | null = null;
  try {
    targetName = run.targetId ? engine.repos.defs.get('target', run.targetId).name : null;
  } catch {
    targetName = null;
  }
  return {
    runId: run.id,
    number: run.number,
    label: run.variantLabel ?? run.name,
    targetId: run.targetId,
    targetName,
    overrides: run.settings.overrides ?? null,
    status: run.status,
    active: engine.runner.isActive(run.id),
    done: run.done,
    total: run.total,
    passRate: s.passRate ?? null,
    passRateCi: s.passRateCi ?? null,
    meanScore: s.meanScore ?? null,
    checks: (s.checks ?? []).map((c: any) => ({ id: c.id, name: c.name, type: c.type, passRate: c.passRate, corpus: c.corpus ?? null })),
    latencyP50: lat?.p50 ?? null,
    latencyP95: lat?.p95 ?? null,
    outputTokens: out ? Math.round(out.mean * out.count) : null,
  };
}

/** Paired outcomes per row (row id + repetition) for each run. */
/** running while any variant runs; completed only when every variant completed. */
function groupStatus(vs: { active: boolean; status: string }[]) {
  if (vs.some((v) => v.active || ACTIVE.has(v.status))) return 'running';
  if (vs.length && vs.every((v) => v.status === 'completed')) return 'completed';
  return vs.some((v) => v.status === 'failed') ? 'failed' : 'stopped';
}

function outcomes(engine: Engine, runId: string) {
  return new Map(engine.repos.runs.allLite(runId).filter((r) => r.passed !== null).map((r) => [`${r.rowId}#${r.rep}`, r.passed as boolean]));
}

type Rankable = { passRate: number | null; meanScore: number | null; latencyP50: number | null };

/** Higher pass rate first, then higher mean score, then lower median latency. */
const byRank = (a: Rankable, b: Rankable) =>
  ((b.passRate ?? -1) - (a.passRate ?? -1)) || ((b.meanScore ?? 0) - (a.meanScore ?? 0)) || ((a.latencyP50 ?? Infinity) - (b.latencyP50 ?? Infinity));

function pickBest<T extends Rankable>(vs: T[]): T | undefined {
  return [...vs].filter((v) => v.passRate !== null).sort(byRank)[0];
}

export const groupsOps: OpDef<any, any>[] = [
  defineOp({
    name: 'start_comparison',
    title: 'Start a comparison',
    description:
      'Runs one dataset through 2–8 variants and scores them with the same suite, so you can pick the best. A variant is a target, optionally with overrides (another model/connection/temperature for model targets, different variables such as a base URL, or any config field such as the prompt). Returns immediately; poll get_comparison.',
    category: 'runs',
    input: z.object({
      name: z.string().optional(),
      dataset: z.string(),
      suite: z.string(),
      variants: z.array(Variant).min(2).max(8),
      settings: BaseSettings.prefault({}),
    }),
    handler: ({ engine, actor }, i) => {
      const { datasets, defs, runs } = engine.repos;
      const ds = datasets.get(i.dataset);
      const suite = defs.get('suite', i.suite);
      // Validate every variant before creating anything.
      const prepared = i.variants.map((v, n) => {
        const target = defs.get('target', v.target);
        try {
          applyOverrides(TargetSpec.parse(target.spec), v.overrides);
        } catch (e: any) {
          throw invalid(`Variant ${n + 1} (${v.label || target.name}): ${e?.message ?? e}`);
        }
        const auto = v.overrides?.model?.model || Object.entries(v.overrides?.vars ?? {}).map(([k, x]) => `${k}=${x}`).join(', ');
        return { target, overrides: v.overrides, label: v.label || v.overrides?.label || (auto ? `${target.name} · ${auto}` : target.name) };
      });
      const labels = new Set<string>();
      for (const p of prepared) {
        let l = p.label;
        for (let k = 2; labels.has(l); k++) l = `${p.label} (${k})`;
        p.label = l;
        labels.add(l);
      }
      // One transaction: if a variant cannot be set up (e.g. no rows match), no half-made comparison is left behind.
      const { group, created } = engine.db.tx(() => {
        const group = runs.createGroup({ name: i.name, datasetId: ds.id, suiteId: suite.id, settings: { ...i.settings, variants: prepared.map((p) => ({ target: p.target.id, label: p.label, overrides: p.overrides ?? null })) } }, actor);
        const created = prepared.map((p) => {
          const settings = RunSettings.parse({ ...i.settings, overrides: p.overrides });
          const { run, rows } = prepareRun(engine, actor, { dataset: ds.id, suite: suite.id, target: p.target.id, name: `${group.name} · ${p.label}`, settings, kind: 'live', groupId: group.id, variantLabel: p.label });
          const items = rows.flatMap((r) => Array.from({ length: settings.repetitions }, (_, rep) => ({ rowId: r.id, rowRev: r.rev, rep, input: r.data })));
          runs.addPending(run.id, items);
          return run;
        });
        return { group, created };
      });
      for (const r of created) engine.runner.start(r.id);
      const warnings = prepared.flatMap((p) => runPreflight(engine, ds.id, p.target.id, { ...i.settings, overrides: p.overrides } as any).map((w) => ({ ...w, variant: p.label })));
      return { id: group.id, number: group.number, name: group.name, runs: created.map((r) => ({ id: r.id, label: r.variantLabel })), warnings };
    },
  }),

  defineOp({
    name: 'get_comparison',
    title: 'Get comparison',
    description:
      'Leaderboard of a comparison: each variant with pass rate (95% interval), mean score, per-check pass rates, corpus metrics, latency and tokens, the best variant, and for each other variant an exact McNemar test on paired rows against the best ("clearly worse" vs "could be noise").',
    category: 'runs',
    readOnly: true,
    input: z.object({ id: z.string() }),
    handler: ({ engine }, i) => {
      const group = engine.repos.runs.getGroup(i.id);
      const runsOf = engine.repos.runs.groupRuns(group.id);
      const variants = runsOf.map((r) => variantSummary(engine, r));
      const status = groupStatus(variants);
      const best = pickBest(variants);
      const bestOut = best ? outcomes(engine, best.runId) : new Map<string, boolean>();
      const ranked = [...variants]
        .sort((a, b) => (best && a.runId === best.runId ? -1 : best && b.runId === best.runId ? 1 : byRank(a, b)))
        .map((v, rank) => {
          if (!best || v.runId === best.runId) return { ...v, rank: rank + 1, isBest: !!best && v.runId === best.runId, vsBest: null };
          const mine = outcomes(engine, v.runId);
          let bestOnly = 0;
          let mineOnly = 0;
          let paired = 0;
          for (const [k, b] of bestOut) {
            const m = mine.get(k);
            if (m === undefined) continue;
            paired++;
            if (b && !m) bestOnly++;
            if (!b && m) mineOnly++;
          }
          const p = mcnemarExact(bestOnly, mineOnly);
          const verdict = v.passRate === best.passRate ? 'tied' : p === null ? 'no difference' : p < 0.05 ? 'clearly worse' : 'could be noise';
          return { ...v, rank: rank + 1, isBest: false, vsBest: { paired, bestOnly, thisOnly: mineOnly, pValue: p, verdict } };
        });
      let datasetName: string | null = null;
      let suiteName: string | null = null;
      try {
        datasetName = engine.repos.datasets.get(group.datasetId).name;
      } catch {}
      try {
        suiteName = engine.repos.defs.get('suite', group.suiteId).name;
      } catch {}
      const done = variants.reduce((n, v) => n + v.done, 0);
      const total = variants.reduce((n, v) => n + v.total, 0);
      return { ...group, datasetName, suiteName, status, done, total, bestRunId: best?.runId ?? null, variants: ranked };
    },
  }),

  defineOp({
    name: 'compare_rows',
    title: 'Compare outputs side by side',
    description:
      'Rows of a comparison with each variant\'s output, pass/fail, score and failing checks. Filter to rows where variants disagree (some pass, some fail), where all failed, or where all passed.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      id: z.string(),
      filter: z.enum(['all', 'disagreements', 'all_failed', 'all_passed']).default('disagreements'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    handler: ({ engine }, i) => {
      const group = engine.repos.runs.getGroup(i.id);
      const runsOf = engine.repos.runs.groupRuns(group.id);
      const rows = new Map<string, { key: string; rowId: string; rep: number; seq: number; input: Record<string, unknown>; variants: Record<string, any> }>();
      for (const run of runsOf) {
        for (const r of engine.repos.runs.allLite(run.id)) {
          const key = `${r.rowId}#${r.rep}`;
          let row = rows.get(key);
          if (!row) {
            row = { key, rowId: r.rowId, rep: r.rep, seq: r.seq, input: r.input, variants: {} };
            rows.set(key, row);
          }
          row.variants[run.id] = {
            resultId: r.id,
            status: r.status,
            passed: r.passed,
            score: r.score,
            output: r.outputs?.output ?? null,
            error: r.error,
            failing: (r.checks ?? []).filter((c: any) => c.status === 'fail' || c.status === 'error').map((c: any) => c.name),
            latencyMs: r.metrics?.latency_ms ?? null,
          };
        }
      }
      const all = [...rows.values()].sort((a, b) => a.seq - b.seq || a.rep - b.rep);
      const verdicts = (r: (typeof all)[number]) => Object.values(r.variants).map((v: any) => v.passed).filter((p) => p !== null);
      const filtered = all.filter((r) => {
        const v = verdicts(r);
        if (i.filter === 'disagreements') return v.includes(true) && v.includes(false);
        if (i.filter === 'all_failed') return v.length > 0 && v.every((p) => p === false);
        if (i.filter === 'all_passed') return v.length > 0 && v.every((p) => p === true);
        return true;
      });
      const counts = {
        all: all.length,
        disagreements: all.filter((r) => { const v = verdicts(r); return v.includes(true) && v.includes(false); }).length,
        all_failed: all.filter((r) => { const v = verdicts(r); return v.length > 0 && v.every((p) => p === false); }).length,
        all_passed: all.filter((r) => { const v = verdicts(r); return v.length > 0 && v.every((p) => p === true); }).length,
      };
      return {
        variants: runsOf.map((r) => ({ runId: r.id, label: r.variantLabel ?? r.name })),
        counts,
        total: filtered.length,
        rows: filtered.slice(i.offset, i.offset + i.limit),
      };
    },
  }),

  defineOp({
    name: 'list_comparisons',
    title: 'List comparisons',
    description: 'Comparisons, newest first, with status, number of variants and the current best variant.',
    category: 'runs',
    readOnly: true,
    input: z.object({ limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    handler: ({ engine }, i) => {
      const { total, groups } = engine.repos.runs.listGroups(i.limit, i.offset);
      return {
        total,
        comparisons: groups.map((g) => {
          const vs = engine.repos.runs.groupRuns(g.id).map((r) => variantSummary(engine, r));
          const best = pickBest(vs);
          return {
            ...g,
            status: groupStatus(vs),
            variants: vs.length,
            done: vs.reduce((n, v) => n + v.done, 0),
            total: vs.reduce((n, v) => n + v.total, 0),
            best: best ? { label: best.label, passRate: best.passRate, runId: best.runId } : null,
          };
        }),
      };
    },
  }),

  defineOp({
    name: 'cancel_comparison',
    title: 'Cancel comparison',
    description: 'Stops every running variant of a comparison. Finished rows are kept.',
    category: 'runs',
    input: z.object({ id: z.string() }),
    handler: ({ engine }, i) => {
      const g = engine.repos.runs.getGroup(i.id);
      const runsOf = engine.repos.runs.groupRuns(g.id);
      for (const r of runsOf) engine.runner.cancel(r.id);
      return { cancelling: runsOf.map((r) => r.id) };
    },
  }),

  defineOp({
    name: 'delete_comparison',
    title: 'Delete comparison',
    description: 'Moves a comparison and all its variant runs to the trash.',
    category: 'runs',
    destructive: true,
    input: z.object({ id: z.string() }),
    handler: ({ engine }, i) => {
      const g = engine.repos.runs.getGroup(i.id);
      for (const r of engine.repos.runs.groupRuns(g.id)) engine.runner.cancel(r.id);
      engine.repos.runs.deleteGroup(g.id);
      return { deleted: g.id };
    },
  }),
];
