import { z } from 'zod';
import type { Engine } from '../engine.js';
import { defineOp } from '../registry.js';
import { wilson } from '../runner/summary.js';
import { invalid, mapSeq, percentile } from '../util.js';

/*
 * Insights: where a run fails (breakdowns by tag / column / row status) and how quality moves
 * across runs (trends). Both read stored results only; nothing is re-run.
 */

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const PREFERRED = ['accent', 'locale', 'lang', 'language', 'category', 'speaker', 'voice', 'topic', 'difficulty', 'persona', 'intent', 'expected_behavior'];
const SLICEABLE = new Set(['text', 'number', 'boolean', 'list']);
const MAX_GROUPS = 50;

type Lite = Awaited<ReturnType<Engine['repos']['runs']['allLite']>>[number];

interface Acc {
  key: string;
  results: Lite[];
}

function latencyKeys(results: Lite[]) {
  const keys = new Set<string>();
  for (const r of results) for (const k of Object.keys(r.metrics ?? {})) if (k === 'latency_ms' || k.endsWith('_latency_ms') || k === 'first_partial_ms') keys.add(k);
  return [...keys].sort();
}

/** Aggregates one group of results: pass rate with interval, per-check rates, corpus error rates, latency percentiles. */
function aggregate(key: string, results: Lite[], lkeys: string[], checkId?: string) {
  const finished = results.filter((r) => r.status === 'done' || r.status === 'error');
  const verdicts = finished.map((r) => {
    if (!checkId) return r.passed;
    const c = r.checks.find((x: any) => x.id === checkId);
    if (!c || c.status === 'skip') return null;
    return c.status === 'pass';
  });
  const passed = verdicts.filter((v) => v === true).length;
  const failed = verdicts.filter((v) => v === false).length;
  const judged = passed + failed;
  const scores = finished.map((r) => r.score).filter((s): s is number => typeof s === 'number');

  const checks = new Map<string, { id: string; name: string; type: string; pass: number; judged: number; errors: number; refUnits: number; metric?: string }>();
  for (const r of finished) {
    for (const c of r.checks ?? []) {
      let a = checks.get(c.id);
      if (!a) checks.set(c.id, (a = { id: c.id, name: c.name, type: c.type, pass: 0, judged: 0, errors: 0, refUnits: 0 }));
      if (c.status !== 'skip') {
        a.judged++;
        if (c.status === 'pass') a.pass++;
      }
      const d = c.details;
      if (d && typeof d.errors === 'number' && typeof d.refUnits === 'number') {
        a.errors += d.errors;
        a.refUnits += d.refUnits;
        a.metric = d.metric ?? c.type;
      }
    }
  }

  const latency: Record<string, { p50: number; p95: number; count: number }> = {};
  for (const k of lkeys) {
    const vals = finished.map((r) => r.metrics?.[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length) latency[k] = { p50: percentile(vals, 50)!, p95: percentile(vals, 95)!, count: vals.length };
  }

  return {
    key,
    n: finished.length,
    passed,
    failed,
    passRate: judged ? round(passed / judged) : null,
    passRateCi: wilson(passed, judged),
    meanScore: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    checks: [...checks.values()].map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      passRate: c.judged ? round(c.pass / c.judged) : null,
      ...(c.metric ? { corpus: { metric: c.metric, errors: c.errors, refUnits: c.refUnits, value: c.refUnits ? round(c.errors / c.refUnits) : c.errors > 0 ? 1 : 0 } } : {}),
    })),
    latency,
  };
}

const valueKey = (v: unknown): string[] => {
  if (v === undefined || v === null || v === '') return ['(empty)'];
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : ['(empty)'];
  if (typeof v === 'object') return [(v as any).blob ? (v as any).name ?? 'file' : JSON.stringify(v)];
  return [String(v)];
};

export const insightOps = [
  defineOp({
    name: 'run_breakdown',
    title: 'Break down a run',
    description:
      'Splits a run\'s results into groups — by row tag, by any row column (e.g. accent, category, lang) or by row status — and reports each group\'s pass rate with a 95% interval, per-check pass rates, corpus WER/CER and latency percentiles. Use it to find where an app fails. Also suggests good columns to split by.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      runId: z.string(),
      by: z.enum(['tag', 'column', 'status']).default('tag'),
      column: z.string().optional().describe('Row column to split by when by = "column"'),
      checkId: z.string().optional().describe('Judge pass/fail by this one check instead of the whole row'),
    }),
    handler: async ({ engine }, i) => {
      const { runs, datasets } = engine.repos;
      const run = await runs.get(i.runId);
      if (i.by === 'column' && !i.column) throw invalid('Pick a column to split by');
      const results = await runs.allLite(run.id);
      const rowMeta = new Map<string, { tags: string[]; status: string }>();
      if (run.datasetVersionId) for (const r of await datasets.versionRowMeta(run.datasetVersionId)) rowMeta.set(r.id, { tags: r.tags, status: r.status });

      // Columns worth slicing by: a handful of distinct values each.
      let columns: { key: string; type: string }[] = [];
      try {
        if (run.datasetId) columns = (await datasets.get(run.datasetId)).schema.columns.map((c) => ({ key: c.key, type: c.type }));
      } catch {
        /* dataset deleted: fall back to keys seen in inputs */
      }
      const uniqueRows = new Set(results.map((r) => r.rowId)).size;
      if (!columns.length) columns = [...new Set(results.flatMap((r) => Object.keys(r.input ?? {})))].map((key) => ({ key, type: 'text' }));
      const candidates = columns
        .filter((c) => SLICEABLE.has(c.type))
        .map((c) => ({ key: c.key, distinct: new Set(results.flatMap((r) => valueKey(r.input?.[c.key]))).size }))
        // Skip identifier-like columns (a different value on every row): one-row groups explain nothing.
        .filter((c) => c.distinct >= 2 && c.distinct <= 30 && (uniqueRows < 4 || c.distinct < uniqueRows));
      const tagCount = new Set([...rowMeta.values()].flatMap((m) => m.tags)).size;
      const rank = (k: string) => {
        const idx = PREFERRED.indexOf(k.toLowerCase());
        return idx === -1 ? 99 : idx;
      };
      candidates.sort((a, b) => rank(a.key) - rank(b.key) || a.distinct - b.distinct);
      const suggestBy =
        candidates.length && rank(candidates[0].key) < 99
          ? { by: 'column' as const, column: candidates[0].key }
          : tagCount >= 2
            ? { by: 'tag' as const }
            : candidates.length
              ? { by: 'column' as const, column: candidates[0].key }
              : { by: 'status' as const };

      const groups = new Map<string, Acc>();
      const add = (key: string, r: Lite) => {
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { key, results: [] }));
        g.results.push(r);
      };
      for (const r of results) {
        const meta = rowMeta.get(r.rowId);
        if (i.by === 'tag') {
          const tags = meta?.tags ?? [];
          if (!tags.length) add('(no tags)', r);
          for (const t of new Set(tags)) add(t, r);
        } else if (i.by === 'status') add(meta?.status ?? '(unknown)', r);
        else {
          for (const k of new Set(valueKey(r.input?.[i.column!]))) add(k, r);
        }
      }

      const lkeys = latencyKeys(results);
      const all = [...groups.values()].sort((a, b) => b.results.length - a.results.length || a.key.localeCompare(b.key));
      const out = all.slice(0, MAX_GROUPS).map((g) => aggregate(g.key, g.results, lkeys, i.checkId));
      const eligible = out.filter((g) => g.n >= 3 && g.passRate != null);
      const weakest = eligible.length > 1 ? eligible.reduce((w, g) => (g.passRate! < w.passRate! ? g : w)).key : null;

      return {
        runId: run.id,
        by: i.by,
        column: i.column ?? null,
        checkId: i.checkId ?? null,
        overall: aggregate('All rows', results, lkeys, i.checkId),
        groups: out,
        truncated: all.length > MAX_GROUPS,
        weakest,
        latencyKeys: lkeys,
        suggestBy,
        columns: candidates.map((c) => c.key),
        hasTags: tagCount > 0,
      };
    },
  }),

  defineOp({
    name: 'suite_trend',
    title: 'Quality over time',
    description:
      'Completed runs in time order (oldest first) with pass rate and interval, mean score, per-check pass rates, corpus metrics and median latency — one series per suite. Filter by suite, dataset or target; without filters it returns the four most-used suites.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      suiteId: z.string().optional(),
      datasetId: z.string().optional(),
      targetId: z.string().optional(),
      limit: z.number().int().min(2).max(200).default(20),
    }),
    handler: async ({ engine }, i) => {
      const { runs, defs, datasets } = engine.repos;
      const suiteId = i.suiteId ? (await defs.get('suite', i.suiteId)).id : undefined;
      const datasetId = i.datasetId ? (await datasets.get(i.datasetId)).id : undefined;
      const targetId = i.targetId ? (await defs.get('target', i.targetId)).id : undefined;
      const all = (await runs.list({ suiteId, datasetId, targetId, limit: 2000 })).runs.filter((r) => r.status === 'completed' && r.suiteId);

      const bySuite = new Map<string, typeof all>();
      for (const r of all) {
        if (!bySuite.has(r.suiteId!)) bySuite.set(r.suiteId!, []);
        bySuite.get(r.suiteId!)!.push(r);
      }
      const chosen = [...bySuite.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, suiteId ? 1 : 4);

      const suiteName = async (id: string) => {
        try {
          return (await defs.get('suite', id)).name;
        } catch {
          return id;
        }
      };
      return {
        series: await mapSeq(chosen, async ([id, list]) => ({
          suiteId: id,
          suiteName: await suiteName(id),
          runs: list
            .slice(0, i.limit)
            .reverse()
            .map((r) => {
              const s = r.summary ?? {};
              return {
                id: r.id,
                number: r.number,
                name: r.name,
                kind: r.kind,
                createdAt: r.createdAt,
                targetId: r.targetId,
                datasetId: r.datasetId,
                passRate: s.passRate ?? null,
                passRateCi: s.passRateCi ?? null,
                meanScore: s.meanScore ?? null,
                latencyP50: s.metrics?.latency_ms?.p50 ?? null,
                checks: (s.checks ?? []).map((c: any) => ({ id: c.id, name: c.name, type: c.type, passRate: c.passRate, corpus: c.corpus ?? null })),
              };
            }),
        })),
      };
    },
  }),
];
