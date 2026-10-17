import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { BASE_PATH, DEFAULT_PROJECT, KalibraError, publicOrigin, roleAtLeast, type EngineEvent, type Hub, type Principal } from '@kalibra/core';
import { authenticate, checkLocalOrigin, clientIp, cookie, isSecure, LOCAL_COOKIE, originAllowed, ownOrigin, RateLimiter, readSessionCookie, sessionCookieName, type AuthConfig } from './auth.js';
import { BASE_HEADERS, fail, readBody, readJson, send, sendData, sendError, serveBlob, serveStatic } from './http.js';
import { ingestRoutes, isIngestRoute } from './ingest.js';

/*
 * The HTTP API. `npx kalibra` (`kalibra serve`) runs it on 127.0.0.1 with a per-launch token
 * (local mode); a team server runs the same API with sign-in (server mode). Everything is an
 * operation, and every call goes through the hub, which decides access.
 *
 * Every address starts with BASE_PATH (/kalibra), so a load balancer can route on the path: the UI
 * is /kalibra/, and the routes below are /kalibra/api/…. "/" redirects to /kalibra/; anything else
 * outside /kalibra is 404. Routes are written here without the prefix:
 *
 *   GET  /api/health                         liveness (no auth)
 *   GET  /api/auth/status                    mode, whether setup is needed, who is signed in (no auth)
 *   POST /api/auth/setup | login | logout    first administrator, sign in, sign out (server mode)
 *   GET  /api/auth/sso/:provider/start       sign in with a provider (redirects there)
 *   GET  /api/auth/sso/:provider/callback    the provider sends the browser back here
 *   GET  /api/meta                           version, how to start the MCP bridge
 *   GET  /api/hub                            hub operations (+ JSON Schemas)
 *   POST /api/hub/:op                        your account, projects, members, administration
 *   GET  /api/projects/:p/ops                project operations (+ JSON Schemas and needed roles)
 *   POST /api/projects/:p/ops/:op            call one
 *   GET  /api/projects/:p/events             live change events (SSE)
 *   POST /api/projects/:p/files              upload a file (raw body) → blob info
 *   GET  /api/projects/:p/files/:hash        download / stream a file (Range supported)
 *   POST /api/projects/:p/ingest/traces      traces from your app (SDK); also otlp/v1/traces,
 *   GET|POST /api/projects/:p/ingest/tools   tool recordings, and proxy/openai/* (see ingest.ts)
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
  meta?: { mcp?: { command: string; args: string[]; env?: Record<string, string> }; version?: string; mode?: 'cli' | 'dev' | 'server' };
}

export interface RunningServer {
  url: string;
  port: number;
  token?: string;
  close(): Promise<void>;
}

export const newToken = () => randomBytes(32).toString('base64url');

function redirect(res: ServerResponse, location: string, cookies: string[] = []) {
  res.writeHead(302, { ...BASE_HEADERS, location, 'cache-control': 'no-store', ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  res.end();
}

/** Failed sign-in attempts per IP address in 10 minutes (each account also locks after repeated wrong passwords). */
const LOGIN_LIMIT = 20;
/** Largest file upload. */
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
/** How often live event streams re-check that the caller may still see the project. */
const RECHECK_MS = 30_000;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { hub } = opts;
  const host = opts.host ?? '127.0.0.1';
  let port = 0;
  const cfg: AuthConfig = { hub, token: opts.token, allowedOrigins: opts.allowedOrigins ?? [], publicUrl: publicOrigin(opts.publicUrl), trustProxy: !!opts.trustProxy };
  const logins = new RateLimiter(LOGIN_LIMIT, 10 * 60_000);
  const ingest = ingestRoutes(hub, cfg);

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

    // Everything lives under BASE_PATH; past this point paths are written without it.
    if (url.pathname === '/' || url.pathname === BASE_PATH) return redirect(res, `${BASE_PATH}/${url.search}`);
    if (!url.pathname.startsWith(`${BASE_PATH}/`)) return fail(res, 404, 'not_found', `Kalibra lives under ${BASE_PATH}/ (the API under ${BASE_PATH}/api/)`);
    url.pathname = url.pathname.slice(BASE_PATH.length);

    // `kalibra serve` opens /kalibra/?token=… once; we turn it into an HttpOnly cookie for the UI.
    if (hub.mode === 'local' && opts.token && url.searchParams.get('token') === opts.token && !url.pathname.startsWith('/api/')) {
      res.writeHead(302, { ...BASE_HEADERS, 'set-cookie': `${LOCAL_COOKIE}=${opts.token}; HttpOnly; SameSite=Strict; Path=${BASE_PATH}`, location: `${BASE_PATH}${url.pathname}` });
      return res.end();
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(opts.staticDir, req, res, url);
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'kalibra' });
    if (url.pathname.startsWith('/api/auth/')) return authRoutes(req, res, url);
    // Apps sending traces authenticate with an ingest key (or a normal sign-in): see ingest.ts.
    if (isIngestRoute(url.pathname)) return ingest(req, res, url);

    const auth = await authenticate(req, cfg);
    if (!auth.ok) return fail(res, auth.status, auth.code, auth.message);
    const p = auth.principal;
    // A browser session must not write with another site's help (CSRF): writes need our Origin.
    if ((auth.via === 'session' || auth.via === 'proxy') && req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.origin) {
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
    // "__Host-" cookies must have Path=/; the plain one stays inside Kalibra's path.
    return `${sessionCookieName(secure)}=${value}; HttpOnly; SameSite=Lax; Path=${secure ? '/' : BASE_PATH}; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  async function newSession(req: IncomingMessage, userId: string) {
    const days = (await hub.settings()).sessionDays;
    const s = await hub.accounts.createSession(userId, { days, ip: clientIp(req, cfg.trustProxy), userAgent: String(req.headers['user-agent'] ?? '') });
    return { ...s, cookie: sessionCookie(req, s.secret, days * 86_400) };
  }

  async function startSession(req: IncomingMessage, res: ServerResponse, userId: string) {
    const s = await newSession(req, userId);
    const me = await hub.call({ user: await hub.accounts.get(userId), via: 'user', sessionId: s.id }, 'get_me', {});
    sendData(res, me, { 'set-cookie': s.cookie });
  }

  /** Where providers send the browser back to. */
  const base = (req: IncomingMessage) => cfg.publicUrl ?? ownOrigin(req, cfg) ?? '';
  // Binds a sign-in to the browser that started it. "__Host-" over HTTPS (needs Path=/), so a
  // sibling subdomain cannot plant its own binding and finish an attacker's sign-in in your browser.
  const ssoCookieName = (req: IncomingMessage) => (isSecure(req, cfg) ? '__Host-kalibra_sso' : 'kalibra_sso');
  const ssoCookie = (req: IncomingMessage, value: string, maxAge: number) =>
    isSecure(req, cfg)
      ? `${ssoCookieName(req)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}; Secure`
      : `${ssoCookieName(req)}=${value}; HttpOnly; SameSite=Lax; Path=${BASE_PATH}/api/auth/sso; Max-Age=${maxAge}`;
  /*
   * Why a sign-in failed travels in a short-lived cookie set by us, not in the URL: a link anyone
   * can craft (/login?error=…) must not be able to put text on our sign-in page.
   */
  const FLASH = 'kalibra_login_error';
  const flash = (req: IncomingMessage, message: string, maxAge = 120) =>
    `${FLASH}=${encodeURIComponent(message.slice(0, 300))}; HttpOnly; SameSite=Lax; Path=${BASE_PATH}/api/auth; Max-Age=${maxAge}${isSecure(req, cfg) ? '; Secure' : ''}`;

  /** Sign-in through a provider: start (redirect out) and callback (redirect back in). */
  async function ssoRoutes(req: IncomingMessage, res: ServerResponse, url: URL, providerId: string, step: string) {
    const ip = clientIp(req, cfg.trustProxy);
    const callback = `${base(req)}${BASE_PATH}/api/auth/sso/${encodeURIComponent(providerId)}/callback`;
    try {
      if (step === 'start') {
        const { url: to, binding } = await hub.sso.start(providerId, { redirectUri: callback, next: url.searchParams.get('next') ?? undefined });
        return redirect(res, to, [ssoCookie(req, binding, 600)]);
      }
      if (logins.blocked(ip)) throw new KalibraError('forbidden', 'Too many sign-in attempts. Wait a few minutes.');
      try {
        const { user, next } = await hub.sso.finish(providerId, { callbackUrl: `${base(req)}${BASE_PATH}${url.pathname}${url.search}`, binding: cookie(req, ssoCookieName(req)), ip });
        const s = await newSession(req, user.id);
        // `next` is an app path (safeNext), so the browser always lands inside Kalibra.
        return redirect(res, `${BASE_PATH}${next}`, [s.cookie, ssoCookie(req, '', 0)]);
      } catch (e) {
        logins.fail(ip);
        throw e;
      }
    } catch (e: any) {
      return redirect(res, `${BASE_PATH}/login`, [ssoCookie(req, '', 0), flash(req, e?.message ?? String(e))]);
    }
  }

  async function authRoutes(req: IncomingMessage, res: ServerResponse, url: URL) {
    const ip = clientIp(req, cfg.trustProxy);
    const path = url.pathname;

    if (path === '/api/auth/status' && req.method === 'GET') {
      const auth = await authenticate(req, cfg);
      const server = hub.mode === 'server';
      const flashed = cookie(req, FLASH);
      const error = flashed ?? (!auth.ok && auth.status === 403 ? auth.message : undefined);
      return sendData(
        res,
        {
          mode: hub.mode,
          setupRequired: await hub.needsSetup(),
          user: auth.ok ? auth.principal.user : null,
          providers: server ? (await hub.providers.enabled()).map((p) => ({ id: p.id, name: p.name, kind: p.kind })) : [],
          passwordLogin: server ? (await hub.settings()).passwordLogin : true,
          ...(error ? { error } : {}),
        },
        flashed !== undefined ? { 'set-cookie': flash(req, '', 0) } : {},
      );
    }

    const sso = /^\/api\/auth\/sso\/([a-z0-9-]+)\/(start|callback)$/.exec(path);
    if (sso && req.method === 'GET') {
      if (hub.mode === 'local') return redirect(res, `${BASE_PATH}/`);
      return ssoRoutes(req, res, url, sso[1], sso[2]);
    }

    if (req.method !== 'POST') return fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
    if (hub.mode === 'local') return fail(res, 400, 'invalid', 'This Kalibra runs on your computer without sign-in');
    if (!req.headers.origin) return fail(res, 403, 'forbidden', 'Missing Origin header');

    if (path === '/api/auth/logout') {
      const auth = await authenticate(req, cfg);
      if (auth.ok && auth.principal.sessionId) await hub.accounts.revokeSession(auth.principal.sessionId);
      return sendData(res, { signedOut: true }, { 'set-cookie': sessionCookie(req, '', 0) });
    }

    const body = await readJson(req, 64 * 1024);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    if (path === '/api/auth/setup') {
      if (logins.blocked(ip)) return fail(res, 429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
      const user = await hub.completeSetup(str(body.code), { username: str(body.username), password: str(body.password), name: str(body.name), email: str(body.email) }, ip).catch((e) => {
        if (e?.code === 'forbidden') logins.fail(ip);
        throw e;
      });
      return startSession(req, res, user.id);
    }

    if (path === '/api/auth/login') {
      const username = str(body.username).trim();
      if (logins.blocked(ip)) {
        await hub.audit({ kind: 'anonymous', id: username }, 'login.rate_limited', username, {}, ip);
        return fail(res, 429, 'rate_limited', 'Too many sign-in attempts. Wait a few minutes.');
      }
      try {
        const user = await hub.accounts.authenticate(username, str(body.password));
        // With password sign-in off, administrators keep it so a broken provider never locks everyone out.
        if (!(await hub.settings()).passwordLogin && user.role !== 'admin') {
          const names = (await hub.providers.enabled()).map((x) => x.name).join(' or ');
          throw new KalibraError('forbidden', `Password sign-in is turned off on this server${names ? `. Sign in with ${names}.` : '.'}`);
        }
        await hub.audit({ kind: 'user', id: user.id, name: user.name }, 'login', user.username, {}, ip);
        return startSession(req, res, user.id);
      } catch (e) {
        logins.fail(ip);
        await hub.audit({ kind: 'anonymous', id: username }, 'login.failed', username, {}, ip);
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
    let projectId = DEFAULT_PROJECT;
    try {
      if (m) projectId = decodeURIComponent(m[1]);
    } catch {
      throw new KalibraError('invalid', 'Bad project in the address');
    }
    const rest = m ? m[2] : path.replace(/^\/api/, '');

    if (rest === '/ops' && req.method === 'GET') {
      const { project } = await hub.projectFor(p, projectId);
      return send(res, 200, (await hub.engine(project.id)).registry.describe());
    }

    const op = /^\/ops\/([a-z0-9_]+)$/.exec(rest);
    if (op && req.method === 'POST') return sendData(res, await hub.callProject(p, projectId, op[1], await readJson(req)));

    if (rest === '/events' && req.method === 'GET') return await events(req, res, p, projectId);

    if (rest === '/files' && req.method === 'POST') {
      const { project, role } = await hub.projectFor(p, projectId);
      if (!roleAtLeast(role, 'editor')) throw new KalibraError('forbidden', 'Uploading files needs the editor role in this project');
      let name: string | undefined;
      try {
        name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')) || undefined;
      } catch {
        throw new KalibraError('invalid', 'Bad x-file-name header');
      }
      const type = String(req.headers['content-type'] ?? '');
      const meta = { name, mime: type && type !== 'application/octet-stream' ? type : undefined };
      const blobs = (await hub.engine(project.id)).blobs;
      // Streamed to disk while hashing: a 2 GB upload must not need 2–4 GB of memory.
      if (blobs.putStream) return sendData(res, await blobs.putStream(req, meta, MAX_UPLOAD));
      return sendData(res, await blobs.put(await readBody(req, MAX_UPLOAD), meta));
    }

    const file = /^\/files\/([a-f0-9]{64})$/.exec(rest);
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      const { project } = await hub.projectFor(p, projectId);
      return await serveBlob(await hub.engine(project.id), req, res, file[1], url);
    }

    fail(res, 404, 'not_found', `No route ${req.method} ${path}`);
  }

  /** Live events of one project, for as long as the caller may see it. */
  async function events(req: IncomingMessage, res: ServerResponse, p: Principal, projectId: string) {
    const { project } = await hub.projectFor(p, projectId);
    const engine = await hub.engine(project.id);
    // The browser may have gone while the project opened: 'close' already fired, so don't subscribe.
    if (req.destroyed || res.destroyed || req.socket.destroyed) return;
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const unsubscribe = engine.events.subscribe((e: EngineEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const stillAllowed = async () => {
      try {
        if (p.sessionId && !(await hub.accounts.resolveSession(cookieValue(req) ?? ''))) return false;
        if (!p.sessionId && !p.tokenId && hub.mode === 'server' && (await hub.accounts.get(p.user.id)).disabled) return false;
        if (p.tokenId && !(await hub.accounts.resolveToken(/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''))) return false;
        await hub.projectFor(hub.mode === 'local' ? p : { ...p, user: await hub.accounts.get(p.user.id) }, project.id);
        return true;
      } catch {
        return false;
      }
    };
    const ping = setInterval(() => void stillAllowed().then((ok) => (ok ? res.write(': ping\n\n') : res.end()), () => res.end()), RECHECK_MS);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  const cookieValue = (req: IncomingMessage) => readSessionCookie(req, cfg);

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
