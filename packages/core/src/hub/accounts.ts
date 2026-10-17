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

export class Accounts {
  constructor(private db: Db) {}

  // ── Users ─────────────────────────────────────────────────────────────────

  list(): User[] {
    return this.db.all('SELECT * FROM users ORDER BY disabled, username').map(toUser);
  }

  get(id: string): User {
    const r = this.db.get('SELECT * FROM users WHERE id = ?', id);
    if (!r) throw notFound('User', id);
    return toUser(r);
  }

  find(idOrUsername: string): User | undefined {
    const r = this.db.get('SELECT * FROM users WHERE id = ? OR username = ?', idOrUsername, idOrUsername);
    return r ? toUser(r) : undefined;
  }

  findByEmail(email: string): User | undefined {
    if (!email) return undefined;
    const r = this.db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE ORDER BY disabled LIMIT 1', email);
    return r ? toUser(r) : undefined;
  }

  countAdmins(): number {
    return this.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
  }

  async create(input: { username: string; name?: string; email?: string; password?: string; role: ServerRole; mustChangePassword?: boolean }, by: string): Promise<User> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) throw invalid('Usernames are 2–64 characters: letters, digits, dot, dash, underscore or @, starting with a letter or digit');
    if (this.find(username)) throw conflict(`The username "${username}" is taken`);
    if (input.password !== undefined) checkPasswordStrength(input.password, username);
    const hash = input.password !== undefined ? await hashPassword(input.password) : null;
    // Re-check after the slow hash: another request may have taken the name meanwhile.
    if (this.find(username)) throw conflict(`The username "${username}" is taken`);
    const id = newId('usr');
    const now = nowIso();
    this.db.run(
      'INSERT INTO users (id, username, name, email, password_hash, role, must_change_password, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, username, input.name?.trim() || username, input.email?.trim() ?? '', hash, input.role, input.mustChangePassword ? 1 : 0, now, by, now,
    );
    return this.get(id);
  }

  update(id: string, patch: { name?: string; email?: string; role?: ServerRole; disabled?: boolean }): User {
    const cur = this.get(id);
    const role = patch.role ?? cur.role;
    const disabled = patch.disabled ?? cur.disabled;
    // Never lock everyone out: keep at least one active administrator.
    if (cur.role === 'admin' && !cur.disabled && (role !== 'admin' || disabled) && this.countAdmins() <= 1) {
      throw new KalibraError('conflict', 'This is the last active administrator. Make someone else an administrator first.');
    }
    this.db.run(
      'UPDATE users SET name = ?, email = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?',
      patch.name?.trim() || cur.name, patch.email?.trim() ?? cur.email, role, disabled ? 1 : 0, nowIso(), id,
    );
    if (disabled && !cur.disabled) this.revokeAllSessions(id);
    return this.get(id);
  }

  async setPassword(id: string, password: string, opts: { mustChange?: boolean } = {}) {
    const user = this.get(id);
    checkPasswordStrength(password, user.username);
    const hash = await hashPassword(password);
    this.db.run(
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
    const r = this.db.get('SELECT * FROM users WHERE username = ?', username.trim());
    const wrong = new KalibraError('forbidden', 'Wrong username or password');
    if (!r || !r.password_hash) {
      await verifyPassword(password, await dummyHash());
      throw wrong;
    }
    if (r.locked_until && r.locked_until > nowIso()) {
      throw new KalibraError('forbidden', `Too many wrong passwords. Try again after ${new Date(r.locked_until).toLocaleTimeString()} or ask an administrator.`);
    }
    if (!(await verifyPassword(password, r.password_hash))) {
      const failed = r.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      this.db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : failed, lock, r.id);
      throw wrong;
    }
    if (r.disabled) throw wrong;
    this.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', nowIso(), r.id);
    return toUser({ ...r, last_login_at: nowIso() });
  }

  markLogin(id: string) {
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), id);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** Starts a browser session. Returns the cookie value; only its hash is stored. */
  createSession(userId: string, opts: { days: number; ip?: string; userAgent?: string }): { id: string; secret: string; expiresAt: string } {
    const secret = randomSecret();
    const id = newId('ses');
    const now = nowIso();
    const expiresAt = new Date(Date.now() + opts.days * 86_400_000).toISOString();
    this.db.run(
      'INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, sha256(secret), userId, now, expiresAt, now, (opts.ip ?? '').slice(0, 64), (opts.userAgent ?? '').slice(0, 300),
    );
    return { id, secret, expiresAt };
  }

  /** The user of a session cookie, if the session is valid and the account active. */
  resolveSession(secret: string): { user: User; sessionId: string } | undefined {
    if (!secret) return undefined;
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(secret));
    if (!s) return undefined;
    if (s.expires_at <= nowIso()) {
      this.db.run('DELETE FROM sessions WHERE id = ?', s.id);
      return undefined;
    }
    const u = this.db.get('SELECT * FROM users WHERE id = ?', s.user_id);
    if (!u || u.disabled) return undefined;
    if (Date.now() - Date.parse(s.last_seen_at) > TOUCH_MS) this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), s.id);
    return { user: toUser(u), sessionId: s.id };
  }

  listSessions(userId: string): SessionInfo[] {
    return this.db
      .all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, nowIso())
      .map((s) => ({ id: s.id, createdAt: s.created_at, expiresAt: s.expires_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent }));
  }

  revokeSession(id: string, userId?: string) {
    if (userId) this.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, userId);
    else this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  revokeAllSessions(userId: string, except?: string) {
    this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, except ?? '');
  }

  pruneSessions() {
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', nowIso());
  }

  // ── Access tokens ─────────────────────────────────────────────────────────

  /** Creates a personal access token. The full token is returned once and never stored. */
  createToken(userId: string, input: { name: string; expiresInDays?: number }): TokenInfo & { token: string } {
    const name = input.name.trim();
    if (!name) throw invalid('Give the token a name, e.g. "Claude Code on my laptop"');
    const token = `${TOKEN_PREFIX}${randomSecret(30)}`;
    const id = newId('tok');
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
    this.db.run(
      'INSERT INTO tokens (id, token_hash, user_id, name, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, sha256(token), userId, name.slice(0, 100), token.slice(0, TOKEN_PREFIX.length + 6), nowIso(), expiresAt,
    );
    return { ...toToken(this.db.get('SELECT * FROM tokens WHERE id = ?', id)), token };
  }

  resolveToken(token: string): { user: User; tokenId: string } | undefined {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const t = this.db.get('SELECT * FROM tokens WHERE token_hash = ? AND revoked_at IS NULL', sha256(token));
    if (!t || (t.expires_at && t.expires_at <= nowIso())) return undefined;
    const u = this.db.get('SELECT * FROM users WHERE id = ?', t.user_id);
    if (!u || u.disabled) return undefined;
    if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > TOUCH_MS) this.db.run('UPDATE tokens SET last_used_at = ? WHERE id = ?', nowIso(), t.id);
    return { user: toUser(u), tokenId: t.id };
  }

  listTokens(userId: string): TokenInfo[] {
    return this.db.all('SELECT * FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC', userId).map(toToken);
  }

  revokeToken(id: string, userId?: string) {
    const t = this.db.get('SELECT * FROM tokens WHERE id = ? AND revoked_at IS NULL', id);
    if (!t || (userId && t.user_id !== userId)) throw notFound('Token', id);
    this.db.run('UPDATE tokens SET revoked_at = ? WHERE id = ?', nowIso(), id);
    return toToken(t);
  }
}
