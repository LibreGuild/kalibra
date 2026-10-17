import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deployConfigFrom, Hub, MemoryObjects, openStorage, type StorageRuntime } from '@kalibra/core';
import { handOverOnRequest, startServer, type RunningServer } from '../src/index.js';

/*
 * Setup B (SQLite + bucket) during a rolling deploy: the new instance starts while the old one still
 * serves. The new one asks for the bucket; the old one stops serving data (503), lets requests finish,
 * syncs one last time and gives the lease back; the new one restores everything and carries on.
 */

const KEY = 'b'.repeat(64);
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Instance {
  dir: string;
  storage: StorageRuntime;
  hub: Hub;
  srv: RunningServer;
  closeHub: () => Promise<void>;
}

async function instance(objects: MemoryObjects, takeover = false): Promise<Instance> {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-handover-'));
  // Syncs only when a database opens or closes: the last writes must come over with the final sync.
  const cfg = deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://unused', KALIBRA_SECRET_KEY: KEY, KALIBRA_SQLITE_SYNC_SECONDS: '3600' });
  const storage = await openStorage(cfg, { dir, objects, takeover, log: () => {}, leaseTiming: { handoverPollMs: 20, handoverWaitMs: 10_000, abandonMs: 3_000 } });
  const hub = await Hub.open({ dir, mode: 'server', databases: storage.databases, storage: storage.hooks });
  await hub.openAll();
  const srv = await startServer({ hub });
  const closeHub = handOverOnRequest(storage, srv, hub, () => {});
  return { dir, storage, hub, srv, closeHub };
}

describe('handing a bucket over during a rolling deploy', { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('the new instance takes over with every write the old one accepted; the old one answers 503', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    const objects = new MemoryObjects();
    const a = await instance(objects);
    dirs.push(a.dir);
    const admin = await a.hub.ensureAdmin('admin', 'correct horse battery');
    const token = (await a.hub.accounts.createToken(admin.id, { name: 'tests' })).token;
    const projectId = (await a.hub.projects.get('default')).id;
    const op = async (srv: RunningServer, name: string, input: unknown) => {
      const res = await fetch(`${srv.url}/kalibra/api/projects/${projectId}/ops/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json().catch(() => ({}))) as any };
    };
    expect((await op(a.srv, 'create_dataset', { name: 'Q', columns: [{ key: 'input', type: 'text' }] })).status).toBe(200);

    // Writes keep arriving at the old instance while the new one starts.
    const accepted: string[] = [];
    let refused = 0;
    const other: unknown[] = [];
    let writing = true;
    const writer = (async () => {
      for (let n = 0; writing; n++) {
        const r = await op(a.srv, 'add_dataset_rows', { dataset: 'Q', rows: [{ data: { input: `w${n}` } }] }).catch(() => undefined);
        if (r?.status === 200) accepted.push(`w${n}`);
        else if (r?.status === 503) {
          refused++;
          expect(r.retryAfter).toBe('5');
          expect(r.body.error.message).toMatch(/moving to a new instance/);
        } else other.push(r ? `${r.status} ${JSON.stringify(r.body)}` : 'no answer');
        await tick(5);
      }
    })();
    await tick(100);

    const b = await instance(objects, true); // returns once it holds the lease and restored
    dirs.push(b.dir);
    await tick(50);
    writing = false;
    await writer;

    // The old instance: data requests refused, health says it is handing over.
    expect(refused).toBeGreaterThan(0);
    expect(other).toEqual([]); // nothing half-done: accepted, or refused with a 503
    expect(accepted.length).toBeGreaterThan(0);
    const health = await (await fetch(`${a.srv.url}/kalibra/api/health`)).json();
    expect(health).toMatchObject({ ok: true, handingOver: true });
    expect((await op(a.srv, 'list_datasets', {})).status).toBe(503);

    // The new instance has every write the old one accepted (and the same accounts and tokens).
    const ds = await op(b.srv, 'list_datasets', {});
    expect(ds.status).toBe(200);
    const q = ds.body.data.find((d: any) => d.name === 'Q');
    const engine = await b.hub.engine(projectId);
    const { rows } = await engine.repos.datasets.listRows(q.id, { limit: 500 });
    const inputs = new Set(rows.map((r: any) => r.data.input));
    for (const w of accepted) expect(inputs.has(w)).toBe(true);
    // ...and goes on writing.
    expect((await op(b.srv, 'add_dataset_rows', { dataset: 'Q', rows: [{ data: { input: 'after' } }] })).status).toBe(200);

    // Restoring left no temporary files behind.
    const leftovers = (readdirSync(b.dir, { recursive: true }) as string[]).filter((f) => /\.restore\.tmp|\.snapshot\.tmp/.test(f));
    expect(leftovers).toEqual([]);
    expect(warnings.filter((w) => w === 'MaxListenersExceededWarning')).toEqual([]);
    process.off('warning', onWarning);

    // Normal shutdown of both still works (the old one's hub is already closed).
    await a.srv.close();
    await a.closeHub();
    await a.storage.close();
    await b.srv.close();
    await b.closeHub();
    await b.storage.close();
  });
});
