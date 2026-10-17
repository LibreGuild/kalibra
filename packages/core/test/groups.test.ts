import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { applyOverrides, deepMerge } from '../src/runner/overrides.js';
import { TargetSpec } from '../src/specs.js';
import type { LlmClient } from '../src/providers/types.js';

/*
 * Comparisons: several variants of one target (model overrides, variable overrides) run over the
 * same dataset version; leaderboard, paired significance, side-by-side rows, lifecycle, filters.
 */

let engine: Engine;
let dir: string;

const stub: LlmClient = {
  // "good" answers correctly, "bad" always says nope, "meh" is right on even rows only.
  text: async (req) => {
    const n = Number(/(\d+)/.exec(req.prompt)?.[1] ?? 0);
    const right = `answer ${n}`;
    const text = req.model === 'good' ? right : req.model === 'meh' ? (n % 2 === 0 ? right : 'nope') : 'nope';
    return { text, latencyMs: 1, model: req.model ?? 'stub' };
  },
  json: async () => ({ value: {} as any, latencyMs: 1, model: 'stub' }),
  image: async () => ({ images: [], latencyMs: 1, model: 'stub' }),
  speech: async () => ({ audio: { data: new Uint8Array(), mime: 'audio/wav' }, latencyMs: 1, model: 'stub' }),
  transcribe: async () => ({ text: '', latencyMs: 1, model: 'stub' }),
};

async function waitComparison(id: string) {
  for (let i = 0; i < 300; i++) {
    const c = await engine.call<any>('get_comparison', { id });
    if (c.status !== 'running') return c;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('comparison did not finish');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kalibra-groups-'));
  engine = await Engine.open({ dir });
  (engine as any).llm = stub;
  await engine.call('create_dataset', { name: 'Q', columns: [{ key: 'input', type: 'text' }, { key: 'expected', type: 'text' }] });
  await engine.call('add_dataset_rows', { dataset: 'Q', rows: Array.from({ length: 10 }, (_, n) => ({ data: { input: `question ${n}`, expected: `answer ${n}` } })) });
  await engine.call('create_target', { name: 'Model', spec: { config: { kind: 'model', connectionId: 'stub', model: 'bad', prompt: '{{input}}' } } });
  await engine.call('create_target', { name: 'Flavour', spec: { variables: [{ key: 'flavour', value: 'plain' }], config: { kind: 'script', code: 'return { output: vars.flavour };' } } });
  await engine.call('create_suite', { name: 'Exact', spec: { checks: [{ id: 'eq', type: 'equals', name: 'Matches', config: { actual: '{{output}}', expected: '{{expected}}' } }] } });
});

afterAll(async () => {
  await engine?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('run overrides', () => {
  it('deep-merges config, replaces or adds variables, and swaps model settings', () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 }, e: 4 })).toEqual({ a: 1, b: { c: 9, d: 3 }, e: 4 });
    const spec = TargetSpec.parse({ variables: [{ key: 'base_url', value: 'http://prod' }], config: { kind: 'model', connectionId: 'a', model: 'm1', prompt: '{{input}}' } });
    const next = applyOverrides(spec, { label: '', vars: { base_url: 'http://staging', extra: 'x' }, model: { connectionId: 'b', model: 'm2', temperature: 0.2 }, config: { prompt: 'Q: {{input}}' } });
    expect(next.variables.map((v) => [v.key, v.value])).toEqual([['base_url', 'http://staging'], ['extra', 'x']]);
    expect(next.config).toMatchObject({ connectionId: 'b', model: 'm2', temperature: 0.2, prompt: 'Q: {{input}}' });
    expect(spec.variables[0].value).toBe('http://prod'); // original untouched
    expect(() => applyOverrides(spec, { label: '', vars: {}, config: { kind: 'nope' } })).toThrow();
  });
});

describe('comparisons', () => {
  let id: string;

  it('validates variants before creating anything', async () => {
    const before = (await engine.call<any>('list_comparisons', {})).total;
    await expect(engine.call('start_comparison', { dataset: 'Q', suite: 'Exact', variants: [{ target: 'Model' }] })).rejects.toThrow();
    await expect(
      engine.call('start_comparison', { dataset: 'Q', suite: 'Exact', variants: [{ target: 'Model' }, { target: 'Model', overrides: { config: { kind: 'nope' } } }] }),
    ).rejects.toThrow(/Variant 2/);
    await expect(engine.call('start_comparison', { dataset: 'Q', suite: 'Exact', variants: [{ target: 'Model' }, { target: 'Missing' }] })).rejects.toThrow(/not found/);
    expect((await engine.call<any>('list_comparisons', {})).total).toBe(before);
  });

  it('runs every variant on the same dataset version and ranks them', async () => {
    const started = await engine.call<any>('start_comparison', {
      name: 'Models',
      dataset: 'Q',
      suite: 'Exact',
      variants: [
        { target: 'Model', overrides: { model: { model: 'bad' } } },
        { target: 'Model', label: 'Good one', overrides: { model: { model: 'good' } } },
        { target: 'Model', overrides: { model: { model: 'meh' } } },
      ],
      settings: { concurrency: 4, retries: 0 },
    });
    id = started.id;
    expect(started.runs.map((r: any) => r.label)).toEqual(['Model · bad', 'Good one', 'Model · meh']);
    const c = await waitComparison(id);
    expect(c.status).toBe('completed');
    expect(c.done).toBe(30);
    const runs = await Promise.all(c.variants.map((v: any) => engine.call<any>('get_run', { runId: v.runId })));
    expect(new Set(runs.map((r: any) => r.datasetVersionId)).size).toBe(1);
    expect(runs.every((r: any) => r.groupId === id && r.variantLabel)).toBe(true);

    const [first, second, third] = c.variants;
    expect(first.label).toBe('Good one');
    expect(first.isBest).toBe(true);
    expect(first.passRate).toBe(1);
    expect(first.vsBest).toBeNull();
    expect(second.label).toBe('Model · meh');
    expect(second.passRate).toBe(0.5);
    expect(second.vsBest).toMatchObject({ paired: 10, bestOnly: 5, thisOnly: 0 });
    expect(second.vsBest.verdict).toBe('could be noise'); // 5 discordant pairs: p = 0.0625
    expect(third.passRate).toBe(0);
    expect(third.vsBest.verdict).toBe('clearly worse'); // 10 discordant pairs: p ≈ 0.002
    expect(third.vsBest.pValue).toBeLessThan(0.01);
    expect(c.checks ?? c.variants[0].checks).toBeTruthy();
    expect(first.checks[0]).toMatchObject({ id: 'eq', passRate: 1 });
  });

  it('shows outputs side by side with disagreement filters', async () => {
    const all = await engine.call<any>('compare_rows', { id, filter: 'all' });
    expect(all.variants).toHaveLength(3);
    expect(all.counts).toEqual({ all: 10, disagreements: 10, all_failed: 0, all_passed: 0 });
    const row = all.rows[0];
    expect(Object.keys(row.variants)).toHaveLength(3);
    const good = all.variants.find((v: any) => v.label === 'Good one');
    expect(row.variants[good.runId]).toMatchObject({ passed: true, failing: [] });
    const bad = all.variants.find((v: any) => v.label === 'Model · bad');
    expect(row.variants[bad.runId].failing).toEqual(['Matches']);
    const page = await engine.call<any>('compare_rows', { id, filter: 'disagreements', offset: 8, limit: 5 });
    expect(page.total).toBe(10);
    expect(page.rows).toHaveLength(2);
    expect((await engine.call<any>('compare_rows', { id, filter: 'all_passed' })).total).toBe(0);
  });

  it('applies variable overrides per variant and dedupes labels', async () => {
    const started = await engine.call<any>('start_comparison', {
      dataset: 'Q',
      suite: 'Exact',
      variants: [
        { target: 'Flavour', label: 'Same', overrides: { vars: { flavour: 'vanilla' } } },
        { target: 'Flavour', label: 'Same', overrides: { vars: { flavour: 'mango' } } },
      ],
      settings: { limit: 2 },
    });
    expect(started.runs.map((r: any) => r.label)).toEqual(['Same', 'Same (2)']);
    const c = await waitComparison(started.id);
    const rows = await engine.call<any>('compare_rows', { id: started.id, filter: 'all' });
    const outputs = rows.variants.map((v: any) => rows.rows[0].variants[v.runId].output);
    expect(outputs).toEqual(['vanilla', 'mango']);
    expect(c.variants.every((v: any) => v.passRate === 0)).toBe(true);
    expect(c.variants[1].vsBest.verdict).toBe('tied');
  });

  it('lists comparisons with their best variant and keeps their runs out of the plain run list on request', async () => {
    const list = await engine.call<any>('list_comparisons', {});
    const mine = list.comparisons.find((g: any) => g.id === id);
    expect(mine).toMatchObject({ name: 'Models', variants: 3, status: 'completed', best: { label: 'Good one', passRate: 1 } });
    const plain = await engine.call<any>('list_runs', { excludeComparisons: true });
    expect(plain.runs.every((r: any) => !r.groupId)).toBe(true);
    const of = await engine.call<any>('list_runs', { comparison: id });
    expect(of.runs).toHaveLength(3);
  });

  it('filters results by id (used by failure themes)', async () => {
    const c = await engine.call<any>('get_comparison', { id });
    const runId = c.variants[0].runId;
    const all = await engine.call<any>('query_results', { runId, limit: 100 });
    const ids = all.results.slice(0, 3).map((r: any) => r.id);
    const some = await engine.call<any>('query_results', { runId, ids });
    expect(some.total).toBe(3);
    expect(some.results.map((r: any) => r.id).sort()).toEqual([...ids].sort());
    expect((await engine.call<any>('query_results', { runId, ids: [] })).total).toBe(0);
    expect((await engine.call<any>('query_results', { runId, ids: ['res_missing'] })).total).toBe(0);
  });

  it('deletes a comparison together with its runs', async () => {
    const c = await engine.call<any>('get_comparison', { id });
    await engine.call('delete_comparison', { id });
    await expect(engine.call('get_comparison', { id })).rejects.toThrow(/not found/);
    await expect(engine.call('get_run', { runId: c.variants[0].runId })).rejects.toThrow(/not found/);
  });
});
