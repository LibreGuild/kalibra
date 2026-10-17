import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveStatic } from '../src/http.js';

/* The built UI: precompressed files, caching and the single-page-app fallback. */

let dir: string;
let server: Server;
let port: number;
const js = 'console.log("kalibra");'.repeat(200);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kalibra-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Kalibra</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), js);
  writeFileSync(join(dir, 'assets', 'app-abc123.js.br'), brotliCompressSync(js));
  writeFileSync(join(dir, 'assets', 'app-abc123.js.gz'), gzipSync(js));
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  server = createServer((req, res) => serveStatic(dir, req, res, new URL(req.url ?? '/', 'http://localhost')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw GET (fetch would decompress and hide the encoding). */
function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serving the built UI', () => {
  it('sends the brotli or gzip copy when the browser accepts it, and the plain file otherwise', async () => {
    const br = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('accept-encoding');
    expect(br.body.length).toBeLessThan(js.length / 5);
    const gz = await get('/assets/app-abc123.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gz.body).toString()).toBe(js);
    const plain = await get('/assets/app-abc123.js');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(js);
    expect(plain.headers['content-length']).toBe(String(js.length));
  });

  it('caches hashed assets for good and lets the browser revalidate everything else', async () => {
    expect((await get('/assets/app-abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const logo = await get('/logo.png');
    expect(logo.headers['cache-control']).toBe('no-cache');
    const again = await get('/logo.png', { 'if-none-match': String(logo.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  it('answers unknown paths with index.html (the app routes them) and keeps paths inside the folder', async () => {
    const page = await get('/p/default/runs');
    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain('<title>Kalibra</title>');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await get('/..%2F..%2Fetc%2Fpasswd')).status).toBe(403);
  });
});
