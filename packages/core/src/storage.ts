import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { nowIso } from './util.js';

export interface BlobInfo {
  hash: string;
  size: number;
  mime: string;
  name?: string;
}

/** Content-addressed file store. Desktop: local folder. Server mode can swap in S3/GCS/Azure Blob. */
export interface BlobStore {
  put(data: Uint8Array, meta: { mime?: string; name?: string }): Promise<BlobInfo>;
  get(hash: string): Promise<Buffer>;
  info(hash: string): BlobInfo | undefined;
  stream(hash: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  has(hash: string): boolean;
}

export class FsBlobStore implements BlobStore {
  constructor(private root: string, private db: Db) {}

  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid blob hash: ${hash}`);
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(data: Uint8Array, meta: { mime?: string; name?: string }): Promise<BlobInfo> {
    const hash = createHash('sha256').update(data).digest('hex');
    const file = this.path(hash);
    if (!existsSync(file)) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    }
    const info: BlobInfo = { hash, size: data.byteLength, mime: meta.mime || sniffMime(data, meta.name), name: meta.name };
    this.db.run(
      'INSERT INTO blobs (hash, size, mime, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      info.hash, info.size, info.mime, info.name ?? null, nowIso(),
    );
    return info;
  }

  get(hash: string) {
    return readFile(this.path(hash));
  }

  info(hash: string): BlobInfo | undefined {
    const row = this.db.get('SELECT hash, size, mime, name FROM blobs WHERE hash = ?', hash);
    return row ? { ...row, name: row.name ?? undefined } : undefined;
  }

  has(hash: string) {
    return existsSync(this.path(hash));
  }

  stream(hash: string, range?: { start: number; end: number }) {
    return createReadStream(this.path(hash), range);
  }
}

export function sniffMime(data: Uint8Array, name?: string): string {
  const b = Buffer.from(data.buffer, data.byteOffset, Math.min(16, data.byteLength));
  const ascii = b.toString('latin1');
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('fLaC')) return 'audio/flac';
  if (ascii.slice(4, 8) === 'ftyp') return 'audio/mp4';
  if (b[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  const ext = name?.split('.').pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    csv: 'text/csv', json: 'application/json', jsonl: 'application/jsonl', txt: 'text/plain',
    wav: 'audio/wav', mp3: 'audio/mpeg', webm: 'audio/webm', svg: 'image/svg+xml', raw: 'application/octet-stream',
  };
  return (ext && byExt[ext]) || 'application/octet-stream';
}

/** Secret values never live in the database or in definition files; definitions hold only names. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/**
 * Encrypted-at-rest secret file. `encrypt`/`decrypt` come from the host: Electron passes
 * safeStorage (OS keychain backed); the dev/CLI server falls back to plaintext with 0600 perms.
 */
export class FileSecretStore implements SecretStore {
  private cache: Record<string, string> | undefined;

  constructor(
    private file: string,
    private codec: { encrypt(s: string): Buffer; decrypt(b: Buffer): string } = {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
    },
  ) {}

  private load(): Record<string, string> {
    if (!this.cache) {
      this.cache = existsSync(this.file) ? JSON.parse(this.codec.decrypt(readFileSync(this.file))) : {};
    }
    return this.cache!;
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, this.codec.encrypt(JSON.stringify(this.load())));
    await chmod(this.file, 0o600);
  }

  async get(name: string) {
    return this.load()[name];
  }
  async set(name: string, value: string) {
    this.load()[name] = value;
    await this.save();
  }
  async delete(name: string) {
    delete this.load()[name];
    await this.save();
  }
  async list() {
    return Object.keys(this.load()).sort();
  }
}

export async function fileSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
