import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { Engine } from '../src/engine.js';
import { getCheckType } from '../src/checks/index.js';
import { azureCliToken, secretValue, strictSchema } from '../src/providers/index.js';
import { Embeddings, LOCAL_MODEL, type Embedder } from '../src/providers/embeddings.js';
import { agglomerate, pickEmbeddings } from '../src/insights/themes.js';
import { cosine } from '../src/providers/embeddings.js';
import { profileColumn } from '../src/quality/profile.js';
import { ColumnSpec } from '../src/specs.js';
import { exportBundle, importBundle, inspectBundle } from '../src/sharing/bundle.js';
import { exportToFolder, importFromFolder } from '../src/sharing/folder.js';
import { importExternal } from '../src/sharing/importers.js';

/* Regression tests for issues found in the code review of checks, providers, insights, quality and sharing. */

const actor = { kind: 'user' as const, id: 'local' };
const dirs: string[] = [];
const engines: Engine[] = [];
const fresh = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const engine = () => {
  const e = new Engine({ dir: fresh('kalibra-r3-') });
  engines.push(e);
  return e;
};
afterAll(() => {
  for (const e of engines) e.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ctx = (scope: Record<string, unknown>, llm: any = {}) => ({ scope, env: {}, llm, log: () => {}, workspaceDir: '.', signal: new AbortController().signal });

describe('checks', () => {
  it('json_schema compiles an edited schema that keeps its $id', async () => {
    const c = getCheckType('json_schema')!;
    expect((await c.run({ schema: '{"$id":"https://x.test/s","type":"object"}' }, ctx({ output: '{}' }))).status).toBe('pass');
    const edited = await c.run({ schema: '{"$id":"https://x.test/s","type":"object","required":["a"]}' }, ctx({ output: '{}' }));
    expect(edited.status).toBe('fail');
    expect(edited.reason).toMatch(/required/);
  });

  it('llm_judge copes with answers that ignore the schema', async () => {
    const judge = getCheckType('llm_judge')!;
    const llm = (value: unknown) => ({ json: async () => ({ value, latencyMs: 1, model: 'm' }) });
    const loose = await judge.run({ connectionId: 'c' }, ctx({ output: 'x' }, llm({ verdict: 'Pass', score: 8 })));
    expect(loose).toMatchObject({ status: 'pass', score: 1, reason: '' });
    const empty = await judge.run({ connectionId: 'c' }, ctx({ output: 'x' }, llm({})));
    expect(empty.status).toBe('fail');
  });

  it('pii_leak ignores toll-free business numbers unless asked, and matches allowed numbers however spaced', async () => {
    const pii = getCheckType('pii_leak')!;
    const out = { output: 'Call support on 1800-123-456 or 1-800-555-0100.' };
    expect((await pii.run({}, ctx(out))).status).toBe('pass');
    expect((await pii.run({ ignoreTollFree: false }, ctx(out))).status).toBe('fail');
    expect((await pii.run({ ignoreTollFree: false, allow: ['1800 123 456', '18005550100'] }, ctx(out))).status).toBe('pass');
    // Personal numbers are still found, and digit matching never allows an email.
    expect((await pii.run({}, ctx({ output: 'My mobile is +91 98765 43210' }))).status).toBe('fail');
    expect((await pii.run({ allow: ['1-23-456'] }, ctx({ output: 'mail priya123456@example.com' }))).status).toBe('fail');
  });
});

describe('providers', () => {
  it('strictSchema handles nullable object types', () => {
    const s = strictSchema({ type: ['object', 'null'], properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] });
    expect(s.required).toEqual(['a', 'b']);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.b.type).toEqual(['number', 'null']);
  });

  it('a named but missing secret is an error, and az scopes are validated before running anything', async () => {
    const secrets = { get: async (n: string) => (n === 'have' ? 'v' : undefined) } as any;
    expect(await secretValue(secrets, 'have')).toBe('v');
    expect(await secretValue(secrets, '')).toBeUndefined();
    await expect(secretValue(secrets, 'aws_key')).rejects.toThrow(/"aws_key" is not set/);
    await expect(azureCliToken('https://x/.default & calc.exe')).rejects.toThrow(/Invalid Azure token scope/);
  });

  it('a local model download cut short is not reported as ready', async () => {
    const dir = fresh('kalibra-models-');
    const pkg = join(dir, 'runtime', 'node_modules', '@huggingface', 'transformers');
    const onnx = join(dir, 'hub', ...LOCAL_MODEL.split('/'), 'onnx');
    mkdirSync(pkg, { recursive: true });
    mkdirSync(onnx, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    writeFileSync(join(onnx, 'model_quantized.onnx'), 'partial');
    const emb = new Embeddings(() => ({ getConnection: () => { throw new Error('none'); }, secrets: {} as any }), { dir });
    expect((await emb.status()).local).toBe('not_downloaded');
    await expect(emb.embed(['hi'])).rejects.toThrow(/not downloaded/);
  });
});

describe('failure themes', () => {
  // The straightforward version the optimized clustering must match exactly.
  function reference(vectors: number[][], threshold: number, maxClusters: number): number[][] {
    const clusters = vectors.map((v, i) => ({ members: [i], sum: [...v] }));
    while (clusters.length > 1) {
      let best = -Infinity;
      let bi = -1;
      let bj = -1;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const s = cosine(clusters[i].sum, clusters[j].sum);
          if (s > best) [best, bi, bj] = [s, i, j];
        }
      }
      if (best < threshold && clusters.length <= maxClusters) break;
      clusters[bi].members.push(...clusters[bj].members);
      clusters[bi].sum = clusters[bi].sum.map((x, k) => x + clusters[bj].sum[k]);
      clusters.splice(bj, 1);
    }
    return clusters.map((c) => c.members).sort((x, y) => y.length - x.length);
  }
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;

  it('clusters exactly like centroid linkage, fast enough for 1000 failures', () => {
    for (const n of [0, 1, 2, 7, 60, 150]) {
      const centers = Array.from({ length: 5 }, () => Array.from({ length: 24 }, rnd));
      const v = Array.from({ length: n }, (_, i) => centers[i % 5].map((x) => x + rnd() * 0.4));
      expect(agglomerate(v, 0.8, 4)).toEqual(reference(v, 0.8, 4));
    }
    const big = Array.from({ length: 1000 }, () => Array.from({ length: 384 }, rnd));
    const started = Date.now();
    expect(agglomerate(big, 0.75, 12)).toHaveLength(12);
    expect(Date.now() - started).toBeLessThan(10_000); // was about a minute, blocking the engine
  }, 30_000);

  it('picks the local model, else the connection’s embedding model, else none', async () => {
    const fake = (local: string): Embedder => ({ embed: async () => ({ vectors: [], model: '', source: 'local' }), status: async () => ({ local: local as any, model: '' }) });
    expect(await pickEmbeddings(fake('ready'), 'c1', { embeddingModel: 'text-embedding-3-small' })).toEqual({});
    expect(await pickEmbeddings(fake('not_downloaded'), 'c1', { embeddingModel: 'text-embedding-3-small' })).toEqual({ connectionId: 'c1' });
    expect(await pickEmbeddings(fake('not_downloaded'), 'c1', { embeddingModel: '' })).toBeUndefined();
  });
});

describe('dataset quality', () => {
  it('profiles very large datasets without overflowing the stack', () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ id: `r${i}`, data: { q: `question number ${i % 977}` }, tags: [], status: 'approved' }));
    const col = profileColumn(ColumnSpec.parse({ key: 'q', type: 'text' }), rows);
    expect(col.filled).toBe(200_000);
    expect(col.length?.histogram.length).toBeGreaterThan(0);
  });
});

describe('sharing', () => {
  const seedWithCode = async (e: Engine) => {
    await e.call('create_target', { name: 'Scripted', spec: { config: { kind: 'script', code: 'return { output: row.q };' } } });
    await e.call('create_target', { name: 'Hooked API', spec: { config: { kind: 'http', url: 'http://localhost:9/x', scripts: { beforeRequest: 'request.headers.x = 1; return request;', afterResponse: '' } } } });
    await e.call('create_target', { name: 'Plain API', spec: { config: { kind: 'http', url: 'http://localhost:9/x' } } });
    await e.call('create_suite', { name: 'Custom', spec: { checks: [{ id: 's', type: 'script', config: { code: 'return true;' } }] } });
  };

  it('bundles report the code they bring in, before and after import', async () => {
    const a = engine();
    await seedWithCode(a);
    const { bytes } = await exportBundle(a, { everything: true });
    const b = engine();
    const info = await inspectBundle(b, bytes);
    expect(info.code).toEqual([
      { kind: 'suite', name: 'Custom', places: ['code'] },
      { kind: 'target', name: 'Hooked API', places: ['beforeRequest'] },
      { kind: 'target', name: 'Scripted', places: ['code'] },
    ]);
    expect(info.warnings[0]).toMatch(/code that runs on your computer.*target "Scripted" \(code\)/);
    const report = await importBundle(b, bytes, 'rename', actor);
    expect(report.code.map((c) => c.name).sort()).toEqual(['Custom', 'Hooked API', 'Scripted']);
    expect(report.warnings[0]).toMatch(/Review it before running/);
    // Skipped definitions keep the local copy, so they are not reported.
    expect((await importBundle(b, bytes, 'skip', actor)).code).toEqual([]);
  });

  it('imports run results whose fields have unexpected types', async () => {
    const e = engine();
    const manifest = { format: 'kalibra-bundle', formatVersion: 1, name: 'x', secrets: [] };
    const results = [
      { row_id: 'r1', seq: 0, status: 'done', passed: true, score: 1, input: { q: 'hi' }, outputs: { output: 'yo' }, checks: [], attempts: 1 },
      { row_id: 'r2', seq: 1, status: 'done', passed: false, score: '0.2', input: 'not json' },
      null,
    ];
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'runs/run_1/run.json': strToU8(JSON.stringify({ name: 'Old run', status: 'completed', createdAt: 12345 })),
      'runs/run_1/results.jsonl': strToU8(results.map((r) => JSON.stringify(r)).join('\n')),
    });
    const report = await importBundle(e, zip, 'rename', actor);
    const run = report.created.find((c) => c.kind === 'run')!;
    const rows = e.db.all('SELECT passed, score, input FROM results WHERE run_id = ? ORDER BY seq', run.id);
    expect(rows).toEqual([
      { passed: 1, score: 1, input: '{"q":"hi"}' },
      { passed: 0, score: null, input: 'not json' },
    ]);
  });

  it('folder export never deletes files it did not write', async () => {
    const e = engine();
    await e.call('create_target', { name: 'API one', spec: { config: { kind: 'http', url: 'http://localhost:9/x' } } });
    const dir = fresh('kalibra-shared-');
    mkdirSync(join(dir, 'datasets'), { recursive: true });
    mkdirSync(join(dir, 'targets'), { recursive: true });
    writeFileSync(join(dir, 'datasets', 'train.jsonl'), '{"mine": true}\n');
    writeFileSync(join(dir, 'targets', 'notes.json'), '{"mine": true}');
    await exportToFolder(e, dir);
    expect(readFileSync(join(dir, 'datasets', 'train.jsonl'), 'utf8')).toContain('mine');
    expect(readFileSync(join(dir, 'targets', 'notes.json'), 'utf8')).toContain('mine');
    // A renamed item's old file, written by Kalibra, is still cleaned up.
    const t = e.repos.defs.get('target', 'API one');
    e.repos.defs.update('target', t.id, { name: 'API two' }, actor);
    const res = await exportToFolder(e, dir);
    expect(res.removed).toBe(1);
    expect(() => readFileSync(join(dir, 'targets', 'api-one.json'))).toThrow();
    expect(readFileSync(join(dir, 'targets', 'notes.json'), 'utf8')).toContain('mine');
  });

  it('folder sync never follows symbolic links out of the folder', async () => {
    const e = engine();
    await e.call('create_target', { name: 'API one', spec: { config: { kind: 'http', url: 'http://localhost:9/x' } } });
    const dir = fresh('kalibra-shared-');
    await exportToFolder(e, dir);
    const outside = fresh('kalibra-outside-');
    writeFileSync(join(outside, 'precious.txt'), 'keep me');
    rmSync(join(dir, 'targets', 'api-one.json'));
    symlinkSync(join(outside, 'precious.txt'), join(dir, 'targets', 'api-one.json'));
    await expect(exportToFolder(e, dir)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');

    // A linked folder is refused on import too (nothing outside is read).
    rmSync(join(dir, 'targets'), { recursive: true });
    mkdirSync(join(outside, 'targets'));
    writeFileSync(join(outside, 'targets', 'evil.json'), JSON.stringify({ name: 'Evil', spec: { config: { kind: 'http', url: 'http://x' } } }));
    symlinkSync(join(outside, 'targets'), join(dir, 'targets'));
    await expect(importFromFolder(engine(), dir, { dryRun: true }, actor)).rejects.toThrow(/symbolic link/);
  });

  it('folder import previews the code that added or changed definitions bring in', async () => {
    const a = engine();
    await seedWithCode(a);
    const dir = fresh('kalibra-shared-');
    await exportToFolder(a, dir);
    const b = engine();
    const dry = await importFromFolder(b, dir, { dryRun: true }, actor);
    expect(dry.code.map((c) => `${c.kind}:${c.name}`)).toEqual(['target:Hooked API', 'target:Scripted', 'suite:Custom']);
    expect(dry.warnings[0]).toMatch(/This folder has code that runs on your computer/);
    await importFromFolder(b, dir, {}, actor);
    expect((await importFromFolder(b, dir, { dryRun: true }, actor)).code).toEqual([]); // unchanged: nothing new to review
  });

  it('importers keep a "__proto__" column as data', () => {
    const e = engine();
    const jsonl = '{"inputs":{"__proto__":{"polluted":true},"question":"q"},"outputs":{"answer":"a"}}';
    const report = importExternal(e, strToU8(jsonl), { format: 'langsmith' }, actor);
    expect(report.dataset!.columns).toEqual(expect.arrayContaining(['proto', 'question']));
  });
});
