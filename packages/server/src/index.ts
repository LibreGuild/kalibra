import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DEFAULT_PROJECT, KalibraError, roleAtLeast, type EngineEvent, type Hub, type Principal } from '@kalibra/core';
import { authenticate, checkLocalOrigin, clientIp, cookie, isSecure, LOCAL_COOKIE, originAllowed, RateLimiter, sessionCookieName, type AuthConfig } from './auth.js';
import { BASE_HEADERS, fail, readBody, readJson, send, sendData, sendError, serveBlob, serveStatic } from './http.js';

/*
 * The HTTP API. The desktop app and `npx kalibra` run it on 127.0.0.1 with a per-launch token
 * (local mode); a team server runs the same API with sign-in (server mode). Everything is an
 * operation, and every call goes through the hub, which decides access:
 *
 *   GET  /api/health                         liveness (no auth)
 *   GET  /api/auth/status                    mode, whether setup is needed, who is signed in (no auth)
 *   POST /api/auth/setup | login | logout    first administrator, sign in, sign out (server mode)
 *   GET  /api/meta                           version, how to start the MCP bridge
 *   GET  /api/hub                            hub operations (+ JSON Schemas)
 *   POST /api/hub/:op                        your account, projects, members, administration
 *   GET  /api/projects/:p/ops                project operations (+ JSON Schemas and needed roles)
 *   POST /api/projects/:p/ops/:op            call one
 *   GET  /api/projects/:p/events             live change events (SSE)
 *   POST /api/projects/:p/files              upload a file (raw body) → blob info
 *   GET  /api/projects/:p/files/:hash        download / stream a file (Range supported)
 *
 * /api/ops, /api/events and /api/files are kept as shortcuts to the default project, for older
 * MCP bridge configs and scripts.
 */

export interface ServerOptions {
  hub: Hub;
  host?: string;
  port?: number;
  /** Local mode: required on every request (Bearer header or cookie). Omit only for trusted local development. */
  token?: string;
  /** Built web UI to serve (SPA). */
  staticDir?: string;
  /** Extra allowed browser origins (e.g. the Vite dev server). */
  allowedOrigins?: string[];
  /** Server mode: the address people use (https://kalibra.example.com), for origin checks and secure cookies. */
  publicUrl?: string;
  /** Server mode: trust X-Forwarded-For/Proto/Host from a reverse proxy in front of Kalibra. */
  trustProxy?: boolean;
  /** Facts about how this engine was launched, shown in the UI (e.g. the MCP command for coding agents). */
  meta?: { mcp?: { command: string; args: string[]; env?: Record<string, string> }; version?: string; mode?: 'desktop' | 'cli' | 'dev' | 'server' };
}

export interface RunningServer {
  url: string;
  port: number;
  token?: string;
  close(): Promise<void>;
}

export const newToken = () => randomBytes(32).toString('base64url');

/** Sign-in attempts per IP address in 10 minutes (each account also locks after repeated wrong passwords). */
const LOGIN_LIMIT = 20;
/** How often live event streams re-check that the caller may still see the project. */
const RECHECK_MS = 30_000;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { hub } = opts;
  const host = opts.host ?? '127.0.0.1';
  let port = 0;
  const cfg: AuthConfig = { hub, token: opts.token, allowedOrigins: opts.allowedOrigins ?? [], publicUrl: opts.publicUrl?.replace(/\/$/, ''), trustProxy: !!opts.trustProxy };
  const logins = new RateLimiter(LOGIN_LIMIT, 10 * 60_000);

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      sendError(res, e);
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (hub.mode === 'local' ? !checkLocalOrigin(req, port, cfg) : !originAllowed(req, cfg)) return fail(res, 403, 'forbidden', 'Host or origin not allowed');

    // The desktop shell opens /?token=… once; we turn it into an HttpOnly cookie for the UI.
    if (hub.mode === 'local' && opts.token && url.searchParams.get('token') === opts.token && !url.pathname.startsWith('/api/')) {
      res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `${LOCAL_COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=/`, location: url.pathname });
      return res.end();
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(opts.staticDir, req, res, url);
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'kalibra' });
    if (url.pathname.startsWith('/api/auth/')) return authRoutes(req, res, url);

    const auth = authenticate(req, cfg);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.message);
    const p = auth.principal;
    // A browser session must not write with another site's help (CSRF): writes need our Origin.
    if (auth.via === 'session' && req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.origin) {
      return fail(res, 403, 'forbidden', 'Missing Origin header');
    }
    // Accounts given a starting password must pick their own before doing anything else.
    if (p.user.mustChangePassword && auth.via === 'session' && !['/api/hub/change_password', '/api/hub/get_me', '/api/meta'].includes(url.pathname)) {
      return fail(res, 403, 'password_change_required', 'Choose a new password to continue');
    }
    return api(req, res, url, p);
  }

  // ── Sign-in ───────────────────────────────────────────────────────────────

  function sessionCookie(req: IncomingMessage, value: string, maxAgeSec: number) {
    const secure = isSecure(req, cfg);
    return `${sessionCookieName(secure)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  async function startSession(req: IncomingMessage, res: ServerResponse, userId: string) {
    const days = hub.settings().sessionDays;
    const s = hub.accounts.createSession(userId, { days, ip: clientIp(req, cfg.trustProxy), userAgent: String(req.headers['user-agent'] ?? '') });
    const me = await hub.call({ user: hub.accounts.get(userId), via: 'user', sessionId: s.id }, 'get_me', {});
    sendData(res, me, { 'set-cookie': sessionCookie(req, s.secret, days * 86_400) });
  }

  async function authRoutes(req: IncomingMessage, res: ServerResponse, url: URL) {
    const ip = clientIp(req, cfg.trustProxy);
    const path = url.pathname;

    if (path === '/api/auth/status' && req.method === 'GET') {
      const auth = authenticate(req, cfg);
      return sendData(res, {
        mode: hub.mode,
        setupRequired: hub.needsSetup(),
        user: auth.ok ? auth.principal.user : null,
        providers: [],
      });
    }

    if (req.method !== 'POST') return fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
    if (hub.mode === 'local') return fail(res, 400, 'invalid', 'This Kalibra runs on your computer without sign-in');
    if (!req.headers.origin) return fail(res, 403, 'forbidden', 'Missing Origin header');

    if (path === '/api/auth/logout') {
      const auth = authenticate(req, cfg);
      if (auth.ok && auth.principal.sessionId) hub.accounts.revokeSession(auth.principal.sessionId);
      return sendData(res, { signedOut: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }

    const body = await readJson(req, 64 * 1024);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    if (path === '/api/auth/setup') {
      if (!logins.allow(ip)) return fail(res, 429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
      const user = await hub.completeSetup(str(body.code), { username: str(body.username), password: str(body.password), name: str(body.name), email: str(body.email) }, ip);
      return startSession(req, res, user.id);
    }

    if (path === '/api/auth/login') {
      const username = str(body.username).trim();
      if (!logins.allow(ip)) {
        hub.audit({ kind: 'anonymous', id: username }, 'login.rate_limited', username, {}, ip);
        return fail(res, 429, 'rate_limited', 'Too many sign-in attempts. Wait a few minutes.');
      }
      try {
        const user = await hub.accounts.authenticate(username, str(body.password));
        hub.audit({ kind: 'user', id: user.id, name: user.name }, 'login', user.username, {}, ip);
        return startSession(req, res, user.id);
      } catch (e) {
        hub.audit({ kind: 'anonymous', id: username }, 'login.failed', username, {}, ip);
        throw e;
      }
    }

    return fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, p: Principal) {
    const path = url.pathname;
    const ip = clientIp(req, cfg.trustProxy);

    if (path === '/api/meta' && req.method === 'GET') {
      const local = hub.mode === 'local';
      return sendData(res, { ...opts.meta, mode: local ? opts.meta?.mode : 'server', hubMode: hub.mode, ...(local ? { dir: hub.dir } : {}), ...(local ? {} : { mcp: undefined }), publicUrl: cfg.publicUrl });
    }

    if (path === '/api/hub' && req.method === 'GET') return send(res, 200, hub.registry.describe());
    const hubOp = /^\/api\/hub\/([a-z0-9_]+)$/.exec(path);
    if (hubOp && req.method === 'POST') return sendData(res, await hub.call(p, hubOp[1], await readJson(req), { ip }));

    // Project routes, and the legacy shortcuts to the default project.
    const m = /^\/api\/projects\/([^/]+)(\/.*)$/.exec(path);
    const projectId = m ? decodeURIComponent(m[1]) : DEFAULT_PROJECT;
    const rest = m ? m[2] : path.replace(/^\/api/, '');

    if (rest === '/ops' && req.method === 'GET') {
      const { project } = hub.projectFor(p, projectId);
      return send(res, 200, hub.engine(project.id).registry.describe());
    }

    const op = /^\/ops\/([a-z0-9_]+)$/.exec(rest);
    if (op && req.method === 'POST') return sendData(res, await hub.callProject(p, projectId, op[1], await readJson(req)));

    if (rest === '/events' && req.method === 'GET') return events(req, res, p, projectId);

    if (rest === '/files' && req.method === 'POST') {
      const { project, role } = hub.projectFor(p, projectId);
      if (!roleAtLeast(role, 'editor')) throw new KalibraError('forbidden', 'Uploading files needs the editor role in this project');
      const data = await readBody(req, 2 * 1024 * 1024 * 1024);
      let name: string | undefined;
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')) || undefined;
      } catch {
        throw new KalibraError('invalid', 'Bad x-file-name header');
      }
      const type = String(req.headers['content-type'] ?? '');
      return sendData(res, await hub.engine(project.id).blobs.put(data, { name, mime: type && type !== 'application/octet-stream' ? type : undefined }));
    }

    const file = /^\/files\/([a-f0-9]{64})$/.exec(rest);
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      const { project } = hub.projectFor(p, projectId);
      return serveBlob(hub.engine(project.id), req, res, file[1], url);
    }

    fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
  }

  /** Live events of one project, for as long as the caller may see it. */
  function events(req: IncomingMessage, res: ServerResponse, p: Principal, projectId: string) {
    const { project } = hub.projectFor(p, projectId);
    const engine = hub.engine(project.id);
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const unsubscribe = engine.events.subscribe((e: EngineEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const stillAllowed = () => {
      try {
        if (p.sessionId && !hub.accounts.resolveSession(cookieValue(req) ?? '')) return false;
        if (p.tokenId && !hub.accounts.resolveToken(/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '')) return false;
        hub.projectFor(hub.mode === 'local' ? p : { ...p, user: hub.accounts.get(p.user.id) }, project.id);
        return true;
      } catch {
        return false;
      }
    };
    const ping = setInterval(() => (stillAllowed() ? res.write(': ping\n\n') : res.end()), RECHECK_MS);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  const cookieValue = (req: IncomingMessage) => cookie(req, sessionCookieName(true)) ?? cookie(req, sessionCookieName(false));

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolveListen());
  });
  port = (server.address() as any).port;

  return {
    url: `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`,
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
