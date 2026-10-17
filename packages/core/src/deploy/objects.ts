import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DeployConfig } from './config.js';
import { storageKind } from './config.js';

/*
 * The few bucket operations Kalibra needs, the same on Google Cloud Storage, S3 (and S3-compatible
 * stores) and Azure Blob Storage. Keys are relative to the configured prefix. Each cloud's SDK is
 * loaded only when its bucket is configured (they are separate chunks of the CLI bundle).
 *
 * Credentials come from each cloud's default chain: Google Application Default Credentials (the
 * metadata server on GCP), the AWS chain (environment, profile, instance or task role), and Azure's
 * DefaultAzureCredential or AZURE_STORAGE_CONNECTION_STRING.
 */

export interface ObjectInfo {
  size: number;
  /** Opaque version for conditional writes (GCS generation, S3/Azure ETag). */
  version: string;
  updated: Date;
}

export interface PutOptions {
  contentType?: string;
  /** Write only if the object does not exist yet. */
  ifAbsent?: boolean;
  /** Write only if the object is still at this version. */
  ifVersion?: string;
}

export interface ObjectStore {
  /** e.g. gs://bucket/prefix, for logs. */
  readonly url: string;
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<ObjectInfo>;
  /** Uploads a local file (streamed, not held in memory). */
  putFile(key: string, path: string, opts?: PutOptions): Promise<ObjectInfo>;
  /** The whole object, or undefined when it does not exist. */
  get(key: string): Promise<{ data: Buffer; info: ObjectInfo } | undefined>;
  /** A byte range (inclusive end) or the whole object as a stream. Throws NotFound when missing. */
  stream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  head(key: string): Promise<ObjectInfo | undefined>;
  /** Keys under a prefix (relative to the store's prefix), in lexical order. */
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** A conditional write lost: the object changed (or exists) since it was read. */
export class PreconditionFailed extends Error {
  constructor(key: string) {
    super(`The bucket object ${key} changed meanwhile`);
  }
}

export class ObjectNotFound extends Error {
  constructor(key: string) {
    super(`No bucket object ${key}`);
  }
}

/** Splits gs://bucket/some/prefix into bucket and prefix (no leading or trailing slash). */
export function parseBucketUrl(url: string): { kind: 'gcs' | 's3' | 'azure'; bucket: string; account?: string; prefix: string } {
  const kind = storageKind(url);
  if (kind === 'disk') throw new Error('Not a bucket URL');
  const rest = url.replace(/^[a-z0-9]+:\/\//i, '');
  const parts = rest.split('/').filter(Boolean);
  if (kind === 'azure') {
    // az://account/container/prefix
    if (parts.length < 2) throw new Error('KALIBRA_STORAGE_URL for Azure is az://<account>/<container>[/prefix]');
    return { kind, account: parts[0], bucket: parts[1], prefix: parts.slice(2).join('/') };
  }
  if (!parts.length) throw new Error(`KALIBRA_STORAGE_URL needs a bucket name (${kind === 'gcs' ? 'gs' : 's3'}://<bucket>[/prefix])`);
  return { kind, bucket: parts[0], prefix: parts.slice(1).join('/') };
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}/${key}` : key);
const strip = (prefix: string, name: string) => (prefix ? name.slice(prefix.length + 1) : name);

/** Opens the bucket of KALIBRA_STORAGE_URL. */
export async function openObjectStore(cfg: Pick<DeployConfig, 'storageUrl' | 's3Endpoint' | 's3Region'>): Promise<ObjectStore> {
  const url = cfg.storageUrl!;
  const parsed = parseBucketUrl(url);
  if (parsed.kind === 'gcs') return gcs(url, parsed.bucket, parsed.prefix);
  if (parsed.kind === 's3') return s3(url, parsed.bucket, parsed.prefix, cfg);
  return azure(url, parsed.account!, parsed.bucket, parsed.prefix);
}

/** CommonJS packages bundled as chunks expose their exports on `default`. */
const pick = <T>(mod: any, name: string): T => (mod[name] ?? mod.default?.[name]) as T;

// ── Google Cloud Storage ─────────────────────────────────────────────────────

async function gcs(url: string, bucketName: string, prefix: string): Promise<ObjectStore> {
  const Storage = pick<any>(await import('@google-cloud/storage'), 'Storage');
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const api = String(storage.apiEndpoint ?? 'https://storage.googleapis.com').replace(/\/+$/, '');
  // Reads go through fetch with the SDK's credentials: its own download streams stack 11 listeners
  // on an internal stream per request, so every read printed a MaxListenersExceededWarning.
  const media = async (key: string, o: { generation?: string; range?: { start: number; end: number } } = {}) => {
    const token = await storage.authClient.getAccessToken();
    const q = new URLSearchParams({ alt: 'media', ...(o.generation ? { generation: o.generation } : {}) });
    const res = await fetch(`${api}/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(join(prefix, key))}?${q}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'accept-encoding': 'identity',
        ...(o.range ? { range: `bytes=${o.range.start}-${o.range.end}` } : {}),
      },
    });
    if (res.status === 404) {
      await res.body?.cancel();
      throw new ObjectNotFound(key);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Reading ${key} from ${url} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  };
  const info = (m: any): ObjectInfo => ({ size: Number(m.size ?? 0), version: String(m.generation), updated: new Date(m.updated ?? Date.now()) });
  const pre = (opts?: PutOptions) =>
    opts?.ifAbsent ? { preconditionOpts: { ifGenerationMatch: 0 } } : opts?.ifVersion ? { preconditionOpts: { ifGenerationMatch: Number(opts.ifVersion) } } : {};
  const wrap = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === 412) throw new PreconditionFailed(key);
      if (e?.code === 404) throw new ObjectNotFound(key);
      throw e;
    }
  };
  const store: ObjectStore = {
    url,
    async put(key, body, opts) {
      const file = bucket.file(join(prefix, key));
      return wrap(key, async () => {
        await file.save(Buffer.from(body), { resumable: false, contentType: opts?.contentType, ...pre(opts) });
        return info(file.metadata);
      });
    },
    async putFile(key, path, opts) {
      return wrap(key, async () => {
        const [file] = await bucket.upload(path, { destination: join(prefix, key), resumable: (await stat(path)).size > 8 << 20, contentType: opts?.contentType, ...pre(opts) });
        return info(file.metadata);
      });
    },
    async get(key) {
      // The metadata first, then exactly that generation, so data and version always belong together.
      for (let attempt = 0; attempt < 5; attempt++) {
        const m = await store.head(key);
        if (!m) return undefined;
        try {
          const res = await media(key, { generation: m.version });
          return { data: Buffer.from(await res.arrayBuffer()), info: m };
        } catch (e) {
          if (!(e instanceof ObjectNotFound)) throw e; // replaced between the two calls: look again
        }
      }
      throw new Error(`${key} keeps changing; try again`);
    },
    async stream(key, range) {
      const res = await media(key, { range });
      return Readable.fromWeb(res.body as any);
    },
    async head(key) {
      try {
        const [m] = await bucket.file(join(prefix, key)).getMetadata();
        return info(m);
      } catch (e: any) {
        if (e?.code === 404) return undefined;
        throw e;
      }
    },
    async list(p) {
      const [files] = await bucket.getFiles({ prefix: join(prefix, p), autoPaginate: true });
      return files.map((f: any) => strip(prefix, f.name)).sort();
    },
    async delete(key) {
      await bucket.file(join(prefix, key)).delete({ ignoreNotFound: true });
    },
  };
  return store;
}

// ── S3 and S3-compatible (MinIO, Cloudflare R2, GCS interoperability) ────────

async function s3(url: string, bucket: string, prefix: string, cfg: Pick<DeployConfig, 's3Endpoint' | 's3Region'>): Promise<ObjectStore> {
  const mod: any = await import('@aws-sdk/client-s3');
  const S3Client = pick<any>(mod, 'S3Client');
  const cmd = (name: string) => pick<any>(mod, name);
  const client = new S3Client({
    region: cfg.s3Region ?? 'us-east-1',
    // S3-compatible stores (MinIO, R2, GCS) don't all accept the SDK's newer default checksums.
    ...(cfg.s3Endpoint ? { endpoint: cfg.s3Endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' } : {}),
  });
  const info = (r: any): ObjectInfo => ({ size: Number(r.ContentLength ?? r.Size ?? 0), version: String(r.ETag ?? ''), updated: new Date(r.LastModified ?? Date.now()) });
  const failed = (e: any) => e?.$metadata?.httpStatusCode;
  const conditions = (opts?: PutOptions) => (opts?.ifAbsent ? { IfNoneMatch: '*' } : opts?.ifVersion ? { IfMatch: opts.ifVersion } : {});
  const store: ObjectStore = {
    url,
    async put(key, body, opts) {
      try {
        const r = await client.send(new (cmd('PutObjectCommand'))({ Bucket: bucket, Key: join(prefix, key), Body: body, ContentType: opts?.contentType, ...conditions(opts) }));
        return { size: body.byteLength, version: String(r.ETag ?? ''), updated: new Date() };
      } catch (e) {
        if (failed(e) === 412 || failed(e) === 409) throw new PreconditionFailed(key);
        throw e;
      }
    },
    async putFile(key, path, opts) {
      const size = (await stat(path)).size;
      try {
        const r = await client.send(
          new (cmd('PutObjectCommand'))({ Bucket: bucket, Key: join(prefix, key), Body: createReadStream(path), ContentLength: size, ContentType: opts?.contentType, ...conditions(opts) }),
        );
        return { size, version: String(r.ETag ?? ''), updated: new Date() };
      } catch (e) {
        if (failed(e) === 412 || failed(e) === 409) throw new PreconditionFailed(key);
        throw e;
      }
    },
    async get(key) {
      try {
        const r = await client.send(new (cmd('GetObjectCommand'))({ Bucket: bucket, Key: join(prefix, key) }));
        const data = Buffer.from(await r.Body.transformToByteArray());
        return { data, info: { ...info(r), size: data.length } };
      } catch (e: any) {
        if (failed(e) === 404 || e?.name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async stream(key, range) {
      try {
        const r = await client.send(new (cmd('GetObjectCommand'))({ Bucket: bucket, Key: join(prefix, key), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }));
        return r.Body as Readable;
      } catch (e: any) {
        if (failed(e) === 404 || e?.name === 'NoSuchKey') throw new ObjectNotFound(key);
        throw e;
      }
    },
    async head(key) {
      try {
        return info(await client.send(new (cmd('HeadObjectCommand'))({ Bucket: bucket, Key: join(prefix, key) })));
      } catch (e: any) {
        if (failed(e) === 404 || e?.name === 'NotFound') return undefined;
        throw e;
      }
    },
    async list(p) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new (cmd('ListObjectsV2Command'))({ Bucket: bucket, Prefix: join(prefix, p), ContinuationToken: token }));
        for (const o of r.Contents ?? []) keys.push(strip(prefix, o.Key));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    },
    async delete(key) {
      try {
        await client.send(new (cmd('DeleteObjectCommand'))({ Bucket: bucket, Key: join(prefix, key) }));
      } catch (e: any) {
        // S3 answers 204 for a missing key; some S3-compatible stores answer 404.
        if (failed(e) !== 404 && e?.name !== 'NoSuchKey') throw e;
      }
    },
  };
  return store;
}

// ── Azure Blob Storage ───────────────────────────────────────────────────────

async function azure(url: string, account: string, containerName: string, prefix: string): Promise<ObjectStore> {
  const mod: any = await import('@azure/storage-blob');
  const BlobServiceClient = pick<any>(mod, 'BlobServiceClient');
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  let service: any;
  if (conn) service = BlobServiceClient.fromConnectionString(conn);
  else {
    const DefaultAzureCredential = pick<any>(await import('@azure/identity'), 'DefaultAzureCredential');
    service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, new DefaultAzureCredential());
  }
  const container = service.getContainerClient(containerName);
  const blob = (key: string) => container.getBlockBlobClient(join(prefix, key));
  const info = (r: any): ObjectInfo => ({ size: Number(r.contentLength ?? 0), version: String(r.etag ?? ''), updated: new Date(r.lastModified ?? Date.now()) });
  const conditions = (opts?: PutOptions) => (opts?.ifAbsent ? { conditions: { ifNoneMatch: '*' } } : opts?.ifVersion ? { conditions: { ifMatch: opts.ifVersion } } : {});
  const guard = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.statusCode === 412 || e?.statusCode === 409) throw new PreconditionFailed(key);
      throw e;
    }
  };
  return {
    url,
    async put(key, body, opts) {
      return guard(key, async () => {
        const r = await blob(key).uploadData(Buffer.from(body), { blobHTTPHeaders: { blobContentType: opts?.contentType }, ...conditions(opts) });
        return { size: body.byteLength, version: String(r.etag ?? ''), updated: new Date(r.lastModified ?? Date.now()) };
      });
    },
    async putFile(key, path, opts) {
      return guard(key, async () => {
        const r = await blob(key).uploadFile(path, { blobHTTPHeaders: { blobContentType: opts?.contentType }, ...conditions(opts) });
        return { size: (await stat(path)).size, version: String(r.etag ?? ''), updated: new Date(r.lastModified ?? Date.now()) };
      });
    },
    async get(key) {
      try {
        const r = await blob(key).download();
        const chunks: Buffer[] = [];
        for await (const c of r.readableStreamBody as Readable) chunks.push(Buffer.from(c));
        const data = Buffer.concat(chunks);
        return { data, info: { ...info(r), size: data.length } };
      } catch (e: any) {
        if (e?.statusCode === 404) return undefined;
        throw e;
      }
    },
    async stream(key, range) {
      try {
        const r = await blob(key).download(range ? range.start : 0, range ? range.end - range.start + 1 : undefined);
        return r.readableStreamBody as Readable;
      } catch (e: any) {
        if (e?.statusCode === 404) throw new ObjectNotFound(key);
        throw e;
      }
    },
    async head(key) {
      try {
        return info(await blob(key).getProperties());
      } catch (e: any) {
        if (e?.statusCode === 404) return undefined;
        throw e;
      }
    },
    async list(p) {
      const keys: string[] = [];
      for await (const b of container.listBlobsFlat({ prefix: join(prefix, p) })) keys.push(strip(prefix, b.name));
      return keys.sort();
    },
    async delete(key) {
      await blob(key).deleteIfExists();
    },
  };
}

// ── In memory (tests) ────────────────────────────────────────────────────────

/** A bucket in memory with the same conditional-write rules; for tests and local experiments. */
export class MemoryObjects implements ObjectStore {
  readonly url = 'memory://test';
  readonly objects = new Map<string, { data: Buffer; version: number; updated: Date; contentType?: string }>();
  /** Counts of each call, to check costs (uploads per sync) in tests. */
  readonly calls = { put: 0, get: 0, head: 0, list: 0, delete: 0, stream: 0 };
  private counter = 0;
  /** Set to make the next calls fail, simulating an outage. */
  failing = false;

  private check() {
    if (this.failing) throw new Error('bucket unavailable (simulated)');
  }

  async put(key: string, body: Uint8Array, opts: PutOptions = {}) {
    this.check();
    this.calls.put++;
    const cur = this.objects.get(key);
    if (opts.ifAbsent && cur) throw new PreconditionFailed(key);
    if (opts.ifVersion !== undefined && String(cur?.version) !== opts.ifVersion) throw new PreconditionFailed(key);
    const o = { data: Buffer.from(body), version: ++this.counter, updated: new Date(), contentType: opts.contentType };
    this.objects.set(key, o);
    return { size: o.data.length, version: String(o.version), updated: o.updated };
  }

  async putFile(key: string, path: string, opts?: PutOptions) {
    const chunks: Buffer[] = [];
    for await (const c of createReadStream(path)) chunks.push(c as Buffer);
    return this.put(key, Buffer.concat(chunks), opts);
  }

  async get(key: string) {
    this.check();
    this.calls.get++;
    const o = this.objects.get(key);
    return o ? { data: Buffer.from(o.data), info: { size: o.data.length, version: String(o.version), updated: o.updated } } : undefined;
  }

  async stream(key: string, range?: { start: number; end: number }) {
    this.check();
    this.calls.stream++;
    const o = this.objects.get(key);
    if (!o) throw new ObjectNotFound(key);
    return Readable.from([range ? o.data.subarray(range.start, range.end + 1) : o.data]);
  }

  async head(key: string) {
    this.check();
    this.calls.head++;
    const o = this.objects.get(key);
    return o ? { size: o.data.length, version: String(o.version), updated: o.updated } : undefined;
  }

  async list(prefix: string) {
    this.check();
    this.calls.list++;
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async delete(key: string) {
    this.check();
    this.calls.delete++;
    this.objects.delete(key);
  }
}
