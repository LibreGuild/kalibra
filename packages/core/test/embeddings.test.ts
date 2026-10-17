import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { embedMany } from 'ai';
import { cosine, Embeddings, LruCache, modelsDir, resolveEmbeddingModel, LOCAL_MODEL } from '../src/providers/embeddings.js';
import { getCheckType } from '../src/checks/index.js';
import { ConnectionSpec } from '../src/specs.js';

const secrets = { get: async (n: string) => (n === 'key' ? 'sk-test' : undefined), set: async () => {}, delete: async () => {}, list: async () => [] };
const openai = ConnectionSpec.parse({ provider: 'openai', apiKeySecret: 'key', embeddingModel: 'text-embedding-3-small' });

/** Deterministic fake vectors: bag of letters, so similar strings get similar vectors. */
const fakeVec = (t: string) => {
  const v = new Array(26).fill(0);
  for (const c of t.toLowerCase()) if (c >= 'a' && c <= 'z') v[c.charCodeAt(0) - 97]++;
  return v;
};

describe('cosine and cache', () => {
  it('cosine handles identical, orthogonal and zero vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('LRU evicts the least recently used entry', () => {
    const c = new LruCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a is now most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
  });
});

describe('Embeddings with a connection', () => {
  it('batches at 64, caches repeats and uses the connection embedding model', async () => {
    const calls: number[] = [];
    const emb = new Embeddings(() => ({ getConnection: async () => openai, secrets }), {
      connection: async (_s, model, texts) => {
        expect(model).toBe('text-embedding-3-small');
        calls.push(texts.length);
        return texts.map(fakeVec);
      },
    });
    const texts = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const r = await emb.embed(texts, { connectionId: 'c' });
    expect(r.vectors).toHaveLength(100);
    expect(r.source).toBe('connection');
    expect(calls).toEqual([64, 36]);
    await emb.embed([...texts.slice(0, 10), 'brand new'], { connectionId: 'c' });
    expect(calls).toEqual([64, 36, 1]);
  });

  it('dedupes identical texts within one call and keeps order', async () => {
    let seen = 0;
    const emb = new Embeddings(() => ({ getConnection: async () => openai, secrets }), { connection: async (_s, _m, t) => ((seen += t.length), t.map(fakeVec)) });
    const r = await emb.embed(['abc', 'xyz', 'abc'], { connectionId: 'c' });
    expect(seen).toBe(2);
    expect(r.vectors[0]).toEqual(r.vectors[2]);
  });

  it('talks to the OpenAI embeddings API through the AI SDK (fake fetch, no network)', async () => {
    let body: any;
    const fakeFetch = (async (_url: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ object: 'embedding', index: i, embedding: [i, 1, 0] })), model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const model = await resolveEmbeddingModel(openai, 'text-embedding-3-small', secrets, fakeFetch);
    const res = await embedMany({ model, values: ['a', 'b'] });
    expect(body.model).toBe('text-embedding-3-small');
    expect(res.embeddings).toEqual([[0, 1, 0], [1, 1, 0]]);
  });

  it('explains providers without embedding models and missing secrets', async () => {
    await expect(resolveEmbeddingModel(ConnectionSpec.parse({ provider: 'anthropic' }), 'x', secrets)).rejects.toThrow(/no embedding models/);
    await expect(resolveEmbeddingModel(ConnectionSpec.parse({ provider: 'openai', apiKeySecret: 'missing' }), 'x', secrets)).rejects.toThrow(/not set/);
  });
});

describe('local model', () => {
  it('reports not downloaded and refuses to embed until it is', async () => {
    const emb = new Embeddings(() => ({ getConnection: async () => openai, secrets }), { dir: '/nonexistent/kalibra-models' });
    expect((await emb.status()).local).toBe('not_downloaded');
    await expect(emb.embed(['hi'])).rejects.toThrow(/not downloaded/);
  });

  const ready = existsSync(join(modelsDir(), 'runtime', 'node_modules', '@huggingface', 'transformers')) && existsSync(join(modelsDir(), 'hub', ...LOCAL_MODEL.split('/'), 'onnx', 'model_quantized.onnx'));
  it.skipIf(!ready)('embeds offline with the downloaded local model', async () => {
    const emb = new Embeddings(() => ({ getConnection: async () => openai, secrets }));
    expect((await emb.status()).local).toBe('ready');
    const r = await emb.embed(['The cat sat on the mat', 'A cat was sitting on the rug', 'Stock markets fell sharply today']);
    expect(r.vectors[0]).toHaveLength(384);
    const close = cosine(r.vectors[0], r.vectors[1]);
    const far = cosine(r.vectors[0], r.vectors[2]);
    expect(close).toBeGreaterThan(far + 0.2);
  }, 60_000);
});

describe('semantic checks', () => {
  const embed = new Embeddings(() => ({ getConnection: async () => openai, secrets }), { local: async (t) => t.map(fakeVec) });
  const ctx = (scope: Record<string, unknown>, llm: any = {}) => ({ scope, env: {}, llm, embed, log: () => {}, workspaceDir: '.', signal: new AbortController().signal });
  const sim = getCheckType('semantic_similarity')!;

  it('identical text scores 1 and passes', async () => {
    const r = await sim.run({}, ctx({ output: 'block my card', expected: 'block my card' }));
    expect(r.status).toBe('pass');
    expect(r.value).toBeCloseTo(1);
  });

  it('unrelated text scores low and fails', async () => {
    const r = await sim.run({ threshold: 0.9 }, ctx({ output: 'zzz qqq', expected: 'block my card' }));
    expect(r.status).toBe('fail');
    expect(r.value!).toBeLessThan(0.5);
  });

  it('skips without a reference, fails an empty output, errors without embeddings', async () => {
    expect((await sim.run({}, ctx({ output: 'x', expected: '' }))).status).toBe('skip');
    expect((await sim.run({}, ctx({ output: '', expected: 'x' }))).status).toBe('fail');
    const noEmbed = { scope: { output: 'a', expected: 'b' }, env: {}, llm: {} as any, log: () => {}, workspaceDir: '.', signal: new AbortController().signal };
    expect((await sim.run({}, noEmbed)).status).toBe('error');
    expect((await sim.run({ source: 'connection' }, ctx({ output: 'a', expected: 'b' }))).status).toBe('error');
  });

  it('semantic_wer counts only meaning errors from the LLM and reports corpus fields', async () => {
    const wer = getCheckType('semantic_wer')!;
    const llm = {
      json: async () => ({ value: { errors: [{ kind: 'name', reference: 'Priya', hypothesis: 'Maria', why: 'wrong person' }] }, model: 'stub', latencyMs: 1 }),
    };
    const r = await wer.run({ connectionId: 'c', max: 0.2 }, ctx({ output: 'transfer 1500 rupees to Maria', reference: 'Transfer fifteen hundred rupees to Priya' }, llm));
    expect(r.status).toBe('pass'); // 1 error / 6 words ≈ 0.17
    expect((r.details as any).errors).toBe(1);
    expect((r.details as any).refUnits).toBe(6);
    const clean = await wer.run({ connectionId: 'c' }, ctx({ output: 'x', reference: 'x y' }, { json: async () => ({ value: { errors: [] }, model: 'stub', latencyMs: 1 }) }));
    expect(clean.status).toBe('pass');
    expect((await wer.run({}, ctx({ output: 'x', reference: 'y' }))).status).toBe('error');
    expect((await wer.run({ connectionId: 'c' }, ctx({ output: 'x', reference: '' }))).status).toBe('skip');
  });
});
