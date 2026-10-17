import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { RunSettings } from '../src/specs.js';
import { summarize } from '../src/runner/summary.js';

/*
 * Fabricated runs: 6 rows over two accents. en_IN rows fail more and have more WER errors,
 * so the breakdown should single en_IN out.
 */
const ROWS = [
  { accent: 'en_IN', tags: ['voice:a'], pass: false, errors: 3, ref: 10, lat: 900 },
  { accent: 'en_IN', tags: ['voice:a'], pass: false, errors: 2, ref: 10, lat: 1100 },
  { accent: 'en_IN', tags: ['voice:b'], pass: true, errors: 1, ref: 10, lat: 800 },
  { accent: 'en_US', tags: ['voice:b'], pass: true, errors: 0, ref: 10, lat: 500 },
  { accent: 'en_US', tags: ['voice:b'], pass: true, errors: 0, ref: 10, lat: 600 },
  { accent: 'en_US', tags: [], pass: true, errors: 1, ref: 10, lat: 700 },
];

describe('insights ops', () => {
  let engine: Engine;
  let dir: string;
  const runIds: string[] = [];
  let suiteId = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-insights-'));
    engine = await Engine.open({ dir });
    await engine.call('create_dataset', {
      name: 'Voice',
      columns: [
        { key: 'reference', type: 'text' },
        { key: 'accent', type: 'text' },
        { key: 'audio', type: 'text' },
      ],
    });
    await engine.call('add_dataset_rows', {
      dataset: 'Voice',
      rows: ROWS.map((r, i) => ({ data: { reference: `ref ${i}`, accent: r.accent, audio: `clip${i}` }, tags: r.tags })),
    });
    suiteId = (await engine.call('create_suite', { name: 'STT', spec: { checks: [] } })).id;
    const ds = await engine.repos.datasets.get('Voice');
    const version = await engine.repos.datasets.createVersion(ds.id, '', { kind: 'user', id: 'local' });
    const rows = await engine.repos.datasets.versionRows(version.id);

    // Two completed runs; the second is better on en_IN.
    for (const improve of [false, true]) {
      const run = await engine.repos.runs.create(
        { kind: 'imported', datasetId: ds.id, datasetVersionId: version.id, suiteId, suiteVersion: 1, settings: RunSettings.parse({}) },
        { kind: 'user', id: 'local' },
      );
      await engine.repos.runs.addPending(run.id, rows.map((r) => ({ rowId: r.id, rowRev: r.rev, rep: 0, input: r.data })));
      const pending = await engine.repos.runs.pending(run.id);
      for (const [i, p] of pending.entries()) {
        const spec = ROWS[i];
        const pass = improve ? true : spec.pass;
        const errors = improve ? 0 : spec.errors;
        await engine.repos.runs.saveResult(run.id, p.id, {
          status: 'done',
          passed: pass,
          score: pass ? 1 : 0.5,
          outputs: { output: 'x' },
          checks: [
            { id: 'wer', name: 'WER', type: 'wer', layer: 4, gate: false, weight: 1, status: pass ? 'pass' : 'fail', value: errors / spec.ref, details: { errors, refUnits: spec.ref, metric: 'wer' } },
            { id: 'lat', name: 'Latency', type: 'latency', layer: 0, gate: false, weight: 1, status: 'pass' },
          ],
          metrics: { latency_ms: spec.lat, final_latency_ms: spec.lat / 2 },
          attempts: 1,
        });
      }
      await engine.repos.runs.setStatus(run.id, 'completed', { summary: summarize(await engine.repos.runs.allLite(run.id), rows.length) });
      runIds.push(run.id);
    }
  });

  afterAll(async () => {
    await engine?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('splits by a column with pass rates, corpus WER and latency', async () => {
    const b = await engine.call<any>('run_breakdown', { runId: runIds[0], by: 'column', column: 'accent' });
    const inGroup = b.groups.find((g: any) => g.key === 'en_IN');
    const usGroup = b.groups.find((g: any) => g.key === 'en_US');
    expect(inGroup.n).toBe(3);
    expect(inGroup.passRate).toBeCloseTo(1 / 3, 4);
    expect(inGroup.passRateCi[0]).toBeGreaterThanOrEqual(0);
    expect(inGroup.passRateCi[1]).toBeLessThanOrEqual(1);
    expect(inGroup.checks.find((c: any) => c.id === 'wer').corpus.value).toBeCloseTo(6 / 30, 4);
    expect(usGroup.checks.find((c: any) => c.id === 'wer').corpus.value).toBeCloseTo(1 / 30, 4);
    expect(inGroup.latency.latency_ms.p50).toBe(900);
    expect(b.latencyKeys).toEqual(['final_latency_ms', 'latency_ms']);
    expect(b.weakest).toBe('en_IN');
    expect(b.overall.n).toBe(6);
  });

  it('puts a row in every tag group it has and collects untagged rows', async () => {
    const b = await engine.call<any>('run_breakdown', { runId: runIds[0], by: 'tag' });
    const keys = b.groups.map((g: any) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['voice:a', 'voice:b', '(no tags)']));
    expect(b.groups.find((g: any) => g.key === 'voice:b').n).toBe(3);
    expect(b.groups.find((g: any) => g.key === '(no tags)').n).toBe(1);
  });

  it('can judge groups by a single check', async () => {
    const b = await engine.call<any>('run_breakdown', { runId: runIds[0], by: 'status', checkId: 'lat' });
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0].passRate).toBe(1);
  });

  it('suggests a preferred slicing column', async () => {
    const b = await engine.call<any>('run_breakdown', { runId: runIds[0] });
    expect(b.suggestBy).toEqual({ by: 'column', column: 'accent' });
    expect(b.columns).toContain('accent');
    expect(b.columns).not.toContain('reference'); // a different value on every row: not a useful split
  });

  it('returns trends oldest first, one series per suite', async () => {
    const t = await engine.call<any>('suite_trend', {});
    expect(t.series).toHaveLength(1);
    const s = t.series[0];
    expect(s.suiteName).toBe('STT');
    expect(s.runs.map((r: any) => r.id)).toEqual(runIds);
    expect(s.runs[0].passRate).toBeCloseTo(4 / 6, 4);
    expect(s.runs[1].passRate).toBe(1);
    expect(s.runs[0].checks.find((c: any) => c.id === 'wer').corpus.value).toBeCloseTo(7 / 60, 4);
    expect(s.runs[1].latencyP50).toBeGreaterThan(0);
    const filtered = await engine.call<any>('suite_trend', { suiteId, limit: 2 });
    expect(filtered.series[0].runs).toHaveLength(2);
  });
});
