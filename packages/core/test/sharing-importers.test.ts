import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { detectFormat } from '../src/sharing/importers.js';
import { evaluateChecks } from '../src/runner/evaluate.js';
import { SuiteSpec } from '../src/specs.js';

/* Importers for promptfoo, OpenAI Evals, LangSmith and Langfuse files, including the awkward bits. */

const FIX = join(__dirname, 'fixtures/sharing');
const fixture = (name: string) => readFileSync(join(FIX, name));

describe('import from other eval tools', () => {
  let engine: Engine;
  let dir: string;
  const upload = async (name: string, bytes: Buffer = fixture(name)) => (await engine.blobs.put(bytes, { name })).hash;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-import-'));
    engine = new Engine({ dir });
  });
  afterAll(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('detects each format', () => {
    expect(detectFormat(fixture('promptfooconfig.yaml'), 'promptfooconfig.yaml')).toBe('promptfoo');
    expect(detectFormat(fixture('evals.jsonl'), 'evals.jsonl')).toBe('openai_evals');
    expect(detectFormat(fixture('langsmith.csv'), 'langsmith.csv')).toBe('langsmith');
    expect(detectFormat(fixture('langsmith-flat.csv'), 'x.csv')).toBe('langsmith');
    expect(detectFormat(fixture('langfuse.json'), 'items.json')).toBe('langfuse');
    expect(detectFormat(Buffer.from('a,b\n1,2\n'), 'plain.csv')).toBe('plain');
    expect(detectFormat(Buffer.from([0x50, 0x4b, 3, 4]), 'x.kalibra')).toBe('kalibra_bundle');
  });

  it('imports a promptfoo config: tests, assertions, providers and what it could not map', async () => {
    const blob = await upload('promptfooconfig.yaml');
    const preview = await engine.call<any>('inspect_external', { blob });
    expect(preview).toMatchObject({ format: 'promptfoo', providers: 3 });

    const r = await engine.call<any>('import_external', { blob });
    expect(r.format).toBe('promptfoo');
    // 6 test entries: one is a file reference (skipped), one has only a file var (row kept without it).
    expect(r.dataset.rows).toBe(5);
    expect(r.dataset.columns).toEqual(expect.arrayContaining(['question', 'lang', 'prompt', 'test_description']));
    const rows = engine.repos.datasets.listRows(r.dataset.id).rows;
    const uni = rows.find((x) => x.data.lang === 'es')!;
    expect(uni.data.question).toBe('¿Cómo bloqueo mi tarjeta? 🙏');
    expect(uni.data.prompt).toBe('Answer the customer: ¿Cómo bloqueo mi tarjeta? 🙏');
    expect(rows.every((x) => x.data.lang)).toBe(true); // defaultTest vars applied

    const types = r.mappedChecks.map((m: any) => m.to);
    expect(types).toEqual(expect.arrayContaining(['latency', 'contains', 'llm_judge', 'is_json', 'equals', 'script', 'regex', 'refusal']));
    expect(types.some((t: string) => t === 'semantic_similarity' || t === 'similarity')).toBe(true);
    expect(r.unsupported.map((u: any) => u.what)).toEqual(expect.arrayContaining(['assert cost', 'provider python:providers/custom.py']));
    expect(r.skipped.map((s: any) => s.what).join(' ')).toMatch(/tests\/more\.yaml/);
    expect(r.skipped.map((s: any) => s.what).join(' ')).toMatch(/questions\/long\.txt/);
    expect(r.skipped.map((s: any) => s.what).join(' ')).toMatch(/prompts\/other\.txt/);
    expect(r.warnings.join(' ')).not.toMatch(/merged/);

    // Targets: the http provider keeps url, headers, body placeholders and the response mapping.
    const http = engine.repos.defs.get('target', r.targets.find((t: any) => t.kind === 'http').id);
    expect(http.name).toBe('Support API (staging)');
    expect(http.spec.config.url).toBe('https://api.example.com/chat');
    expect(http.spec.config.headers[0]).toMatchObject({ key: 'Authorization', value: 'Bearer {{api_token}}' });
    expect(http.spec.config.body.content).toContain('"message": "{{question}}"');
    expect(http.spec.config.outputs[0]).toMatchObject({ from: 'expression', path: 'body.answer' });
    const model = engine.repos.defs.get('target', r.targets.find((t: any) => t.kind === 'model').id);
    expect(model.spec.config).toMatchObject({ kind: 'model', model: 'gpt-6-luna', connectionId: '' });

    // The suite is valid and behaves sensibly on rows with and without per-row assertions.
    const suite = SuiteSpec.parse(engine.repos.defs.get('suite', r.suite.id).spec);
    expect(suite.checks.find((c) => c.type === 'llm_judge')!.enabled).toBe(false);
    const run = (output: string, row: Record<string, unknown>) =>
      evaluateChecks(suite, { scope: { ...row, row, output, outputs: { output }, response: {}, metrics: { latency_ms: 100 }, vars: {}, error: '' }, env: {}, llm: {} as any, log: () => {}, workspaceDir: dir, signal: new AbortController().signal });
    const card = rows.find((x) => x.data.test_description === 'Card blocking')!.data;
    const res = await run('You can BLOCK it in the app', card);
    const contains = res.checks.find((c) => c.type === 'contains' && c.name.startsWith('icontains'))!;
    expect(contains.status).toBe('pass');
    // Rows without an "equals" assertion skip that check instead of failing it.
    expect(res.checks.find((c) => c.type === 'equals')!.status).toBe('skip');
    const math = rows.find((x) => x.data.question === 'What is 2 + 2?')!.data;
    // Value-less assertions present only in some tests (is-json, is-refusal) apply only there.
    expect(res.checks.find((c) => c.type === 'is_json')!.status).toBe('skip');
    expect(res.checks.find((c) => c.type === 'refusal')!.status).toBe('skip');
    expect(res.checks.find((c) => c.type === 'latency')!.status).toBe('pass'); // defaultTest: every row
    const mathRes = await run('4', math);
    expect(mathRes.checks.find((c) => c.type === 'equals')!.status).toBe('pass');
    expect(mathRes.checks.find((c) => c.type === 'script')!.status).toBe('pass');
    expect(mathRes.checks.find((c) => c.type === 'regex')!.status).toBe('pass'); // not-regex: no dddd-dddd
  });

  it('imports OpenAI Evals data with graders', async () => {
    const r = await engine.call<any>('import_external', { blob: await upload('evals.jsonl'), gradersBlob: await upload('graders.json') });
    expect(r.format).toBe('openai_evals');
    expect(r.dataset.rows).toBe(3);
    const rows = engine.repos.datasets.listRows(r.dataset.id).rows;
    expect(rows.map((x) => x.data.answer)).toEqual(['Paris', '4', 'blue']);
    expect(rows[1].data.tags).toEqual(['math']);
    expect(r.mappedChecks.map((m: any) => m.to)).toEqual(['equals', 'contains', 'similarity', 'rouge_l', 'llm_judge']);
    expect(r.unsupported.map((u: any) => u.what)).toEqual(['text_similarity meteor', 'grader python']);
    const suite = engine.repos.defs.get('suite', r.suite.id).spec;
    expect(suite.checks[0].config).toMatchObject({ actual: '{{output}}', expected: '{{answer}}' });
    expect(suite.checks.find((c: any) => c.type === 'llm_judge').config.criteria).toContain('{{question}}');
  });

  it('imports LangSmith exports (JSON columns and flattened columns)', async () => {
    const r = await engine.call<any>('import_external', { blob: await upload('langsmith.csv') });
    expect(r.format).toBe('langsmith');
    const rows = engine.repos.datasets.listRows(r.dataset.id).rows;
    expect(rows[0].data).toMatchObject({ question: 'What is 1, 2, 3?', context: 'say "numbers"', expected: 'Three numbers' });
    expect(rows[0].split).toBe('test');
    expect(rows[0].tags).toEqual(['math']);
    expect(rows[1].data.question).toBe('Ünïcödé?');

    const flat = await engine.call<any>('import_external', { blob: await upload('langsmith-flat.csv'), name: 'Flat' });
    const frows = engine.repos.datasets.listRows(flat.dataset.id).rows;
    expect(frows[0].data).toMatchObject({ question: 'Hello?', lang: 'en', expected_answer: 'Hi' });
  });

  it('imports Langfuse items, keeping archived ones as rejected', async () => {
    const r = await engine.call<any>('import_external', { blob: await upload('langfuse.json') });
    expect(r.format).toBe('langfuse');
    const rows = engine.repos.datasets.listRows(r.dataset.id).rows;
    expect(rows[0].data).toMatchObject({ question: 'Reset password?', user_tier: 'gold', expected: 'Use the reset link' });
    expect(rows[1].status).toBe('rejected');
    expect(rows[1].data).toMatchObject({ input: 'Plain string input', expected_answer: 'x', expected_confidence: 0.9 });
    expect(rows[2].data.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('handles empty, broken and unrecognised files', async () => {
    const empty = await engine.call<any>('import_external', { blob: await upload('empty.yaml', Buffer.from('description: Nothing here\ntests: []\n')), format: 'promptfoo' });
    expect(empty.dataset.rows).toBe(0);
    expect(empty.warnings.join(' ')).toMatch(/no rows/);
    await expect(engine.call('import_external', { blob: await upload('plain.csv', Buffer.from('a,b\n1,2\n')) })).rejects.toThrow(/not recognised/);
    await expect(engine.call('import_external', { blob: await upload('bad.yaml', Buffer.from('tests: [unclosed')), format: 'promptfoo' })).rejects.toThrow(/Could not read/);
    await expect(engine.call('import_external', { blob: 'f'.repeat(64) })).rejects.toThrow(/Upload the file first/);
    // Re-importing creates a new, uniquely named dataset rather than clobbering the first.
    const again = await engine.call<any>('import_external', { blob: await upload('langfuse.json') });
    expect(again.dataset.name).toMatch(/\(imported/);
  });
});
