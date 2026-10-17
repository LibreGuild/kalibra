import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hub, providersFromEnv } from '@kalibra/core';
import { inList, safeNext } from '../../core/src/hub/sso.js';
import { startServer, type RunningServer } from '../src/index.js';

/*
 * Sign-in through providers, end to end over HTTP, against small fake providers:
 * an OpenID Connect server, a GitHub (Enterprise) server, and a login gateway that signs JWTs.
 */

const PW = 'correct horse battery';

interface Person {
  sub: string;
  email: string;
  email_verified?: boolean;
  name: string;
  groups?: string[];
}

/** A tiny OIDC provider: discovery, authorize (signs `next` person in at once), token, JWKS, userinfo. */
async function fakeOidc() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { person: Person; nonce: string; challenge: string; clientId: string; redirect: string }>();
  const state = { person: undefined as Person | undefined, clientSecret: 'oidc-secret', issuer: '' };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, state.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        jwks_uri: `${state.issuer}/jwks`,
        userinfo_endpoint: `${state.issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = Math.random().toString(36).slice(2);
      codes.set(code, { person: state.person!, nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, clientId: url.searchParams.get('client_id')!, redirect: url.searchParams.get('redirect_uri')! });
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : undefined;
      const secret = body.get('client_secret') ?? basic?.[1];
      const c = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      if (!c || secret !== state.clientSecret) return json(400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== c.challenge || body.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'PKCE or redirect mismatch' });
      const idToken = await new SignJWT({ ...c.person, nonce: c.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(state.issuer)
        .setAudience(c.clientId)
        .setSubject(c.person.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return json(200, { access_token: `at-${c.person.sub}`, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === '/userinfo') return json(200, state.person);
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.issuer = `http://127.0.0.1:${(server.address() as any).port}`;
  return { state, privateKey, jwk, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A tiny GitHub Enterprise: authorize, access_token and the user APIs under /api/v3. */
async function fakeGithub() {
  const state = { user: { id: 4242, login: 'octo', name: 'Octo Cat' }, emails: [{ email: 'octo@corp.example', primary: true, verified: true }], orgs: ['evals'], teams: [{ organization: { login: 'evals' }, slug: 'speech' }], url: '' };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, state.url);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'gh-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/login/oauth/access_token') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      return body.code === 'gh-code' && body.client_secret === 'gh-secret' ? json({ access_token: 'gh-token', token_type: 'bearer' }) : json({ error: 'bad_verification_code' });
    }
    if (req.headers.authorization !== 'Bearer gh-token') return json({ message: 'Bad credentials' }, 401);
    if (url.pathname === '/api/v3/user') return json(state.user);
    if (url.pathname === '/api/v3/user/emails') return json(state.emails);
    if (url.pathname === '/api/v3/user/orgs') return json(state.orgs.map((login) => ({ login })));
    if (url.pathname === '/api/v3/user/teams') return json(state.teams);
    json({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('sign-in providers', () => {
  let dir: string;
  let hub: Hub;
  let srv: RunningServer;
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  let gh: Awaited<ReturnType<typeof fakeGithub>>;
  let jwks: Server;
  let jwksUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-sso-'));
    idp = await fakeOidc();
    gh = await fakeGithub();
    jwks = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [idp.jwk] }));
    });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()));
    jwksUrl = `http://127.0.0.1:${(jwks.address() as any).port}/jwks`;
    hub = new Hub({ dir, mode: 'server' });
    await hub.completeSetup(hub.setupCode()!, { username: 'admin', password: PW });
    srv = await startServer({ hub });
  });

  afterAll(async () => {
    await srv?.close();
    hub?.close();
    await idp?.close();
    await gh?.close();
    await new Promise<void>((r) => jwks.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs a whole browser sign-in: start → provider → callback. Returns where it ended and the session cookie. */
  async function signIn(providerId: string, next = '/projects', opts: { dropBinding?: boolean } = {}) {
    const start = await fetch(`${srv.url}/api/auth/sso/${providerId}/start?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const binding = start.headers.get('set-cookie')?.split(';')[0] ?? '';
    const atProvider = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const callback = atProvider.headers.get('location')!;
    const back = await fetch(callback, { redirect: 'manual', headers: opts.dropBinding ? {} : { cookie: binding } });
    const cookies = back.headers.getSetCookie?.() ?? [];
    const session = cookies.find((c) => c.startsWith('kalibra_session='))?.split(';')[0];
    const flash = cookies.find((c) => c.startsWith('kalibra_login_error='))?.split(';')[0];
    const error = flash ? ((await fetch(`${srv.url}/api/auth/status`, { headers: { cookie: flash } }).then((r) => r.json())).data.error as string) : undefined;
    return { location: back.headers.get('location') ?? '', session, callback, binding, error };
  }

  const me = async (cookie?: string) => (await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { origin: srv.url, cookie: cookie ?? '' } }).then((r) => r.json())).data;

  it('signs in with OIDC, invite-only by default, linking the invited account by verified email', async () => {
    await hub.providers.save({ name: 'Company SSO', kind: 'oidc', issuer: idp.state.issuer, clientId: 'kalibra', clientSecret: idp.state.clientSecret });
    idp.state.person = { sub: 'u-1', email: 'fran@corp.example', email_verified: true, name: 'Fran' };

    const refused = await signIn('company-sso');
    expect(refused.session).toBeUndefined();
    expect(refused.location).toBe('/login');
    expect(refused.error).toMatch(/^There is no Kalibra account for fran@corp\.example/);

    await hub.accounts.create({ username: 'fran', email: 'fran@corp.example', role: 'user' }, 'test');
    const ok = await signIn('company-sso', '/p/default/runs');
    expect(ok.location).toBe('/p/default/runs');
    const fran = await me(ok.session);
    expect(fran.user.username).toBe('fran');
    expect(fran.identities).toEqual([expect.objectContaining({ provider: 'company-sso', providerName: 'Company SSO', email: 'fran@corp.example' })]);
  });

  it('never links by an unverified email', async () => {
    idp.state.person = { sub: 'u-2', email: 'fran@corp.example', email_verified: false, name: 'Not Fran' };
    const r = await signIn('company-sso');
    expect(r.session).toBeUndefined();
  });

  it('creates accounts when allowed, enforces domains, promotes admin groups and mirrors groups', async () => {
    await hub.providers.save({ id: 'company-sso', autoCreate: true, allowedDomains: ['corp.example'], groupsClaim: 'groups', syncGroups: true, adminGroups: ['kalibra-admins'] });
    idp.state.person = { sub: 'u-3', email: 'gail@other.example', email_verified: true, name: 'Gail' };
    expect((await signIn('company-sso')).error).toMatch(/limited to corp\.example/);

    idp.state.person = { sub: 'u-4', email: 'hank@corp.example', email_verified: true, name: 'Hank', groups: ['speech-team', 'kalibra-admins'] };
    const r = await signIn('company-sso');
    const hank = await me(r.session);
    expect(hank.user).toMatchObject({ username: 'hank', name: 'Hank', role: 'admin', hasPassword: false });
    expect(hank.groups.map((g: any) => g.name).sort()).toEqual(['kalibra-admins', 'speech-team']);
  });

  it('refuses a callback without the browser binding, a reused state, and open redirects', async () => {
    idp.state.person = { sub: 'u-4', email: 'hank@corp.example', email_verified: true, name: 'Hank' };
    const noBinding = await signIn('company-sso', '/projects', { dropBinding: true });
    expect(noBinding.error).toMatch(/started in another browser/);

    const once = await signIn('company-sso');
    expect(once.session).toBeDefined();
    const replay = await fetch(once.callback, { redirect: 'manual', headers: { cookie: once.binding } });
    expect(replay.headers.get('location')).toBe('/login');

    expect(safeNext('//evil.example/x')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/api/hub/get_me')).toBe('/');
    expect(safeNext('/p/x/runs?tab=1')).toBe('/p/x/runs?tab=1');
    const evil = await signIn('company-sso', '//evil.example');
    expect(evil.location).toBe('/');
  });

  it('signs in with GitHub Enterprise, limited to organisations, with teams as groups', async () => {
    await hub.providers.save({ name: 'GitHub Enterprise', id: 'ghe', kind: 'github', githubUrl: gh.state.url, clientId: 'gh-client', clientSecret: 'gh-secret', allowedOrgs: ['evals'], autoCreate: true, syncGroups: true });
    const r = await signIn('ghe');
    const octo = await me(r.session);
    expect(octo.user).toMatchObject({ username: 'octo', email: 'octo@corp.example' });
    expect(octo.groups.map((g: any) => g.name)).toEqual(expect.arrayContaining(['evals', 'evals/speech']));

    gh.state.orgs = ['someone-else'];
    gh.state.teams = [];
    gh.state.user = { id: 777, login: 'stranger', name: 'Stranger' };
    expect((await signIn('ghe')).error).toMatch(/limited to members of evals/);
  });

  it('trusts gateway headers only from listed proxy addresses', async () => {
    await hub.providers.save({ name: 'Gateway', id: 'gate', kind: 'proxy', emailHeader: 'X-Forwarded-Email', nameHeader: 'X-Forwarded-User', trustedProxies: ['127.0.0.1', '::1'], autoCreate: true });
    const r = await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { origin: srv.url, 'x-forwarded-email': 'ivy@corp.example', 'x-forwarded-user': 'Ivy' } }).then((x) => x.json());
    expect(r.data.user).toMatchObject({ email: 'ivy@corp.example', name: 'Ivy' });
    expect(inList('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(inList('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(inList('192.168.1.1', ['10.0.0.0/8', '127.0.0.1'])).toBe(false);
    await hub.providers.save({ id: 'gate', trustedProxies: ['10.9.9.9'] });
    const untrusted = await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { origin: srv.url, 'x-forwarded-email': 'ivy@corp.example' } });
    expect(untrusted.status).toBe(403);
    await hub.providers.delete('gate');
  });

  it('accepts a gateway JWT only for the right audience', async () => {
    await hub.providers.save({ name: 'IAP', id: 'iap', kind: 'proxy', jwtHeader: 'X-Goog-IAP-JWT-Assertion', jwksUrl, jwtAudience: 'kalibra-app', autoCreate: true });
    const jwt = (aud: string) =>
      new SignJWT({ email: 'jo@corp.example' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setAudience(aud).setSubject('jo').setIssuedAt().setExpirationTime('5m').sign(idp.privateKey);
    const good = await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { origin: srv.url, 'x-goog-iap-jwt-assertion': await jwt('kalibra-app') } }).then((r) => r.json());
    expect(good.data.user.email).toBe('jo@corp.example');
    const bad = await fetch(`${srv.url}/api/hub/get_me`, { method: 'POST', headers: { origin: srv.url, 'x-goog-iap-jwt-assertion': await jwt('another-app') } });
    expect(bad.status).toBe(403);
    await hub.providers.delete('iap');
  });

  it('can turn password sign-in off for everyone but administrators', async () => {
    await hub.accounts.create({ username: 'kim', password: PW, role: 'user' }, 'test');
    hub.updateSettings({ passwordLogin: false });
    const login = (username: string) => fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { origin: srv.url, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PW }) });
    const kim = await login('kim');
    expect(kim.status).toBe(403);
    expect((await kim.json()).error.message).toMatch(/Password sign-in is turned off.*Company SSO/);
    expect((await login('admin')).status).toBe(200);
    const status = await fetch(`${srv.url}/api/auth/status`).then((r) => r.json());
    expect(status.data.passwordLogin).toBe(false);
    expect(status.data.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['company-sso', 'ghe']));
    hub.updateSettings({ passwordLogin: true });
  });

  it('keeps client secrets write-only and validates provider settings', async () => {
    const admin = { user: hub.accounts.find('admin')!, via: 'user' as const };
    const listed = await hub.call<any>(admin, 'list_auth_providers', {});
    expect(JSON.stringify(listed)).not.toContain(idp.state.clientSecret);
    expect(listed.providers.find((p: any) => p.id === 'company-sso')).toMatchObject({ hasClientSecret: true, callbackUrl: '/api/auth/sso/company-sso/callback' });
    await expect(hub.call(admin, 'save_auth_provider', { name: 'Bad', kind: 'oidc', issuer: 'http://insecure.example', clientId: 'x', clientSecret: 'y' })).rejects.toThrow(/https/);
    await expect(hub.call(admin, 'save_auth_provider', { name: 'Open proxy', kind: 'proxy', emailHeader: 'X-Email' })).rejects.toThrow(/proxy addresses/);
    await expect(hub.call(admin, 'save_auth_provider', { name: 'No secret', kind: 'oidc', issuer: 'https://idp.example', clientId: 'x' })).rejects.toThrow(/client secret/);
  });
});

describe('providers from the environment', () => {
  it('builds common providers and only auto-creates accounts when sign-in is restricted', () => {
    const out = providersFromEnv({
      KALIBRA_GOOGLE_CLIENT_ID: 'g', KALIBRA_GOOGLE_CLIENT_SECRET: 'gs',
      KALIBRA_GITHUB_CLIENT_ID: 'h', KALIBRA_GITHUB_CLIENT_SECRET: 'hs', KALIBRA_GITHUB_URL: 'https://github.sec.example.net/', KALIBRA_GITHUB_ORGS: 'evals, speech',
      KALIBRA_OIDC_ISSUER: 'https://sso.example.com', KALIBRA_OIDC_CLIENT_ID: 'o', KALIBRA_OIDC_CLIENT_SECRET: 'os', KALIBRA_OIDC_DOMAINS: 'example.com', KALIBRA_OIDC_NAME: 'Example SSO',
    });
    expect(out.map((p: any) => [p.config.id, p.config.autoCreate])).toEqual([['google', false], ['github', true], ['sso', true]]);
    expect((out[1].config as any).githubUrl).toBe('https://github.sec.example.net');
    expect((out[1].config as any).allowedOrgs).toEqual(['evals', 'speech']);
    expect(out[2]).toMatchObject({ config: { name: 'Example SSO', allowedDomains: ['example.com'] }, clientSecret: 'os' });
  });

  it('reads a config file with secrets from the environment or files', () => {
    const d = mkdtempSync(join(tmpdir(), 'kalibra-authcfg-'));
    writeFileSync(join(d, 'secret.txt'), 'from-file\n');
    writeFileSync(
      join(d, 'auth.json'),
      JSON.stringify({ providers: [
        { id: 'okta', name: 'Okta', kind: 'oidc', issuer: 'https://x.okta.com', clientId: 'c', clientSecret: 'env:OKTA_SECRET' },
        { id: 'kc', name: 'Keycloak', kind: 'oidc', issuer: 'https://kc.example/realms/x', clientId: 'c', clientSecret: `file:${join(d, 'secret.txt')}` },
      ] }),
    );
    const out = providersFromEnv({ KALIBRA_AUTH_CONFIG: join(d, 'auth.json'), OKTA_SECRET: 'from-env' });
    expect(out.map((p) => p.clientSecret)).toEqual(['from-env', 'from-file']);
    rmSync(d, { recursive: true, force: true });
    const hubDir = mkdtempSync(join(tmpdir(), 'kalibra-cfghub-'));
    const h = new Hub({ dir: hubDir, mode: 'server', authProviders: out });
    expect(h.providers.list().map((p) => [p.id, p.source])).toEqual([['kc', 'config'], ['okta', 'config']]);
    expect(() => new Hub({ dir: hubDir, mode: 'server', authProviders: [{ config: { id: 'x', name: 'X', kind: 'proxy', emailHeader: 'X-Email' } }] })).toThrow(/proxy addresses/);
    h.close();
    rmSync(hubDir, { recursive: true, force: true });
  });
});
