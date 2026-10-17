import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { RunSettings } from '../src/specs.js';
import { agglomerate, freeGroups, normalizeReason, type FailureLite } from '../src/insights/themes.js';

const user = { kind: 'user' as const, id: 'local' };

const fail = (id: string, checkId: string, reason: string, output = 'out', extra: Partial<FailureLite> = {}): FailureLite => ({
  id,
  status: 'done',
  passed: false,
  error: null,
  input: { question: `q ${id}` },
  outputs: { output },
  checks: [
    { id: 'status', name: 'HTTP 2xx', type: 'status', status: 'pass' },
    { id: checkId, name: checkId.toUpperCase(), type: checkId, status: 'fail', reason },
  ],
  ...extra,
});

describe('free grouping', () => {
  it('strips numbers, ids and quoted values so similar reasons group together', () => {
    expect(normalizeReason('WER 12.5% (limit 15%)')).toBe(normalizeReason('WER 33% (limit 15%)'));
    expect(normalizeReason('Missing "Priya" in res_mvbdsdr04cisfol7')).toBe(normalizeReason("Missing 'Monday' in res_abcdefgh12345678"));
    expect(normalizeReason('Status 500, expected 2xx')).not.toContain('500');
  });

  it('groups by first failing check, keeps different reasons apart, and counts shares', () => {
    const results = [
      fail('a', 'wer', 'WER 20% > 15%'),
      fail('b', 'wer', 'WER 31% > 15%'),
      fail('c', 'wer', 'Reference is empty'),
      fail('d', 'contains', 'Missing "block"'),
      { ...fail('e', 'wer', 'x'), passed: true, checks: [] } as FailureLite, // a pass: ignored
    ];
    const { total, groups } = freeGroups(results);
    expect(total).toBe(4);
    expect(groups[0].count).toBe(2);
    expect(groups[0].checkId).toBe('wer');
    expect(groups[0].resultIds.sort()).toEqual(['a', 'b']);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(groups[0].share).toBeCloseTo(0.5);
    expect(groups[0].examples.length).toBe(2);
  });

  it('handles no failures, a single failure, identical reasons and transport errors', () => {
    expect(freeGroups([]).groups).toEqual([]);
    expect(freeGroups([fail('a', 'wer', 'x')]).groups).toHaveLength(1);
    const same = freeGroups(Array.from({ length: 10 }, (_, i) => fail(`r${i}`, 'wer', 'WER too high')));
    expect(same.groups).toHaveLength(1);
    expect(same.groups[0].examples).toHaveLength(3);
    const err = freeGroups([{ id: 'x', status: 'error', passed: false, error: 'ECONNREFUSED 127.0.0.1:9999', input: {}, outputs: {}, checks: [] }]);
    expect(err.groups[0].checkName).toBe('Target error');
  });

  it('truncates huge outputs in examples', () => {
    const { groups } = freeGroups([fail('a', 'wer', 'x', 'y'.repeat(100_000))]);
    expect(groups[0].examples[0].output.length).toBeLessThan(260);
  });
});

describe('agglomerative clustering', () => {
  it('merges similar vectors and respects the cluster cap', () => {
    const v = [[1, 0, 0], [0.98, 0.05, 0], [0, 1, 0], [0.02, 0.99, 0], [0, 0, 1]];
    const clusters = agglomerate(v, 0.9, 10);
    expect(clusters).toHaveLength(3);
    expect(clusters.map((c) => c.length).sort()).toEqual([1, 2, 2]);
    expect(agglomerate(v, 0.9, 2)).toHaveLength(2);
    expect(agglomerate([[1, 0]], 0.9, 5)).toEqual([[0]]);
  });
});

describe('cluster_failures / get_failure_themes', () => {
  let engine: Engine;
  let dir: string;
  let runId = '';
  let emptyRunId = '';
  let calls: { prompt: string; schemaName?: string }[] = [];
  let mode: 'ok' | 'bad-ids' | 'error' | 'no-themes' = 'ok';

  async function makeRun(failures: { checkId: string; reason: string }[], passes = 0) {
    const ds = await engine.repos.datasets.get('Q');
    const v = await engine.repos.datasets.createVersion(ds.id, '', user);
    const rows = await engine.repos.datasets.versionRows(v.id);
    const run = await engine.repos.runs.create({ kind: 'imported', datasetId: ds.id, datasetVersionId: v.id, suiteId: 'ste_x', suiteVersion: 1, settings: RunSettings.parse({}) }, user);
    const items = [...failures.map(() => false), ...Array.from({ length: passes }, () => true)];
    await engine.repos.runs.addPending(run.id, items.map((_, i) => ({ rowId: rows[i % rows.length].id, rowRev: 1, rep: i, input: rows[i % rows.length].data })));
    for (const [i, p] of (await engine.repos.runs.pending(run.id)).entries()) {
      const f = failures[i];
      await engine.repos.runs.saveResult(run.id, p.id, {
        status: 'done',
        passed: !f,
        score: f ? 0 : 1,
        outputs: { output: f ? `bad answer ${i}` : 'good' },
        checks: f ? [{ id: f.checkId, name: f.checkId, type: f.checkId, status: 'fail', reason: f.reason }] : [{ id: 'ok', name: 'ok', type: 'equals', status: 'pass' }],
        metrics: {},
        attempts: 1,
      });
    }
    return run.id;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-themes-'));
    engine = await Engine.open({ dir });
    await engine.call('create_dataset', { name: 'Q', columns: [{ key: 'question', type: 'text' }] });
    await engine.call('add_dataset_rows', { dataset: 'Q', rows: Array.from({ length: 6 }, (_, i) => ({ data: { question: `question ${i}` } })) });
    await engine.call('create_connection', { name: 'Stub', spec: { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'stub' } });
    runId = await makeRun([
      { checkId: 'wer', reason: 'WER 20% > 15%' },
      { checkId: 'wer', reason: 'WER 30% > 15%' },
      { checkId: 'contains', reason: 'Missing "1800-123-456"' },
      { checkId: 'contains', reason: 'Missing "block"' },
      { checkId: 'judge', reason: 'Invents a policy' },
    ], 2);
    emptyRunId = await makeRun([], 3);

    (engine as any).llm = {
      json: async (req: any) => {
        calls.push({ prompt: req.prompt, schemaName: req.schemaName });
        if (mode === 'error') throw new Error('model unavailable');
        if (req.schemaName === 'failure_theme') return { value: { title: 'Wrong numbers in transcripts and other words', explanation: 'e', cause: 'c', fix: 'f', severity: 'high' }, latencyMs: 1, model: 'stub-1' };
        if (req.schemaName === 'failure_themes') {
          if (mode === 'no-themes') return { value: { themes: [] }, latencyMs: 1, model: 'stub-1' };
          return { value: { themes: [{ id: 't1', title: 'Transcription errors', explanation: 'e', cause: 'c', fix: 'f', severity: 'medium' }, { id: 't1', title: 'dup', explanation: '', cause: '', fix: '', severity: 'low' }, { id: 't2', title: 'Missing facts', explanation: 'e', cause: 'c', fix: 'f', severity: 'weird' }] }, latencyMs: 1, model: 'stub-1' };
        }
        // assignment: map ids we can see; add junk
        const ids = [...req.prompt.matchAll(/\[(res_[a-z0-9]+)\]/g)].map((m: any) => m[1]);
        const assignments = ids.slice(0, ids.length - 1).map((id: string, k: number) => ({ resultId: id, themeId: k < 2 ? 't1' : 't2' }));
        if (mode === 'bad-ids') assignments.push({ resultId: 'res_unknown', themeId: 't1' }, { resultId: ids[0], themeId: 'nope' });
        return { value: { assignments }, latencyMs: 1, model: 'stub-1' };
      },
    };
  });

  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (input: Record<string, unknown>) => {
    const { jobId } = await engine.call<any>('cluster_failures', { runId, connectionId: 'Stub', ...input });
    return engine.jobs.wait(jobId, 10);
  };

  it('returns free groups and no AI themes before clustering', async () => {
    const t = await engine.call<any>('get_failure_themes', { runId });
    expect(t.totalFailures).toBe(5);
    // "Missing "1800-123-456"" and "Missing "block"" share a pattern once quoted values are stripped.
    expect(t.groups.map((g: any) => g.count)).toEqual([2, 2, 1]);
    expect(t.ai).toBeNull();
  });

  it('refuses runs without failures', async () => {
    await expect(engine.call('cluster_failures', { runId: emptyRunId, connectionId: 'Stub' })).rejects.toThrow(/no failures/);
  });

  it('LLM path: proposes, dedupes theme ids, assigns, puts leftovers in Other, and saves the insight', async () => {
    calls = [];
    mode = 'ok';
    const job = await run({ useEmbeddings: false });
    expect(job.status).toBe('completed');
    expect((job.result as any).method).toBe('llm');
    const t = await engine.call<any>('get_failure_themes', { runId });
    const titles = t.ai.themes.map((x: any) => x.title);
    expect(titles).toEqual(expect.arrayContaining(['Transcription errors', 'Missing facts', 'Other failures']));
    expect(t.ai.themes.reduce((s: number, x: any) => s + x.count, 0)).toBe(5);
    expect(t.ai.themes.find((x: any) => x.title === 'Missing facts').severity).toBe('medium'); // unknown severity normalised
    expect(t.ai.model).toBe('stub-1');
  });

  it('ignores unknown result ids and theme ids from the model', async () => {
    mode = 'bad-ids';
    const job = await run({ useEmbeddings: false });
    expect(job.status).toBe('completed');
    const t = await engine.call<any>('get_failure_themes', { runId });
    const all = t.ai.themes.flatMap((x: any) => x.resultIds);
    expect(all).not.toContain('res_unknown');
    expect(new Set(all).size).toBe(5);
  });

  it('embeddings path clusters, then names each cluster (titles capped at 6 words)', async () => {
    mode = 'ok';
    calls = [];
    engine.embeddings = {
      embed: async (texts: string[]) => ({ vectors: texts.map((s) => (s.includes('Failed: wer') ? [1, 0, 0] : s.includes('Failed: contains') ? [0, 1, 0] : [0, 0, 1])), model: 'stub-emb', source: 'local' as const }),
      status: async () => ({ local: 'ready' as const, model: 'stub-emb' }),
    };
    const job = await run({});
    expect((job.result as any).method).toBe('embeddings');
    expect(calls.every((c) => c.schemaName === 'failure_theme')).toBe(true);
    const t = await engine.call<any>('get_failure_themes', { runId });
    expect(t.ai.themes.map((x: any) => x.count).sort()).toEqual([1, 2, 2]);
    expect(t.ai.themes[0].title.split(' ').length).toBeLessThanOrEqual(6);
  });

  it('falls back to LLM assignment when there is no embedding model', async () => {
    engine.embeddings = { embed: async () => { throw new Error('should not be called'); }, status: async () => ({ local: 'unavailable' as const, model: '' }) };
    const job = await run({});
    expect((job.result as any).method).toBe('llm');
    const t = await engine.call<any>('get_failure_themes', { runId });
    expect(t.ai.embeddingNote).toMatch(/No embedding model/);
  });

  it("uses the connection's embedding model when the local one is not installed", async () => {
    const seen: any[] = [];
    engine.embeddings = {
      embed: async (texts: string[], opts: any) => {
        seen.push(opts);
        return { vectors: texts.map(() => [1, 0, 0]), model: 'conn-emb', source: 'connection' as const };
      },
      status: async () => ({ local: 'unavailable' as const, model: '' }),
    };
    const conn = await engine.call<any>('get_connection', { id: 'Stub' });
    await engine.call('update_connection', { id: conn.id, spec: { ...conn.spec, embeddingModel: 'text-embedding-3-small' } });
    mode = 'ok';
    const job = await run({});
    expect((job.result as any).method).toBe('embeddings');
    expect(seen[0].connectionId).toBe('Stub');
    await engine.call('update_connection', { id: conn.id, spec: conn.spec });
  });

  it('reports why embeddings failed and falls back to LLM assignment', async () => {
    engine.embeddings = { embed: async () => { throw new Error('model download broken'); }, status: async () => ({ local: 'ready' as const, model: 'x' }) };
    const job = await run({});
    expect((job.result as any).method).toBe('llm');
    const t = await engine.call<any>('get_failure_themes', { runId });
    expect(t.ai.embeddingNote).toMatch(/model download broken/);
  });

  it('keeps the free grouping and reports the error when the model fails or returns nothing', async () => {
    const before = (await engine.call<any>('get_failure_themes', { runId })).ai.id;
    mode = 'error';
    const job = await run({ useEmbeddings: false });
    expect(job.status).toBe('completed');
    expect((job.result as any).fallback).toBe(true);
    expect((job.result as any).error).toMatch(/model unavailable/);
    mode = 'no-themes';
    expect(((await run({ useEmbeddings: false })).result as any).error).toMatch(/no themes/);
    expect((await engine.call<any>('get_failure_themes', { runId })).ai.id).toBe(before); // latest successful result kept
  });

  it('analyses at most maxFailures and says so', async () => {
    mode = 'ok';
    const job = await run({ useEmbeddings: false, maxFailures: 2 });
    expect((job.result as any).analyzed).toBe(2);
    expect((await engine.call<any>('get_failure_themes', { runId })).ai.truncated).toBe(true);
  });
});
