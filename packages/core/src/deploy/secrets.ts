import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { Db } from '../db.js';
import type { SecretStore } from '../storage.js';
import { nowIso } from '../util.js';

/*
 * Provider keys and other secrets stored in the database, encrypted, for deployments where the
 * local disk may disappear (a bucket or Postgres). AES-256-GCM with a fresh 96-bit nonce per value;
 * the key comes from KALIBRA_SECRET_KEY through HKDF, and its id is stored with every value so the
 * key can be rotated later. The secret's scope and name are authenticated too, so a value copied
 * into another row doesn't decrypt.
 *
 *   value = "v1:<key id>:<nonce, base64url>:<ciphertext + tag, base64url>"
 */

export class SecretKey {
  readonly id: string;
  private key: Buffer;

  private constructor(key: Buffer) {
    this.key = key;
    this.id = createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  /** From KALIBRA_SECRET_KEY: at least 32 random bytes, as hex or base64. */
  static from(raw: string): SecretKey {
    const bytes = Buffer.from(raw.trim(), /^[0-9a-f]+$/i.test(raw.trim()) ? 'hex' : 'base64');
    if (bytes.length < 32) throw new Error('KALIBRA_SECRET_KEY must hold at least 32 random bytes (e.g. `openssl rand -base64 32`).');
    return new SecretKey(Buffer.from(hkdfSync('sha256', bytes, 'kalibra', 'secrets-v1', 32)));
  }

  encrypt(plain: string, aad: string): string {
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final(), c.getAuthTag()]);
    return `v1:${this.id}:${nonce.toString('base64url')}:${ct.toString('base64url')}`;
  }

  decrypt(value: string, aad: string): string {
    const [v, id, nonce, data] = value.split(':');
    if (v !== 'v1' || !nonce || !data) throw new Error('A stored secret is not in a format this Kalibra can read');
    if (id !== this.id) throw new Error('A stored secret was encrypted with a different KALIBRA_SECRET_KEY');
    const buf = Buffer.from(data, 'base64url');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(buf.subarray(buf.length - 16));
    try {
      return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
    } catch {
      throw new Error('A stored secret could not be decrypted (wrong KALIBRA_SECRET_KEY, or the value was changed)');
    }
  }
}

/**
 * Secrets in the `secrets` table of a hub or project database. Secrets of an older local file
 * (secrets.json, hub-secrets.json) are imported on first use and the file is renamed `.imported`.
 */
export class DbSecretStore implements SecretStore {
  private ready?: Promise<void>;

  constructor(
    private db: Db,
    private key: SecretKey,
    private scope: 'hub' | 'project',
    private legacyFile?: string,
  ) {}

  private aad(name: string) {
    return `${this.scope}:${name}`;
  }

  private init() {
    this.ready ??= this.importLegacy();
    return this.ready;
  }

  private async importLegacy() {
    const file = this.legacyFile;
    if (!file || !existsSync(file)) return;
    const values: Record<string, string> = JSON.parse(readFileSync(file, 'utf8'));
    await this.db.tx(async () => {
      for (const [name, value] of Object.entries(values)) {
        if (typeof value !== 'string') continue;
        if (await this.db.get('SELECT 1 AS ok FROM secrets WHERE name = ?', name)) continue;
        await this.db.run('INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)', name, this.key.encrypt(value, this.aad(name)), nowIso());
      }
    });
    renameSync(file, `${file}.imported`);
  }

  async get(name: string) {
    await this.init();
    const row = await this.db.get<{ value: string }>('SELECT value FROM secrets WHERE name = ?', name);
    return row ? this.key.decrypt(row.value, this.aad(name)) : undefined;
  }

  async set(name: string, value: string) {
    await this.init();
    await this.db.run(
      'INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      name, this.key.encrypt(value, this.aad(name)), nowIso(),
    );
  }

  async delete(name: string) {
    await this.init();
    await this.db.run('DELETE FROM secrets WHERE name = ?', name);
  }

  async list() {
    await this.init();
    return (await this.db.all<{ name: string }>('SELECT name FROM secrets ORDER BY name')).map((r) => r.name);
  }
}
