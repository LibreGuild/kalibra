import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from './db.js';
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

export interface EngineOptions {
  /** Workspace directory: holds kalibra.db and blobs/. */
  dir: string;
  /** Desktop passes an OS-keychain-backed store; defaults to a 0600 file in the workspace. */
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
  embeddings: Embedder = new Embeddings(() => ({ getConnection: (id) => ConnectionSpec.parse(this.repos.defs.get('connection', id).spec), secrets: this.secrets }));
  /** Background jobs (media generation, augmentation, …). */
  readonly jobs: Jobs;

  constructor(opts: EngineOptions) {
    this.dir = resolve(opts.dir);
    mkdirSync(this.dir, { recursive: true });
    this.db = new Db(join(this.dir, 'kalibra.db'));
    this.blobs = new FsBlobStore(join(this.dir, 'blobs'), this.db);
    this.secrets = opts.secrets ?? new FileSecretStore(join(this.dir, 'secrets.json'));
    this.repos = { datasets: new DatasetRepo(this.db), defs: new DefRepo(this.db), runs: new RunRepo(this.db) };
    this.llm = createLlmClient((id) => ConnectionSpec.parse(this.repos.defs.get('connection', id).spec), this.secrets);
    this.jobs = new Jobs(this.events);
    this.registry.add(...ALL_OPS);
    this.runner = new Runner(this);
    this.runner.recover();
  }

  /**
   * Calls an operation as `actor`. Every change is logged with its actor and broadcast to listeners.
   * `role` and `caps` default to full access (the desktop's single user); the hub passes the caller's
   * real role and the server's capabilities.
   */
  async call<T = any>(name: string, input: unknown, actor: Actor = LOCAL_USER, access: { role?: ProjectRole; caps?: Capabilities } = {}): Promise<T> {
    const ctx = { engine: this, actor, role: access.role ?? 'owner', caps: access.caps ?? ALL_CAPABILITIES };
    const result = await withCall(ctx, () => this.registry.call(ctx, name, input));
    const def = this.registry.get(name)!;
    if (!def.readOnly && !def.quiet) {
      const summary = describeChange(def.title, input);
      this.db.run('INSERT INTO activity (at, actor, op, summary) VALUES (?, ?, ?, ?)', nowIso(), JSON.stringify(actor), name, summary);
      this.events.emit({ type: 'activity', op: name, summary, actor });
    }
    return result as T;
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

  close() {
    this.jobs.cancelAll();
    for (const r of this.db.all("SELECT id FROM runs WHERE status = 'running'")) this.runner.cancel(r.id);
    this.db.close();
  }
}

function describeChange(title: string, input: any): string {
  const hint = input?.name ?? input?.datasetId ?? input?.id ?? input?.runId ?? '';
  const count = Array.isArray(input?.rows) ? ` (${input.rows.length} rows)` : '';
  return `${title}${hint ? `: ${hint}` : ''}${count}`;
}
