import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub } from '@kalibra/core';
import { clientIp } from '../src/auth.js';
import { startServer, type RunningServer } from '../src/index.js';

/* Regression tests from the security review of the team server's HTTP layer. */

const PW = 'correct horse battery';
const open: { srv: RunningServer; hub: Hub; dir: string }[] = [];

async function team(opts: { publicUrl?: string; trustProxy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-srvsec-'));
  const hub = new Hub({ dir, mode: 'server' });
  await hub.completeSetup(hub.setupCode()!, { username: 'admin', password: PW });
  const srv = await startServer({ hub, ...opts });
  open.push({ srv, hub, dir });
  return { hub, srv };
}

afterEach(async () => {
  for (const { srv, hub, dir } of open.splice(0)) {
    await srv.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const post = (srv: RunningServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { origin: srv.url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('forwarded addresses', () => {
  it('uses the address our proxy appended, not what the client wrote first', () => {
    const req = { headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.2' } } as any;
    expect(clientIp(req, true)).toBe('203.0.113.9');
    expect(clientIp(req, false)).toBe('10.0.0.2');
  });

  it('trusts gateway headers by the connecting address, never by X-Forwarded-For', async () => {
    const { hub, srv } = await team({ trustProxy: true });
    await hub.providers.save({ name: 'Gateway', id: 'gate', kind: 'proxy', emailHeader: 'X-Forwarded-Email', trustedProxies: ['10.0.0.1'], autoCreate: true });
    const spoofed = await post(srv, '/kalibra/api/hub/get_me', {}, { 'x-forwarded-for': '10.0.0.1', 'x-forwarded-email': 'admin@corp.example' });
    expect(spoofed.status).toBe(403);
    await hub.providers.save({ id: 'gate', trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] });
    const real = await post(srv, '/kalibra/api/hub/get_me', {}, { 'x-forwarded-email': 'ivy@corp.example' });
    expect((await real.json()).data.user.email).toBe('ivy@corp.example');
  });

  it('applies a disabled account to gateway sign-ins at once', async () => {
    const { hub, srv } = await team();
    await hub.providers.save({ name: 'Gateway', id: 'gate', kind: 'proxy', emailHeader: 'X-Forwarded-Email', trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'], autoCreate: true });
    const me = await (await post(srv, '/kalibra/api/hub/get_me', {}, { 'x-forwarded-email': 'jo@corp.example' })).json();
    hub.accounts.update(me.data.user.id, { disabled: true });
    expect((await post(srv, '/kalibra/api/hub/get_me', {}, { 'x-forwarded-email': 'jo@corp.example' })).status).toBe(403);
  });
});

describe('sign-in limits', () => {
  it('counts only failed sign-ins per address, so an office behind one address is not locked out', async () => {
    const { srv } = await team();
    for (let i = 0; i < 22; i++) expect((await post(srv, '/kalibra/api/auth/login', { username: 'admin', password: PW })).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) last = (await post(srv, '/kalibra/api/auth/login', { username: 'nobody', password: 'wrong password!' })).status;
    expect(last).toBe(429);
  }, 60_000);
});

describe('cookies over HTTPS', () => {
  it('accepts only the __Host- session cookie, so a sibling subdomain cannot plant a session', async () => {
    const { srv } = await team({ publicUrl: 'https://kalibra.test' });
    const login = await fetch(`${srv.url}/kalibra/api/auth/login`, { method: 'POST', headers: { origin: 'https://kalibra.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PW }) });
    const set = login.headers.get('set-cookie')!;
    expect(set).toMatch(/^__Host-kalibra_session=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure/);
    const secret = set.split(';')[0].split('=')[1];
    const me = (cookie: string) => fetch(`${srv.url}/kalibra/api/hub/get_me`, { method: 'POST', headers: { origin: 'https://kalibra.test', cookie } });
    expect((await me(`__Host-kalibra_session=${secret}`)).status).toBe(200);
    expect((await me(`kalibra_session=${secret}`)).status).toBe(401);
  });

  it('binds sign-ins with a __Host- cookie over HTTPS', async () => {
    const { hub, srv } = await team({ publicUrl: 'https://kalibra.test' });
    await hub.providers.save({ name: 'GitHub', id: 'gh', kind: 'github', githubUrl: 'https://github.com', clientId: 'c', clientSecret: 's' });
    const start = await fetch(`${srv.url}/kalibra/api/auth/sso/gh/start`, { redirect: 'manual' });
    expect(start.headers.get('set-cookie')).toMatch(/^__Host-kalibra_sso=[^;]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure$/);
  });
});

describe('provider callbacks', () => {
  it('shows nothing from a callback link that is not a sign-in we started', async () => {
    const { hub, srv } = await team();
    await hub.providers.save({ name: 'GitHub', id: 'gh', kind: 'github', githubUrl: 'https://github.com', clientId: 'c', clientSecret: 's' });
    const res = await fetch(`${srv.url}/kalibra/api/auth/sso/gh/callback?state=bogus&error_description=${encodeURIComponent('Your account is locked. Call 555-0100.')}`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('/kalibra/login');
    const flash = res.headers.getSetCookie().find((c) => c.startsWith('kalibra_login_error='))!.split(';')[0];
    const status = await fetch(`${srv.url}/kalibra/api/auth/status`, { headers: { cookie: flash } });
    const { error } = (await status.json()).data;
    expect(error).toMatch(/expired or was already used/);
    expect(error).not.toContain('555-0100');
    // Shown once: the status answer clears it.
    expect(status.headers.getSetCookie().join()).toMatch(/kalibra_login_error=; .*Max-Age=0/);
    // Text in the address is never shown.
    expect((await (await fetch(`${srv.url}/kalibra/api/auth/status?error=hello`)).json()).data.error).toBeUndefined();
  });
});

describe('addresses', () => {
  it('answers a malformed project in the URL with 400', async () => {
    const { srv } = await team();
    const login = await post(srv, '/kalibra/api/auth/login', { username: 'admin', password: PW });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await fetch(`${srv.url}/kalibra/api/projects/%E0%A4%A/ops`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});
