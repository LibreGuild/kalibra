import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { agreementStats, cohensKappa, confusion, correctedRate, kappaBand } from '../src/ops/labels.js';

describe('agreement maths', () => {
  it('computes Cohen\'s kappa on a known table', () => {
    // Classic example: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no → po 0.7, pe 0.5, kappa 0.4
    const c = { tp: 20, fp: 5, fn: 10, tn: 15 };
    expect(cohensKappa(c)).toBeCloseTo(0.4, 6);
    expect(kappaBand(0.4)).toBe('fair');
    expect(kappaBand(0.85)).toBe('almost perfect');
    expect(cohensKappa({ tp: 0, fp: 0, fn: 0, tn: 0 })).toBeNull();
  });

  it('corrects an observed pass rate for judge error (Rogan–Gladen)', () => {
    // true rate 0.6, TPR 0.9, TNR 0.8 → observed = 0.6*0.9 + 0.4*0.2 = 0.62
    expect(correctedRate(0.62, 0.9, 0.8)).toBeCloseTo(0.6, 6);
    expect(correctedRate(0.5, 0.5, 0.52)).toBeNull(); // no better than chance
  });

  it('builds the confusion matrix with pass as positive class', () => {
    const c = confusion([
      { judge: 'pass', human: 'pass' },
      { judge: 'pass', human: 'fail' },
      { judge: 'fail', human: 'pass' },
      { judge: 'fail', human: 'fail' },
      { judge: 'fail', human: 'fail' },
    ]);
    expect(c).toEqual({ tp: 1, fp: 1, fn: 1, tn: 2 });
  });

  it('returns stats, a bootstrap interval and sample-size warnings', () => {
    const pairs = [
      ...Array.from({ length: 27 }, () => ({ judge: 'pass' as const, human: 'pass' as const })),
      ...Array.from({ length: 3 }, () => ({ judge: 'fail' as const, human: 'pass' as const })),
      ...Array.from({ length: 16 }, () => ({ judge: 'fail' as const, human: 'fail' as const })),
      ...Array.from({ length: 4 }, () => ({ judge: 'pass' as const, human: 'fail' as const })),
    ];
    const s = agreementStats(pairs, 0.62);
    expect(s.n).toBe(50);
    expect(s.tpr).toBeCloseTo(0.9, 4);
    expect(s.tnr).toBeCloseTo(0.8, 4);
    expect(s.correctedPassRate).toBeCloseTo(0.6, 4);
    expect(s.correctedPassRateCi![0]).toBeLessThanOrEqual(0.6);
    expect(s.correctedPassRateCi![1]).toBeGreaterThanOrEqual(0.6);
    expect(agreementStats(pairs.slice(0, 5), 0.5).warnings[0]).toMatch(/at least 30/);
  });
});

describe('label ops on an engine', () => {
  let dir: string;
  let engine: Engine;
  let suiteId: string;
  const runIds: string[] = [];
  const resultIds: string[][] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-labels-'));
    engine = await Engine.open({ dir });
    const ds = await engine.call('create_dataset', { name: 'L', columns: [{ key: 'q', type: 'text' }] });
    await engine.call('add_dataset_rows', { dataset: ds.id, rows: Array.from({ length: 6 }, (_, k) => ({ data: { q: `q${k}` } })) });
    const suite = await engine.call('create_suite', { name: 'S', spec: { checks: [{ id: 'judge', type: 'expression', config: { expression: 'true' } }] } });
    suiteId = suite.id;
    const version = await engine.repos.datasets.createVersion(ds.id, '', { kind: 'user', id: 'local' });
    const rows = await engine.repos.datasets.versionRows(version.id);
    // Two runs; the check passes on even rows and fails on odd rows (one odd row errors).
    for (let n = 0; n < 2; n++) {
      const run = await engine.repos.runs.create(
        { kind: 'imported', datasetId: ds.id, datasetVersionId: version.id, suiteId: suite.id, suiteVersion: suite.version, settings: { concurrency: 1, retries: 0, repetitions: 1, includeStatuses: ['approved'], delayMs: 0 } },
        { kind: 'user', id: 'local' },
      );
      await engine.repos.runs.addPending(run.id, rows.map((r) => ({ rowId: r.id, rowRev: r.rev, rep: 0, input: r.data })));
      const ids: string[] = [];
      for (const [k, p] of (await engine.repos.runs.pending(run.id)).entries()) {
        const status = k % 2 === 0 ? 'pass' : k === 3 ? 'error' : 'fail';
        await engine.repos.runs.saveResult(run.id, p.id, { status: 'done', passed: status === 'pass', score: null, outputs: {}, metrics: {}, attempts: 1, checks: [{ id: 'judge', name: 'Judge', type: 'expression', layer: 5, gate: false, weight: 1, status }] });
        ids.push(p.id);
      }
      runIds.push(run.id);
      resultIds.push(ids);
    }
  });

  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('balanced sampler alternates check passes and fails and skips labeled rows', async () => {
    const next = await engine.call('next_to_label', { runId: runIds[0], checkId: 'judge', strategy: 'balanced', limit: 6 });
    expect(next.items.map((x: any) => x.verdict)).toEqual(['pass', 'fail', 'pass', 'fail', 'pass', 'fail']);
    await engine.call('label_result', { resultId: next.items[0].resultId, checkId: 'judge', label: 'pass' });
    const after = await engine.call('next_to_label', { runId: runIds[0], checkId: 'judge', strategy: 'balanced', limit: 10 });
    expect(after.items.some((x: any) => x.resultId === next.items[0].resultId)).toBe(false);
    expect(after.remaining).toBe(5);
  });

  it('rejects labels for checks that did not run, and clears labels', async () => {
    await expect(engine.call('label_result', { resultId: resultIds[0][1], checkId: 'nope', label: 'pass' })).rejects.toThrow(/did not run/);
    await engine.call('label_result', { resultId: resultIds[0][1], checkId: 'judge', label: 'fail' });
    await engine.call('label_result', { resultId: resultIds[0][1], checkId: 'judge', label: null });
    expect((await engine.call('list_labels', { runId: runIds[0], checkId: 'judge' })).length).toBe(1);
  });

  it('aggregates agreement across all runs of a suite and ignores agent labels by default', async () => {
    // run 1: human agrees on rows 0,1,2 and disagrees on row 3 (check errored = fail, human says pass)
    for (const [k, label] of [[1, 'fail'], [2, 'pass'], [3, 'pass']] as const) {
      await engine.call('label_result', { resultId: resultIds[0][k], checkId: 'judge', label });
    }
    // run 2: one human label, one agent label
    await engine.call('label_result', { resultId: resultIds[1][0], checkId: 'judge', label: 'fail' });
    await engine.call('label_result', { resultId: resultIds[1][1], checkId: 'judge', label: 'fail' }, { kind: 'agent', id: 'claude-code', client: 'claude-code' });

    const one = await engine.call('judge_agreement', { runId: runIds[0], checkId: 'judge' });
    expect(one.n).toBe(4);
    expect(one.confusion).toEqual({ tp: 2, fp: 0, fn: 1, tn: 1 });
    expect(one.disagreements.map((d: any) => d.resultId)).toEqual([resultIds[0][3]]);
    expect(one.observedPassRate).toBeCloseTo(0.5, 6);

    const all = await engine.call('judge_agreement', { suiteId, checkId: 'judge' });
    expect(all.runs).toBe(2);
    expect(all.n).toBe(5);
    const withAgents = await engine.call('judge_agreement', { suiteId, checkId: 'judge', includeAgentLabels: true });
    expect(withAgents.n).toBe(6);

    const dis = await engine.call('next_to_label', { runId: runIds[0], checkId: 'judge', strategy: 'disagreements' });
    expect(dis.items.map((x: any) => x.resultId)).toEqual([resultIds[0][3]]);
  });
});
