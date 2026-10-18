import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { invalid, KalibraError, notFound, nowIso } from './util.js';

export interface BlobInfo {
  hash: string;
  size: number;
  mime: string;
  name?: string;
}

/** Content-addressed file store. Local folder by default; server mode can swap in S3/GCS/Azure Blob. */
export interface BlobStore {
  put(data: Uint8Array, meta: { mime?: string; name?: string }): Promise<BlobInfo>;
  /**
   * Stores a stream without holding it in memory (large uploads). Optional for other stores; callers
   * fall back to buffering and put(). Throws when more than `maxBytes` arrive.
   */
  putStream?(source: AsyncIterable<Uint8Array>, meta: { mime?: string; name?: string }, maxBytes: number): Promise<BlobInfo>;
  get(hash: string): Promise<Buffer>;
  info(hash: string): Promise<BlobInfo | undefined>;
  stream(hash: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
  has(hash: string): Promise<boolean>;
}

export class FsBlobStore implements BlobStore {
  constructor(private root: string, private db: Db) {}

  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw invalid(`Not a file hash: ${String(hash).slice(0, 80)}`);
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(data: Uint8Array, meta: { mime?: string; name?: string }): Promise<BlobInfo> {
    const hash = createHash('sha256').update(data).digest('hex');
    const file = this.path(hash);
    if (!existsSync(file)) {
      await mkdir(dirname(file), { recursive: true });
      // Unique temp name: concurrent puts of identical content must not race on one temp file.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
    }
    const info: BlobInfo = { hash, size: data.byteLength, mime: meta.mime || sniffMime(data, meta.name), name: meta.name };
    await this.db.run(
      'INSERT INTO blobs (hash, size, mime, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      info.hash, info.size, info.mime, info.name ?? null, nowIso(),
    );
    return info;
  }

  async putStream(source: AsyncIterable<Uint8Array>, meta: { mime?: string; name?: string }, maxBytes: number): Promise<BlobInfo> {
    // Written to a temp file while hashing, then moved to its content address.
    await mkdir(this.root, { recursive: true });
    const tmp = join(this.root, `upload.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    const out = createWriteStream(tmp);
    const hasher = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of source) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new KalibraError('invalid', 'File too large');
        hasher.update(chunk);
        if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk.subarray(0, 16 - head.length))]);
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'close');
      const hash = hasher.digest('hex');
      const file = this.path(hash);
      if (existsSync(file)) await rm(tmp, { force: true });
      else {
        await mkdir(dirname(file), { recursive: true });
        await rename(tmp, file);
      }
      const info: BlobInfo = { hash, size, mime: meta.mime || sniffMime(head, meta.name), name: meta.name };
      await this.db.run(
        'INSERT INTO blobs (hash, size, mime, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
        info.hash, info.size, info.mime, info.name ?? null, nowIso(),
      );
      return info;
    } catch (e) {
      // Wait for the stream to close first: if it was still opening, the file would appear after rm.
      if (!out.closed) {
        const closed = once(out, 'close').catch(() => {});
        out.destroy();
        await closed;
      }
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async get(hash: string) {
    try {
      return await readFile(this.path(hash));
    } catch (e: any) {
      // Not the raw ENOENT: that message carries the workspace path into API and MCP errors.
      if (e?.code === 'ENOENT') throw notFound('File', hash);
      throw e;
    }
  }

  async info(hash: string): Promise<BlobInfo | undefined> {
    const row = await this.db.get('SELECT hash, size, mime, name FROM blobs WHERE hash = ?', hash);
    return row ? { ...row, name: row.name ?? undefined } : undefined;
  }

  async has(hash: string) {
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

/** Secret file outside definitions and exports, readable only by its owner (0600). */
export class FileSecretStore implements SecretStore {
  private cache: Record<string, string> | undefined;

  constructor(private file: string) {}

  private load(): Record<string, string> {
    if (!this.cache) {
      this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    }
    return this.cache!;
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    // mode applies when the file is created; chmod covers files made by older versions.
    await writeFile(this.file, JSON.stringify(this.load()), { mode: 0o600 });
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
