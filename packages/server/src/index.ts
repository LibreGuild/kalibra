import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { KalibraError, LOCAL_USER, type Actor, type Engine, type EngineEvent } from '@kalibra/core';

/*
 * The engine's HTTP API. The desktop app runs this on 127.0.0.1 with a per-launch token; a future
 * server mode runs the same API behind TLS and a login. Everything is an operation:
 *   GET  /api/ops            list operations (+ JSON Schemas)
 *   POST /api/ops/:name      call one
 *   GET  /api/events         live change events (SSE)
 *   POST /api/files          upload a file (raw body) → blob info
 *   GET  /api/files/:hash    download / stream a file (supports Range for audio seeking)
 */

export interface ServerOptions {
  engine: Engine;
  host?: string;
  port?: number;
  /** Required on every request (Bearer header or cookie). Omit only for trusted local development. */
  token?: string;
  /** Built web UI to serve (SPA). */
  staticDir?: string;
  /** Extra allowed browser origins (e.g. the Vite dev server). */
  allowedOrigins?: string[];
  /** Facts about how this engine was launched, shown in the UI (e.g. the MCP command for coding agents). */
  meta?: { mcp?: { command: string; args: string[]; env?: Record<string, string> }; version?: string; mode?: 'desktop' | 'cli' | 'dev' };
}

export interface RunningServer {
  url: string;
  port: number;
  token?: string;
  close(): Promise<void>;
}

const STATUS: Record<string, number> = { not_found: 404, invalid: 400, conflict: 409, forbidden: 403, unavailable: 503, internal: 500 };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json',
};

export const newToken = () => randomBytes(32).toString('base64url');

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { engine } = opts;
  const host = opts.host ?? '127.0.0.1';
  let port = 0;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      sendError(res, e);
    }
  });

  function allowedHosts() {
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(opts.allowedOrigins ?? []).map((o) => new URL(o).host)]);
  }

  /** Blocks DNS-rebinding and cross-site requests: Host must be ours; Origin, when present, must be ours too. */
  function checkOrigin(req: IncomingMessage): boolean {
    if (host !== '127.0.0.1' && host !== 'localhost') return true; // server mode: handled by a reverse proxy / auth layer
    const hosts = allowedHosts();
    if (!req.headers.host || !hosts.has(req.headers.host)) return false;
    // "null" comes from sandboxed iframes and file:// pages, which any website can create.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (!hosts.has(new URL(origin).host)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function authorized(req: IncomingMessage): boolean {
    if (!opts.token) return true;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const cookie = /(?:^|;\s*)kalibra_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const given = header || cookie || '';
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!checkOrigin(req)) return send(res, 403, { error: { code: 'forbidden', message: 'Host or origin not allowed' } });

    // Desktop shell opens /?token=… once; we turn it into an HttpOnly cookie for the UI.
    if (opts.token && url.searchParams.get('token') === opts.token && !url.pathname.startsWith('/api/')) {
      res.writeHead(302, {
        'set-cookie': `kalibra_token=${opts.token}; HttpOnly; SameSite=Strict; Path=/`,
        location: url.pathname,
      });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'kalibra' });
      if (!authorized(req)) return send(res, 401, { error: { code: 'forbidden', message: 'Missing or invalid token' } });
      return api(req, res, url);
    }
    return serveStatic(req, res, url);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path === '/api/ops' && req.method === 'GET') return send(res, 200, engine.registry.describe());
    if (path === '/api/meta' && req.method === 'GET') return send(res, 200, { data: { dir: engine.dir, ...opts.meta } });

    const op = /^\/api\/ops\/([a-z0-9_]+)$/.exec(path);
    if (op && req.method === 'POST') {
      const body = await readBody(req, 50 * 1024 * 1024);
      const input = body.length ? JSON.parse(body.toString('utf8')) : {};
      const result = await engine.call(op[1], input, actorFrom(req));
      return send(res, 200, { data: result ?? null });
    }

    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const unsubscribe = engine.events.subscribe((e: EngineEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
      return;
    }

    if (path === '/api/files' && req.method === 'POST') {
      const data = await readBody(req, 2 * 1024 * 1024 * 1024);
      const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')) || undefined;
      const type = String(req.headers['content-type'] ?? '');
      const info = await engine.blobs.put(data, { name, mime: type && type !== 'application/octet-stream' ? type : undefined });
      return send(res, 200, { data: info });
    }

    const file = /^\/api\/files\/([a-f0-9]{64})$/.exec(path);
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      const info = engine.blobs.info(file[1]);
      if (!info || !engine.blobs.has(file[1])) return send(res, 404, { error: { code: 'not_found', message: 'File not found' } });
      const headers: Record<string, string | number> = {
        'content-type': info.mime,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=31536000, immutable',
        // Files come from datasets, bundles and model output: opened directly (e.g. an SVG or HTML file),
        // they must not run script with this origin's access to the API.
        'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
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

    send(res, 404, { error: { code: 'not_found', message: `No route ${req.method} ${path}` } });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!opts.staticDir) return send(res, 404, { error: { code: 'not_found', message: 'UI not built. Run the web dev server or build the UI.' } });
    const root = resolve(opts.staticDir);
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: { code: 'forbidden', message: 'Bad path' } });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    const isAsset = file.includes(`${root}/assets/`);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });
  port = (server.address() as any).port;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    port,
    token: opts.token,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        // Live event streams never end on their own and would keep close() waiting forever.
        server.closeAllConnections();
      }),
  };
}

/** Callers holding the token may say who they are (the MCP bridge marks agent calls). */
function actorFrom(req: IncomingMessage): Actor {
  const raw = req.headers['x-kalibra-actor'];
  if (typeof raw === 'string') {
    try {
      const a = JSON.parse(raw);
      if (['user', 'agent', 'cli'].includes(a.kind) && typeof a.id === 'string') {
        return { kind: a.kind, id: a.id.slice(0, 100), client: a.client?.slice?.(0, 100), model: a.model?.slice?.(0, 100) };
      }
    } catch {
      /* fall through */
    }
  }
  return LOCAL_USER;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end();
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, e: unknown) {
  if (e instanceof KalibraError) return send(res, STATUS[e.code] ?? 500, { error: { code: e.code, message: e.message, details: e.details } });
  if (e instanceof SyntaxError) return send(res, 400, { error: { code: 'invalid', message: `Invalid JSON: ${e.message}` } });
  const message = (e as any)?.message ?? String(e);
  send(res, 500, { error: { code: 'internal', message } });
}
