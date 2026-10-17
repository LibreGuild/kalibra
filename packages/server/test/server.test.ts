import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hub, type Engine } from '@kalibra/core';
import { startServer, type RunningServer } from '../src/index.js';

const TOKEN = 'test-token';

describe('HTTP server hardening', () => {
  let dir: string;
  let hub: Hub;
  let engine: Engine;
  let srv: RunningServer;
  const auth = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-server-'));
    mkdirSync(join(dir, 'web', 'dist'), { recursive: true });
    mkdirSync(join(dir, 'web', 'dist-private'), { recursive: true });
    writeFileSync(join(dir, 'web', 'dist', 'index.html'), '<!doctype html><title>ui</title>');
    writeFileSync(join(dir, 'web', 'dist-private', 'secret.txt'), 'do not serve');
    hub = await Hub.open({ dir: join(dir, 'ws'), mode: 'local' });
    engine = await hub.engine('default');
    srv = await startServer({ hub, token: TOKEN, staticDir: join(dir, 'web', 'dist') });
  });

  afterAll(async () => {
    await srv?.close();
    await hub?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not serve sibling folders that share the UI folder name prefix', async () => {
    const res = await fetch(`${srv.url}/kalibra/..%2fdist-private/secret.txt`);
    expect(await res.text()).not.toContain('do not serve');
    expect(res.status).toBe(403);
    expect((await fetch(`${srv.url}/kalibra/some/route`)).status).toBe(200); // SPA fallback still works
  });

  it('lives under /kalibra: / redirects there, everything else outside it is 404', async () => {
    const go = (path: string) => fetch(`${srv.url}${path}`, { redirect: 'manual' });
    for (const [path, to] of [
      ['/', '/kalibra/'],
      ['/kalibra', '/kalibra/'],
      ['/?token=abc', '/kalibra/?token=abc'],
    ]) {
      const res = await go(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe(to);
    }
    for (const path of ['/api/health', '/api/ops/list_datasets', '/some/route', '/kalibraevil/api/health', '/assets/x.js']) {
      const res = await go(path);
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as any).error.message, path).toMatch(/under \/kalibra\//);
    }
    expect(await (await go('/kalibra/api/health')).json()).toEqual({ ok: true, name: 'kalibra' });
    expect((await go('/kalibra/')).status).toBe(200);
  });

  it('turns the launch link into a cookie scoped to /kalibra', async () => {
    const res = await fetch(`${srv.url}/kalibra/?token=${TOKEN}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/kalibra/');
    expect(res.headers.get('set-cookie')).toBe(`kalibra_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/kalibra`);
    // An old /?token=… link goes through the redirect to /kalibra/ first.
    const old = await fetch(`${srv.url}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(old.headers.get('location')).toBe(`/kalibra/?token=${TOKEN}`);
    const cookie = `kalibra_token=${TOKEN}`;
    expect((await fetch(`${srv.url}/kalibra/api/ops/list_datasets`, { method: 'POST', headers: { cookie }, body: '{}' })).status).toBe(200);
  });

  it('rejects the "null" origin that sandboxed iframes send', async () => {
    const res = await fetch(`${srv.url}/kalibra/api/ops/list_datasets`, { method: 'POST', headers: { ...auth, origin: 'null' }, body: '{}' });
    expect(res.status).toBe(403);
    const ok = await fetch(`${srv.url}/kalibra/api/ops/list_datasets`, { method: 'POST', headers: { ...auth, origin: srv.url }, body: '{}' });
    expect(ok.status).toBe(200);
  });

  it('serves files sandboxed so an uploaded SVG or HTML file cannot script the app', async () => {
    const info = await engine.blobs.put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { name: 'x.svg' });
    const res = await fetch(`${srv.url}/kalibra/api/files/${info.hash}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers unsatisfiable ranges with 416 instead of failing', async () => {
    const info = await engine.blobs.put(Buffer.from('0123456789'), { name: 'digits.txt' });
    const get = (range: string) => fetch(`${srv.url}/kalibra/api/files/${info.hash}`, { headers: { ...auth, range } });
    const part = await get('bytes=2-4');
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('234');
    expect((await get('bytes=8-3')).status).toBe(416);
    expect((await get('bytes=50-')).status).toBe(416);
    const whole = await get('bytes=-');
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('0123456789');
    expect(await (await get('bytes=-3')).text()).toBe('789');
  });

  it('closes even while a live event stream is open', async () => {
    const extra = await startServer({ hub, token: TOKEN });
    await new Promise<void>((resolve, reject) => {
      const req = request(`${extra.url}/api/events`, { headers: auth }, (res) => res.once('data', () => resolve()));
      req.on('error', () => {});
      req.end();
      setTimeout(() => reject(new Error('no event stream')), 2000);
    });
    const closed = await Promise.race([extra.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
    expect(closed).toBe('closed');
  });
});
