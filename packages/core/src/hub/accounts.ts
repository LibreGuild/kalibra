import { HubCache } from '../coord/cache.js';
import { LocalCoordinator } from '../coord/coordinator.js';
import type { Db } from '../db.js';
import { conflict, invalid, KalibraError, newId, notFound, nowIso } from '../util.js';
import { checkPasswordStrength, dummyHash, hashPassword, randomSecret, sha256, verifyPassword } from './passwords.js';
import type { ServerRole, User } from './types.js';

/*
 * User accounts, browser sessions and access tokens. Secrets (passwords, cookie values, tokens)
 * are never stored: passwords as scrypt hashes, cookies and tokens as SHA-256 hashes.
 */

/** After this many wrong passwords in a row, the account is locked for LOCK_MINUTES. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** Prefix that makes tokens easy to recognise (and to find with secret scanners). */
export const TOKEN_PREFIX = 'kal_';

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{1,63}$/;

const toUser = (r: any): User => ({
  id: r.id,
  username: r.username,
  name: r.name,
  email: r.email,
  role: r.role,
  disabled: !!r.disabled,
  mustChangePassword: !!r.must_change_password,
  hasPassword: !!r.password_hash,
  createdAt: r.created_at,
  ...(r.last_login_at ? { lastLoginAt: r.last_login_at } : {}),
});

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
}

export interface TokenInfo {
  id: string;
  name: string;
  /** First characters of the token, to recognise it in a list. */
  prefix: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

const toToken = (r: any): TokenInfo => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
});

/** last_seen / last_used are written at most this often, so busy clients don't write on every request. */
const TOUCH_MS = 60_000;

/** What a session or token cookie resolves to, as cached (see HubCache). */
interface CachedCredential {
  id: string;
  user: User | null;
  expiresAt: string | null;
  touchedAt: string | null;
}

export class Accounts {
  constructor(
    private db: Db,
    private cache = new HubCache(new LocalCoordinator(), false),
  ) {}

  // ── Users ─────────────────────────────────────────────────────────────────

  async list(): Promise<User[]> {
    return (await this.db.all('SELECT * FROM users ORDER BY disabled, lower(username)')).map(toUser);
  }

  async get(id: string): Promise<User> {
    const user = await this.cache.lookup(`user:${id}`, async () => {
      const r = await this.db.get('SELECT * FROM users WHERE id = ?', id);
      return r ? toUser(r) : undefined;
    });
    if (!user) throw notFound('User', id);
    return user;
  }

  async find(idOrUsername: string): Promise<User | undefined> {
    // An id wins over a username that happens to look like one.
    const r = await this.db.get('SELECT * FROM users WHERE id = ? OR lower(username) = lower(?) ORDER BY id = ? DESC LIMIT 1', idOrUsername, idOrUsername, idOrUsername);
    return r ? toUser(r) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    if (!email) return undefined;
    const r = await this.db.get('SELECT * FROM users WHERE lower(email) = lower(?) ORDER BY disabled LIMIT 1', email);
    return r ? toUser(r) : undefined;
  }

  async findAllByEmail(email: string): Promise<User[]> {
    if (!email) return [];
    return (await this.db.all('SELECT * FROM users WHERE lower(email) = lower(?)', email)).map(toUser);
  }

  async countAdmins(): Promise<number> {
    return (await this.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")).n;
  }

  async create(input: { username: string; name?: string; email?: string; password?: string; role: ServerRole; mustChangePassword?: boolean }, by: string): Promise<User> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) throw invalid('Usernames are 2–64 characters: letters, digits, dot, dash, underscore or @, starting with a letter or digit');
    if (await this.find(username)) throw conflict(`The username "${username}" is taken`);
    if (input.password !== undefined) checkPasswordStrength(input.password, username);
    const hash = input.password !== undefined ? await hashPassword(input.password) : null;
    // Re-check after the slow hash (another request may have taken the name meanwhile), in one unit with the insert.
    return this.db.tx(async () => {
      if (await this.find(username)) throw conflict(`The username "${username}" is taken`);
      const id = newId('usr');
      const now = nowIso();
      await this.db.run(
        'INSERT INTO users (id, username, name, email, password_hash, role, must_change_password, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, username, input.name?.trim() || username, input.email?.trim() ?? '', hash, input.role, input.mustChangePassword ? 1 : 0, now, by, now,
      );
      return await this.get(id);
    });
  }

  async update(id: string, patch: { name?: string; email?: string; role?: ServerRole; disabled?: boolean }): Promise<User> {
    return this.db.tx(async () => {
      const cur = await this.get(id);
      const role = patch.role ?? cur.role;
      const disabled = patch.disabled ?? cur.disabled;
      // Never lock everyone out: keep at least one active administrator.
      if (cur.role === 'admin' && !cur.disabled && (role !== 'admin' || disabled) && await this.countAdmins() <= 1) {
        throw new KalibraError('conflict', 'This is the last active administrator. Make someone else an administrator first.');
      }
      await this.db.run(
        'UPDATE users SET name = ?, email = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?',
        patch.name?.trim() || cur.name, patch.email?.trim() ?? cur.email, role, disabled ? 1 : 0, nowIso(), id,
      );
      if (disabled && !cur.disabled) await this.revokeAllSessions(id);
      return await this.get(id);
    });
  }

  async setPassword(id: string, password: string, opts: { mustChange?: boolean } = {}) {
    const user = await this.get(id);
    checkPasswordStrength(password, user.username);
    const hash = await hashPassword(password);
    await this.db.run(
      'UPDATE users SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
      hash, opts.mustChange ? 1 : 0, nowIso(), id,
    );
  }

  /**
   * Checks a username and password. Wrong passwords count towards a temporary lock. The answer
   * is the same for unknown users, wrong passwords and disabled accounts, so it does not reveal
   * which usernames exist.
   */
  async authenticate(username: string, password: string): Promise<User> {
    const r = await this.db.get('SELECT * FROM users WHERE lower(username) = lower(?)', username.trim());
    const wrong = new KalibraError('forbidden', 'Wrong username or password');
    if (!r || !r.password_hash) {
      await verifyPassword(password, await dummyHash());
      throw wrong;
    }
    const locked = (until: string) => new KalibraError('forbidden', `Too many wrong passwords. Try again after ${new Date(until).toLocaleTimeString()} or ask an administrator.`);
    const lock = async () => {
      const until = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
      await this.db.run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', until, r.id);
      return locked(until);
    };
    // Count the attempt before checking the password, in one statement, so guesses sent in parallel
    // cannot all pass the lock check before the first failure is recorded.
    const slot = await this.db.get('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? AND (locked_until IS NULL OR locked_until <= ?) RETURNING failed_logins', r.id, nowIso());
    if (!slot) throw locked((await this.db.get('SELECT locked_until FROM users WHERE id = ?', r.id))?.locked_until ?? nowIso());
    if (slot.failed_logins > MAX_FAILED_LOGINS) throw await lock();
    if (!(await verifyPassword(password, r.password_hash))) {
      if (slot.failed_logins >= MAX_FAILED_LOGINS) await lock();
      throw wrong;
    }
    if (r.disabled) throw wrong;
    await this.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', nowIso(), r.id);
    return toUser({ ...r, last_login_at: nowIso() });
  }

  async markLogin(id: string) {
    await this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), id);
  }

  /** A free username based on `wanted` (adds a number when it is taken). */
  async freeUsername(wanted: string): Promise<string> {
    let base = wanted.toLowerCase().replace(/[^a-z0-9._@-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 56) || 'user';
    if (base.length < 2) base = `${base}-user`;
    let name = base;
    for (let n = 2; await this.find(name); n++) name = `${base}-${n}`;
    return name;
  }

  // ── Provider identities ───────────────────────────────────────────────────

  /** The account linked to a provider identity. */
  async byIdentity(provider: string, subject: string): Promise<User | undefined> {
    const r = await this.db.get('SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?', provider, subject);
    return r ? toUser(r) : undefined;
  }

  async linkIdentity(provider: string, subject: string, userId: string, email: string, data: unknown) {
    return this.db.tx(async () => {
      const now = nowIso();
      await this.db.run(
        `INSERT INTO identities (provider, subject, user_id, email, data, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, data = excluded.data, last_login_at = excluded.last_login_at`,
        provider, subject, userId, email, JSON.stringify(data ?? {}), now, now,
      );
    });
  }

  /** Linked sign-in methods. Subjects are internal (they identify the person at the provider). */
  identities(userId: string): Promise<{ provider: string; email: string; lastLoginAt?: string }[]>;
  identities(userId: string, withSubject: true): Promise<{ provider: string; email: string; subject: string; lastLoginAt?: string }[]>;
  async identities(userId: string, withSubject = false) {
    return (await this.db.all('SELECT provider, subject, email, last_login_at FROM identities WHERE user_id = ? ORDER BY provider', userId))
      .map((r) => ({ provider: r.provider, email: r.email, ...(withSubject ? { subject: r.subject } : {}), ...(r.last_login_at ? { lastLoginAt: r.last_login_at } : {}) }));
  }

  async unlinkIdentity(userId: string, provider: string) {
    return this.db.tx(async () => {
      await this.db.run('DELETE FROM identities WHERE user_id = ? AND provider = ?', userId, provider);
    });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** Starts a browser session. Returns the cookie value; only its hash is stored. */
  async createSession(userId: string, opts: { days: number; ip?: string; userAgent?: string }): Promise<{ id: string; secret: string; expiresAt: string }> {
    return this.db.tx(async () => {
      const secret = randomSecret();
      const id = newId('ses');
      const now = nowIso();
      const expiresAt = new Date(Date.now() + opts.days * 86_400_000).toISOString();
      await this.db.run(
        'INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, sha256(secret), userId, now, expiresAt, now, (opts.ip ?? '').slice(0, 64), (opts.userAgent ?? '').slice(0, 300),
      );
      return { id, secret, expiresAt };
    });
  }

  /** The user of a session cookie, if the session is valid and the account active. */
  async resolveSession(secret: string): Promise<{ user: User; sessionId: string } | undefined> {
    if (!secret) return undefined;
    const key = `ses:${sha256(secret)}`;
    const s = await this.cache.lookup<CachedCredential>(key, async () => {
      const row = await this.db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(secret));
      if (!row) return undefined;
      const u = await this.db.get('SELECT * FROM users WHERE id = ?', row.user_id);
      return { id: row.id, user: u && !u.disabled ? toUser(u) : null, expiresAt: row.expires_at, touchedAt: row.last_seen_at };
    });
    if (!s) return undefined;
    if (s.expiresAt! <= nowIso()) {
      await this.db.run('DELETE FROM sessions WHERE id = ?', s.id);
      return undefined;
    }
    if (!s.user) return undefined;
    if (Date.now() - Date.parse(s.touchedAt!) > TOUCH_MS) {
      const now = nowIso();
      await this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, s.id);
      await this.cache.refresh(key, { ...s, touchedAt: now });
    }
    return { user: s.user, sessionId: s.id };
  }

  async listSessions(userId: string): Promise<SessionInfo[]> {
    return (await this.db.all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, nowIso()))
      .map((s) => ({ id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent }));
  }

  async revokeSession(id: string, userId?: string) {
    return this.db.tx(async () => {
      if (userId) await this.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, userId);
      else await this.db.run('DELETE FROM sessions WHERE id = ?', id);
    });
  }

  async revokeAllSessions(userId: string, except?: string) {
    return this.db.tx(async () => {
      await this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, except ?? '');
    });
  }

  async pruneSessions() {
    return this.db.tx(async () => {
      await this.db.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso());
    });
  }

  // ── Access tokens ─────────────────────────────────────────────────────────

  /** Creates a personal access token. The full token is returned once and never stored. */
  async createToken(userId: string, input: { name: string; expiresInDays?: number }): Promise<TokenInfo & { token: string }> {
    return this.db.tx(async () => {
      const name = input.name.trim();
      if (!name) throw invalid('Give the token a name, e.g. "Claude Code on my laptop"');
      const token = `${TOKEN_PREFIX}${randomSecret(30)}`;
      const id = newId('tok');
      const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
      await this.db.run(
        'INSERT INTO tokens (id, token_hash, user_id, name, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, sha256(token), userId, name.slice(0, 100), token.slice(0, TOKEN_PREFIX.length + 6), nowIso(), expiresAt,
      );
      return { ...toToken(await this.db.get('SELECT * FROM tokens WHERE id = ?', id)), token };
    });
  }

  async resolveToken(token: string): Promise<{ user: User; tokenId: string } | undefined> {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const key = `tok:${sha256(token)}`;
    const t = await this.cache.lookup<CachedCredential>(key, async () => {
      const row = await this.db.get('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
      if (!row) return undefined;
      const u = await this.db.get('SELECT * FROM users WHERE id = ?', row.user_id);
      return { id: row.id, user: u && !u.disabled ? toUser(u) : null, expiresAt: row.expires_at, touchedAt: row.last_used_at };
    });
    if (!t || (t.expiresAt && t.expiresAt <= nowIso())) return undefined;
    if (!t.user) return undefined;
    if (!t.touchedAt || Date.now() - Date.parse(t.touchedAt) > TOUCH_MS) {
      const now = nowIso();
      await this.db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', now, t.id);
      await this.cache.refresh(key, { ...t, touchedAt: now });
    }
    return { user: t.user, tokenId: t.id };
  }

  async listTokens(userId: string): Promise<TokenInfo[]> {
    return (await this.db.all('SELECT * FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId)).map(toToken);
  }

  async revokeToken(id: string, userId?: string) {
    return this.db.tx(async () => {
      const t = await this.db.get('SELECT * FROM tokens WHERE id = ? AND revoked_at IS NULL', id);
      if (!t || (userId && t.user_id !== userId)) throw notFound('Token', id);
      await this.db.run('UPDATE tokens SET revoked_at = ? WHERE id = ?', nowIso(), id);
      return toToken(t);
    });
  }
}
