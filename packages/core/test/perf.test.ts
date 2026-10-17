import { getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine.js';
import { Hub } from '../src/hub/hub.js';
import { summarize } from '../src/runner/summary.js';
import { RunSettings } from '../src/specs.js';
import { insertRows } from '../src/sharing/common.js';
import { sleep } from '../src/util.js';

/* Guards for things that used to grow quadratically, leak, or hold whole files in memory. */

const user = { kind: 'user' as const, id: 'local' };
const dirs: string[] = [];
const closers: (() => void)[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kalibra-perf-'));
  dirs.push(d);
  return d;
};
const engineWith = async (rows: number) => {
  const engine = new Engine({ dir: tmp() });
  closers.push(() => engine.close());
  await engine.call('create_dataset', { name: 'D', columns: [{ key: 'q' }] });
  const ds = engine.repos.datasets.get('D');
  if (rows) engine.repos.datasets.addRows(ds.id, Array.from({ length: rows }, (_, i) => ({ data: { q: `question ${i}` } })), user);
  return { engine, ds };
};
afterEach(() => {
  closers.splice(0).forEach((c) => c());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

async function runWith(rows: number) {
  const { engine, ds } = await engineWith(rows);
  const v = engine.repos.datasets.createVersion(ds.id, '', user);
  const run = engine.repos.runs.create({ kind: 'imported', datasetId: ds.id, datasetVersionId: v.id, suiteId: 'ste_x', suiteVersion: 1, settings: RunSettings.parse({}) }, user);
  engine.repos.runs.addPending(run.id, engine.repos.datasets.versionRows(v.id).map((r) => ({ rowId: r.id, rowRev: r.rev, rep: 0, input: r.data })));
  return { engine, run, pending: engine.repos.runs.pending(run.id) };
}

const save = (engine: Engine, runId: string, id: string, status: 'done' | 'error' = 'done') =>
  engine.repos.runs.saveResult(runId, id, {
    status,
    passed: status === 'done',
    score: 1,
    outputs: { output: 'x' },
    checks: [{ id: 'c', name: 'c', type: 'contains', layer: 3, status: status === 'done' ? 'pass' : 'error', score: 1, details: { errors: 1, refUnits: 4, metric: 'wer' } }],
    metrics: { latency_ms: 100 },
    error: status === 'error' ? 'boom' : null,
    attempts: 1,
  });

describe('saving results', () => {
  it('costs the same per row at the end of a big run as at the start', async () => {
    const { engine, run, pending } = await runWith(20_000);
    const chunk = 1000;
    const times: number[] = [];
    for (let c = 0; c < pending.length / chunk; c++) {
      const start = performance.now();
      for (const p of pending.slice(c * chunk, (c + 1) * chunk)) save(engine, run.id, p.id);
      times.push(performance.now() - start);
    }
    // Recounting finished results on every save made the last chunks ~3× slower than the first at 20k rows.
    // Fastest of the first five against fastest of the last five, so a GC pause or a busy CI machine
    // during one chunk doesn't decide the result.
    const best = (xs: number[]) => Math.min(...xs);
    expect(best(times.slice(-5)) / best(times.slice(0, 5))).toBeLessThan(1.8);
    expect(engine.repos.runs.get(run.id).done).toBe(20_000);
  }, 60_000);

  it('keeps the finished count right when results are saved again, fail, or are retried', async () => {
    const { engine, run, pending } = await runWith(3);
    const [a, b, c] = pending;
    save(engine, run.id, a.id);
    save(engine, run.id, a.id); // saved twice: still one finished row
    save(engine, run.id, b.id, 'error');
    expect(engine.repos.runs.get(run.id).done).toBe(2);
    engine.repos.runs.markRunning(c.id);
    engine.repos.runs.resetRunning(run.id);
    expect(engine.repos.runs.get(run.id).done).toBe(2);
    save(engine, run.id, c.id);
    expect(engine.repos.runs.get(run.id).done).toBe(3);
  });
});

describe('run summaries', () => {
  it('read only what the summary needs and give the same answer', async () => {
    const { engine, run, pending } = await runWith(50);
    pending.forEach((p, i) => save(engine, run.id, p.id, i % 5 ? 'done' : 'error'));
    const fromLite = summarize(engine.repos.runs.allLite(run.id), 50);
    expect(summarize(engine.repos.runs.summaryRows(run.id), 50)).toEqual(fromLite);
    expect(fromLite.checks[0].corpus).toMatchObject({ errors: 50, refUnits: 200 });
  });
});

describe('adding rows to a big dataset', () => {
  it('finds duplicates with an index instead of reading every row', async () => {
    const { engine, ds } = await engineWith(5);
    const plan = engine.db.all("EXPLAIN QUERY PLAN SELECT id FROM rows WHERE dataset_id = ? AND fp = ? AND deleted_at IS NULL LIMIT 1", ds.id, 'x').map((r: any) => r.detail).join(' ');
    expect(plan).toMatch(/USING INDEX rows_fp/);
  });

  it('still rejects copies of stored rows, of rows in the same batch, and of rows from before fingerprints', async () => {
    const { engine, ds } = await engineWith(3);
    // Rows written by an older version have no fingerprint yet.
    engine.db.run('UPDATE rows SET fp = NULL WHERE dataset_id = ?', ds.id);
    const res = engine.repos.datasets.addRows(ds.id, [{ data: { q: 'question 1' } }, { data: { q: 'brand new' } }, { data: { q: 'brand new' } }], user);
    expect(res.added).toHaveLength(1);
    expect(res.rejected.map((r) => r.index)).toEqual([0, 2]);
    expect(engine.db.get('SELECT COUNT(*) AS n FROM rows WHERE dataset_id = ? AND fp IS NULL', ds.id).n).toBe(0);
    // With dedupe off, stored copies are allowed but copies inside the batch still are not.
    const loose = engine.repos.datasets.addRows(ds.id, [{ data: { q: 'question 1' } }, { data: { q: 'twin' } }, { data: { q: 'twin' } }], user, { dedupe: false });
    expect(loose.added).toHaveLength(2);
  });

  it('follows edits, deletes and imported rows', async () => {
    const { engine, ds } = await engineWith(2);
    const [r0, r1] = engine.repos.datasets.listRows(ds.id).rows;
    engine.repos.datasets.updateRow(r0.id, { data: { q: 'edited' } }, user);
    expect(engine.repos.datasets.addRows(ds.id, [{ data: { q: 'edited' } }], user).rejected).toHaveLength(1);
    expect(engine.repos.datasets.addRows(ds.id, [{ data: { q: 'question 0' } }], user).added).toHaveLength(1);
    engine.repos.datasets.deleteRows(ds.id, [r1.id]);
    expect(engine.repos.datasets.addRows(ds.id, [{ data: { q: 'question 1' } }], user).added).toHaveLength(1);
    insertRows(engine, ds.id, ds.schema.columns, [{ data: { q: 'from a bundle' } }], user);
    expect(engine.repos.datasets.addRows(ds.id, [{ data: { q: 'from a bundle' } }], user).rejected).toHaveLength(1);
  });
});

describe('waiting', () => {
  it('leaves no abort listeners behind on a shared signal', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 50; i++) await sleep(0, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
    const pending = sleep(10_000, ac.signal);
    ac.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });
});

describe('streamed file storage', () => {
  async function* chunks(n: number, size: number) {
    for (let i = 0; i < n; i++) yield Buffer.alloc(size, i % 256);
  }

  it('stores a stream under the same address as put(), without a temp file left over', async () => {
    const { engine } = await engineWith(0);
    const whole = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.alloc(64 * 1024, i % 256)));
    const info = await engine.blobs.putStream!(chunks(64, 64 * 1024), { name: 'clip.wav' }, 10 * 1024 * 1024);
    expect(info.hash).toBe(createHash('sha256').update(whole).digest('hex'));
    expect(info.size).toBe(whole.length);
    expect((await engine.blobs.get(info.hash)).equals(whole)).toBe(true);
    expect((await engine.blobs.put(whole, {})).hash).toBe(info.hash);
    // Storing the same content again is fine.
    expect((await engine.blobs.putStream!(chunks(64, 64 * 1024), {}, 10 * 1024 * 1024)).hash).toBe(info.hash);
    expect(readdirSync(join(engine.dir, 'blobs')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('stops at the size limit and cleans up', async () => {
    const { engine } = await engineWith(0);
    await expect(engine.blobs.putStream!(chunks(10, 1024), {}, 5000)).rejects.toThrow(/too large/);
    expect(readdirSync(join(engine.dir, 'blobs')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('sniffs the type from the first bytes even when they arrive in pieces', async () => {
    const { engine } = await engineWith(0);
    async function* wav() {
      yield Buffer.from('RIF');
      yield Buffer.from('F\0\0\0\0WAVEfmt ');
      yield Buffer.alloc(100);
    }
    expect((await engine.blobs.putStream!(wav(), {}, 1e6)).mime).toBe('audio/wav');
  });
});

describe('open projects', () => {
  it('closes idle projects beyond the limit, keeps busy ones, and reopens on use', async () => {
    const dir = tmp();
    const hub = new Hub({ dir, mode: 'local', maxOpenProjects: 2 });
    closers.push(() => hub.close());
    const me = hub.localPrincipal();
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) ids.push((await hub.call<any>(me, 'create_project', { name })).id);
    await hub.callProject(me, ids[0], 'create_dataset', { name: 'Kept', columns: [{ key: 'q' }] });
    // A open with a live listener (an open browser tab), B idle.
    const unsubscribe = hub.engine(ids[0]).events.subscribe(() => {});
    hub.engine(ids[1]);
    // Recently used projects stay open even over the limit.
    expect(hub.openEngineCount()).toBeGreaterThan(2);
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    hub.engine(ids[2]);
    // B (idle, unused for 11 minutes) was closed; A has a listener and C is in use.
    expect(hub.openEngineCount()).toBe(2);
    // The busy project is still open; its data is there whatever happened to the others.
    expect(await hub.callProject<any[]>(me, ids[0], 'list_datasets', {})).toHaveLength(1);
    unsubscribe();
    expect(await hub.callProject<any[]>(me, ids[1], 'list_datasets', {})).toEqual([]);
  });

  it('opens every project once at start but keeps only the limit open', async () => {
    const dir = tmp();
    const hub = new Hub({ dir, mode: 'local', maxOpenProjects: 3 });
    closers.push(() => hub.close());
    for (let i = 0; i < 6; i++) await hub.call(hub.localPrincipal(), 'create_project', { name: `P${i}` });
    hub.close();
    closers.pop();
    const again = new Hub({ dir, mode: 'local', maxOpenProjects: 3 });
    closers.push(() => again.close());
    again.openAll();
    expect(again.openEngineCount()).toBeLessThanOrEqual(3);
    expect((await again.call<any[]>(again.localPrincipal(), 'list_projects', {})).length).toBe(7);
  });
});
