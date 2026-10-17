import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BASE_PATH } from '../base-path.js';
import { KalibraError, mapSeq } from '../util.js';
import type { Hub } from './hub.js';
import { randomSecret } from './passwords.js';
import type { AuthProvider } from './providers.js';
import type { User } from './types.js';

/*
 * Signing in through a provider (OIDC, GitHub, a trusted proxy) and turning the provider's answer
 * into a Kalibra account.
 *
 * Browser flow (OIDC and GitHub):
 *   start()  → pending login (state, nonce, PKCE verifier) kept here for 10 minutes, bound to the
 *              browser by a cookie; redirect to the provider.
 *   finish() → the provider sends the browser back with a code; we check state and the cookie,
 *              exchange the code (server to provider), read who it is, and sign them in.
 *
 * The exchange is a server-to-provider call: the Kalibra server must be able to reach the provider
 * (e.g. an internal GitHub Enterprise is only usable when Kalibra runs inside that network).
 */

/** What a provider tells us about the person. */
export interface ExternalProfile {
  subject: string;
  email: string;
  /** Only verified emails are trusted for domain rules and for linking to invited accounts. */
  emailVerified: boolean;
  name: string;
  /** A username suggestion for new accounts (GitHub login, email local part…). */
  username: string;
  groups: string[];
}

interface Pending {
  provider: string;
  binding: string;
  verifier: string;
  nonce: string;
  next: string;
  redirectUri: string;
  expires: number;
}

const PENDING_MS = 10 * 60_000;
/** Sign-ins in progress kept at most; anyone can start one, so the oldest are dropped beyond this. */
export const MAX_PENDING = 2000;
/** Gateway sign-ins remembered at most. */
const MAX_CACHED = 5000;

export class SsoService {
  private pending = new Map<string, Pending>();
  private discovered = new Map<string, Promise<oidc.Configuration>>();
  private jwks = new Map<string, JWTVerifyGetKey>();
  /** Proxy sign-ins resolved recently (per assertion), so each request is not a database write. */
  private proxyCache = new Map<string, { user: User; until: number }>();

  constructor(private hub: Hub) {}

  // ── Browser flow ─────────────────────────────────────────────────────────

  /**
   * Starts a sign-in. Returns where to send the browser and a value for the binding cookie, which
   * finish() requires so that a sign-in started in one browser cannot be completed in another.
   */
  async start(providerId: string, opts: { redirectUri: string; next?: string }): Promise<{ url: string; binding: string }> {
    const p = await this.provider(providerId);
    if (p.kind === 'proxy') throw new KalibraError('invalid', `${p.name} signs you in automatically through the gateway`);
    this.prune();
    const state = oidc.randomState();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const nonce = oidc.randomNonce();
    const binding = randomSecret(24);
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(state, { provider: p.id, binding, verifier, nonce, next: safeNext(opts.next), redirectUri: opts.redirectUri, expires: Date.now() + PENDING_MS });

    if (p.kind === 'github') {
      const url = new URL(`${p.githubUrl.replace(/\/$/, '')}/login/oauth/authorize`);
      url.search = new URLSearchParams({ client_id: p.clientId, redirect_uri: opts.redirectUri, scope: 'read:user user:email read:org', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false' }).toString();
      return { url: url.toString(), binding };
    }
    const config = await this.config(p);
    const url = oidc.buildAuthorizationUrl(config, { redirect_uri: opts.redirectUri, scope: p.scopes, state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
    return { url: url.toString(), binding };
  }

  /** Completes a sign-in from the provider's redirect. Returns the account and where to go next. */
  async finish(providerId: string, opts: { callbackUrl: string; binding?: string; ip?: string }): Promise<{ user: User; next: string }> {
    const p = await this.provider(providerId);
    const url = new URL(opts.callbackUrl);
    const providerError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    const state = url.searchParams.get('state') ?? '';
    const pending = this.pending.get(state);
    this.pending.delete(state);
    // Check the sign-in is ours before showing anything from the URL: otherwise anyone could send a
    // link that makes the login page display their text.
    if (!pending || pending.provider !== p.id || pending.expires < Date.now()) throw new KalibraError('forbidden', 'This sign-in link expired or was already used. Try again.');
    if (!opts.binding || opts.binding !== pending.binding) throw new KalibraError('forbidden', 'This sign-in was started in another browser. Try again here.');
    if (providerError) throw new KalibraError('forbidden', `${p.name} did not sign you in: ${providerError.slice(0, 200)}`);

    const profile = p.kind === 'github' ? await this.githubProfile(p, url, pending) : await this.oidcProfile(p, url, pending, state);
    const user = await this.admit(p, profile, opts.ip ?? '');
    return { user, next: pending.next };
  }

  private async oidcProfile(p: AuthProvider, url: URL, pending: Pending, state: string): Promise<ExternalProfile> {
    const config = await this.config(p);
    // The callback URL must be the redirect URI we registered (the request may arrive through a proxy).
    const current = new URL(pending.redirectUri);
    current.search = url.search;
    const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: pending.verifier, expectedState: state, expectedNonce: pending.nonce, idTokenExpected: true });
    const claims: Record<string, any> = { ...(tokens.claims() ?? {}) };
    // Some providers put email or groups only in userinfo.
    if ((!claims.email || (p.groupsClaim && !claims[p.groupsClaim])) && tokens.access_token) {
      try {
        Object.assign(claims, { ...(await oidc.fetchUserInfo(config, tokens.access_token, claims.sub)), ...claims });
      } catch {
        /* userinfo is optional */
      }
    }
    const email = String(claims.email ?? '');
    const groupsRaw = p.groupsClaim ? claims[p.groupsClaim] : undefined;
    return {
      subject: String(claims.sub),
      email,
      // Some providers omit email_verified for managed accounts; only an explicit true counts.
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: String(claims.name ?? claims.preferred_username ?? email ?? ''),
      username: String(claims.preferred_username ?? email.split('@')[0] ?? ''),
      groups: Array.isArray(groupsRaw) ? groupsRaw.map(String) : typeof groupsRaw === 'string' ? groupsRaw.split(',').map((g) => g.trim()) : [],
    };
  }

  private async githubProfile(p: AuthProvider, url: URL, pending: Pending): Promise<ExternalProfile> {
    const base = p.githubUrl.replace(/\/$/, '');
    const api = base === 'https://github.com' ? 'https://api.github.com' : `${base}/api/v3`;
    const res = await fetch(`${base}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: p.clientId, client_secret: await this.hub.providers.clientSecret(p.id), code: url.searchParams.get('code'), redirect_uri: pending.redirectUri, code_verifier: pending.verifier }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new KalibraError('unavailable', `Could not reach ${base} (${e?.message ?? e}). The Kalibra server must be able to reach GitHub.`);
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new KalibraError('forbidden', `GitHub refused the sign-in: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
    const gh = async (path: string) => {
      const r = await fetch(`${api}${path}`, { headers: { authorization: `Bearer ${body.access_token}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new KalibraError('forbidden', `GitHub API ${path}: HTTP ${r.status}`);
      return r.json() as Promise<any>;
    };
    const user = await gh('/user');
    const emails: any[] = await gh('/user/emails').catch(() => []);
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    const orgs: any[] = await gh('/user/orgs').catch(() => []);
    const teams: any[] = await gh('/user/teams').catch(() => []);
    return {
      subject: String(user.id),
      email: primary?.email ?? '',
      emailVerified: !!primary,
      name: user.name || user.login,
      username: user.login,
      groups: [...orgs.map((o) => String(o.login)), ...teams.map((t) => `${t.organization?.login}/${t.slug}`)],
    };
  }

  // ── Trusted proxy ────────────────────────────────────────────────────────

  /**
   * Signs in a request that came through a login gateway. Undefined when no proxy provider is
   * enabled or the request does not carry its headers (then other sign-in methods apply).
   * `peer` is the address that connected to us (the gateway itself), never a forwarded-for value,
   * which the client can write; `ip` is only recorded.
   */
  async fromProxy(headers: Record<string, string | string[] | undefined>, conn: { peer: string; ip?: string }): Promise<User | undefined> {
    const ip = conn.ip ?? conn.peer;
    this.pruneProxyCache();
    for (const p of (await this.hub.providers.enabled()).filter((x) => x.kind === 'proxy')) {
      const header = (name: string) => {
        const v = headers[name.toLowerCase()];
        return (Array.isArray(v) ? v[0] : v) ?? '';
      };
      let profile: ExternalProfile | undefined;
      if (p.jwtHeader) {
        const token = header(p.jwtHeader);
        if (!token) continue;
        const key = `${p.id}:${hash(token)}`;
        const cached = await this.cachedProxyUser(key);
        if (cached) return cached;
        const { payload } = await jwtVerify(token, this.jwksFor(p.jwksUrl), { audience: p.jwtAudience, ...(p.jwtIssuer ? { issuer: p.jwtIssuer } : {}) }).catch((e) => {
          throw new KalibraError('forbidden', `The login gateway's token was refused: ${e?.code ?? e?.message ?? e}`);
        });
        const email = String(payload.email ?? '');
        profile = { subject: String(payload.sub ?? email), email, emailVerified: !!email, name: String(payload.name ?? email), username: email.split('@')[0], groups: toList(payload.groups) };
        const user = await this.admit(p, profile, ip);
        this.proxyCache.set(key, { user, until: Math.min(Date.now() + 60_000, Number(payload.exp ?? 0) * 1000 || Infinity) });
        return user;
      }
      const email = header(p.emailHeader).trim();
      if (!email) continue;
      if (!inList(conn.peer, p.trustedProxies)) throw new KalibraError('forbidden', `Sign-in headers from ${conn.peer || 'an unknown address'} are not trusted`);
      const key = `${p.id}:${hash([email, header(p.nameHeader), header(p.groupsHeader)].join('\n'))}`;
      const cached = await this.cachedProxyUser(key);
      if (cached) return cached;
      profile = { subject: email.toLowerCase(), email, emailVerified: true, name: header(p.nameHeader) || email, username: email.split('@')[0], groups: toList(header(p.groupsHeader)) };
      const user = await this.admit(p, profile, ip);
      this.proxyCache.set(key, { user, until: Date.now() + 60_000 });
      return user;
    }
    return undefined;
  }

  /** A recently admitted gateway user, re-read so a disabled account or a role change applies at once. */
  private async cachedProxyUser(key: string): Promise<User | undefined> {
    const cached = this.proxyCache.get(key);
    if (!cached || cached.until <= Date.now()) return undefined;
    const user = await this.hub.accounts.get(cached.user.id);
    if (user.disabled) {
      this.proxyCache.delete(key);
      throw new KalibraError('forbidden', 'This account is disabled. Ask an administrator.');
    }
    return user;
  }

  private pruneProxyCache() {
    if (this.proxyCache.size < MAX_CACHED) return;
    const now = Date.now();
    for (const [k, v] of this.proxyCache) if (v.until <= now) this.proxyCache.delete(k);
    // Still full of live entries: start over rather than grow without bound.
    if (this.proxyCache.size >= MAX_CACHED) this.proxyCache.clear();
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  /**
   * Who gets in, and as which account:
   *   1. the provider's rules (email domains, groups / GitHub organisations) must pass;
   *   2. an account already linked to this provider identity signs in;
   *   3. else an account with the same verified email is linked (that is how invitations work);
   *   4. else a new account is created if the provider allows it; otherwise "ask to be invited".
   * Members of the provider's admin groups become administrators; groups can be mirrored.
   */
  async admit(p: AuthProvider, profile: ExternalProfile, ip: string): Promise<User> {
    const { hub } = this;
    const who = profile.email || profile.username || profile.subject;
    const refuse = async (message: string, reason: string) => {
      await hub.audit({ kind: 'anonymous', id: who }, 'login.refused', who, { provider: p.id, reason }, ip);
      return new KalibraError('forbidden', message);
    };
    const domain = profile.email.split('@')[1]?.toLowerCase() ?? '';
    if (p.allowedDomains.length && !(profile.emailVerified && p.allowedDomains.some((d) => d.toLowerCase() === domain))) {
      throw await refuse(`Sign-in with ${p.name} is limited to ${p.allowedDomains.join(', ')} addresses${profile.emailVerified ? '' : ' (and a verified email)'}.`, 'domain');
    }
    const groupsLower = profile.groups.map((g) => g.toLowerCase());
    const inAny = (names: string[]) => names.some((n) => groupsLower.includes(n.toLowerCase()));
    if (p.kind === 'github' && p.allowedOrgs.length && !inAny(p.allowedOrgs)) throw await refuse(`Sign-in with ${p.name} is limited to members of ${p.allowedOrgs.join(', ')}.`, 'org');
    if (p.allowedGroups.length && !inAny(p.allowedGroups)) throw await refuse(`Your ${p.name} account is not in a group that may use Kalibra. Ask an administrator.`, 'group');

    const subject = identityKey(p, profile.subject);
    let user = await hub.accounts.byIdentity(p.id, subject);
    if (user?.disabled) throw await refuse('This account is disabled. Ask an administrator.', 'disabled');
    if (!user && profile.emailVerified && profile.email) {
      const matches = (await hub.accounts.findAllByEmail(profile.email)).filter((u) => !u.disabled);
      // Several accounts share the email: linking would pick one at random.
      if (matches.length > 1) throw await refuse(`More than one Kalibra account uses ${profile.email}. Ask an administrator to sort it out.`, 'ambiguous email');
      const invited = matches[0];
      // The account already belongs to another identity at this same provider (e.g. an email
      // address given to a new person): don't hand it over.
      const sameIssuer = identityKey(p, '');
      if (invited && (await hub.accounts.identities(invited.id, true)).some((i) => i.provider === p.id && i.subject.startsWith(sameIssuer) && i.subject !== subject)) {
        throw await refuse(`${profile.email} is linked to another ${p.name} account. Ask an administrator.`, 'email taken');
      }
      if (invited) user = invited;
    }
    if (!user) {
      if (!p.autoCreate) throw await refuse(`There is no Kalibra account for ${who}. Ask an administrator to add you (with this email).`, 'not invited');
      user = await hub.accounts.create({ username: await hub.accounts.freeUsername(profile.username || who), name: profile.name || who, email: profile.emailVerified ? profile.email : '', role: 'user' }, `provider:${p.id}`);
      await hub.audit({ kind: 'system', id: p.id }, 'user.created', user.username, { provider: p.id, from: 'sign-in' }, ip);
    }
    await hub.accounts.linkIdentity(p.id, subject, user.id, profile.email, { name: profile.name, username: profile.username, groups: profile.groups });
    if (p.adminGroups.length && inAny(p.adminGroups) && user.role !== 'admin') {
      user = await hub.accounts.update(user.id, { role: 'admin' });
      await hub.audit({ kind: 'system', id: p.id }, 'user.updated', user.username, { role: 'admin', from: `${p.name} admin group` }, ip);
    }
    if (p.syncGroups) {
      const ids = await mapSeq(profile.groups, async (g) => (await hub.projects.ensureExternalGroup(p.id, g)).id);
      await hub.projects.syncUserGroups(user.id, p.id, ids);
    }
    await hub.accounts.markLogin(user.id);
    await hub.audit({ kind: 'user', id: user.id, name: user.name }, 'login', user.username, { provider: p.id }, ip);
    return await hub.accounts.get(user.id);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async provider(id: string): Promise<AuthProvider> {
    const p = await this.hub.providers.get(id);
    if (!p.enabled) throw new KalibraError('forbidden', `${p.name} sign-in is turned off`);
    return p;
  }

  /** OIDC discovery, cached per provider settings (retried after a failure). */
  private async config(p: AuthProvider): Promise<oidc.Configuration> {
    const secret = await this.hub.providers.clientSecret(p.id);
    const key = JSON.stringify([p.id, p.issuer, p.clientId, hash(secret ?? '')]);
    let found = this.discovered.get(key);
    if (!found) {
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(p.issuer).hostname);
      found = oidc.discovery(new URL(p.issuer), p.clientId, secret, undefined, local ? { execute: [oidc.allowInsecureRequests] } : undefined).catch((e) => {
        this.discovered.delete(key);
        throw new KalibraError('unavailable', `Could not reach ${p.name} at ${p.issuer} (${e?.message ?? e}). The Kalibra server must be able to reach it.`);
      });
      this.discovered.set(key, found);
    }
    return found;
  }

  private jwksFor(url: string) {
    let set = this.jwks.get(url);
    if (!set) {
      set = createRemoteJWKSet(new URL(url));
      this.jwks.set(url, set);
    }
    return set;
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    for (const [k, v] of this.proxyCache) if (v.until < now) this.proxyCache.delete(k);
  }
}

/**
 * Only app paths are allowed as the page to return to (no open redirects). The result is a path
 * inside the app ("/p/x/runs"); the server puts BASE_PATH in front, so it can never leave Kalibra.
 * A path that already starts with BASE_PATH is accepted too.
 */
export function safeNext(next?: string): string {
  // Browsers drop tabs and newlines in URLs and read a backslash as "/", so "/<tab>/evil.example" would become "//evil.example".
  if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  if (next === BASE_PATH || next.startsWith(`${BASE_PATH}/`) || next.startsWith(`${BASE_PATH}?`) || next.startsWith(`${BASE_PATH}#`)) next = next.slice(BASE_PATH.length) || '/';
  if (!next.startsWith('/')) next = `/${next}`;
  if (next.startsWith('//') || next === '/api' || next.startsWith('/api/')) return '/';
  return next;
}

/**
 * The stored identity: the provider's subject scoped to the issuer it came from. Pointing a provider
 * at another server (e.g. github.com → GitHub Enterprise, both with numeric user ids) then cannot
 * sign someone into the account of whoever had the same id at the old server.
 */
export function identityKey(p: AuthProvider, subject: string): string {
  const issuer = p.kind === 'oidc' ? p.issuer : p.kind === 'github' ? p.githubUrl : p.jwtHeader ? p.jwksUrl : 'gateway';
  return `${issuer.replace(/\/+$/, '').toLowerCase()}#${subject}`;
}

const hash = (v: string) => createHash('sha256').update(v).digest('hex');

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Whether an address is in a list of IPs and CIDR ranges (IPv4 and IPv6; IPv4-mapped IPv6 handled). */
export function inList(ip: string, entries: string[]): boolean {
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const type = isIP(addr);
  if (!type) return false;
  const list = new BlockList();
  for (const e of entries) {
    const [base, bits] = e.split('/');
    const t = isIP(base);
    if (!t) continue;
    if (bits !== undefined) list.addSubnet(base, Number(bits), t === 4 ? 'ipv4' : 'ipv6');
    else list.addAddress(base, t === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(addr, type === 4 ? 'ipv4' : 'ipv6');
}

