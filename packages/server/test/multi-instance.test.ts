import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Hub, RedisCoordinator, sqliteDatabases, type Databases, type Db } from '@kalibra/core';
import { startServer, type RunningServer } from '../src/index.js';

/*
 * Two Kalibra instances behind one load balancer: one shared database (here SQLite opened once and
 * handed to both, standing in for Postgres) and one shared Redis (ioredis-mock). Each instance has its
 * own hub, engines, coordinator and HTTP server, so everything that used to live in one process must
 * go through the database or Redis to be seen by the other.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEASE = { leaseMs: 600, renewMs: 150, sweepMs: 200 };

/** One set of database handles for both instances; closing is done once, at the end. */
function sharedDatabases(): Databases & { closeAll(): Promise<void> } {
  const inner = sqliteDatabases();
  const open = new Map<string, Promise<Db>>();
  const handle = (db: Db): Db => new Proxy(db, { get: (t, p) => (p === 'close' ? async () => {} : typeof (t as any)[p] === 'function' ? (t as any)[p].bind(t) : (t as any)[p]) });
  const once = (key: string, make: () => Promise<Db>) => {
    if (!open.has(key)) open.set(key, make());
    return open.get(key)!.then(handle);
  };
  return {
    dialect: 'sqlite',
    hub: (dir) => once(`hub:${dir}`, () => inner.hub(dir)),
    project: (id, dir) => once(`p:${dir}`, () => inner.project(id, dir)),
    exists: (kind, id, dir) => inner.exists(kind, id, dir),
    close: async () => {},
    closeAll: async () => {
      for (const db of open.values()) await (await db).close();
    },
  };
}

// Two servers, real runs and live streams in one process: give busy CI machines time.
describe('several instances (Postgres + Redis + bucket in production)', { timeout: 40_000 }, () => {
  let dir: string;
  let databases: ReturnType<typeof sharedDatabases>;
  let hubA: Hub;
  let hubB: Hub;
  let srvA: RunningServer;
  let srvB: RunningServer;
  let app: Server;
  let appUrl: string;
  let adminToken: string;
  let bobToken: string;
  let projectId: string;

  const call = async (srv: RunningServer, token: string, path: string, body?: unknown) => {
    const res = await fetch(`${srv.url}/kalibra/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const op = async (srv: RunningServer, name: string, input: unknown, token = adminToken) => {
    const r = await call(srv, token, `/projects/${projectId}/ops/${name}`, input);
    if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };

  /** Reads a live-event stream into `seen` until stopped. */
  async function listen(srv: RunningServer) {
    const ac = new AbortController();
    const res = await fetch(`${srv.url}/kalibra/api/projects/${projectId}/events`, { headers: { authorization: `Bearer ${adminToken}` }, signal: ac.signal });
    const reader = res.body!.getReader();
    const seen: any[] = [];
    let buffer = '';
    let connected!: () => void;
    const ready = new Promise<void>((r) => (connected = r));
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          if (buffer.includes(': connected')) connected();
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
          }
        }
      } catch {
        /* stopped */
      }
    })();
    await ready;
    return { seen, stop: () => ac.abort() };
  }

  async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() > until) throw new Error('timed out');
      await sleep(25);
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-multi-'));
    databases = sharedDatabases();
    const coordinator = (id: string) => new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, id);
    hubA = await Hub.open({ dir, mode: 'server', databases, coordinator: coordinator('A'), runLease: LEASE });
    hubB = await Hub.open({ dir, mode: 'server', databases, coordinator: coordinator('B'), runLease: LEASE });
    srvA = await startServer({ hub: hubA });
    srvB = await startServer({ hub: hubB });

    const admin = await hubA.ensureAdmin('admin', 'correct horse battery');
    adminToken = (await hubA.accounts.createToken(admin.id, { name: 'tests' })).token;
    const bob = await hubA.accounts.create({ username: 'bob', password: 'another long password', role: 'user' }, 'tests');
    bobToken = (await hubA.accounts.createToken(bob.id, { name: 'bob' })).token;
    projectId = (await hubA.projects.get('default')).id;
    await hubA.projects.setMember(projectId, 'user', bob.id, 'viewer', admin.id);

    // The app under test: answers after a short wait, so runs take long enough to interrupt.
    app = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => setTimeout(() => res.end(JSON.stringify({ answer: JSON.parse(body || '{}').q ?? '' })), 60));
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(app.address() as any).port}`;

    await op(srvA, 'create_dataset', { name: 'Q', columns: [{ key: 'input', type: 'text' }, { key: 'expected', type: 'text' }] });
    await op(srvA, 'add_dataset_rows', { dataset: 'Q', rows: Array.from({ length: 12 }, (_, n) => ({ data: { input: `q${n}`, expected: `q${n}` } })) });
    await op(srvA, 'create_target', {
      name: 'App',
      spec: {
        variables: [{ key: 'base_url', value: appUrl, enabled: true }],
        config: { kind: 'http', method: 'POST', url: '{{vars.base_url}}/chat', body: { type: 'json', content: '{"q": "{{input}}"}' }, outputs: [{ name: 'output', from: 'json', path: '$.answer' }] },
      },
    });
    await op(srvA, 'create_suite', { name: 'Exact', spec: { checks: [{ id: 'eq', type: 'equals', name: 'Matches', config: { actual: '{{output}}', expected: '{{expected}}' } }] } });
  });

  afterAll(async () => {
    await srvA?.close();
    await srvB?.close();
    await hubA?.close();
    await hubB?.close();
    await databases?.closeAll();
    await new Promise((r) => app?.close(r));
    await new RedisMock().flushall();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers an event raised on one instance to live streams on the other, once', async () => {
    const onB = await listen(srvB);
    const onA = await listen(srvA);
    const fromA = await op(srvA, 'create_dataset', { name: 'From A', columns: [{ key: 'x', type: 'text' }] });
    const fromB = await op(srvB, 'create_dataset', { name: 'From B', columns: [{ key: 'x', type: 'text' }] });
    const count = (seen: any[], id: string) => seen.filter((e) => e.type === 'dataset.changed' && e.datasetId === id).length;
    await waitFor(async () => count(onB.seen, fromA.id) && count(onA.seen, fromB.id));
    await sleep(100);
    for (const s of [onA.seen, onB.seen]) {
      expect(count(s, fromA.id)).toBe(1);
      expect(count(s, fromB.id)).toBe(1);
    }
    onA.stop();
    onB.stop();
  });

  it('takes a role change made on one instance into account on the other at once', async () => {
    expect((await call(srvB, bobToken, `/projects/${projectId}/ops/list_datasets`, {})).status).toBe(200);
    expect((await call(srvB, bobToken, `/projects/${projectId}/ops/list_datasets`, {})).status).toBe(200); // cached now
    const admin = (await hubA.accounts.find('admin'))!;
    await hubA.projects.removeMember(projectId, 'user', (await hubA.accounts.find('bob'))!.id);
    expect((await call(srvB, bobToken, `/projects/${projectId}/ops/list_datasets`, {})).status).toBe(404);
    await hubA.projects.setMember(projectId, 'user', (await hubA.accounts.find('bob'))!.id, 'viewer', admin.id);
    expect((await call(srvB, bobToken, `/projects/${projectId}/ops/list_datasets`, {})).status).toBe(200);
    // A revoked token stops working on the other instance immediately too.
    const temp = await hubA.accounts.createToken(admin.id, { name: 'temp' });
    expect((await call(srvB, temp.token, '/hub/get_me', {})).status).toBe(200);
    await hubA.accounts.revokeToken(temp.id);
    expect((await call(srvB, temp.token, '/hub/get_me', {})).status).toBe(401);
  });

  it('shares the sign-in limit between instances', async () => {
    const login = (srv: RunningServer) =>
      fetch(`${srv.url}/kalibra/api/auth/login`, { method: 'POST', headers: { origin: srv.url, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ghost', password: 'wrong password!' }) }).then((r) => r.status);
    for (let i = 0; i < 20; i++) expect(await login(i % 2 ? srvA : srvB)).not.toBe(429);
    expect(await login(srvA)).toBe(429);
    expect(await login(srvB)).toBe(429);
  }, 30_000); // each failed sign-in hashes a password, then writes to the database

  it('lets another instance resume a run whose instance stopped, without duplicating rows', async () => {
    const engineB = await hubB.engine(projectId);
    const startedOnB: string[] = [];
    const startB = engineB.runner.start.bind(engineB.runner);
    engineB.runner.start = (id: string) => (startedOnB.push(id), startB(id));

    const run = await op(srvA, 'start_run', { dataset: 'Q', target: 'App', suite: 'Exact', settings: { concurrency: 1 } });
    const engineA = await hubA.engine(projectId);
    await waitFor(async () => (await op(srvA, 'get_run', { runId: run.id })).done >= 3);
    // Instance A "crashes": it stops working, renewing and sweeping, leaving the run "running" with its lease.
    engineA.runner.stopSweeping();
    (engineA.runner as any).stop(run.id, 'lost');
    await waitFor(async () => !engineA.runner.isLocal(run.id));

    const done = await waitFor(async () => {
      const r = await op(srvB, 'get_run', { runId: run.id });
      return r.status === 'completed' && r;
    }, 15_000);
    expect(startedOnB).toContain(run.id);
    expect(done.done).toBe(12);
    expect(done.total).toBe(12);
    const { results } = await op(srvB, 'query_results', { runId: run.id, limit: 100 });
    expect(results).toHaveLength(12);
    expect(new Set(results.map((r: any) => r.rowId)).size).toBe(12);
    expect(results.every((r: any) => r.status === 'done' && r.passed)).toBe(true);
    expect(done.summary.passRate).toBe(1);
    await engineA.runner.recover(); // A is back
  });

  it('hands runs to the other instance when one shuts down', async () => {
    const run = await op(srvA, 'start_run', { dataset: 'Q', target: 'App', suite: 'Exact', settings: { concurrency: 1 } });
    const engineA = await hubA.engine(projectId);
    await waitFor(async () => (await op(srvA, 'get_run', { runId: run.id })).done >= 2);
    await engineA.runner.handOff();
    const done = await waitFor(async () => {
      const r = await op(srvB, 'get_run', { runId: run.id });
      return r.status === 'completed' && r;
    }, 15_000);
    expect(done.done).toBe(12);
    await engineA.runner.recover(); // A keeps serving: back to looking for orphaned runs
  });

  it('cancels, from one instance, a run executing on the other', async () => {
    const run = await op(srvA, 'start_run', { dataset: 'Q', target: 'App', suite: 'Exact', settings: { concurrency: 1 } });
    const engineA = await hubA.engine(projectId);
    await waitFor(async () => engineA.runner.isLocal(run.id) && (await op(srvA, 'get_run', { runId: run.id })).done >= 1);
    expect((await op(srvB, 'get_run', { runId: run.id })).active).toBe(true);
    await op(srvB, 'cancel_run', { runId: run.id });
    const r = await waitFor(async () => {
      const x = await op(srvB, 'get_run', { runId: run.id });
      return x.status === 'cancelled' && x;
    });
    expect(r.done).toBeLessThan(12);
    expect(engineA.runner.isLocal(run.id)).toBe(false);
    expect((await op(srvB, 'get_run', { runId: run.id })).active).toBe(false);
  });

  it('shows and cancels a background job from either instance', async () => {
    const engineA = await hubA.engine(projectId);
    const job = engineA.jobs.start('test', 'Slow job', async (h) => {
      for (let i = 0; i < 200 && !h.signal.aborted; i++) {
        h.progress(i, 200);
        await sleep(20);
      }
    });
    const seen = await waitFor(async () => {
      const j = await op(srvB, 'get_job', { jobId: job.id });
      return j.status === 'running' && j;
    });
    expect(seen.title).toBe('Slow job');
    expect((await op(srvB, 'list_jobs', {})).some((j: any) => j.id === job.id)).toBe(true);
    expect((await op(srvB, 'cancel_job', { jobId: job.id })).cancelled).toBe(true);
    await waitFor(async () => (await op(srvB, 'get_job', { jobId: job.id })).status === 'cancelled');
  });

  it('shares one setup link between instances', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'kalibra-multi-setup-'));
    const dbs = sharedDatabases();
    const coordinator = (id: string) => new RedisCoordinator(new RedisMock() as any, new RedisMock() as any, id);
    const a = await Hub.open({ dir: dir2, mode: 'server', databases: dbs, coordinator: coordinator('A2') });
    const b = await Hub.open({ dir: dir2, mode: 'server', databases: dbs, coordinator: coordinator('B2') });
    try {
      const code = await a.setupCode();
      expect(code).toBeTruthy();
      expect(await b.setupCode()).toBe(code);
      await b.completeSetup(code!, { username: 'root', password: 'correct horse battery' });
      expect(await a.setupCode()).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
      await dbs.closeAll();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
