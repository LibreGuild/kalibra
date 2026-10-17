import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { embedMany, type EmbeddingModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAzure } from '@ai-sdk/azure';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertex } from '@ai-sdk/google-vertex';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ConnectionSpec } from '../specs.js';
import type { SecretStore } from '../storage.js';
import { invalid } from '../util.js';
import { azureCliToken, secretValue } from './index.js';

/*
 * Text embeddings for semantic similarity, near-duplicate detection and failure clustering.
 * Two sources: a small local model (free, offline after a one-time download) or a model
 * connection's embedding model. Implementation lives here; callers use the Embedder interface.
 *
 * Local model: Transformers.js + the native ONNX runtime are ~100 MB, too heavy to ship with
 * `npx kalibra`, so they are installed on demand into the models folder (one click in the UI),
 * with unused platform binaries pruned. The model itself (all-MiniLM-L6-v2, quantized) is 23 MB.
 */

export interface EmbedOptions {
  /** Use this connection's embedding model instead of the local one. */
  connectionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  source: 'local' | 'connection';
}

export interface EmbedderStatus {
  local: 'ready' | 'not_downloaded' | 'downloading' | 'unavailable';
  model: string;
  detail?: string;
}

export interface Embedder {
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>;
  status(): Promise<EmbedderStatus>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Placeholder used where no engine is available (e.g. hand-built check contexts). */
export class UnavailableEmbedder implements Embedder {
  async embed(): Promise<EmbedResult> {
    throw new Error('Embeddings are not available here');
  }
  async status(): Promise<EmbedderStatus> {
    return { local: 'unavailable', model: '' };
  }
}

/** Small LRU map: re-embedding the same text (reference answers, repeated rows) is free. */
export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() {
    return this.map.size;
  }
}

// ── Local model ─────────────────────────────────────────────────────────────

export const LOCAL_MODEL = process.env.KALIBRA_LOCAL_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
export const TRANSFORMERS_VERSION = '4.3.1';
/** Approximate one-time download: runtime (pruned to this platform) + quantized model. */
export const LOCAL_DOWNLOAD_MB = 110;

export const modelsDir = () => process.env.KALIBRA_MODELS_DIR || join(homedir(), 'Kalibra', 'models');
const runtimeDir = (root: string) => join(root, 'runtime');
const hubDir = (root: string) => join(root, 'hub');
// Written only after an install or model load fully succeeded, so a download cut short (app closed,
// network gone) is never mistaken for a ready one and is simply redone.
const runtimeMarker = (root: string) => join(runtimeDir(root), '.kalibra-ready');
const modelMarker = (root: string) => join(hubDir(root), `.kalibra-ready-${LOCAL_MODEL.replace(/[^\w.-]+/g, '_')}`);
const runtimeInstalled = (root: string) => existsSync(runtimeMarker(root)) && existsSync(join(runtimeDir(root), 'node_modules', '@huggingface', 'transformers', 'package.json'));
const modelCached = (root: string) => existsSync(modelMarker(root)) && existsSync(join(hubDir(root), ...LOCAL_MODEL.split('/'), 'onnx', 'model_quantized.onnx'));

/**
 * How to run npm: through the npm that launched us (npx), else `npm` on PATH, else common install
 * locations (for a PATH without them, e.g. a service or a GUI-launched terminal).
 */
async function findNpm(): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null> {
  const execpath = process.env.npm_execpath;
  if (execpath && /npm-cli\.js$|npx-cli\.js$/.test(execpath)) {
    const cli = execpath.replace(/npx-cli\.js$/, 'npm-cli.js');
    if (existsSync(cli)) return { cmd: process.execPath, args: [cli], env: process.env };
  }
  const win = process.platform === 'win32';
  const candidates = win
    ? ['npm.cmd', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'npm.cmd'), join(process.env.APPDATA ?? '', 'npm', 'npm.cmd')]
    : ['npm', '/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm', join(homedir(), '.volta', 'bin', 'npm')];
  for (const npm of candidates) {
    if (npm.includes(sep) && !existsSync(npm)) continue;
    try {
      // npm's launcher needs `node` on PATH, so put npm's own folder first.
      const env = npm.includes(sep) ? { ...process.env, PATH: `${dirname(npm)}${delimiter}${process.env.PATH ?? ''}` } : process.env;
      // .cmd files only run through a shell, which splits an unquoted "C:\Program Files\…" path.
      const cmd = win && npm.includes(' ') ? `"${npm}"` : npm;
      await promisify(execFile)(cmd, ['--version'], { timeout: 15000, shell: win, env });
      return { cmd, args: [], env };
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Removes ONNX runtime binaries for other platforms (~200 MB we will never load). */
function pruneOtherPlatforms(root: string) {
  const bin = join(runtimeDir(root), 'node_modules', 'onnxruntime-node', 'bin');
  if (!existsSync(bin)) return;
  for (const napi of readdirSync(bin)) {
    const napiDir = join(bin, napi);
    for (const platform of safeList(napiDir)) {
      for (const arch of safeList(join(napiDir, platform))) {
        if (platform !== process.platform || arch !== process.arch) rmSync(join(napiDir, platform, arch), { recursive: true, force: true });
      }
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── Connection models ───────────────────────────────────────────────────────

const DEFAULT_EMBED_MODEL: Record<string, string> = {
  openai: 'text-embedding-3-small',
  azure: 'text-embedding-3-small',
  google: 'gemini-embedding-001',
  vertex: 'text-embedding-005',
  bedrock: 'amazon.titan-embed-text-v2:0',
  openai_compatible: 'nomic-embed-text',
};

/** Resolves a connection to an AI SDK embedding model (same credential sources as chat models). */
export async function resolveEmbeddingModel(spec: ConnectionSpec, model: string, secrets: SecretStore, fetchImpl?: typeof fetch): Promise<EmbeddingModel> {
  const o = spec.options as Record<string, any>;
  const apiKey = await secretValue(secrets, spec.apiKeySecret);
  const headers = Object.fromEntries(spec.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]));
  const baseURL = spec.baseUrl || undefined;
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  switch (spec.provider) {
    case 'openai':
      return createOpenAI({ apiKey, baseURL, headers, organization: o.organization || undefined, project: o.project || undefined, ...f }).embedding(model);
    case 'openai_compatible':
      if (!baseURL) throw invalid('Base URL is required for OpenAI-compatible connections');
      return createOpenAICompatible({ name: o.name || 'custom', baseURL, apiKey, headers, ...f }).textEmbeddingModel(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL, headers, ...f }).embedding(model);
    case 'azure': {
      const useCli = o.authMode === 'az_cli';
      const tokenProvider = useCli ? () => azureCliToken(o.tokenScope || 'https://cognitiveservices.azure.com/.default') : undefined;
      return createAzure({
        resourceName: o.resourceName || undefined,
        baseURL,
        apiKey: useCli ? undefined : apiKey,
        tokenProvider,
        apiVersion: o.apiVersion || undefined,
        useDeploymentBasedUrls: !!o.useDeploymentBasedUrls,
        headers,
        ...f,
      }).embedding(model);
    }
    case 'bedrock': {
      const region = o.region || 'us-east-1';
      const p =
        o.authMode === 'api_key'
          ? createAmazonBedrock({ region, apiKey, headers, ...f })
          : o.authMode === 'access_keys'
            ? createAmazonBedrock({
                region,
                accessKeyId: await secretValue(secrets, o.accessKeyIdSecret),
                secretAccessKey: await secretValue(secrets, o.secretAccessKeySecret),
                sessionToken: await secretValue(secrets, o.sessionTokenSecret),
                headers,
                ...f,
              })
            : createAmazonBedrock({ region, credentialProvider: fromNodeProviderChain(o.profile ? { profile: o.profile } : {}), headers, ...f });
      return p.embedding(model);
    }
    case 'vertex': {
      const p =
        o.authMode === 'express'
          ? createVertex({ apiKey, headers, ...f })
          : createVertex({ project: o.project || undefined, location: o.location || 'us-central1', headers, googleAuthOptions: o.keyFile ? { keyFilename: o.keyFile } : undefined, ...f });
      return p.textEmbeddingModel(model);
    }
    default:
      throw invalid(`${spec.provider} connections have no embedding models. Use the local model or another connection.`);
  }
}

// ── The embedder ────────────────────────────────────────────────────────────

export interface EmbeddingsDeps {
  getConnection(id: string): Promise<ConnectionSpec>;
  secrets: SecretStore;
}

export interface DownloadProgress {
  phase: 'runtime' | 'model' | 'done';
  percent?: number;
  message: string;
}

/** Test seams: replace the local model or the connection call without touching the network. */
export interface EmbeddingsOverrides {
  dir?: string;
  local?: (texts: string[]) => Promise<number[][]>;
  connection?: (spec: ConnectionSpec, model: string, texts: string[], signal?: AbortSignal) => Promise<number[][]>;
}

const BATCH = 64;
const hashText = (s: string) => createHash('sha1').update(s).digest('base64url');

export class Embeddings implements Embedder {
  private cache = new LruCache<number[]>(20_000);
  private pipe: Promise<any> | null = null;
  private downloading: Promise<void> | null = null;
  private lastError: string | undefined;

  constructor(private deps: () => EmbeddingsDeps, private overrides: EmbeddingsOverrides = {}) {}

  get dir() {
    return this.overrides.dir ?? modelsDir();
  }

  async status(): Promise<EmbedderStatus> {
    if (this.overrides.local) return { local: 'ready', model: LOCAL_MODEL };
    if (this.downloading) return { local: 'downloading', model: LOCAL_MODEL };
    if (runtimeInstalled(this.dir) && modelCached(this.dir)) return { local: 'ready', model: LOCAL_MODEL };
    if (this.lastError) return { local: 'unavailable', model: LOCAL_MODEL, detail: this.lastError };
    return { local: 'not_downloaded', model: LOCAL_MODEL, detail: `One-time download of about ${LOCAL_DOWNLOAD_MB} MB into ${this.dir}` };
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    let source: 'local' | 'connection' = opts.connectionId ? 'connection' : 'local';
    let model = LOCAL_MODEL;
    let spec: ConnectionSpec | undefined;
    if (source === 'connection') {
      spec = await this.deps().getConnection(opts.connectionId!);
      model = opts.model || spec.embeddingModel || DEFAULT_EMBED_MODEL[spec.provider] || '';
      if (!model) throw invalid('This connection has no embedding model set');
    }

    const keyOf = (t: string) => `${source}:${model}:${hashText(t)}`;
    const vectors: (number[] | undefined)[] = texts.map((t) => this.cache.get(keyOf(t)));
    const missing = [...new Set(texts.filter((_, i) => !vectors[i]))];

    for (let i = 0; i < missing.length; i += BATCH) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Aborted');
      const batch = missing.slice(i, i + BATCH);
      const out = source === 'local' ? await this.embedLocal(batch) : await this.embedConnection(spec!, model, batch, opts.signal);
      batch.forEach((t, j) => this.cache.set(keyOf(t), out[j]));
    }
    return { vectors: texts.map((t, i) => vectors[i] ?? this.cache.get(keyOf(t))!), model, source };
  }

  private async embedConnection(spec: ConnectionSpec, model: string, texts: string[], signal?: AbortSignal) {
    if (this.overrides.connection) return this.overrides.connection(spec, model, texts, signal);
    const m = await resolveEmbeddingModel(spec, model, this.deps().secrets);
    const res = await embedMany({ model: m, values: texts.map((t) => t || ' '), abortSignal: signal, maxParallelCalls: 2 });
    return res.embeddings;
  }

  private async embedLocal(texts: string[]): Promise<number[][]> {
    if (this.overrides.local) return this.overrides.local(texts);
    if (!runtimeInstalled(this.dir) || !modelCached(this.dir)) {
      throw invalid('The local embedding model is not downloaded yet. Download it (about 110 MB, once) from a dataset\'s Quality tab or Connections, or use a connection\'s embedding model.');
    }
    const fe = await this.pipeline();
    const out = await fe(texts.map((t) => t || ' '), { pooling: 'mean', normalize: true });
    return out.tolist() as number[][];
  }

  private pipeline(onModelProgress?: (p: DownloadProgress) => void) {
    if (!this.pipe) {
      this.pipe = (async () => {
        const req = createRequire(join(runtimeDir(this.dir), 'package.json'));
        const tf = req('@huggingface/transformers');
        tf.env.cacheDir = hubDir(this.dir);
        tf.env.allowRemoteModels = true;
        return tf.pipeline('feature-extraction', LOCAL_MODEL, {
          dtype: 'q8',
          progress_callback: (e: any) => {
            if (e?.status === 'progress' && onModelProgress) {
              onModelProgress({ phase: 'model', percent: Math.round(e.progress ?? 0), message: `Downloading ${e.file ?? 'model'}` });
            }
          },
        });
      })();
      this.pipe.catch(() => (this.pipe = null));
    }
    return this.pipe;
  }

  /** One-time download of the runtime (via npm) and the model. Safe to call again; it resumes. */
  downloadLocal(onProgress: (p: DownloadProgress) => void = () => {}): Promise<void> {
    if (this.downloading) return this.downloading;
    this.lastError = undefined;
    this.downloading = (async () => {
      try {
        const root = this.dir;
        mkdirSync(runtimeDir(root), { recursive: true });
        if (!runtimeInstalled(root)) {
          // Packages left half-extracted by an interrupted install look installed to npm; start clean.
          rmSync(join(runtimeDir(root), 'node_modules'), { recursive: true, force: true });
          this.pipe = null;
          const npm = await findNpm();
          if (!npm) throw new Error('Downloading the local model needs npm (it comes with Node.js from nodejs.org). Or use a connection\'s embedding model instead.');
          writeFileSync(
            join(runtimeDir(root), 'package.json'),
            JSON.stringify(
              {
                name: 'kalibra-local-models',
                private: true,
                dependencies: { '@huggingface/transformers': TRANSFORMERS_VERSION },
                // Not needed for text embeddings in Node; skipping them saves ~170 MB.
                overrides: { sharp: 'npm:noop-package@1.0.0', 'onnxruntime-web': 'npm:noop-package@1.0.0' },
              },
              null,
              2,
            ),
          );
          onProgress({ phase: 'runtime', message: 'Installing the embedding runtime (one time)…' });
          await new Promise<void>((resolve, reject) => {
            const child = spawn(npm.cmd, [...npm.args, 'install', '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error'], {
              cwd: runtimeDir(root),
              env: npm.env,
              shell: process.platform === 'win32' && /\.cmd"?$/.test(npm.cmd),
            });
            let err = '';
            child.stderr?.on('data', (d) => (err += d));
            child.on('error', reject);
            child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install failed (${code}): ${err.slice(-500)}`))));
          });
          pruneOtherPlatforms(root);
          writeFileSync(runtimeMarker(root), TRANSFORMERS_VERSION);
        }
        onProgress({ phase: 'model', percent: 0, message: `Downloading ${LOCAL_MODEL}…` });
        try {
          await this.pipeline(onProgress);
        } catch {
          // A model file cut off by an earlier interrupted download does not load: fetch it again, once.
          rmSync(join(hubDir(root), ...LOCAL_MODEL.split('/')), { recursive: true, force: true });
          await this.pipeline(onProgress);
        }
        mkdirSync(hubDir(root), { recursive: true });
        writeFileSync(modelMarker(root), LOCAL_MODEL);
        onProgress({ phase: 'done', percent: 100, message: 'Local model ready' });
      } catch (e: any) {
        this.lastError = e?.message ?? String(e);
        throw e;
      } finally {
        // Cleared before the promise settles, so status() is accurate for whoever awaited it.
        this.downloading = null;
      }
    })();
    this.downloading.catch(() => {}); // callers that only poll status() must not see an unhandled rejection
    return this.downloading;
  }
}
