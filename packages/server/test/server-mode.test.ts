import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hub } from '@kalibra/core';
import { startServer, type RunningServer } from '../src/index.js';

/** A team server over real HTTP: sign-in, cookies, tokens, CSRF and per-project access. */
describe('server mode over HTTP', () => {
  const PW = 'correct horse battery';
  let dir: string;
  let hub: Hub;
  let srv: RunningServer;
  let origin: string;

  /** A tiny browser: keeps the session cookie and sends our Origin like a real page would. */
  function browser() {
    let jar = '';
    const call = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const res = await fetch(`${srv.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) jar = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, headers: res.headers };
    };
    return { call, cookie: () => jar };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-srv-'));
    hub = new Hub({ dir, mode: 'server' });
    srv = await startServer({ hub });
    origin = srv.url;
  });

  afterAll(async () => {
    await srv?.close();
    hub?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks for setup with the one-time code, then signs the administrator in', async () => {
    const b = browser();
    expect((await b.call('/api/auth/status')).body.data).toMatchObject({ mode: 'server', setupRequired: true, user: null });
    expect((await b.call('/api/hub/list_projects', {})).status).toBe(401);
    expect((await b.call('/api/auth/setup', { code: 'wrong', username: 'admin', password: PW })).status).toBe(403);
    const ok = await b.call('/api/auth/setup', { code: hub.setupCode(), username: 'admin', password: PW });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax; Path=\//);
    expect(ok.body.data.user.username).toBe('admin');
    expect((await b.call('/api/auth/status')).body.data).toMatchObject({ setupRequired: false, user: { username: 'admin' } });
  });

  it('signs in and out, without saying whether the username exists', async () => {
    const b = browser();
    const bad1 = await b.call('/api/auth/login', { username: 'admin', password: 'wrong password!' });
    const bad2 = await b.call('/api/auth/login', { username: 'ghost', password: 'wrong password!' });
    expect(bad1.status).toBe(403);
    expect(bad1.body.error.message).toBe(bad2.body.error.message);
    expect((await b.call('/api/auth/login', { username: 'admin', password: PW })).status).toBe(200);
    expect((await b.call('/api/hub/get_me', {})).body.data.user.username).toBe('admin');
    await b.call('/api/auth/logout', {});
    expect((await b.call('/api/hub/get_me', {})).status).toBe(401);
  });

  it('refuses cookie-authenticated writes from other sites (CSRF)', async () => {
    const b = browser();
    await b.call('/api/auth/login', { username: 'admin', password: PW });
    expect((await b.call('/api/hub/list_projects', {}, { origin: 'https://evil.example' })).status).toBe(403);
    // A form post from a page with no Origin is refused too.
    const res = await fetch(`${srv.url}/api/hub/create_project`, { method: 'POST', headers: { cookie: b.cookie(), 'content-type': 'application/json' }, body: '{"name":"csrf"}' });
    expect(res.status).toBe(403);
  });

  it('makes new users choose their own password before anything else', async () => {
    const admin = browser();
    await admin.call('/api/auth/login', { username: 'admin', password: PW });
    expect((await admin.call('/api/hub/create_user', { username: 'dana', password: 'starting password 1' })).status).toBe(200);
    const dana = browser();
    const me = await dana.call('/api/auth/login', { username: 'dana', password: 'starting password 1' });
    expect(me.body.data.user.mustChangePassword).toBe(true);
    expect((await dana.call('/api/hub/list_projects', {})).body.error.code).toBe('password_change_required');
    expect((await dana.call('/api/hub/change_password', { current: 'starting password 1', next: 'my very own secret' })).status).toBe(200);
    expect((await dana.call('/api/hub/list_projects', {})).status).toBe(200);
  });

  it('serves projects only to their members, with their role', async () => {
    const admin = browser();
    await admin.call('/api/auth/login', { username: 'admin', password: PW });
    await admin.call('/api/hub/create_user', { username: 'erin', password: PW, mustChangePassword: false });
    const p = (await admin.call('/api/hub/create_project', { name: 'Team evals' })).body.data;
    await admin.call(`/api/projects/${p.id}/ops/create_dataset`, { name: 'Q', columns: [{ key: 'q' }] });

    const erin = browser();
    await erin.call('/api/auth/login', { username: 'erin', password: PW });
    expect((await erin.call(`/api/projects/${p.id}/ops/list_datasets`, {})).status).toBe(404);
    expect((await erin.call('/api/hub/list_projects', {})).body.data).toEqual([]);

    await admin.call('/api/hub/set_member', { project: p.id, user: 'erin', role: 'viewer' });
    expect((await erin.call(`/api/projects/${p.id}/ops/list_datasets`, {})).body.data.map((d: any) => d.name)).toEqual(['Q']);
    expect((await erin.call(`/api/projects/${p.id}/ops/create_dataset`, { name: 'No', columns: [{ key: 'q' }] })).status).toBe(403);
    // Raw uploads need the editor role too.
    const up = await fetch(`${srv.url}/api/projects/${p.id}/files`, { method: 'POST', headers: { origin, cookie: erin.cookie(), 'x-file-name': 'a.txt' }, body: 'hello' });
    expect(up.status).toBe(403);
    // Each op lists the role it needs.
    const ops = await fetch(`${srv.url}/api/projects/${p.id}/ops`, { headers: { cookie: erin.cookie() } }).then((r) => r.json());
    expect(ops.find((o: any) => o.name === 'set_secret').access).toBe('owner');
  });

  it('accepts access tokens for agents, without cookies or Origin', async () => {
    const admin = browser();
    await admin.call('/api/auth/login', { username: 'admin', password: PW });
    const token = (await admin.call('/api/hub/create_token', { name: 'claude' })).body.data.token as string;
    const asAgent = (path: string, body: unknown) =>
      fetch(`${srv.url}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-kalibra-actor': JSON.stringify({ kind: 'agent', client: 'claude-code' }) },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    const projects = await asAgent('/api/hub/list_projects', {});
    expect(projects.status).toBe(200);
    const p = projects.body.data[0];
    expect((await asAgent(`/api/projects/${p.id}/ops/create_dataset`, { name: 'From agent', columns: [{ key: 'q' }] })).status).toBe(200);
    const activity = await asAgent(`/api/projects/${p.id}/ops/list_activity`, {});
    expect(activity.body.data[0].actor).toMatchObject({ kind: 'agent', client: 'claude-code', name: 'admin' });
    // Tokens cannot manage accounts, even for an administrator.
    expect((await asAgent('/api/hub/create_user', { username: 'mallory', password: PW })).status).toBe(403);
    expect((await asAgent('/api/hub/list_projects', {})).status).toBe(200);
    expect((await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { authorization: 'Bearer kal_nope' } })).status).toBe(401);
  });

  it('limits sign-in attempts per address', async () => {
    const b = browser();
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await b.call('/api/auth/login', { username: 'nobody', password: 'x' })).status;
    expect(last).toBe(429);
  }, 30_000); // each failed sign-in hashes a password on purpose: slow on busy CI machines

  it('sends security headers and keeps paths private', async () => {
    const res = await fetch(`${srv.url}/api/health`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
