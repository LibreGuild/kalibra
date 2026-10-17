import { z } from 'zod';
import { defineOp, type OpDef } from '../registry.js';
import { GitInfoInput } from '../repo/runs.js';
import { compareToBaseline, trimReport } from '../runner/report.js';
import { RowStatus, RunSettings } from '../specs.js';
import { invalid, KalibraError } from '../util.js';
import { prepareRun } from './runs.js';

/*
 * Runs from code (docs/design/sdk-and-traces.md §3): the developer's own function produces the
 * outputs (SDK `evaluate()` inside vitest/pytest, or CI), Kalibra provides the rows and scores the
 * outputs with a suite, exactly like outputs imported from a file.
 *
 *   start_code_run      → a run of kind "code" with one pending result per row; returns the rows
 *   submit_code_results → outputs per row, in batches; submitting a row again replaces it
 *   finish_code_run     → rows without a submission become errors, the suite scores everything,
 *                         and the answer compares the run with its baseline (runner/report.ts)
 *   compare_to_baseline → the same comparison for any finished run
 */

/** Rows per submit_code_results call. */
const MAX_BATCH = 1000;

const OPEN = new Set(['queued', 'interrupted']);

export const codeRunOps: OpDef<any, any>[] = [
  defineOp({
    name: 'start_code_run',
    title: 'Start a run from code',
    description:
      'Starts a run whose outputs come from your own code (the Kalibra SDK evaluate() helper, or CI) instead of a target. Returns the dataset rows to run your function on, each with the resultId to report against. Then call submit_code_results (in batches) and finish_code_run, which scores the outputs with the suite and compares with the baseline.',
    category: 'runs',
    input: z.object({
      dataset: z.string(),
      suite: z.string(),
      name: z.string().optional(),
      git: GitInfoInput.optional().describe('Branch / commit / PR of the code under test, for comparing with the base branch'),
      limit: z.number().int().positive().optional().describe('Only the first N rows'),
      tags: z.array(z.string()).optional().describe('Only rows with any of these tags'),
      includeStatuses: z.array(RowStatus).optional(),
    }),
    handler: async ({ engine, actor }, i) => {
      const settings = RunSettings.parse({ concurrency: 8, ...(i.limit ? { limit: i.limit } : {}), ...(i.tags ? { tags: i.tags } : {}), ...(i.includeStatuses ? { includeStatuses: i.includeStatuses } : {}) });
      const branch = i.git?.branch ? ` (${i.git.branch})` : '';
      const { run, rows } = await prepareRun(engine, actor, { dataset: i.dataset, suite: i.suite, name: i.name || `Code run${branch}`, settings, kind: 'code' });
      if (i.git) await engine.repos.runs.setGit(run.id, i.git);
      await engine.repos.runs.addPending(run.id, rows.map((r) => ({ rowId: r.id, rowRev: r.rev, rep: 0, input: r.data })));
      engine.events.emit({ type: 'run.updated', runId: run.id, status: 'queued', done: 0, total: rows.length });
      const pending = await engine.repos.runs.pending(run.id);
      return {
        runId: run.id,
        number: run.number,
        name: run.name,
        rows: pending.map((p) => ({ id: p.rowId, resultId: p.id, data: p.input })),
      };
    },
  }),

  defineOp({
    name: 'submit_code_results',
    title: 'Submit outputs of a run from code',
    description: `Stores what your code produced for rows of a run from code (up to ${MAX_BATCH} per call). outputs is what the suite checks ({ output: … } plus any other fields); metrics are numbers such as latency_ms; error marks a row whose call failed. Submitting a row again replaces it.`,
    category: 'runs',
    quiet: true,
    input: z.object({
      runId: z.string(),
      results: z
        .array(
          z.object({
            rowId: z.string(),
            outputs: z.record(z.string(), z.unknown()).default({}),
            metrics: z.record(z.string(), z.number()).default({}),
            error: z.string().nullable().optional(),
            traceId: z.string().optional().describe('A trace your app sent for this row (links it to the result)'),
          }),
        )
        .max(MAX_BATCH),
    }),
    handler: async ({ engine }, i) => {
      const { runs } = engine.repos;
      const run = await runs.get(i.runId);
      if (run.kind !== 'code') throw invalid('This run was not started from code (start_code_run)');
      if (!OPEN.has(run.status)) throw new KalibraError('conflict', `This run is already ${run.status}; start a new one`);
      const unknown: string[] = [];
      let accepted = 0;
      // A trace the app just sent may still be queued; store it so traceId below can link it.
      if (i.results.some((r) => r.traceId)) await engine.traces.flush();
      await engine.db.tx(async () => {
        // Postgres may run a transaction again after a conflict: start counting afresh each time.
        unknown.length = 0;
        accepted = 0;
        for (const r of i.results) {
          if (!(await runs.submitCodeOutput(run.id, r.rowId, { outputs: r.outputs, metrics: r.metrics, error: r.error ?? null }))) {
            unknown.push(r.rowId);
            continue;
          }
          accepted++;
          if (r.traceId) {
            await engine.db.run(
              'UPDATE traces SET run_id = ?, result_id = (SELECT id FROM results WHERE run_id = ? AND row_id = ? ORDER BY rep LIMIT 1) WHERE id = ?',
              run.id, run.id, r.rowId, r.traceId,
            );
          }
        }
      });
      return { accepted, unknown, submitted: await runs.submittedCount(run.id), total: run.total };
    },
  }),

  defineOp({
    name: 'finish_code_run',
    title: 'Finish a run from code',
    description:
      'Scores the submitted outputs with the suite (rows nothing was submitted for count as errors), waits for scoring to end, and compares the run with its baseline: the latest completed run on the base branch (git.baseBranch, else main) with the same dataset and suite, or baselineRunId. Returns the run, its summary, new failures and fixed rows. Calling it again returns the comparison again.',
    category: 'runs',
    input: z.object({
      runId: z.string(),
      baselineRunId: z.string().optional(),
      wait: z.boolean().default(true).describe('Wait for scoring to finish (false: return at once and poll get_run, then compare_to_baseline)'),
    }),
    handler: async ({ engine }, i) => {
      const { runs } = engine.repos;
      let run = await runs.get(i.runId);
      if (run.kind !== 'code') throw invalid('This run was not started from code (start_code_run)');
      if (OPEN.has(run.status)) {
        if (!(await runs.submittedCount(run.id))) throw invalid('Nothing was submitted for this run yet (submit_code_results)');
        await runs.markUnsubmitted(run.id, 'No output was submitted for this row');
        engine.runner.start(run.id);
        if (!i.wait) return { run: await runs.get(run.id) };
      }
      if (i.wait) run = await engine.runner.wait(run.id);
      // The report's own `run` (pass-rate digest) is left out: the full run record takes its place.
      const { run: _digest, ...comparison } = trimReport(await compareToBaseline(engine, run.id, i.baselineRunId));
      return { run, summary: run.summary, ...comparison };
    },
  }),

  defineOp({
    name: 'compare_to_baseline',
    title: 'Compare a run with its baseline',
    description:
      'Compares a run row by row with a baseline run: by default the latest completed run on the base branch (the run\'s git.baseBranch, else main) with the same dataset, suite and target. Returns pass rates, the change, new failures (with reasons) and fixed rows. Use it for pull request reports.',
    category: 'runs',
    readOnly: true,
    input: z.object({ runId: z.string(), baselineRunId: z.string().optional() }),
    handler: async ({ engine }, i) => trimReport(await compareToBaseline(engine, i.runId, i.baselineRunId)),
  }),
];
