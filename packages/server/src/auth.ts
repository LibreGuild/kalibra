import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LocalCoordinator, TOKEN_PREFIX, type Coordinator, type Hub, type Principal } from '@kalibra/core';

/*
 * Who is calling, and may they call from where they are calling.
 *
 * Local mode (`npx kalibra`): the per-launch token (header or cookie) proves it is the person on
 * this computer. Host and Origin must be this machine, which blocks DNS rebinding and other sites.
 *
 * Server mode: a browser session cookie, or a personal access token in the Authorization header
 * (coding agents, the CLI, scripts). Cookie-authenticated writes must come from our own origin
 * (CSRF); the cookie is also SameSite=Lax, so other sites cannot send it with a POST.
 */

export const LOCAL_COOKIE = 'kalibra_token';
/** "__Host-" cookies must be Secure, host-only and Path=/, which stops subdomains from planting them. */
export const sessionCookieName = (secure: boolean) => (secure ? '__Host-kalibra_session' : 'kalibra_session');

export interface AuthConfig {
  hub: Hub;
  /** Local mode: required on every request. Unset only for trusted local development. */
  token?: string;
  /** Origins allowed besides our own (e.g. the Vite dev server). */
  allowedOrigins: string[];
  /** Server mode: the address people use, e.g. https://kalibra.example.com. */
  publicUrl?: string;
  /** Trust X-Forwarded-* headers from a reverse proxy in front of the server. */
  trustProxy: boolean;
}

/**
 * The session cookie of this request. Over HTTPS only the "__Host-" one counts: falling back to the
 * plain name would let a sibling subdomain plant its own session cookie (session fixation).
 */
export const readSessionCookie = (req: IncomingMessage, cfg: AuthConfig) => cookie(req, sessionCookieName(isSecure(req, cfg)));

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * The client's address. Behind a trusted proxy it is the last X-Forwarded-For entry: the one our
 * proxy appended. Earlier entries are whatever the client sent and must not be trusted.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop() : undefined;
  return forwarded || req.socket.remoteAddress || '';
}

/** Whether the browser reached us over HTTPS (directly or via a trusted proxy). */
export function isSecure(req: IncomingMessage, cfg: AuthConfig): boolean {
  if (cfg.publicUrl) return cfg.publicUrl.startsWith('https:');
  if (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https') return true;
  return !!(req.socket as any).encrypted;
}

/** The origin the browser sees for this server. */
export function ownOrigin(req: IncomingMessage, cfg: AuthConfig): string | undefined {
  if (cfg.publicUrl) return new URL(cfg.publicUrl).origin;
  const host = (cfg.trustProxy && (req.headers['x-forwarded-host'] as string)) || req.headers.host;
  return host ? `${isSecure(req, cfg) ? 'https' : 'http'}://${host}` : undefined;
}

/**
 * Local mode: Host must be this machine and Origin (when sent) must be ours. "null" (sandboxed
 * iframes, file:// pages) is refused because any website can produce it.
 */
export function checkLocalOrigin(req: IncomingMessage, port: number, cfg: AuthConfig): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...cfg.allowedOrigins.map((o) => new URL(o).host)]);
  if (!req.headers.host || !hosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return hosts.has(new URL(origin).host);
  } catch {
    return false;
  }
}

/** Server mode: a request's Origin, when present, must be ours (or an allowed one). */
export function originAllowed(req: IncomingMessage, cfg: AuthConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  return origin === ownOrigin(req, cfg) || cfg.allowedOrigins.includes(origin);
}

/** Agents and the CLI say who they are with this header; it can only narrow how a call is labelled. */
function viaHeader(req: IncomingMessage): { via?: 'agent' | 'cli'; client?: string; model?: string } {
  const raw = req.headers['x-kalibra-actor'];
  if (typeof raw !== 'string') return {};
  try {
    const a = JSON.parse(raw);
    if (a.kind !== 'agent' && a.kind !== 'cli') return {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 100) : undefined);
    return { via: a.kind, client: str(a.client) ?? (a.kind === 'agent' ? str(a.id) : undefined), model: str(a.model) };
  } catch {
    return {};
  }
}

const sameSecret = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export type AuthResult =
  | { ok: true; principal: Principal; via: 'local' | 'session' | 'token' | 'proxy' }
  | { ok: false; status: number; code: string; message: string };

/** Works out who is calling. Does not check what they may do; the hub does that per call. */
export async function authenticate(req: IncomingMessage, cfg: AuthConfig): Promise<AuthResult> {
  const { hub } = cfg;
  const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
  const tagged = viaHeader(req);

  if (hub.mode === 'local') {
    if (cfg.token) {
      const given = header || cookie(req, LOCAL_COOKIE) || '';
      if (!sameSecret(given, cfg.token)) return { ok: false, status: 401, code: 'unauthorized', message: 'Missing or invalid token' };
    }
    return { ok: true, principal: hub.localPrincipal(tagged.via ?? 'user', tagged.client, tagged.model), via: 'local' };
  }

  if (header) {
    const found = header.startsWith(TOKEN_PREFIX) ? await hub.accounts.resolveToken(header) : undefined;
    if (!found) return { ok: false, status: 401, code: 'unauthorized', message: 'Invalid or expired access token' };
    return { ok: true, principal: { user: found.user, via: tagged.via ?? 'cli', client: tagged.client, model: tagged.model, tokenId: found.tokenId }, via: 'token' };
  }

  const secret = readSessionCookie(req, cfg);
  const session = secret ? await hub.accounts.resolveSession(secret) : undefined;
  if (session) return { ok: true, principal: { user: session.user, via: 'user', sessionId: session.sessionId }, via: 'session' };

  // Behind a login gateway, every request carries the signed-in user.
  try {
    const user = await hub.sso.fromProxy(req.headers, { peer: req.socket.remoteAddress ?? '', ip: clientIp(req, cfg.trustProxy) });
    if (user) return { ok: true, principal: { user, via: 'user' }, via: 'proxy' };
  } catch (e: any) {
    return { ok: false, status: 403, code: 'forbidden', message: e?.message ?? String(e) };
  }
  return { ok: false, status: 401, code: 'unauthorized', message: 'Sign in to continue' };
}

/**
 * Counts failures per key in a sliding window (failed sign-ins per IP). Only failures count, so an
 * office signing in from one shared address is never blocked by its own successful sign-ins. Kept
 * on the coordinator, so several instances share the count (in memory for one instance: a restart
 * resets it, and account lockout still applies per user).
 */
export class RateLimiter {
  constructor(
    private max: number,
    private windowMs: number,
    private store: Coordinator = new LocalCoordinator(),
    private name = 'logins',
  ) {}

  private key(key: string) {
    return `rl:${this.name}:${key}`;
  }

  /** Whether the key has failed too often recently. An unreachable store blocks nobody. */
  async blocked(key: string): Promise<boolean> {
    try {
      return (await this.store.windowCount(this.key(key), this.windowMs)) >= this.max;
    } catch (e: any) {
      console.error(`Sign-in limits unavailable: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Records a failure. */
  async fail(key: string) {
    try {
      await this.store.windowAdd(this.key(key), this.windowMs);
    } catch {
      /* see blocked() */
    }
  }
}
