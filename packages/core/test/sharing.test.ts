import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { Engine } from '../src/engine.js';
import { encodeWav } from '../src/audio/wav.js';
import { readZip } from '../src/sharing/common.js';

/*
 * Team sharing: bundles round-trip a workspace (datasets with media, definitions, runs) into a fresh
 * workspace; folder sync is byte-stable and applies exactly the changes made to files.
 */

const tmp: string[] = [];
const freshDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(d);
  return d;
};
const freshEngine = () => new Engine({ dir: freshDir('kalibra-share-') });
const engines: Engine[] = [];
const track = (e: Engine) => (engines.push(e), e);

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

async function seed(engine: Engine) {
  const wav = encodeWav([new Float32Array(1600).map((_, i) => Math.sin(i / 5) * 0.3)], 16000);
  const audio = await engine.blobs.put(wav, { mime: 'audio/wav', name: 'hello.wav' });
  const image = await engine.blobs.put(PNG, { mime: 'image/png', name: 'dot.png' });
  await engine.secrets.set('openai_key', 'sk-SUPER-SECRET-VALUE-123');
  const ds = await engine.call<any>('create_dataset', {
    name: 'Voice & images',
    description: 'Mixed media',
    columns: [
      { key: 'reference', type: 'text', required: true },
      { key: 'audio', type: 'audio' },
      { key: 'image', type: 'image' },
      { key: 'keywords', type: 'list' },
    ],
  });
  await engine.call('add_dataset_rows', {
    dataset: ds.id,
    rows: [
      { data: { reference: 'turn left at the light', audio: { blob: audio.hash, name: 'hello.wav', mime: 'audio/wav' }, keywords: ['left'] }, tags: ['en'] },
      { data: { reference: 'ünïcödé — 日本語 ✓', image: { blob: image.hash, name: 'dot.png', mime: 'image/png' } }, tags: ['uni'] },
      { data: { reference: 'third row' }, status: 'needs_review' },
    ],
  });
  const target = await engine.call<any>('create_target', {
    name: 'STT API',
    spec: { variables: [{ key: 'base_url', value: 'http://localhost:9' }], config: { kind: 'http', url: '{{vars.base_url}}/stt', headers: [{ key: 'Authorization', value: 'Bearer {{secret.api_token}}' }] } },
  });
  const suite = await engine.call<any>('create_suite', { name: 'STT checks', spec: { checks: [{ id: 'wer', type: 'wer', config: { reference: '{{reference}}' } }] } });
  await engine.call('create_connection', { name: 'OpenAI', spec: { provider: 'openai', apiKeySecret: 'openai_key', defaultModel: 'gpt-x' } });

  // A finished run with results, inserted directly (no network).
  const rows = (await engine.call<any>('list_rows', { dataset: ds.id })).rows;
  const version = engine.repos.datasets.createVersion(ds.id, 'v', { kind: 'user', id: 'local' });
  const run = engine.repos.runs.create(
    { name: 'Baseline', kind: 'live', datasetId: ds.id, datasetVersionId: version.id, targetId: target.id, targetVersion: 1, suiteId: suite.id, suiteVersion: 1, settings: { concurrency: 1, retries: 0, repetitions: 1, includeStatuses: ['approved'], delayMs: 0 } as any },
    { kind: 'user', id: 'local' },
  );
  engine.repos.runs.addPending(run.id, rows.map((r: any) => ({ rowId: r.id, rowRev: 1, rep: 0, input: r.data })));
  for (const p of engine.repos.runs.pending(run.id)) {
    engine.repos.runs.saveResult(run.id, p.id, { status: 'done', passed: true, score: 1, outputs: { output: 'ok' }, checks: [{ id: 'wer', status: 'pass' }], metrics: { latency_ms: 12 }, attempts: 1 });
  }
  engine.repos.runs.setStatus(run.id, 'completed', { summary: { passRate: 1 } });
  return { ds, target, suite, run, audio, image };
}

const snapshot = async (engine: Engine) => {
  const datasets = await Promise.all(
    engine.repos.datasets.list().map(async (d) => ({
      name: d.name,
      description: d.description,
      schema: d.schema,
      rows: engine.repos.datasets.listRows(d.id, { limit: 1000 }).rows.map((r) => ({ data: r.data, tags: r.tags, status: r.status })),
    })),
  );
  const defs = (['target', 'suite', 'connection'] as const).flatMap((k) => engine.repos.defs.list(k).map((d) => ({ k, name: d.name, spec: d.spec })));
  return { datasets: datasets.sort((a, b) => a.name.localeCompare(b.name)), defs: defs.sort((a, b) => (a.k + a.name).localeCompare(b.k + b.name)) };
};

afterAll(() => {
  for (const e of engines) e.close();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe('bundles', () => {
  let a: Engine;
  let seeded: Awaited<ReturnType<typeof seed>>;
  let bundleHash: string;

  beforeAll(async () => {
    a = track(freshEngine());
    seeded = await seed(a);
    const res = await a.call<any>('export_bundle', { everything: true, includeRuns: true });
    bundleHash = res.hash;
  });

  const bytesFrom = async (src: Engine, hash: string) => new Uint8Array(await src.blobs.get(hash));
  const upload = async (dst: Engine, bytes: Uint8Array) => (await dst.blobs.put(bytes, { mime: 'application/zip', name: 'b.kalibra' })).hash;

  it('never contains secret values, only the names to set', async () => {
    const bytes = await bytesFrom(a, bundleHash);
    const files = readZip(bytes);
    const all = [...files.values()].map((b) => Buffer.from(b).toString('latin1')).join('\n');
    expect(all).not.toContain('sk-SUPER-SECRET-VALUE-123');
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString());
    expect(manifest.secrets).toEqual(['api_token', 'openai_key']);
    expect(manifest.counts).toMatchObject({ datasets: 1, rows: 3, targets: 1, suites: 1, connections: 1, runs: 1, results: 3 });
    expect(manifest.media.files).toBe(2);
  });

  it('round-trips everything into a fresh workspace', async () => {
    const b = track(freshEngine());
    const hash = await upload(b, await bytesFrom(a, bundleHash));
    const inspect = await b.call<any>('inspect_bundle', { blob: hash });
    expect(inspect.conflicts).toBe(0);
    expect(inspect.secretsMissing).toEqual(['api_token', 'openai_key']);

    const report = await b.call<any>('import_bundle', { blob: hash });
    expect(report.secretsToSet).toEqual(['api_token', 'openai_key']);
    expect(await snapshot(b)).toEqual(await snapshot(a));
    // Media came across byte-for-byte.
    expect(Buffer.compare(await b.blobs.get(seeded.audio.hash), await a.blobs.get(seeded.audio.hash))).toBe(0);
    expect(b.blobs.info(seeded.image.hash)?.mime).toBe('image/png');
    // Run results point at the imported rows and keep their outputs.
    const run = (await b.call<any>('list_runs', {})).runs[0];
    expect(run.name).toBe('Baseline');
    expect(run.status).toBe('completed');
    const results = (await b.call<any>('query_results', { runId: run.id })).results;
    const rowIds = new Set(b.repos.datasets.listRows(run.datasetId, { limit: 100 }).rows.map((r) => r.id));
    expect(results).toHaveLength(3);
    expect(results.every((r: any) => rowIds.has(r.rowId) && r.outputs.output === 'ok')).toBe(true);
    expect(run.suiteId).toBe(b.repos.defs.get('suite', 'STT checks').id);
  });

  it('handles conflicts: rename, skip and new_version', async () => {
    const b = track(freshEngine());
    const bytes = await bytesFrom(a, bundleHash);
    await b.call('import_bundle', { blob: await upload(b, bytes) });

    const renamed = await b.call<any>('import_bundle', { blob: await upload(b, bytes), onConflict: 'rename' });
    expect(renamed.renamed.map((r: any) => r.to)).toEqual(expect.arrayContaining(['Voice & images (imported)', 'STT API (imported)']));
    expect(b.repos.datasets.list()).toHaveLength(2);

    const skipped = await b.call<any>('import_bundle', { blob: await upload(b, bytes), onConflict: 'skip' });
    expect(skipped.skipped.length).toBeGreaterThanOrEqual(4);
    expect(b.repos.datasets.list()).toHaveLength(2);

    // Change the target and add a row in the source, then import as new versions.
    await a.call('update_target', { id: 'STT API', spec: { ...a.repos.defs.get('target', 'STT API').spec, variables: [{ key: 'base_url', value: 'http://staging:9', enabled: true }] } });
    await a.call('add_dataset_rows', { dataset: 'Voice & images', rows: [{ data: { reference: 'a brand new row' } }] });
    const next = await a.call<any>('export_bundle', { datasets: ['Voice & images'], targets: ['STT API'] });
    const updated = await b.call<any>('import_bundle', { blob: await upload(b, await bytesFrom(a, next.hash)), onConflict: 'new_version' });
    expect(updated.updated.find((u: any) => u.kind === 'target')).toBeTruthy();
    expect(b.repos.defs.get('target', 'STT API').version).toBe(2);
    expect(b.repos.defs.get('target', 'STT API').spec.variables[0].value).toBe('http://staging:9');
    // Only the new row was added; existing rows (same ids) were not duplicated.
    expect(updated.updated.find((u: any) => u.kind === 'dataset').rows).toBe(1);
    expect(b.repos.datasets.listRows(b.repos.datasets.get('Voice & images').id).total).toBe(4);
  });

  it('rejects corrupt, incomplete, future and malicious bundles', async () => {
    const b = track(freshEngine());
    const imp = async (bytes: Uint8Array) => b.call('import_bundle', { blob: await upload(b, bytes) });
    await expect(imp(strToU8('definitely not a zip'))).rejects.toThrow(/not a readable zip/);
    await expect(imp(zipSync({ 'readme.txt': strToU8('hi') }))).rejects.toThrow(/missing manifest\.json/);
    const future = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'kalibra-bundle', formatVersion: 99 })) });
    await expect(imp(future)).rejects.toThrow(/newer Kalibra/);
    const other = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'something-else', formatVersion: 1 })) });
    await expect(imp(other)).rejects.toThrow(/not a Kalibra bundle/);
    const slip = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'kalibra-bundle', formatVersion: 1 })), '../escape.json': strToU8('{}') });
    await expect(imp(slip)).rejects.toThrow(/Unsafe path/);
    const abs = zipSync({ '/etc/passwd': strToU8('x') });
    await expect(imp(abs)).rejects.toThrow(/Unsafe path/);
    const bad = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'kalibra-bundle', formatVersion: 1 })), 'definitions/targets/x.json': strToU8(JSON.stringify({ name: 'X', spec: { config: { kind: 'nope' } } })) });
    await expect(imp(bad)).rejects.toThrow(/invalid target/);
    // Nothing was half-imported by the failures above.
    expect(b.repos.defs.list('target')).toHaveLength(0);
  });

  it('enforces size limits and verifies media content', async () => {
    const big = zipSync({ 'big.bin': new Uint8Array(5000) });
    expect(() => readZip(big, { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 10_000 })).toThrow(/too large/);
    expect(() => readZip(zipSync({ a: new Uint8Array(600), b: new Uint8Array(600) }), { maxEntries: 10, maxEntryBytes: 1000, maxTotalBytes: 1000 })).toThrow(/too large to import/);
    expect(() => readZip(zipSync({ a: strToU8('1'), b: strToU8('2'), c: strToU8('3') }), { maxEntries: 2, maxEntryBytes: 10, maxTotalBytes: 100 })).toThrow(/too many files/);

    const b = track(freshEngine());
    const fake = 'a'.repeat(64);
    const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'kalibra-bundle', formatVersion: 1, secrets: [] })), [`media/${fake}`]: strToU8('tampered') });
    const res = await b.call<any>('import_bundle', { blob: (await b.blobs.put(zip, {})).hash });
    expect(res.warnings.join(' ')).toMatch(/does not match its name/);
    expect(b.blobs.has(fake)).toBe(false);
  });

  it('exports only what was asked, plus what runs depend on', async () => {
    await expect(a.call('export_bundle', {})).rejects.toThrow(/Pick something/);
    const r = await a.call<any>('export_bundle', { runs: [seeded.run.id], includeMedia: false });
    expect(r.manifest.counts).toMatchObject({ runs: 1, datasets: 1, targets: 1, suites: 1, connections: 0 });
    expect(r.manifest.autoIncluded.length).toBe(3);
    expect(r.manifest.media.files).toBe(0);
    const b = track(freshEngine());
    const rep = await b.call<any>('import_bundle', { blob: (await b.blobs.put(await a.blobs.get(r.hash), {})).hash });
    expect(rep.warnings.join(' ')).toMatch(/files were not included/);
  });
});

describe('folder sync', () => {
  let a: Engine;
  let dir: string;
  beforeAll(async () => {
    a = track(freshEngine());
    await seed(a);
    dir = freshDir('kalibra-folder-');
  });

  const readTree = (root: string) => {
    const out: Record<string, string> = {};
    const walk = (d: string, p = '') => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) walk(full, `${p}${e}/`);
        else out[`${p}${e}`] = readFileSync(full, 'utf8');
      }
    };
    walk(root);
    return out;
  };

  it('exports stable files without secrets and re-exports byte-identically', async () => {
    const first = await a.call<any>('export_to_folder', { dir });
    expect(first.written).toBeGreaterThan(5);
    const tree = readTree(dir);
    expect(Object.keys(tree)).toEqual(expect.arrayContaining(['kalibra.json', 'targets/stt-api.json', 'suites/stt-checks.json', 'connections/openai.json', 'datasets/voice-images/schema.json', 'datasets/voice-images/rows.jsonl']));
    expect(Object.values(tree).join('\n')).not.toContain('sk-SUPER-SECRET');
    const again = await a.call<any>('export_to_folder', { dir });
    expect(again.written).toBe(0);
    expect(readTree(dir)).toEqual(tree);
    expect((await a.call<any>('get_sharing_settings', {})).folder).toBe(dir);
  });

  it('imports into another workspace with identical content and ids', async () => {
    const b = track(freshEngine());
    const preview = await b.call<any>('import_from_folder', { dir, dryRun: true });
    expect(preview.summary.added).toBe(4);
    expect(b.repos.datasets.list()).toHaveLength(0); // dry run wrote nothing
    await b.call('import_from_folder', { dir });
    expect(await snapshot(b)).toEqual(await snapshot(a));
    // Exporting from the importing workspace gives the same files (no id churn).
    const dir2 = freshDir('kalibra-folder2-');
    await b.call('export_to_folder', { dir: dir2 });
    expect(readTree(dir2)).toEqual(readTree(dir));
    const repeat = await b.call<any>('import_from_folder', { dir });
    expect(repeat.summary).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });

  it('applies exactly the edited files, and prunes only when asked', async () => {
    const b = track(freshEngine());
    await b.call('import_from_folder', { dir });
    const rowsPath = join(dir, 'datasets/voice-images/rows.jsonl');
    const lines = readFileSync(rowsPath, 'utf8').trim().split('\n');
    const row0 = JSON.parse(lines[0]);
    row0.data.reference = 'edited in git';
    const suitePath = join(dir, 'suites/stt-checks.json');
    const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
    suite.spec.passThreshold = 0.5;
    suite.spec.passRule = 'weighted';
    writeFileSync(rowsPath, [JSON.stringify(row0), ...lines.slice(1, -1)].join('\n') + '\n'); // edit one row, drop the last
    writeFileSync(suitePath, JSON.stringify(suite, null, 2));

    const preview = await b.call<any>('import_from_folder', { dir, dryRun: true });
    const dsChange = preview.datasets.find((d: any) => d.name === 'Voice & images');
    expect(dsChange.rows).toMatchObject({ changed: 1, added: 0, removed: 0 });
    expect(preview.definitions.filter((d: any) => d.change === 'changed').map((d: any) => d.name)).toEqual(['STT checks']);
    expect(b.repos.datasets.getRow(row0.id).data.reference).not.toBe('edited in git');

    await b.call('import_from_folder', { dir });
    expect(b.repos.datasets.getRow(row0.id).data.reference).toBe('edited in git');
    expect(b.repos.defs.get('suite', 'STT checks').version).toBe(2);
    expect(b.repos.datasets.listRows(b.repos.datasets.get('Voice & images').id).total).toBe(3); // no prune: dropped line kept

    const pruned = await b.call<any>('import_from_folder', { dir, prune: true });
    expect(pruned.datasets.find((d: any) => d.name === 'Voice & images').rows.removed).toBe(1);
    expect(b.repos.datasets.listRows(b.repos.datasets.get('Voice & images').id).total).toBe(2);
  });

  it('refuses unsafe folders and non-Kalibra folders', async () => {
    await expect(a.call('export_to_folder', { dir: 'relative/path' })).rejects.toThrow(/absolute/);
    await expect(a.call('export_to_folder', { dir: '/' })).rejects.toThrow(/root/);
    await expect(a.call('export_to_folder', { dir: '/etc/kalibra' })).rejects.toThrow(/system folder/);
    await expect(a.call('export_to_folder', { dir: a.dir })).rejects.toThrow(/outside the Kalibra workspace/);
    await expect(a.call('import_from_folder', { dir: freshDir('kalibra-empty-') })).rejects.toThrow(/no kalibra\.json/);
    const broken = freshDir('kalibra-broken-');
    writeFileSync(join(broken, 'kalibra.json'), JSON.stringify({ format: 'kalibra-folder', formatVersion: 7 }));
    await expect(a.call('import_from_folder', { dir: broken })).rejects.toThrow(/newer Kalibra/);
  });
});
