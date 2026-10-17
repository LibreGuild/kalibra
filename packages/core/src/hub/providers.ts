import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BASE_PATH } from '../base-path.js';
import type { Db } from '../db.js';
import type { SecretStore } from '../storage.js';
import { conflict, invalid, KalibraError, notFound, parseJson } from '../util.js';

/*
 * Sign-in providers: how people prove who they are on a team server, besides a password.
 *
 *   oidc    Any OpenID Connect provider: Google, Microsoft Entra, Okta, Auth0, Keycloak, GitLab,
 *           Dex, Authentik, most company SSO systems.
 *   github  github.com or a GitHub Enterprise Server (e.g. https://github.mycompany.com).
 *           GitHub is OAuth, not OIDC, so it has its own flow.
 *   proxy   A login gateway in front of Kalibra (Google IAP, Cloudflare Access, oauth2-proxy…)
 *           that passes the signed-in user in a header or a signed JWT.
 *
 * Providers come from two places:
 *   - configuration (environment variables or KALIBRA_AUTH_CONFIG): read-only in the app;
 *   - the app (Administration → Sign-in): stored in hub.db, client secrets in the hub secret store.
 *
 * Who gets in is decided per provider (see `admit` in sso.ts): allowed email domains, allowed
 * groups/organisations, and whether accounts are created automatically or must be invited first.
 */

const list = z.array(z.string().trim().min(1)).default([]);

export const AuthProviderConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(60).describe('Button label, e.g. "Google" or "Company SSO"'),
  kind: z.enum(['oidc', 'github', 'proxy']),
  enabled: z.boolean().default(true),

  // OIDC
  issuer: z.string().default('').describe('Issuer URL, e.g. https://accounts.google.com'),
  clientId: z.string().default(''),
  scopes: z.string().default('openid email profile'),
  groupsClaim: z.string().default('').describe('Claim that lists the user’s groups, e.g. "groups" (optional)'),

  // GitHub
  githubUrl: z.string().default('https://github.com').describe('https://github.com, or your GitHub Enterprise address'),
  allowedOrgs: list.describe('Only members of these organisations may sign in (optional)'),

  // Trusted proxy
  emailHeader: z.string().default('').describe('Header with the user’s email, e.g. X-Forwarded-Email'),
  nameHeader: z.string().default(''),
  groupsHeader: z.string().default('').describe('Header with comma-separated groups (optional)'),
  jwtHeader: z.string().default('').describe('Header with a signed JWT, e.g. X-Goog-IAP-JWT-Assertion or Cf-Access-Jwt-Assertion'),
  jwksUrl: z.string().default('').describe('Where the JWT signing keys are published'),
  jwtIssuer: z.string().default(''),
  jwtAudience: z.string().default(''),
  trustedProxies: list.describe('Proxy addresses allowed to set the headers (IPs or CIDR ranges). Required without a JWT.'),

  // Who gets in
  allowedDomains: list.describe('Only these email domains, e.g. example.com (optional)'),
  allowedGroups: list.describe('Only members of these groups (optional)'),
  autoCreate: z.boolean().default(false).describe('Create accounts on first sign-in. Off: an administrator adds people first (by email).'),
  adminGroups: list.describe('Members of these groups become administrators'),
  syncGroups: z.boolean().default(false).describe('Mirror the provider’s groups as Kalibra groups, so they can be added to projects'),
});
export type AuthProviderConfig = z.infer<typeof AuthProviderConfig>;

export interface AuthProvider extends AuthProviderConfig {
  source: 'app' | 'config';
}

/** A provider as administrators see it: everything but the secret. */
export interface ProviderView extends AuthProvider {
  hasClientSecret: boolean;
  callbackUrl: string;
}

/** Provider ids also used in URLs; these would clash with routes or mislead. */
const RESERVED = new Set(['password', 'local', 'setup', 'login', 'logout', 'status']);

const secretKey = (id: string) => `auth.${id}.client_secret`;

export class Providers {
  /** Providers from configuration, with their client secrets. */
  private fromConfig = new Map<string, { config: AuthProviderConfig; clientSecret?: string }>();

  constructor(
    private db: Db,
    private secrets: SecretStore,
    configured: { config: unknown; clientSecret?: string }[] = [],
  ) {
    for (const c of configured) {
      const parsed = AuthProviderConfig.safeParse(c.config);
      if (!parsed.success) throw new Error(`Sign-in provider configuration is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      validateProvider(parsed.data);
      this.fromConfig.set(parsed.data.id, { config: parsed.data, clientSecret: c.clientSecret });
    }
  }

  private async stored(): Promise<AuthProviderConfig[]> {
    const raw = parseJson<unknown[]>((await this.db.get("SELECT value FROM settings WHERE key = 'auth_providers'"))?.value, []);
    return raw.flatMap((r) => {
      const p = AuthProviderConfig.safeParse(r);
      return p.success ? [p.data] : [];
    });
  }

  private async saveStored(all: AuthProviderConfig[]) {
    return this.db.tx(async () => {
      await this.db.run("INSERT INTO settings (key, value) VALUES ('auth_providers', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(all));
    });
  }

  /** Every provider; configuration wins over the app for the same id. */
  async list(): Promise<AuthProvider[]> {
    const out = new Map<string, AuthProvider>();
    for (const p of await this.stored()) out.set(p.id, { ...p, source: 'app' });
    for (const { config } of this.fromConfig.values()) out.set(config.id, { ...config, source: 'config' });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async enabled(): Promise<AuthProvider[]> {
    return (await this.list()).filter((p) => p.enabled);
  }

  async get(id: string): Promise<AuthProvider> {
    const p = (await this.list()).find((x) => x.id === id);
    if (!p) throw notFound('Sign-in provider', id);
    return p;
  }

  async clientSecret(id: string): Promise<string | undefined> {
    const c = this.fromConfig.get(id);
    if (c) return c.clientSecret;
    return this.secrets.get(secretKey(id));
  }

  async view(p: AuthProvider, callbackBase: string): Promise<ProviderView> {
    return { ...p, hasClientSecret: !!(await this.clientSecret(p.id)), callbackUrl: `${callbackBase}${BASE_PATH}/api/auth/sso/${p.id}/callback` };
  }

  /** Creates or updates a provider made in the app. `clientSecret` replaces the stored one when given. */
  async save(input: Partial<AuthProviderConfig> & { id?: string; clientSecret?: string }): Promise<AuthProvider> {
    const { clientSecret, ...rest } = input;
    const all = await this.stored();
    const id = rest.id || slug(rest.name ?? '');
    if (this.fromConfig.has(id)) throw new KalibraError('conflict', `"${id}" is set in the server configuration and cannot be changed here`);
    const existing = all.find((p) => p.id === id);
    if (!input.id && existing) throw conflict(`A sign-in provider with id "${id}" exists; pick another name`);
    const parsed = AuthProviderConfig.safeParse({ ...existing, ...rest, id });
    if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'provider'}: ${i.message}`).join('; '));
    validateProvider(parsed.data);
    if (clientSecret) await this.secrets.set(secretKey(id), clientSecret);
    const needsSecret = parsed.data.kind !== 'proxy';
    if (needsSecret && parsed.data.enabled && !clientSecret && !(await this.secrets.get(secretKey(id)))) throw invalid('Enter the client secret from the provider');
    await this.saveStored([...all.filter((p) => p.id !== id), parsed.data]);
    return { ...parsed.data, source: 'app' };
  }

  async delete(id: string) {
    if (this.fromConfig.has(id)) throw new KalibraError('conflict', `"${id}" is set in the server configuration; remove it there`);
    const all = await this.stored();
    if (!all.some((p) => p.id === id)) throw notFound('Sign-in provider', id);
    await this.saveStored(all.filter((p) => p.id !== id));
    await this.secrets.delete(secretKey(id));
  }
}

/** Checks that a provider has what its kind needs, with messages an administrator can act on. */
export function validateProvider(p: AuthProviderConfig) {
  if (RESERVED.has(p.id)) throw invalid(`"${p.id}" is reserved; pick another id`);
  const url = (v: string, what: string) => {
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error();
    } catch {
      throw invalid(`${what} must be an https:// address`);
    }
  };
  if (p.kind === 'oidc') {
    url(p.issuer, 'Issuer');
    if (!p.clientId) throw invalid('Client ID is required');
    if (!p.scopes.split(/\s+/).includes('openid')) throw invalid('Scopes must include "openid"');
  }
  if (p.kind === 'github') {
    url(p.githubUrl, 'GitHub address');
    if (!p.clientId) throw invalid('Client ID is required');
  }
  if (p.kind === 'proxy') {
    if (p.jwtHeader) {
      url(p.jwksUrl, 'JWKS URL');
      if (!p.jwtAudience) throw invalid('Set the expected JWT audience, so tokens meant for other apps are refused');
    } else {
      if (!p.emailHeader) throw invalid('Set the email header (or a JWT header)');
      if (!p.trustedProxies.length) throw invalid('List the proxy addresses allowed to set the header; otherwise anyone could send it');
      const everyone = p.trustedProxies.find((e) => /^(0\.0\.0\.0|::)\/0$/.test(e.trim()) || e.trim() === '*');
      if (everyone) throw invalid(`"${everyone}" would trust the header from anywhere; list the gateway's own addresses`);
    }
  }
  for (const d of p.allowedDomains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) throw invalid(`"${d}" is not a domain`);
}

function slug(name: string) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!s) throw invalid('Give the provider a name');
  return s;
}

const csv = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Reads a secret given as "env:NAME", "file:/path" or a plain value (config files). */
function resolveSecret(v: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (v.startsWith('env:')) return env[v.slice(4)];
  if (v.startsWith('file:')) return readFileSync(v.slice(5), 'utf8').trim();
  return v;
}

/**
 * Providers from the environment. Shortcuts cover the common cases; KALIBRA_AUTH_CONFIG points at
 * a JSON file with a list of providers (any field above, with clientSecret as "env:NAME" or "file:/path").
 * Accounts are created automatically only when a shortcut also restricts who may sign in.
 */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): { config: unknown; clientSecret?: string }[] {
  const out: { config: unknown; clientSecret?: string }[] = [];
  if (env.KALIBRA_GOOGLE_CLIENT_ID) {
    const domains = csv(env.KALIBRA_GOOGLE_DOMAINS);
    out.push({
      config: { id: 'google', name: 'Google', kind: 'oidc', issuer: 'https://accounts.google.com', clientId: env.KALIBRA_GOOGLE_CLIENT_ID, allowedDomains: domains, autoCreate: domains.length > 0 },
      clientSecret: env.KALIBRA_GOOGLE_CLIENT_SECRET,
    });
  }
  if (env.KALIBRA_MICROSOFT_CLIENT_ID) {
    const tenant = env.KALIBRA_MICROSOFT_TENANT;
    if (!tenant) throw new Error('Set KALIBRA_MICROSOFT_TENANT to your Microsoft Entra tenant id');
    const domains = csv(env.KALIBRA_MICROSOFT_DOMAINS);
    out.push({
      config: { id: 'microsoft', name: 'Microsoft', kind: 'oidc', issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, clientId: env.KALIBRA_MICROSOFT_CLIENT_ID, allowedDomains: domains, autoCreate: true },
      clientSecret: env.KALIBRA_MICROSOFT_CLIENT_SECRET,
    });
  }
  if (env.KALIBRA_GITHUB_CLIENT_ID) {
    const orgs = csv(env.KALIBRA_GITHUB_ORGS);
    const url = (env.KALIBRA_GITHUB_URL || 'https://github.com').replace(/\/$/, '');
    out.push({
      config: { id: 'github', name: url === 'https://github.com' ? 'GitHub' : 'GitHub Enterprise', kind: 'github', githubUrl: url, clientId: env.KALIBRA_GITHUB_CLIENT_ID, allowedOrgs: orgs, autoCreate: orgs.length > 0 },
      clientSecret: env.KALIBRA_GITHUB_CLIENT_SECRET,
    });
  }
  if (env.KALIBRA_OIDC_ISSUER) {
    const domains = csv(env.KALIBRA_OIDC_DOMAINS);
    const groups = csv(env.KALIBRA_OIDC_GROUPS);
    out.push({
      config: {
        id: env.KALIBRA_OIDC_ID || 'sso',
        name: env.KALIBRA_OIDC_NAME || 'Company sign-in',
        kind: 'oidc',
        issuer: env.KALIBRA_OIDC_ISSUER,
        clientId: env.KALIBRA_OIDC_CLIENT_ID ?? '',
        scopes: env.KALIBRA_OIDC_SCOPES || 'openid email profile',
        groupsClaim: env.KALIBRA_OIDC_GROUPS_CLAIM ?? '',
        allowedDomains: domains,
        allowedGroups: groups,
        adminGroups: csv(env.KALIBRA_OIDC_ADMIN_GROUPS),
        syncGroups: !!env.KALIBRA_OIDC_GROUPS_CLAIM,
        autoCreate: domains.length > 0 || groups.length > 0,
      },
      clientSecret: env.KALIBRA_OIDC_CLIENT_SECRET,
    });
  }
  if (env.KALIBRA_PROXY_EMAIL_HEADER || env.KALIBRA_PROXY_JWT_HEADER) {
    out.push({
      config: {
        id: 'proxy',
        name: env.KALIBRA_PROXY_NAME || 'Login gateway',
        kind: 'proxy',
        emailHeader: env.KALIBRA_PROXY_EMAIL_HEADER ?? '',
        nameHeader: env.KALIBRA_PROXY_NAME_HEADER ?? '',
        groupsHeader: env.KALIBRA_PROXY_GROUPS_HEADER ?? '',
        jwtHeader: env.KALIBRA_PROXY_JWT_HEADER ?? '',
        jwksUrl: env.KALIBRA_PROXY_JWKS_URL ?? '',
        jwtIssuer: env.KALIBRA_PROXY_ISSUER ?? '',
        jwtAudience: env.KALIBRA_PROXY_AUDIENCE ?? '',
        trustedProxies: csv(env.KALIBRA_PROXY_TRUSTED),
        allowedDomains: csv(env.KALIBRA_PROXY_DOMAINS),
        autoCreate: true,
      },
    });
  }
  if (env.KALIBRA_AUTH_CONFIG) {
    let file: unknown;
    try {
      file = JSON.parse(readFileSync(env.KALIBRA_AUTH_CONFIG, 'utf8'));
    } catch (e: any) {
      throw new Error(`Could not read KALIBRA_AUTH_CONFIG (${env.KALIBRA_AUTH_CONFIG}): ${e?.message ?? e}`);
    }
    const providers = Array.isArray(file) ? file : (file as any)?.providers;
    if (!Array.isArray(providers)) throw new Error('KALIBRA_AUTH_CONFIG must hold a list of providers (or { "providers": [...] })');
    for (const p of providers) {
      const { clientSecret, ...config } = p ?? {};
      out.push({ config, clientSecret: resolveSecret(clientSecret, env) });
    }
  }
  return out;
}
