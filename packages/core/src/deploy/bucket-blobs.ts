import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db.js';
import { sniffMime, type BlobInfo, type BlobStore } from '../storage.js';
import { invalid, KalibraError, notFound, nowIso } from '../util.js';
import { ObjectNotFound, type ObjectStore } from './objects.js';

/*
 * Uploaded files in a bucket. Content-addressed and written once (`files/aa/bb/<sha256>`), so every
 * project shares one copy; each project's database still says which files belong to it, and a
 * project can only read files it has a record of (as with files on disk, which live per project).
 * Reads go through a bounded local cache, so audio seeking and repeated runs don't re-download.
 */

/** A file's object name in the bucket. */
export const fileKey = (hash: string) => {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw invalid(`Not a file hash: ${String(hash).slice(0, 80)}`);
  return `files/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
};
const key = fileKey;

/** Least-recently-used files on local disk, up to a size limit; shared by every project. */
export class FileCache {
  private entries = new Map<string, number>(); // hash → size, oldest first
  private bytes = 0;

  constructor(
    readonly dir: string,
    private maxBytes: number,
  ) {
    mkdirSync(dir, { recursive: true });
    const found: { hash: string; size: number; used: number }[] = [];
    for (const a of readdirSync(dir)) {
      if (!/^[a-f0-9]{2}$/.test(a)) continue;
      for (const hash of readdirSync(join(dir, a))) {
        if (!/^[a-f0-9]{64}$/.test(hash)) continue;
        const st = statSync(join(dir, a, hash));
        found.push({ hash, size: st.size, used: st.atimeMs });
      }
    }
    for (const f of found.sort((x, y) => x.used - y.used)) this.add(f.hash, f.size);
  }

  path(hash: string) {
    return join(this.dir, hash.slice(0, 2), hash);
  }

  tempPath() {
    return join(this.dir, `incoming.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  }

  has(hash: string) {
    return this.entries.has(hash);
  }

  /** Marks a cached file as just used (and keeps its access time for the next start). */
  touch(hash: string) {
    const size = this.entries.get(hash);
    if (size === undefined) return;
    this.entries.delete(hash);
    this.entries.set(hash, size);
    const now = new Date();
    utimes(this.path(hash), now, now).catch(() => {});
  }

  /** Moves a finished temp file into the cache. */
  async adopt(hash: string, tmp: string, size: number) {
    if (this.entries.has(hash)) return void (await rm(tmp, { force: true }));
    await mkdir(dirname(this.path(hash)), { recursive: true });
    await rename(tmp, this.path(hash));
    this.add(hash, size);
    await this.evict();
  }

  async write(hash: string, data: Uint8Array) {
    if (this.entries.has(hash)) return;
    const tmp = this.tempPath();
    await writeFile(tmp, data);
    await this.adopt(hash, tmp, data.byteLength);
  }

  private add(hash: string, size: number) {
    this.entries.set(hash, size);
    this.bytes += size;
  }

  private async evict() {
    for (const [hash, size] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(hash);
      this.bytes -= size;
      await rm(this.path(hash), { force: true });
    }
  }

  get size() {
    return this.bytes;
  }
}

export class BucketBlobStore implements BlobStore {
  /** Downloads in progress, so concurrent readers of one file share a single download. */
  private static fetching = new Map<string, Promise<void>>();

  constructor(
    private objects: ObjectStore,
    private db: Db,
    private cache: FileCache,
  ) {}

  private async record(info: BlobInfo) {
    await this.db.run(
      'INSERT INTO blobs (hash, size, mime, name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING',
      info.hash, info.size, info.mime, info.name ?? null, nowIso(),
    );
  }

  private async upload(hash: string, body: { data: Uint8Array } | { file: string }) {
    const k = key(hash);
    if (await this.objects.head(k)) return; // written once: identical content is already there
    if ('data' in body) await this.objects.put(k, body.data, { contentType: 'application/octet-stream' });
    else await this.objects.putFile(k, body.file, { contentType: 'application/octet-stream' });
  }

  async put(data: Uint8Array, meta: { mime?: string; name?: string }): Promise<BlobInfo> {
    const hash = createHash('sha256').update(data).digest('hex');
    await this.upload(hash, { data });
    await this.cache.write(hash, data);
    const info: BlobInfo = { hash, size: data.byteLength, mime: meta.mime || sniffMime(data, meta.name), name: meta.name };
    await this.record(info);
    return info;
  }

  async putStream(source: AsyncIterable<Uint8Array>, meta: { mime?: string; name?: string }, maxBytes: number): Promise<BlobInfo> {
    // Spooled to a temp file in the cache while hashing, then uploaded from there.
    const tmp = this.cache.tempPath();
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
      await this.upload(hash, { file: tmp });
      await this.cache.adopt(hash, tmp, size);
      const info: BlobInfo = { hash, size, mime: meta.mime || sniffMime(head, meta.name), name: meta.name };
      await this.record(info);
      return info;
    } catch (e) {
      out.destroy();
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Downloads a file into the cache (once, however many readers ask at the same time). */
  private fetch(hash: string): Promise<void> {
    if (this.cache.has(hash)) return Promise.resolve();
    let p = BucketBlobStore.fetching.get(hash);
    if (!p) {
      p = (async () => {
        const tmp = this.cache.tempPath();
        try {
          await pipeline(await this.objects.stream(key(hash)), createWriteStream(tmp));
          const st = statSync(tmp);
          await this.cache.adopt(hash, tmp, st.size);
        } catch (e) {
          await rm(tmp, { force: true });
          if (e instanceof ObjectNotFound) throw notFound('File', hash);
          throw e;
        }
      })().finally(() => BucketBlobStore.fetching.delete(hash));
      BucketBlobStore.fetching.set(hash, p);
    }
    return p;
  }

  /** Only files this project has a record of; others answer "not found", like a missing file on disk. */
  private async owned(hash: string) {
    key(hash);
    if (!(await this.db.get('SELECT 1 AS ok FROM blobs WHERE hash = ?', hash))) throw notFound('File', hash);
  }

  async get(hash: string) {
    await this.owned(hash);
    await this.fetch(hash);
    this.cache.touch(hash);
    try {
      return await readFile(this.cache.path(hash));
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw notFound('File', hash); // evicted meanwhile: rare; the caller may retry
      throw e;
    }
  }

  async info(hash: string): Promise<BlobInfo | undefined> {
    const row = await this.db.get('SELECT hash, size, mime, name FROM blobs WHERE hash = ?', hash);
    return row ? { ...row, name: row.name ?? undefined } : undefined;
  }

  async has(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    if (!(await this.db.get('SELECT 1 AS ok FROM blobs WHERE hash = ?', hash))) return false;
    return this.cache.has(hash) || !!(await this.objects.head(key(hash)));
  }

  stream(hash: string, range?: { start: number; end: number }): NodeJS.ReadableStream {
    const out = new PassThrough();
    (async () => {
      await this.owned(hash);
      let src: Readable | NodeJS.ReadableStream;
      if (this.cache.has(hash) && existsSync(this.cache.path(hash))) {
        this.cache.touch(hash);
        src = createReadStream(this.cache.path(hash), range);
      } else if (range) {
        // Seeking into a file not cached yet: serve the range straight from the bucket and cache the
        // whole file in the background for the next request.
        src = await this.objects.stream(key(hash), range);
        this.fetch(hash).catch(() => {});
      } else {
        await this.fetch(hash);
        src = createReadStream(this.cache.path(hash));
      }
      await pipeline(src, out);
    })().catch((e) => out.destroy(e instanceof ObjectNotFound ? notFound('File', hash) : e));
    return out;
  }
}
