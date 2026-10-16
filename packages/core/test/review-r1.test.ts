import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { Db } from '../src/db.js';
import { FileSecretStore } from '../src/storage.js';
import { mcnemarExact } from '../src/ops/runs.js';

const AGENT = { kind: 'agent' as const, id: 'claude-code', client: 'claude-code' };

/** Regression tests for issues found in the code review of the engine, ops and storage. */
describe('engine review fixes', () => {
  let dir: string;
  let engine: Engine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-review-'));
    engine = new Engine({ dir });
    await engine.call('create_dataset', { name: 'Questions', columns: [{ key: 'question' }] });
    await engine.call('add_dataset_rows', { dataset: 'Questions', rows: [{ data: { question: 'a' } }, { data: { question: 'b' } }] });
    await engine.call('create_target', { name: 'Nowhere', spec: { config: { kind: 'http', url: 'http://127.0.0.1:9/x' } } });
    await engine.call('create_suite', { name: 'Empty', spec: { checks: [] } });
  });

  afterAll(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fails = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e: any) {
      return e;
    }
    throw new Error('expected the call to fail');
  };

  it('does not let agents call secret operations by name, though they are hidden from MCP', async () => {
    expect((await fails(engine.call('set_secret', { name: 'stolen', value: 'x' }, AGENT))).code).toBe('forbidden');
    expect((await fails(engine.call('delete_secret', { name: 'anything' }, AGENT))).code).toBe('forbidden');
    expect(await engine.secrets.list()).not.toContain('stolen');
    await engine.call('set_secret', { name: 'mine', value: 'x' }); // the person in the app still can
    expect(await engine.call('list_secrets', {}, AGENT)).toContain('mine');
  });

  it('reports a missing or malformed file without the workspace path', async () => {
    const missing = await fails(engine.blobs.get('a'.repeat(64)));
    expect(missing.code).toBe('not_found');
    expect(missing.message).not.toContain(dir);
    expect((await fails(engine.blobs.get('../../etc/passwd'))).code).toBe('invalid');
    const viaOp = await fails(engine.call('import_rows', { dataset: 'Questions', blob: 'b'.repeat(64) }));
    expect(viaOp.code).toBe('not_found');
  });

  it('keeps the secrets file private', async () => {
    const file = join(dir, 'private-secrets.json');
    const store = new FileSecretStore(file);
    await store.set('k', 'v');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to rename a dataset onto another dataset\'s name with a conflict, not a database error', async () => {
    await engine.call('create_dataset', { name: 'Other' });
    const e = await fails(engine.call('update_dataset', { dataset: 'Other', name: 'Questions' }));
    expect(e.code).toBe('conflict');
    await engine.call('update_dataset', { dataset: 'Other', name: 'Other renamed' });
  });

  it('bounds the prepared statement cache', () => {
    const db = new Db(join(dir, 'cache.db'));
    for (let n = 1; n <= 800; n++) db.get(`SELECT ${Array.from({ length: n }, () => '?').join(' + ')} AS s`, ...Array.from({ length: n }, () => 1));
    expect((db as any).cache.size).toBeLessThanOrEqual(500);
    db.close();
  });

  it('re-imports a file whose headers are not valid column names without adding duplicate columns', async () => {
    await engine.call('create_dataset', { name: 'Imported' });
    const csv = 'user question,expected answer\nHow do I reset?,Use the link\n';
    const up = (text: string, name: string) => engine.call<any>('upload_file', { name, base64: Buffer.from(text).toString('base64') });
    const first = await engine.call<any>('import_rows', { dataset: 'Imported', blob: (await up(csv, 'a.csv')).hash });
    expect(first.added).toHaveLength(1);
    const again = await engine.call<any>('import_rows', { dataset: 'Imported', blob: (await up(`${csv}Second?,Yes\n`, 'b.csv')).hash });
    expect(again.added).toHaveLength(1);
    const schema = await engine.call<any>('get_dataset_schema', { dataset: 'Imported' });
    expect(schema.columns.map((c: any) => c.key)).toEqual(['user_question', 'expected_answer']);
  });

  it('rejects JSONL lines that are not objects with a clear error', async () => {
    await engine.call('create_dataset', { name: 'Lines' });
    const blob = await engine.call<any>('upload_file', { name: 'x.jsonl', base64: Buffer.from('{"q": "a"}\n5\n').toString('base64') });
    const e = await fails(engine.call('import_rows', { dataset: 'Lines', blob: blob.hash }));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/Line 2/);
  });

  it('computes McNemar p-values for large runs instead of NaN', () => {
    expect(mcnemarExact(0, 12)).toBeCloseTo(2 / 4096, 10);
    expect(mcnemarExact(3, 10)).toBeCloseTo(0.0923, 3);
    const big = mcnemarExact(600, 700)!;
    expect(Number.isFinite(big)).toBe(true);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(0.01);
    expect(mcnemarExact(1000, 1000)).toBe(1);
  });

  it('leaves no empty comparison behind when its variants cannot be set up', async () => {
    const e = await fails(
      engine.call('start_comparison', { dataset: 'Questions', suite: 'Empty', variants: [{ target: 'Nowhere' }, { target: 'Nowhere', label: 'again' }], settings: { tags: ['no-such-tag'] } }),
    );
    expect(e.code).toBe('invalid');
    expect((await engine.call<any>('list_comparisons', {})).total).toBe(0);
    expect((await engine.call<any>('list_runs', {})).total).toBe(0);
  });

  it('keeps pinned target and suite versions usable after they are moved to the trash', async () => {
    await engine.call('create_target', { name: 'Short-lived', spec: { config: { kind: 'http', url: 'http://127.0.0.1:9/y' } } });
    const started = await engine.call<any>('start_run', { dataset: 'Questions', target: 'Short-lived', suite: 'Empty', settings: { retries: 0 } });
    await engine.runner.wait(started.id);
    await engine.call('delete_target', { id: 'Short-lived' });
    const pinned = await engine.call<any>('get_target', { id: started.targetId, version: started.targetVersion });
    expect(pinned.spec.config.url).toBe('http://127.0.0.1:9/y');
    await engine.call('resume_run', { runId: started.id });
    const resumed = await engine.runner.wait(started.id);
    expect(resumed.status).toBe('completed');
    expect(resumed.error).toBeNull();
    await engine.call('delete_run', { runId: started.id });
  });

  it('asks for a column when breaking a run down by column', async () => {
    const rows = await engine.call<any>('list_rows', { dataset: 'Questions' });
    const csv = ['row_id,output', ...rows.rows.map((r: any) => `${r.id},hello`)].join('\n');
    const file = await engine.call<any>('upload_file', { name: 'out.csv', base64: Buffer.from(csv).toString('base64') });
    const res = await engine.call<any>('import_outputs', { dataset: 'Questions', suite: 'Empty', blob: file.hash });
    await engine.runner.wait(res.run.id);
    expect((await fails(engine.call('run_breakdown', { runId: res.run.id, by: 'column' }))).code).toBe('invalid');
    // Light result reads still carry everything the grids and summaries use.
    const page = await engine.call<any>('query_results', { runId: res.run.id });
    expect(page.results[0]).toMatchObject({ rowId: expect.any(String), status: 'done', outputs: { output: 'hello' } });
  });
});
