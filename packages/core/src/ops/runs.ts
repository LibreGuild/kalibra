import { z } from 'zod';
import Papa from 'papaparse';
import { defineOp } from '../registry.js';
import { RunSettings, TargetSpec } from '../specs.js';
import { preflight } from '../runner/preflight.js';
import { applyOverrides } from '../runner/overrides.js';
import { invalid } from '../util.js';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';

/** Snapshot the dataset, pick rows per settings, create the run with one pending result per row × repetition. */
export function prepareRun(engine: Engine, actor: Actor, i: { dataset: string; suite: string; target?: string; name?: string; settings: RunSettings; kind: 'live' | 'imported'; groupId?: string; variantLabel?: string }) {
  const { datasets, defs, runs } = engine.repos;
  const ds = datasets.get(i.dataset);
  const suite = defs.get('suite', i.suite);
  const target = i.kind === 'live' ? defs.get('target', i.target ?? '') : null;
  const version = datasets.createVersion(ds.id, 'Saved automatically for a run', actor);
  let rows = datasets.versionRows(version.id).filter((r) => i.settings.includeStatuses.includes(r.status));
  if (i.settings.rowIds?.length) rows = rows.filter((r) => i.settings.rowIds!.includes(r.id));
  if (i.settings.tags?.length) rows = rows.filter((r) => r.tags.some((t) => i.settings.tags!.includes(t)));
  if (i.settings.limit) rows = rows.slice(0, i.settings.limit);
  if (!rows.length) throw invalid('No rows match these settings (check row statuses and filters)');
  const run = runs.create(
    { name: i.name, kind: i.kind, datasetId: ds.id, datasetVersionId: version.id, targetId: target?.id, targetVersion: target?.version, suiteId: suite.id, suiteVersion: suite.version, settings: i.settings, groupId: i.groupId, variantLabel: i.variantLabel },
    actor,
  );
  return { run, rows, datasetVersion: version };
}

export const runOps = [
  defineOp({
    name: 'start_run',
    title: 'Start a run',
    description:
      'Runs every row of a dataset through a target and scores the results with a suite. The dataset is versioned automatically and the run pins the exact target and suite versions. Returns immediately; poll get_run for progress.',
    category: 'runs',
    input: z.object({
      dataset: z.string(),
      target: z.string(),
      suite: z.string(),
      name: z.string().optional(),
      settings: RunSettings.prefault({}),
    }),
    handler: ({ engine, actor }, i) => {
      const warnings = runPreflight(engine, i.dataset, i.target, i.settings);
      const { run, rows } = prepareRun(engine, actor, { ...i, kind: 'live' });
      const items = rows.flatMap((r) => Array.from({ length: i.settings.repetitions }, (_, rep) => ({ rowId: r.id, rowRev: r.rev, rep, input: r.data })));
      engine.repos.runs.addPending(run.id, items);
      engine.runner.start(run.id);
      return { ...engine.repos.runs.get(run.id), warnings };
    },
  }),

  defineOp({
    name: 'preflight_run',
    title: 'Check a run setup',
    description:
      'Before starting a run: lists problems such as the target using a {{column}} the dataset does not have (it would be sent empty), a missing {{vars.x}}, or a scripted conversation without its turns column. start_run also returns these as warnings.',
    category: 'runs',
    readOnly: true,
    input: z.object({ dataset: z.string(), target: z.string(), settings: RunSettings.prefault({}) }),
    handler: ({ engine }, i) => ({ warnings: runPreflight(engine, i.dataset, i.target, i.settings) }),
  }),

  defineOp({
    name: 'import_outputs',
    title: 'Score outputs produced elsewhere',
    description:
      'Creates a run from outputs you produced outside Kalibra. Upload a CSV/JSONL with a row id column plus output column(s), then the suite scores them like a live run. Optional latency_ms / error columns are kept.',
    category: 'runs',
    input: z.object({
      dataset: z.string(),
      suite: z.string(),
      blob: z.string().describe('Uploaded CSV, JSONL or JSON file'),
      rowIdColumn: z.string().default('row_id'),
      outputs: z.record(z.string(), z.string()).default({ output: 'output' }).describe('output field → file column'),
      latencyColumn: z.string().default('latency_ms'),
      errorColumn: z.string().default('error'),
      name: z.string().optional(),
    }),
    handler: async ({ engine, actor }, i) => {
      const text = (await engine.blobs.get(i.blob)).toString('utf8');
      const name = engine.blobs.info(i.blob)?.name ?? '';
      const records: Record<string, any>[] = /\.csv$/i.test(name) || !/^\s*[[{]/.test(text)
        ? Papa.parse<Record<string, any>>(text, { header: true, skipEmptyLines: true }).data
        : text.trimStart().startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
      const byId = new Map(records.map((r) => [String(r[i.rowIdColumn] ?? ''), r]));
      const { run, rows } = prepareRun(engine, actor, { dataset: i.dataset, suite: i.suite, name: i.name ?? `Imported: ${name || 'outputs'}`, settings: RunSettings.parse({ concurrency: 8 }), kind: 'imported' });
      let matched = 0;
      const items = rows.map((r) => {
        const rec = byId.get(r.id);
        if (rec) matched++;
        const outputs = Object.fromEntries(Object.entries(i.outputs).map(([field, col]) => [field, rec?.[col]]));
        const latency = Number(rec?.[i.latencyColumn]);
        return {
          rowId: r.id,
          rowRev: r.rev,
          rep: 0,
          input: r.data,
          outputs,
          metrics: Number.isFinite(latency) ? { latency_ms: latency } : {},
          error: !rec ? 'No output for this row in the imported file' : rec[i.errorColumn] ? String(rec[i.errorColumn]) : null,
        };
      });
      if (!matched) throw invalid(`No rows matched. The file needs a "${i.rowIdColumn}" column with Kalibra row ids (export the dataset to get them).`);
      engine.repos.runs.addPending(run.id, items);
      engine.runner.start(run.id);
      return { run: engine.repos.runs.get(run.id), matched, unmatchedRows: rows.length - matched, fileRows: records.length };
    },
  }),

  defineOp({
    name: 'list_runs',
    title: 'List runs',
    description: 'Lists runs, newest first, with status, progress and summary.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      dataset: z.string().optional(),
      target: z.string().optional(),
      suite: z.string().optional(),
      comparison: z.string().optional().describe('Only the runs of this comparison'),
      excludeComparisons: z.boolean().default(false).describe('Leave out runs that belong to a comparison (list those with list_comparisons)'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    handler: ({ engine }, i) =>
      engine.repos.runs.list({
        groupId: i.comparison ? engine.repos.runs.getGroup(i.comparison).id : undefined,
        excludeGrouped: i.excludeComparisons,
        datasetId: i.dataset ? engine.repos.datasets.get(i.dataset).id : undefined,
        targetId: i.target ? engine.repos.defs.get('target', i.target).id : undefined,
        suiteId: i.suite ? engine.repos.defs.get('suite', i.suite).id : undefined,
        limit: i.limit,
        offset: i.offset,
      }),
  }),

  defineOp({
    name: 'get_run',
    title: 'Get run',
    description: 'Status, progress and summary of a run: pass rate with a 95% interval, per-check results, corpus WER for WER checks, and latency percentiles.',
    category: 'runs',
    readOnly: true,
    input: z.object({ runId: z.string() }),
    handler: ({ engine }, i) => {
      const run = engine.repos.runs.get(i.runId);
      const { datasets, defs } = engine.repos;
      const name = (fn: () => string) => {
        try {
          return fn();
        } catch {
          return null;
        }
      };
      return {
        ...run,
        active: engine.runner.isActive(run.id),
        datasetName: name(() => datasets.get(run.datasetId!).name),
        targetName: run.targetId ? name(() => defs.get('target', run.targetId!).name) : null,
        suiteName: name(() => defs.get('suite', run.suiteId!).name),
      };
    },
  }),

  defineOp({
    name: 'cancel_run',
    title: 'Cancel run',
    description: 'Stops a running run. Finished rows are kept; it can be resumed later.',
    category: 'runs',
    input: z.object({ runId: z.string() }),
    handler: ({ engine }, i) => {
      const run = engine.repos.runs.get(i.runId);
      engine.runner.cancel(run.id);
      return { cancelling: run.id };
    },
  }),

  defineOp({
    name: 'resume_run',
    title: 'Resume run',
    description: 'Continues a cancelled or interrupted run from the rows that are not finished yet.',
    category: 'runs',
    input: z.object({ runId: z.string() }),
    handler: ({ engine }, i) => {
      const run = engine.repos.runs.get(i.runId);
      if (engine.runner.isActive(run.id)) return run;
      engine.repos.runs.resetRunning(run.id);
      engine.runner.start(run.id);
      return engine.repos.runs.get(run.id);
    },
  }),

  defineOp({
    name: 'delete_run',
    title: 'Delete run',
    description: 'Moves a run and its results to the trash.',
    category: 'runs',
    destructive: true,
    input: z.object({ runId: z.string() }),
    handler: ({ engine }, i) => {
      const run = engine.repos.runs.get(i.runId);
      engine.runner.cancel(run.id);
      engine.repos.runs.delete(run.id);
      return { deleted: run.id };
    },
  }),

  defineOp({
    name: 'query_results',
    title: 'Query results',
    description: 'Pages through a run\'s results. Filter by passed/failed/errors or by a failing check; sort by worst score or slowest.',
    category: 'runs',
    readOnly: true,
    input: z.object({
      runId: z.string(),
      filter: z.enum(['all', 'passed', 'failed', 'errors']).default('all'),
      checkId: z.string().optional(),
      search: z.string().optional(),
      ids: z.array(z.string()).max(1000).optional().describe('Only these result ids (e.g. the members of a failure theme)'),
      sort: z.enum(['seq', 'score', 'latency']).default('seq'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler: ({ engine }, i) => engine.repos.runs.query(engine.repos.runs.get(i.runId).id, i),
  }),

  defineOp({
    name: 'get_result',
    title: 'Get result',
    description: 'Full detail of one result: inputs, request, response, outputs, every check with its reasoning and details, metrics and logs.',
    category: 'runs',
    readOnly: true,
    input: z.object({ resultId: z.string() }),
    handler: ({ engine }, i) => engine.repos.runs.getResult(i.resultId),
  }),

  defineOp({
    name: 'compare_runs',
    title: 'Compare two runs',
    description:
      'Matches rows between a baseline run and a new run and reports which rows improved or regressed, per-check pass-rate changes, and whether the change in pass rate is statistically significant (exact McNemar test).',
    category: 'runs',
    readOnly: true,
    input: z.object({ baseRunId: z.string(), runId: z.string() }),
    handler: ({ engine }, i) => {
      const { runs } = engine.repos;
      const base = runs.get(i.baseRunId);
      const next = runs.get(i.runId);
      const key = (r: { rowId: string; rep: number }) => `${r.rowId}#${r.rep}`;
      const a = new Map(runs.allLite(base.id).map((r) => [key(r), r]));
      const b = new Map(runs.allLite(next.id).map((r) => [key(r), r]));
      const keys = [...new Set([...a.keys(), ...b.keys()])];
      let improved = 0, regressed = 0, same = 0, onlyBase = 0, onlyNew = 0;
      const rows = keys.map((k) => {
        const x = a.get(k);
        const y = b.get(k);
        let change: 'improved' | 'regressed' | 'same' | 'only_base' | 'only_new';
        if (!x) (change = 'only_new'), onlyNew++;
        else if (!y) (change = 'only_base'), onlyBase++;
        else if (x.passed === y.passed) {
          const d = (y.score ?? 0) - (x.score ?? 0);
          change = Math.abs(d) < 1e-9 ? 'same' : d > 0 ? 'improved' : 'regressed';
          if (change === 'same') same++;
          else if (change === 'improved') improved++;
          else regressed++;
        } else if (y.passed) (change = 'improved'), improved++;
        else (change = 'regressed'), regressed++;
        const pick = (r: any) => r && { resultId: r.id, passed: r.passed, score: r.score, output: r.outputs?.output, error: r.error, failing: r.checks.filter((c: any) => c.status === 'fail' || c.status === 'error').map((c: any) => c.name) };
        return { key: k, rowId: (x ?? y)!.rowId, input: (y ?? x)!.input, change, base: pick(x), next: pick(y) };
      });
      const flipsUp = rows.filter((r) => r.base && r.next && r.base.passed === false && r.next.passed === true).length;
      const flipsDown = rows.filter((r) => r.base && r.next && r.base.passed === true && r.next.passed === false).length;
      const checkDelta = (next.summary?.checks ?? []).map((c: any) => {
        const prev = (base.summary?.checks ?? []).find((p: any) => p.id === c.id);
        return {
          id: c.id,
          name: c.name,
          base: prev?.passRate ?? null,
          next: c.passRate,
          delta: prev?.passRate != null && c.passRate != null ? Math.round((c.passRate - prev.passRate) * 10000) / 10000 : null,
          corpusBase: prev?.corpus?.value ?? null,
          corpusNext: c.corpus?.value ?? null,
        };
      });
      return {
        base: { id: base.id, number: base.number, name: base.name, passRate: base.summary?.passRate ?? null },
        next: { id: next.id, number: next.number, name: next.name, passRate: next.summary?.passRate ?? null },
        counts: { improved, regressed, same, onlyBase, onlyNew },
        passFlips: { failToPass: flipsUp, passToFail: flipsDown, pValue: mcnemarExact(flipsUp, flipsDown) },
        checks: checkDelta,
        rows: rows.sort((p, q) => order(p.change) - order(q.change)),
      };
    },
  }),
];

const order = (c: string) => ({ regressed: 0, improved: 1, only_new: 2, only_base: 3, same: 4 })[c] ?? 5;

/** Two-sided exact McNemar test on discordant pairs (binomial with p = 0.5). */
export function mcnemarExact(b: number, c: number): number | null {
  const n = b + c;
  if (n === 0) return null;
  const k = Math.min(b, c);
  // Terms C(n, i) / 2^n in log space: both overflow a double past ~1000 discordant pairs.
  let logTerm = -n * Math.LN2;
  let p = Math.exp(logTerm);
  for (let i = 1; i <= k; i++) {
    logTerm += Math.log(n - i + 1) - Math.log(i);
    p += Math.exp(logTerm);
  }
  return Math.min(1, 2 * p);
}

/** Setup problems for a dataset × target pair (with the run's overrides applied). */
export function runPreflight(engine: Engine, dataset: string, target: string, settings: RunSettings) {
  const ds = engine.repos.datasets.get(dataset);
  const spec = applyOverrides(TargetSpec.parse(engine.repos.defs.get('target', target).spec), settings.overrides);
  return preflight(spec, ds.schema, settings.conversation);
}
