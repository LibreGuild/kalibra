import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { KalibraError, type Engine } from '@kalibra/core';

/* Small HTTP helpers shared by the routes: JSON responses, errors, bodies, files and the built UI. */

const STATUS: Record<string, number> = { not_found: 404, invalid: 400, conflict: 409, forbidden: 403, unavailable: 503, internal: 500, unauthorized: 401, rate_limited: 429 };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json',
};

/** Headers on every response: no MIME sniffing, no framing (clickjacking), no referrer leaks to other sites. */
export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

/**
 * The UI's content security policy: only this origin's scripts, no plugins, no framing. Inline
 * styles are allowed because the code editor and charts set them.
 */
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  if (res.headersSent) return res.end();
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export const sendData = (res: ServerResponse, data: unknown, headers?: Record<string, string | string[]>) => send(res, 200, { data: data ?? null }, headers);

export const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

export function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof KalibraError) return send(res, STATUS[e.code] ?? 500, { error: { code: e.code, message: e.message, details: e.details } });
  if (e instanceof SyntaxError) return send(res, 400, { error: { code: 'invalid', message: `Invalid JSON: ${e.message}` } });
  const message = (e as any)?.message ?? String(e);
  send(res, 500, { error: { code: 'internal', message } });
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new KalibraError('invalid', 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req: IncomingMessage, limit = 50 * 1024 * 1024): Promise<any> {
  const body = await readBody(req, limit);
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

/** Streams a stored file, with Range support (audio seeking) and a sandbox so opened files cannot script the app. */
export function serveBlob(engine: Engine, req: IncomingMessage, res: ServerResponse, hash: string, url: URL) {
  const info = engine.blobs.info(hash);
  if (!info || !engine.blobs.has(hash)) return fail(res, 404, 'not_found', 'File not found');
  const headers: Record<string, string | number> = {
    ...BASE_HEADERS,
    'content-type': info.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    // Files come from datasets, bundles and model output: opened directly (e.g. an SVG or HTML file),
    // they must not run script with this origin's access to the API.
    'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(info.name ?? info.hash)}"`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return engine.blobs.stream(info.hash, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  if (req.method === 'HEAD') return res.end();
  return engine.blobs.stream(info.hash).pipe(res);
}

/** Serves the built web UI; unknown paths get index.html (client-side routing). */
export function serveStatic(staticDir: string | undefined, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!staticDir) return fail(res, 404, 'not_found', 'UI not built. Run the web dev server or build the UI.');
  const root = resolve(staticDir);
  let file: string;
  try {
    file = normalize(join(root, decodeURIComponent(url.pathname)));
  } catch {
    return fail(res, 400, 'invalid', 'Bad path');
  }
  if (file !== root && !file.startsWith(root + sep)) return fail(res, 403, 'forbidden', 'Bad path');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  const isAsset = file.startsWith(join(root, 'assets') + sep);
  const isHtml = extname(file) === '.html';
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(isHtml ? { 'content-security-policy': UI_CSP } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
