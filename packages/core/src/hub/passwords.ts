import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { KalibraError } from '../util.js';

/*
 * Password hashing with scrypt (built into Node, memory-hard). Parameters follow OWASP's
 * recommendation (N=2^17, r=8, p=1) and are stored with each hash, so they can be raised later
 * without breaking existing passwords: `scrypt$N$r$p$salt$hash` (base64url parts).
 *
 * scrypt runs on libuv's thread pool, so hashing does not block the event loop.
 */

const PARAMS = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LEN = 32;

/**
 * Runs at most `limit` tasks at once and refuses new ones when `maxWaiting` are already queued.
 * Each scrypt takes ~128 MiB and one of libuv's four threads (also used for file reads), so a
 * burst of sign-in attempts must not take them all or queue without bound.
 */
export class Gate {
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private limit: number,
    private maxWaiting: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) throw new KalibraError('unavailable', 'The server is busy signing people in. Try again in a moment.');
      // The finishing task hands its slot over, so `running` stays as it is.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

const hashing = new Gate(2, 100);

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  // maxmem must cover 128 * N * r bytes (128 MiB at N=2^17, r=8).
  const maxmem = 256 * 1024 * 1024;
  return hashing.run(() => new Promise((resolve, reject) => scryptCb(password.normalize('NFKC'), salt, KEY_LEN, { ...opts, maxmem }, (err, key) => (err ? reject(err) : resolve(key)))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to verify against when the user does not exist, so timing does not reveal valid usernames. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));

/** Passwords people pick first. Rejected outright; longer lists belong in a breach-check service. */
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou',
  'admin123', 'administrator', 'letmein123', 'welcome1', 'welcome123', 'changeme', 'changeme123', 'kalibra123', 'abcdefgh', '11111111', '00000000',
]);

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** Length-based rules (NIST 800-63B): long enough, not common, not the username. No composition rules. */
export function checkPasswordStrength(password: string, username?: string) {
  if (password.length < PASSWORD_MIN) throw new KalibraError('invalid', `Use at least ${PASSWORD_MIN} characters`);
  if (password.length > PASSWORD_MAX) throw new KalibraError('invalid', `Use at most ${PASSWORD_MAX} characters`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw new KalibraError('invalid', 'This password is too easy to guess');
  if (username && lower.includes(username.toLowerCase())) throw new KalibraError('invalid', 'The password must not contain the username');
}

/** Random secrets for cookies and tokens, and the hash stored for them (lookups by hash, never by value). */
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
