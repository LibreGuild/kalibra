import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { Embeddings } from '../src/providers/embeddings.js';
import { buildReport, compressionRatio, distinctN, selfBleu, type QualityRow } from '../src/quality/profile.js';
import { exactDuplicates, jaccard, nearDuplicates, semanticDuplicates, shingles } from '../src/quality/duplicates.js';
import type { ColumnSpec } from '../src/specs.js';

const row = (id: string, data: Record<string, unknown>, status = 'approved', tags: string[] = []): QualityRow => ({ id, data, status, tags });
const col = (key: string, type = 'text', extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ key, type: type as any, description: '', required: false, ...extra });

describe('quality report (pure)', () => {
  it('handles an empty dataset', () => {
    const r = buildReport([col('q')], []);
    expect(r.rows).toBe(0);
    expect(r.columns[0].fillRate).toBe(1);
    expect(r.flags).toEqual([]);
  });

  it('handles a single row without crashing on diversity', () => {
    const r = buildReport([col('q')], [row('1', { q: 'hello' })]);
    expect(r.columns[0].filled).toBe(1);
    expect(r.columns[0].diversity).toBeUndefined();
    expect(r.flags.map((f) => f.kind)).toContain('small');
  });

  it('flags copies, low variety and dominant values on all-identical rows', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(String(i), { q: 'How do I block my card right now please', lang: 'en' }));
    const r = buildReport([col('q'), col('lang')], rows);
    expect(r.exactDuplicateRows).toBe(11);
    const kinds = r.flags.map((f) => f.kind);
    expect(kinds).toContain('duplicates');
    expect(r.columns.find((c) => c.key === 'lang')!.categorical).toBe(true);
    expect(r.columns.find((c) => c.key === 'q')!.categorical).toBe(true); // a single repeated value is categorical
  });

  it('reports empties, missing enum values, mixed types and skips rejected rows', () => {
    const rows = [
      row('1', { q: 'a', n: 1, ok: true, cat: 'cards' }),
      row('2', { q: '', n: '2', ok: false, cat: 'cards' }),
      row('3', { q: 'c', n: null, cat: 'loans' }),
      row('4', { q: 'zzz', cat: 'fraud' }, 'rejected'),
    ];
    const r = buildReport([col('q', 'text', { required: true }), col('n', 'number'), col('ok', 'boolean'), col('cat', 'text', { enum: ['cards', 'loans', 'fraud', 'other'] })], rows);
    expect(r.statuses).toEqual({ approved: 3, rejected: 1 });
    const q = r.columns.find((c) => c.key === 'q')!;
    expect(q.empty).toBe(1);
    const cat = r.columns.find((c) => c.key === 'cat')!;
    expect(cat.missingValues).toEqual(['fraud', 'other']); // the fraud row is rejected
    expect(r.flags.some((f) => f.kind === 'empty' && f.column === 'q' && f.level === 'warn')).toBe(true);
    expect(r.flags.some((f) => f.kind === 'missing_values')).toBe(true);
  });

  it('treats file columns by blob and never computes text metrics for them', () => {
    const blob = (c: string) => ({ blob: c.repeat(64), name: 'a.wav' });
    const r = buildReport([col('audio', 'audio')], [row('1', { audio: blob('a') }), row('2', { audio: blob('a') }), row('3', { audio: blob('b') }), row('4', {})]);
    const a = r.columns[0];
    expect(a.distinct).toBe(2);
    expect(a.categorical).toBe(false);
    expect(a.length).toBeUndefined();
    expect(a.fillRate).toBe(0.75);
  });

  it('diversity metrics move in the right direction', () => {
    const varied = ['The cat sleeps on the warm sofa', 'Markets rallied after the announcement', 'Please reset my banking password', 'Rain is expected later this week', 'My flight to Delhi was cancelled'];
    const same = Array.from({ length: 5 }, () => 'Please reset my banking password today');
    expect(distinctN(varied, 2)).toBeGreaterThan(distinctN(same, 2));
    expect(compressionRatio(same.concat(same))).toBeGreaterThan(compressionRatio(varied));
    expect(selfBleu(same)!).toBeGreaterThan(selfBleu(varied)!);
    expect(selfBleu(['only', 'two'])).toBeNull();
  });
});

describe('duplicates (pure)', () => {
  const rows = [
    row('1', { q: 'How do I block my card?' }),
    row('2', { q: '  how do I BLOCK my   card?  ' }), // case + whitespace
    row('3', { q: 'ｈｏｗ do I block my card?' }), // fullwidth unicode (NFKC)
    row('4', { q: 'How do I block my credit card?' }), // near
    row('5', { q: 'What are your branch opening hours?' }),
  ];

  it('exact groups ignore case, spacing and unicode width', () => {
    const g = exactDuplicates(rows);
    expect(g).toHaveLength(1);
    expect(g[0].rowIds).toEqual(['1', '2', '3']);
  });

  it('near groups catch small edits but not different questions', () => {
    const { groups } = nearDuplicates(rows, 0.55);
    const big = groups.find((g) => g.rowIds.includes('1'))!;
    expect(big.rowIds).toEqual(expect.arrayContaining(['1', '2', '3', '4']));
    expect(groups.some((g) => g.rowIds.includes('5'))).toBe(false);
  });

  it('jaccard and shingles handle empty and tiny texts', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(shingles('ab').size).toBe(1);
    expect(nearDuplicates([row('a', { q: '' }), row('b', { q: '' })]).groups).toEqual([]);
  });

  it('semantic groups use vectors and skip empty text', () => {
    const r = [row('a', { q: 'x' }), row('b', { q: 'y' }), row('c', { q: 'z' }), row('d', { q: '' })];
    const vec = [[1, 0], [0.99, 0.01], [0, 1], [1, 0]];
    const g = semanticDuplicates(r, vec, 0.95);
    expect(g).toHaveLength(1);
    expect(g[0].rowIds).toEqual(['a', 'b']);
  });

  it('can compare on selected columns only', () => {
    const r = [row('1', { q: 'same', id: 1 }), row('2', { q: 'same', id: 2 })];
    expect(exactDuplicates(r)).toHaveLength(0);
    expect(exactDuplicates(r, ['q'])).toHaveLength(1);
  });
});

describe('quality operations', () => {
  let engine: Engine;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-quality-'));
    engine = await Engine.open({ dir });
    (engine as any).embeddings = new Embeddings(() => ({ getConnection: async () => ({}) as any, secrets: engine.secrets }), {
      local: async (texts) => texts.map((t) => (t.includes('block') ? [1, 0] : [0, 1])),
    });
    await engine.call('create_dataset', {
      name: 'Q',
      columns: [
        { key: 'question', type: 'text', required: true },
        { key: 'category', type: 'text', enum: ['cards', 'loans', 'fraud'] },
      ],
    });
    await engine.call('add_dataset_rows', {
      dataset: 'Q',
      rows: [
        { data: { question: 'How do I block my card?', category: 'cards' } },
        { data: { question: 'how do i block my card ?', category: 'cards' } },
        { data: { question: 'Please block my card now', category: 'cards' } },
        { data: { question: 'What is the loan rate?', category: 'loans' } },
      ],
    });
  });
  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dataset_quality returns a report with flags', async () => {
    const r = await engine.call<any>('dataset_quality', { dataset: 'Q' });
    expect(r.rows).toBe(4);
    expect(r.columns.find((c: any) => c.key === 'category').missingValues).toEqual(['fraud']);
  });

  it('find_duplicates works for each method and rejects unknown columns', async () => {
    const near = await engine.call<any>('find_duplicates', { dataset: 'Q', method: 'near' });
    expect(near.groups[0].rowIds).toHaveLength(2);
    const sem = await engine.call<any>('find_duplicates', { dataset: 'Q', method: 'semantic', threshold: 0.9 });
    expect(sem.groups[0].rowIds).toHaveLength(3); // all three "block" questions share a vector
    await expect(engine.call('find_duplicates', { dataset: 'Q', method: 'exact', columns: ['nope'] })).rejects.toThrow(/Unknown columns/);
  });

  it('resolve_duplicates keeps one per group and is idempotent', async () => {
    const sem = await engine.call<any>('find_duplicates', { dataset: 'Q', method: 'semantic', threshold: 0.9 });
    const r = await engine.call<any>('resolve_duplicates', { dataset: 'Q', groups: sem.groups.map((g: any) => g.rowIds), keep: 'longest' });
    expect(r).toEqual({ rejected: 2, kept: 1 });
    const again = await engine.call<any>('resolve_duplicates', { dataset: 'Q', groups: sem.groups.map((g: any) => g.rowIds) });
    expect(again.rejected).toBe(0);
    const rows = await engine.call<any>('list_rows', { dataset: 'Q', status: ['rejected'] });
    expect(rows.total).toBe(2);
  });

  it('fill_gaps generates rows for under-represented values with a model', async () => {
    const asked: string[] = [];
    (engine as any).llm = {
      json: async (req: any) => {
        asked.push(req.prompt);
        const value = /category = "(\w+)"/.exec(req.prompt)?.[1] ?? 'cards';
        return { value: { rows: [{ question: `Question about ${value} ${asked.length}`, category: value }] }, model: 'stub', latencyMs: 1 };
      },
    };
    await engine.call('create_connection', { name: 'stub', spec: { provider: 'openai', defaultModel: 'x' } });
    const r = await engine.call<any>('fill_gaps', { dataset: 'Q', column: 'category', targetPerValue: 1, connectionId: 'stub' });
    expect(r.plan.map((p: any) => p.value)).toEqual(['fraud']);
    for (let i = 0; i < 100 && ['queued', 'running'].includes(engine.jobs.get(r.jobId)?.status ?? ''); i++) await new Promise((res) => setTimeout(res, 20));
    const job = engine.jobs.get(r.jobId)!;
    expect(job.status).toBe('completed');
    expect((job.result as any).totalAdded).toBe(1);
    expect(asked.some((p) => p.includes('category = "fraud"'))).toBe(true);
  });

  it('fill_gaps returns straight away when nothing needs filling, and refuses file columns', async () => {
    const r = await engine.call<any>('fill_gaps', { dataset: 'Q', column: 'category', targetPerValue: 1, connectionId: 'stub' });
    expect(r.jobId).toBeNull();
    expect(r.result.totalAdded).toBe(0);
    await engine.call('update_dataset', { dataset: 'Q', columns: [{ key: 'question', type: 'text', required: true }, { key: 'category', type: 'text', enum: ['cards', 'loans', 'fraud'] }, { key: 'audio', type: 'audio' }] });
    await expect(engine.call('fill_gaps', { dataset: 'Q', column: 'audio', connectionId: 'stub' })).rejects.toThrow(/text-like/);
    await expect(engine.call('fill_gaps', { dataset: 'Q', column: 'nope', connectionId: 'stub' })).rejects.toThrow(/Unknown column/);
  });

  it('embeddings_status and test_embeddings report the local model', async () => {
    const s = await engine.call<any>('embeddings_status', {});
    expect(s.local).toBe('ready');
    const t = await engine.call<any>('test_embeddings', {});
    expect(t.source).toBe('local');
    expect(t.dims).toBe(2);
  });
});

describe('near duplicates at scale', () => {
  it('uses MinHash banding above 1000 rows and still finds copies with typos', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row(String(i), { q: `Unique question number ${i} about topic ${i * 7919} and account ${i * 104729}` }));
    rows.push(row('dupA', { q: 'Please help me reset the password for my online banking account today' }));
    rows.push(row('dupB', { q: 'Please help me reset the pasword for my online banking account today' }));
    const t = Date.now();
    const { groups, truncated } = nearDuplicates(rows, 0.8);
    expect(truncated).toBe(false);
    expect(groups.some((g) => g.rowIds.includes('dupA') && g.rowIds.includes('dupB'))).toBe(true);
    expect(Date.now() - t).toBeLessThan(10_000);
  });
});

describe('coverage only for real categories', () => {
  it('treats short repeated values as categories but not unique free text', async () => {
    const { profileColumn } = await import('../src/quality/profile.js');
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      status: 'approved',
      tags: [],
      data: { category: ['cards', 'loans', 'fraud'][i % 3], answer: `A unique, fairly long answer sentence number ${i} for this row.` },
    }));
    expect(profileColumn({ key: 'category', type: 'text', description: '', required: false } as any, rows as any).categorical).toBe(true);
    expect(profileColumn({ key: 'answer', type: 'text', description: '', required: false } as any, rows as any).categorical).toBe(false);
    // An enum column is always a category, even with one row.
    expect(profileColumn({ key: 'x', type: 'text', description: '', required: false, enum: ['a', 'b'] } as any, rows.slice(0, 1).map((r) => ({ ...r, data: { x: 'a' } })) as any).categorical).toBe(true);
  });
});
