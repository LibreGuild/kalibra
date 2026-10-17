import { describe, expect, it } from 'vitest';
import { CHECK_TYPES, describeCheckTypes, getCheckType, statusMatches } from '../src/checks/index.js';
import type { CheckScope } from '../src/checks/types.js';
import type { LlmClient } from '../src/providers/types.js';

function ctx(scope: Record<string, unknown>, llm?: Partial<LlmClient>): CheckScope {
  const row = (scope.row as Record<string, unknown>) ?? {};
  return {
    scope: { ...row, row, outputs: {}, metrics: {}, vars: {}, error: '', ...scope },
    env: {},
    llm: llm as LlmClient,
    log: () => {},
    workspaceDir: process.cwd(),
    signal: new AbortController().signal,
  };
}

const run = (type: string, config: Record<string, unknown>, scope: Record<string, unknown>, llm?: Partial<LlmClient>) =>
  getCheckType(type)!.run(config, ctx(scope, llm));

describe('catalog', () => {
  it('has unique types with parseable defaults', () => {
    expect(new Set(CHECK_TYPES.map((c) => c.type)).size).toBe(CHECK_TYPES.length);
    const catalog = describeCheckTypes();
    expect(catalog.find((c) => c.type === 'wer')?.defaults).toMatchObject({ metric: 'wer', max: 0.15 });
    for (const c of catalog) expect(c.configSchema).toBeTypeOf('object');
  });
});

describe('transport checks', () => {
  it('status supports classes, ranges and exact codes', async () => {
    expect(statusMatches(201, '2xx')).toBe(true);
    expect(statusMatches(404, '200, 404')).toBe(true);
    expect(statusMatches(503, '200-299')).toBe(false);
    expect((await run('status', {}, { response: { status: 200 } })).status).toBe('pass');
    expect((await run('status', { expected: '2xx' }, { response: { status: 500 } })).status).toBe('fail');
    const noResp = await run('status', {}, { error: 'ECONNREFUSED' });
    expect(noResp.status).toBe('fail');
    expect(noResp.reason).toContain('ECONNREFUSED');
  });
  it('latency skips missing metrics', async () => {
    expect((await run('latency', { max: 100 }, { metrics: { latency_ms: 80 } })).status).toBe('pass');
    expect((await run('latency', { max: 100 }, { metrics: { latency_ms: 120 } })).status).toBe('fail');
    expect((await run('latency', { metric: 'ttft_ms' }, { metrics: {} })).status).toBe('skip');
  });
});

describe('structure checks', () => {
  it('json_schema validates parsed text', async () => {
    const schema = '{"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}';
    expect((await run('json_schema', { schema }, { output: '{"answer":"hi"}' })).status).toBe('pass');
    const bad = await run('json_schema', { schema }, { output: { answer: 3 } });
    expect(bad.status).toBe('fail');
    expect(bad.reason).toContain('/answer');
    expect((await run('json_schema', { schema }, { output: 'not json' })).status).toBe('fail');
  });
  it('json_schema with "$async": true fails invalid output instead of passing on a promise', async () => {
    const schema = '{"$async":true,"type":"object","required":["answer"],"properties":{"answer":{"type":"string"}}}';
    expect((await run('json_schema', { schema }, { output: '{"answer":"hi"}' })).status).toBe('pass');
    const bad = await run('json_schema', { schema }, { output: { answer: 3 } });
    expect(bad.status).toBe('fail');
    expect(bad.reason).toContain('/answer');
  });
  it('jsonpath compares numbers and lengths', async () => {
    const output = { confidence: 0.9, sources: [{ id: 'a' }, { id: 'b' }] };
    expect((await run('jsonpath', { path: '$.confidence', operator: 'gt', value: '0.5' }, { output })).status).toBe('pass');
    expect((await run('jsonpath', { path: '$.sources', operator: 'length_gte', value: '3' }, { output })).status).toBe('fail');
    expect((await run('jsonpath', { path: '$.sources[*].id', operator: 'equals', value: 'a', quantifier: 'any' }, { output })).status).toBe('pass');
    expect((await run('jsonpath', { path: '$.missing', operator: 'not_exists' }, { output })).status).toBe('pass');
    expect((await run('jsonpath', { path: '$.confidence', operator: 'gte', value: '{{min}}' }, { output, row: { min: 0.95 } })).status).toBe('fail');
  });
});

describe('content checks', () => {
  it('contains any / all / none', async () => {
    const scope = { output: 'Your refund was approved.', row: { keywords: ['refund', 'cancel'] } };
    expect((await run('contains', { values: ['{{keywords}}'], mode: 'any' }, scope)).status).toBe('pass');
    const all = await run('contains', { values: ['{{keywords}}'], mode: 'all' }, scope);
    expect(all.status).toBe('fail');
    expect(all.details?.missing).toEqual(['cancel']);
    expect((await run('contains', { values: ['sorry'], mode: 'none' }, scope)).status).toBe('pass');
  });
  it('equals, numeric and similarity', async () => {
    expect((await run('equals', {}, { output: ' Paris ', row: { expected: 'Paris' } })).status).toBe('pass');
    expect((await run('numeric', { expected: '100', tolerance: 0.05, toleranceType: 'relative' }, { output: '104' })).status).toBe('pass');
    expect((await run('numeric', { min: 0, max: 1 }, { output: 1.5 })).status).toBe('fail');
    expect((await run('similarity', { threshold: 0.8 }, { output: 'colour', row: { expected: 'color' } })).status).toBe('pass');
  });
});

describe('reference checks', () => {
  it('wer reports corpus-ready details', async () => {
    const r = await run('wer', { normalizer: 'basic', max: 0.5 }, { output: 'The cat sit on mat.', row: { reference: 'the cat sat on the mat' } });
    expect(r.status).toBe('pass');
    expect(r.value).toBeCloseTo(0.3333, 3);
    expect(r.details).toMatchObject({ metric: 'wer', errors: 2, refUnits: 6, subs: 1, dels: 1, ins: 0, hits: 4 });
    expect(Array.isArray(r.details?.ops)).toBe(true);
    const strict = await run('wer', { max: 0.1 }, { output: 'The cat sit on mat.', row: { reference: 'the cat sat on the mat' } });
    expect(strict.status).toBe('fail');
  });
  it('keyword recall finds phrases as whole words', async () => {
    const r = await run('keyword_recall', { keywords: 'turn left, main street' }, { output: 'Turn left on Main Street.' });
    expect(r.status).toBe('pass');
    const miss = await run('keyword_recall', { keywords: '{{keywords}}' }, { output: 'Go straight', row: { keywords: ['left'] } });
    expect(miss.details?.missing).toEqual(['left']);
  });
  it('text metrics against references with commas', async () => {
    const reference = 'Yes, the order shipped on Monday.';
    expect((await run('bleu', { min: 0.9 }, { output: reference, row: { expected: reference } })).status).toBe('pass');
    expect((await run('rouge_l', {}, { output: reference, row: { expected: reference } })).score).toBeCloseTo(1);
    const f1 = await run('token_f1', { min: 0.6 }, { output: 'shipped monday', row: { expected: reference } });
    expect(f1.status).toBe('fail');
    expect(f1.score).toBeCloseTo(4 / 7); // P = 1, R = 2/5
  });
});

describe('judgment checks', () => {
  it('script returns booleans, numbers or objects', async () => {
    expect((await run('script', { code: 'return output.includes("ok");' }, { output: 'ok' })).status).toBe('pass');
    expect((await run('script', { code: 'return 0.2;' }, { output: 'x' })).status).toBe('fail');
    const obj = await run('script', { code: 'return { pass: row.n > 1, reason: "n=" + row.n };' }, { output: '', row: { n: 2 } });
    expect(obj).toMatchObject({ status: 'pass', reason: 'n=2' });
    expect((await run('script', { code: 'throw new Error("boom")' }, { output: '' })).status).toBe('error');
  });
  it('expression', async () => {
    expect((await run('expression', { expression: 'outputs.items.length >= 2' }, { output: '', outputs: { items: [1, 2] } })).status).toBe('pass');
  });
  it('llm_judge takes the majority verdict', async () => {
    const verdicts = ['pass', 'fail', 'pass'];
    let i = 0;
    const llm: Partial<LlmClient> = {
      json: async () => ({ value: { reasoning: 'checked', verdict: verdicts[i++] }, latencyMs: 5, model: 'judge-1', inputTokens: 10, outputTokens: 3 }) as any,
    };
    const r = await run('llm_judge', { connectionId: 'con_1', repetitions: 3 }, { output: 'Paris', row: { question: 'Capital of France?' } }, llm);
    expect(r.status).toBe('pass');
    expect(r.score).toBeCloseTo(2 / 3);
    expect(r.details?.verdicts).toEqual(verdicts);
    expect(String(r.details?.prompt)).toContain('Capital of France?');
    expect((await run('llm_judge', {}, { output: 'x' }, llm)).status).toBe('error');
  });
});
