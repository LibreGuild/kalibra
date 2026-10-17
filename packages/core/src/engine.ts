import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSqlite, type Db } from './db.js';
import { EventBus } from './events.js';
import { createLlmClient } from './providers/index.js';
import type { LlmClient } from './providers/types.js';
import { Embeddings, type Embedder } from './providers/embeddings.js';
import { ALL_CAPABILITIES, LOCAL_USER, opAccess, Registry, roleAtLeast, type Actor, type Capabilities, type ProjectRole } from './registry.js';
import { DatasetRepo } from './repo/datasets.js';
import { DefRepo } from './repo/defs.js';
import { RunRepo } from './repo/runs.js';
import { Runner } from './runner/runner.js';
import { ConnectionSpec } from './specs.js';
import { FileSecretStore, FsBlobStore, type BlobStore, type SecretStore } from './storage.js';
import type { TemplateEnv } from './template.js';
import { KalibraError, nowIso } from './util.js';
import { ALL_OPS } from './ops/index.js';
import { withCall } from './policy.js';
import { Jobs } from './jobs.js';
import { TraceStore } from './traces/store.js';

export interface EngineOptions {
  /** Workspace directory: holds kalibra.db and blobs/. */
  dir: string;
  /** Where secret values live; defaults to a 0600 file in the workspace. */
  secrets?: SecretStore;
}

/** The engine owns all state. UI, CLI and MCP are clients that call operations through it. */
export class Engine {
  readonly dir: string;
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly secrets: SecretStore;
  readonly events = new EventBus();
  readonly registry = new Registry({
    authorize: (def, ctx) => {
      const needed = opAccess(def);
      if (!roleAtLeast(ctx.role, needed)) {
        throw new KalibraError('forbidden', `${def.title} needs the ${needed} role in this project (you are ${ctx.role === 'viewer' ? 'a viewer' : `an ${ctx.role}`})`);
      }
    },
    accessOf: opAccess,
  });
  readonly repos: { datasets: DatasetRepo; defs: DefRepo; runs: RunRepo };
  readonly runner: Runner;
  readonly llm: LlmClient;
  /** Text embeddings (local model or a connection) for similarity, dedup and clustering. */
  embeddings: Embedder = new Embeddings(() => ({ getConnection: async (id) => ConnectionSpec.parse((await this.repos.defs.get('connection', id)).spec), secrets: this.secrets }));
  /** Background jobs (media generation, augmentation, …). */
  readonly jobs: Jobs;
  /** Traces the app sends (SDK, OpenTelemetry, proxy), tool recordings, and joining them to eval rows. */
  readonly traces: TraceStore;
  /** Operations currently executing. */
  private inFlight = 0;

  /** Opens the project in `opts.dir` (creating it when new), migrates it and resumes its state. */
  static async open(opts: EngineOptions): Promise<Engine> {
    const dir = resolve(opts.dir);
    mkdirSync(dir, { recursive: true });
    const db = await openSqlite(join(dir, 'kalibra.db'));
    try {
      const engine = new Engine({ ...opts, dir }, db);
      await engine.traces.prune();
      await engine.runner.recover();
      return engine;
    } catch (e) {
      await db.close();
      throw e;
    }
  }

  private constructor(opts: EngineOptions, db: Db) {
    this.dir = opts.dir;
    this.db = db;
    this.blobs = new FsBlobStore(join(this.dir, 'blobs'), this.db);
    this.secrets = opts.secrets ?? new FileSecretStore(join(this.dir, 'secrets.json'));
    this.repos = { datasets: new DatasetRepo(this.db), defs: new DefRepo(this.db), runs: new RunRepo(this.db) };
    this.llm = createLlmClient(async (id) => ConnectionSpec.parse((await this.repos.defs.get('connection', id)).spec), this.secrets);
    this.jobs = new Jobs(this.events);
    this.traces = new TraceStore(this);
    this.registry.add(...ALL_OPS);
    this.runner = new Runner(this);
  }

  /**
   * Calls an operation as `actor`. Every change is logged with its actor and broadcast to listeners.
   * `role` and `caps` default to full access (local mode's single user); the hub passes the caller's
   * real role and the server's capabilities.
   */
  async call<T = any>(name: string, input: unknown, actor: Actor = LOCAL_USER, access: { role?: ProjectRole; caps?: Capabilities } = {}): Promise<T> {
    const ctx = { engine: this, actor, role: access.role ?? 'owner', caps: access.caps ?? ALL_CAPABILITIES };
    this.inFlight++;
    let result: unknown;
    try {
      result = await withCall(ctx, () => this.registry.call(ctx, name, input));
    } finally {
      this.inFlight--;
    }
    const def = this.registry.get(name)!;
    if (!def.readOnly && !def.quiet) {
      const summary = describeChange(def.title, input);
      await this.db.run('INSERT INTO activity (at, actor, op, summary) VALUES (?, ?, ?, ?)', nowIso(), JSON.stringify(actor), name, summary);
      this.events.emit({ type: 'activity', op: name, summary, actor });
    }
    return result as T;
  }

  /** Nothing running, no operation executing and nobody listening: safe to close to free its files. */
  isIdle() {
    return this.inFlight === 0 && this.runner.activeCount() === 0 && this.jobs.activeCount() === 0 && this.events.listenerCount() === 0 && this.traces.pending() === 0;
  }

  templateEnv(): TemplateEnv {
    return {
      secret: (name) => this.secrets.get(name),
      loadFile: async (value: any) => {
        if (!value?.blob) throw new Error('Not a file value');
        return this.blobs.get(value.blob);
      },
    };
  }

  async close() {
    this.jobs.cancelAll();
    for (const r of await this.db.all("SELECT id FROM runs WHERE status = 'running'")) this.runner.cancel(r.id);
    await this.traces.close();
    await this.db.close();
  }
}

function describeChange(title: string, input: any): string {
  const hint = input?.name ?? input?.datasetId ?? input?.id ?? input?.runId ?? '';
  const count = Array.isArray(input?.rows) ? ` (${input.rows.length} rows)` : '';
  return `${title}${hint ? `: ${hint}` : ''}${count}`;
}
