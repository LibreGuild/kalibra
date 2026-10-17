import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { renderEvalReport, REPORT_MARKER } from '../src/runner/report.js';

/** Runs from code: the developer's function produces outputs, Kalibra scores them and compares with main. */
describe('runs from code', () => {
  let engine: Engine;
  let dir: string;
  const rows = [
    { q: 'capital of France', expected: 'Paris' },
    { q: 'capital of Japan', expected: 'Tokyo' },
    { q: 'capital of Peru', expected: 'Lima' },
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-code-'));
    engine = new Engine({ dir });
    await engine.call('create_dataset', { name: 'Capitals', columns: [{ key: 'q' }, { key: 'expected' }] });
    await engine.call('add_dataset_rows', { dataset: 'Capitals', rows: rows.map((data) => ({ data })) });
    await engine.call('create_suite', { name: 'Exact', spec: { checks: [{ id: 'eq', type: 'equals', name: 'Matches', config: { actual: '{{output}}', expected: '{{expected}}' } }] } });
  });

  afterAll(() => {
    engine?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Plays the SDK: start, run `answer` on every row, submit in batches of `batch`, finish. */
  async function codeRun(git: Record<string, unknown>, answer: (q: string) => string, opts: { batch?: number; skip?: string[] } = {}) {
    const started = await engine.call<any>('start_code_run', { dataset: 'Capitals', suite: 'Exact', git });
    const results = started.rows
      .filter((r: any) => !opts.skip?.includes(r.data.q))
      .map((r: any) => ({ rowId: r.id, outputs: { output: answer(r.data.q) }, metrics: { latency_ms: 5 } }));
    for (let i = 0; i < results.length; i += opts.batch ?? 2) await engine.call('submit_code_results', { runId: started.runId, results: results.slice(i, i + (opts.batch ?? 2)) });
    return { started, finished: await engine.call<any>('finish_code_run', { runId: started.runId }) };
  }

  const truth = Object.fromEntries(rows.map((r) => [r.q, r.expected]));

  it('scores outputs submitted in batches and has no baseline on the first main run', async () => {
    const { started, finished } = await codeRun({ branch: 'main', commit: 'aaa' }, (q) => (q.includes('Peru') ? 'Quito' : truth[q]));
    expect(started.rows).toHaveLength(3);
    expect(started.rows[0]).toEqual({ id: expect.any(String), resultId: expect.stringMatching(/^res_/), data: rows[0] });
    expect(finished.run).toMatchObject({ kind: 'code', status: 'completed', git: { branch: 'main', commit: 'aaa' } });
    expect(finished.summary).toMatchObject({ passed: 2, failed: 1 });
    expect(finished.baseline).toBeNull();
    expect(finished.newFailures).toEqual([expect.objectContaining({ reason: expect.stringMatching(/^Matches/), wasInBaseline: false })]);
  });

  it('compares a pull request run with the latest main run: new failures, fixed rows and the change', async () => {
    const { finished } = await codeRun({ branch: 'feature/x', baseBranch: 'main', pr: 7 }, (q) => (q.includes('Japan') ? 'Kyoto' : truth[q]));
    expect(finished.baseline).toMatchObject({ number: expect.any(Number), passRate: 0.6667, git: { branch: 'main' } });
    expect(finished.delta).toBe(0);
    expect(finished.newFailures).toHaveLength(1);
    expect(finished.newFailures[0]).toMatchObject({ wasInBaseline: true, reason: expect.stringContaining('Matches') });
    expect(finished.fixed).toHaveLength(1);
    expect(finished.counts).toEqual({ newFailures: 1, fixed: 1 });

    const report = await engine.call<any>('compare_to_baseline', { runId: finished.run.id });
    const md = renderEvalReport(report, { marker: true, url: 'https://kalibra.example.com/p/x/runs/2' });
    expect(md.startsWith(REPORT_MARKER)).toBe(true);
    expect(md).toMatch(/Pass rate 66\.7%\*\* \(95% CI 21%–94%\) · 2\/3 rows passed/);
    expect(md).toMatch(/on `main` \(66\.7%\): \*\*±0\.0 pts\*\* · 1 new failure · 1 fixed/);
    expect(md).toMatch(/\| `row_\w+` \| Matches: Got \\?"Kyoto\\?", expected/);
    expect(md).toContain('[Open run #');
  });

  it('accepts a resubmitted row, reports unknown rows, and turns missing rows into errors', async () => {
    const started = await engine.call<any>('start_code_run', { dataset: 'Capitals', suite: 'Exact', name: 'Partial' });
    const [a] = started.rows;
    await engine.call('submit_code_results', { runId: started.runId, results: [{ rowId: a.id, outputs: { output: 'wrong' } }] });
    const again = await engine.call<any>('submit_code_results', { runId: started.runId, results: [{ rowId: a.id, outputs: { output: a.data.expected } }, { rowId: 'row_nope', outputs: {} }] });
    expect(again).toMatchObject({ accepted: 1, unknown: ['row_nope'], submitted: 1, total: 3 });
    const done = await engine.call<any>('finish_code_run', { runId: started.runId });
    expect(done.summary).toMatchObject({ passed: 1 });
    const results = await engine.call<any>('query_results', { runId: started.runId, filter: 'errors' });
    expect(results.results.map((r: any) => r.error)).toEqual(['No output was submitted for this row', 'No output was submitted for this row']);

    // Finished runs take no more results, and finishing again just returns the comparison.
    await expect(engine.call('submit_code_results', { runId: started.runId, results: [{ rowId: a.id, outputs: {} }] })).rejects.toMatchObject({ code: 'conflict' });
    expect((await engine.call<any>('finish_code_run', { runId: started.runId })).run.status).toBe('completed');
  });

  it('refuses to finish an empty run and to take results for runs not started from code', async () => {
    const started = await engine.call<any>('start_code_run', { dataset: 'Capitals', suite: 'Exact', limit: 1 });
    expect(started.rows).toHaveLength(1);
    await expect(engine.call('finish_code_run', { runId: started.runId })).rejects.toThrow(/Nothing was submitted/);
    const live = (await engine.call<any>('list_runs', {})).runs.find((r: any) => r.kind !== 'code');
    if (live) await expect(engine.call('submit_code_results', { runId: live.id, results: [] })).rejects.toThrow(/not started from code/);
  });

  it('compare_to_baseline works for any run, with an explicit baseline too', async () => {
    const list = (await engine.call<any>('list_runs', {})).runs.filter((r: any) => r.status === 'completed');
    const [newest, older] = [list[0], list[list.length - 1]];
    const report = await engine.call<any>('compare_to_baseline', { runId: newest.id, baselineRunId: older.id });
    expect(report.baseline.id).toBe(older.id);
    expect(report.run.id).toBe(newest.id);
    await expect(engine.call('compare_to_baseline', { runId: newest.id, baselineRunId: newest.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('needs the editor role to run from code and only viewer to compare', () => {
    const access = (n: string) => engine.registry.describe().find((o) => o.name === n)!.access;
    expect(['start_code_run', 'submit_code_results', 'finish_code_run'].map(access)).toEqual(['editor', 'editor', 'editor']);
    expect(access('compare_to_baseline')).toBe('viewer');
  });
});
