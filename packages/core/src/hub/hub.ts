import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { publicOrigin } from '../base-path.js';
import { HubCache } from '../coord/cache.js';
import { LocalCoordinator, type Coordinator } from '../coord/coordinator.js';
import type { EngineEvent } from '../events.js';
import type { LeaseTiming } from '../runner/runner.js';
import { type Db } from '../db.js';
import { defaultDatabases, type Databases } from '../deploy/databases.js';
import { Engine } from '../engine.js';
import { ALL_CAPABILITIES, Registry, type Actor, type Capabilities, type ProjectRole } from '../registry.js';
import { FileSecretStore, type SecretStore } from '../storage.js';
import type { StorageHooks } from '../deploy/storage.js';
import { KalibraError, notFound, nowIso, parseJson } from '../util.js';
import { Accounts } from './accounts.js';
import { HUB_OPS, type HubOpContext, type HubOpDef } from './ops.js';
import { randomSecret } from './passwords.js';
import { DEFAULT_PROJECT, Projects } from './projects.js';
import { Providers } from './providers.js';
import { SsoService } from './sso.js';
import { IngestKeys } from './ingest-keys.js';
import { actorOf, LOCAL_ACCOUNT, type HubMode, type Principal, type Project, type User } from './types.js';

/*
 * The hub sits above projects. It owns accounts and the project list, opens one Engine per
 * project, and is the single place where a caller's access is decided:
 *
 *   HTTP / MCP / CLI ──► Hub.callProject(principal, project, op, input)
 *                          ├─ project exists and is live?
 *                          ├─ caller's role in it (member, group, or server admin)?
 *                          └─ Engine.call(op, input, actor, { role, caps })  ── checks the op's needed role
 *
 * Folder layout (the hub folder is the old workspace folder, so existing data keeps working):
 *   <dir>/hub.db                accounts, sessions, tokens, projects, members, settings, audit
 *   <dir>/kalibra.db, blobs/    the default project
 *   <dir>/projects/<id>/        every other project (its own kalibra.db, blobs/, secrets)
 */

/** Server settings an administrator can change in the app. */
export const ServerSettings = z.object({
  allowProjectCreation: z.boolean().default(true).describe('Let every signed-in user create projects (otherwise only administrators)'),
  // Admins by default: JavaScript runs on the server with its permissions (Node's vm is no sandbox),
  // so whoever may write it can read every project. Teams that trust all editors can open it up.
  codePolicy: z
    .enum(['everyone', 'admins'])
    .default('admins')
    .describe('Who may add or change JavaScript (script targets, hooks, script checks). It runs on the server with the server’s permissions.'),
  sessionDays: z.number().int().min(1).max(365).default(14).describe('How long a sign-in lasts'),
  passwordLogin: z
    .boolean()
    .default(true)
    .describe('Allow signing in with a username and password. When off, only administrators can (so a broken sign-in provider never locks everyone out).'),
});
export type ServerSettings = z.infer<typeof ServerSettings>;

export interface HubOptions {
  /** The hub folder (KALIBRA_DIR, or ~/Kalibra/default). */
  dir: string;
  mode: HubMode;
  /** Secret store for a project folder. Defaults to a 0600 file in the folder. */
  secretsFor?: (projectDir: string) => SecretStore;
  /** Server only: folder sync may only use folders inside this one. Unset turns folder sync off on servers. */
  folderRoot?: string;
  /** The address people use (https://kalibra.example.com); shown as the sign-in callback base. */
  publicUrl?: string;
  /** Sign-in providers from configuration (see providersFromEnv). Read-only in the app. */
  authProviders?: { config: unknown; clientSecret?: string }[];
  /** Where client secrets of sign-in providers made in the app are kept. Defaults to hub-secrets.json (0600). */
  hubSecrets?: SecretStore;
  /** Where files and secrets go when not in the data folder (a bucket, the database): see deploy/storage.ts. */
  storage?: StorageHooks;
  /**
   * Project engines kept open at once (each holds ~4 open files). Beyond this, engines that have
   * been idle for a while are closed and reopened on next use. Default 64.
   */
  maxOpenProjects?: number;
  /**
   * What instances share (KALIBRA_REDIS_URL: Redis; default: this process only). With Redis, live
   * events, cancels, job status, sign-in limits and the lookup cache reach every instance, and runs
   * move to another instance when theirs stops.
   */
  coordinator?: Coordinator;
  /** Cache session, token, role, project and settings lookups (default: with Redis or Postgres, where they cost a round trip). */
  cache?: boolean;
  /** Run lease timings (tests shorten them). */
  runLease?: Partial<LeaseTiming>;
  /** Where the hub and project databases live (SQLite files by default, or Postgres); closed with the hub. */
  databases?: Databases;
}

/** An open project is only closed to make room after this long without use. */
const IDLE_CLOSE_MS = 10 * 60_000;

export class Hub {
  readonly dir: string;
  readonly mode: HubMode;
  readonly db: Db;
  readonly accounts: Accounts;
  readonly projects: Projects;
  readonly providers: Providers;
  readonly sso: SsoService;
  /** Keys apps use to send traces to one project (SDK, OpenTelemetry, proxy). */
  readonly ingestKeys: IngestKeys;
  readonly registry = new Registry<HubOpContext, HubOpDef>({
    authorize: (def, ctx) => {
      if (def.serverOnly && this.mode === 'local') throw new KalibraError('unavailable', `${def.title} is only available on a team server`);
      if (def.access === 'admin' && ctx.principal.user.role !== 'admin') throw new KalibraError('forbidden', `${def.title} is for administrators`);
      // Tokens let agents and scripts work in projects; managing accounts needs someone signed in.
      if (def.mcp === false && ctx.principal.tokenId) throw new KalibraError('forbidden', `${def.title} needs you to be signed in to the Kalibra app (not an access token)`);
    },
    accessOf: (def) => def.access,
  });
  /** Open project engines, least recently used first, with when each was last used. */
  private engines = new Map<string, Engine>();
  private opening = new Map<string, Promise<Engine>>();
  private lastUsed = new Map<string, number>();
  /** One-time code that lets the first administrator be created on a fresh server (see completeSetup). */
  private setup?: string;
  /** Messages, cache and locks shared with other instances (in memory when this is the only one). */
  readonly coordinator: Coordinator;
  /** Short-lived cache of per-request lookups, invalidated by any hub write (see HubCache). */
  readonly cache: HubCache;
  private ownsCoordinator: boolean;
  private stopListening: (() => void)[] = [];

  /** Opens (and migrates) the hub in `opts.dir`, creating the default project when there is none. */
  static async open(opts: HubOptions): Promise<Hub> {
    const dir = resolve(opts.dir);
    mkdirSync(dir, { recursive: true });
    const databases = opts.databases ?? defaultDatabases(dir);
    const db = await databases.hub(dir);
    try {
      const hub = new Hub({ ...opts, dir, databases }, db);
      await hub.projects.ensureDefault(hub.mode === 'local' ? 'My project' : 'Default');
      await hub.accounts.pruneSessions();
      if (hub.coordinator.kind === 'local' && (await hub.needsSetup())) hub.setup = randomSecret(18);
      return hub;
    } catch (e) {
      await db.close();
      throw e;
    }
  }

  private constructor(
    private opts: HubOptions,
    db: Db,
  ) {
    this.dir = opts.dir;
    this.mode = opts.mode;
    this.ownsCoordinator = !opts.coordinator;
    this.coordinator = opts.coordinator ?? new LocalCoordinator();
    this.cache = new HubCache(this.coordinator, opts.cache ?? (this.coordinator.kind !== 'local' || db.dialect === 'postgres'));
    // Every hub write that could change a cached lookup invalidates the cache, on every instance.
    this.db = this.cache.watch(db);
    this.accounts = new Accounts(this.db, this.cache);
    this.projects = new Projects(this.db, this.cache);
    const hubSecrets = opts.storage?.secrets?.(this.db, join(this.dir, 'hub-secrets.json'), 'hub') ?? opts.hubSecrets ?? new FileSecretStore(join(this.dir, 'hub-secrets.json'));
    this.providers = new Providers(this.db, hubSecrets, opts.authProviders);
    this.sso = new SsoService(this);
    this.ingestKeys = new IngestKeys(this.db, this.cache);
    this.registry.add(...HUB_OPS);
    if (this.coordinator.kind !== 'local') this.listen();
  }

  /** Several instances: events raised on others reach live streams here; cancels reach the runs and jobs they name. */
  private listen() {
    const me = this.coordinator.instanceId;
    this.stopListening.push(
      this.coordinator.subscribe('events', (raw) => {
        const m = JSON.parse(raw) as { o: string; p: string; e: EngineEvent };
        if (m.o !== me) this.engines.get(m.p)?.events.deliver(m.e);
      }),
      this.coordinator.subscribe('control', (raw) => {
        const m = JSON.parse(raw) as { type: string; project: string; runId?: string; jobId?: string };
        const engine = this.engines.get(m.project);
        if (m.type === 'cancel-run' && m.runId) engine?.runner.cancelLocal(m.runId);
        if (m.type === 'cancel-job' && m.jobId) engine?.jobs.cancel(m.jobId);
      }),
    );
  }

  // ── Settings and audit ────────────────────────────────────────────────────

  async settings(): Promise<ServerSettings> {
    const stored = await this.cache.lookup('settings', async () => parseJson<Record<string, unknown>>((await this.db.get("SELECT value FROM settings WHERE key = 'server'"))?.value, {}));
    return ServerSettings.parse(stored ?? {});
  }

  async updateSettings(patch: Partial<ServerSettings>): Promise<ServerSettings> {
    return this.db.tx(async () => {
      const next = ServerSettings.parse({ ...(await this.settings()), ...patch });
      await this.db.run("INSERT INTO settings (key, value) VALUES ('server', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
      return next;
    });
  }

  /** Records a security-relevant event (sign-ins, account and permission changes). */
  async audit(actor: Actor | { kind: 'anonymous'; id: string }, action: string, subject = '', details: unknown = {}, ip = '') {
    await this.db.run('INSERT INTO audit (at, actor, action, subject, details, ip) VALUES (?, ?, ?, ?, ?, ?)', nowIso(), JSON.stringify(actor), action, subject, JSON.stringify(details ?? {}), ip.slice(0, 64));
  }

  /** The public origin for sign-in callbacks, when configured (Kalibra itself lives under BASE_PATH there). */
  publicUrl(): string | undefined {
    return publicOrigin(this.opts.publicUrl);
  }

  // ── First administrator ───────────────────────────────────────────────────

  /** A server with no active administrator must be set up before anyone can sign in. */
  async needsSetup() {
    return this.mode === 'server' && await this.accounts.countAdmins() === 0;
  }

  /** The one-time setup code to print at startup (undefined once an administrator exists). */
  async setupCode() {
    if (!(await this.needsSetup())) return undefined;
    if (this.coordinator.kind === 'local') return (this.setup ??= randomSecret(18));
    // Several instances print the same link: the code lives in the database, made by whichever starts first.
    await this.db.run("INSERT INTO settings (key, value) VALUES ('setup', ?) ON CONFLICT (key) DO NOTHING", JSON.stringify(randomSecret(18)));
    return parseJson<string>((await this.db.get("SELECT value FROM settings WHERE key = 'setup'"))?.value, '') || undefined;
  }

  /** Creates the first administrator, with the code printed at startup. */
  async completeSetup(code: string, input: { username: string; password: string; name?: string; email?: string }, ip = ''): Promise<User> {
    const expected = await this.setupCode();
    if (!expected) throw new KalibraError('conflict', 'This server is already set up. Sign in instead.');
    if (!sameSecret(code, expected)) {
      await this.audit({ kind: 'anonymous', id: '' }, 'setup.failed', '', {}, ip);
      throw new KalibraError('forbidden', 'The setup code is wrong. Use the link printed when the server started.');
    }
    const user = await this.accounts.create({ ...input, role: 'admin' }, 'setup');
    await this.accounts.markLogin(user.id);
    this.setup = undefined;
    await this.db.run("DELETE FROM settings WHERE key = 'setup'");
    await this.audit({ kind: 'user', id: user.id, name: user.name }, 'setup.completed', user.username, {}, ip);
    return user;
  }

  /**
   * Creates (or resets) an administrator from configuration, e.g. KALIBRA_ADMIN_USERNAME/PASSWORD.
   * An existing account with that name gets the configured password too: whoever holds the
   * configuration gets the account, not whoever happened to own the username.
   */
  async ensureAdmin(username: string, password: string): Promise<User> {
    const existing = await this.accounts.find(username);
    if (existing) {
      await this.accounts.setPassword(existing.id, password);
      await this.accounts.revokeAllSessions(existing.id);
      if (existing.role !== 'admin' || existing.disabled) await this.accounts.update(existing.id, { role: 'admin', disabled: false });
      await this.audit({ kind: 'system', id: 'config' }, 'password.reset', existing.username, { role: 'admin', from: 'environment' });
      return await this.accounts.get(existing.id);
    }
    const user = await this.accounts.create({ username, password, role: 'admin' }, 'config');
    await this.audit({ kind: 'system', id: 'config' }, 'user.created', user.username, { role: 'admin', from: 'environment' });
    return user;
  }

  // ── Who is calling ────────────────────────────────────────────────────────

  /** The principal for local mode (`npx kalibra`), where the per-launch token already proved who it is. */
  localPrincipal(via: Principal['via'] = 'user', client?: string, model?: string): Principal {
    if (this.mode !== 'local') throw new KalibraError('forbidden', 'Sign in required');
    return { user: LOCAL_ACCOUNT, via, ...(client ? { client } : {}), ...(model ? { model } : {}) };
  }

  /** The caller's role in a project, or undefined when they may not see it at all. */
  async roleIn(p: Principal, projectId: string): Promise<ProjectRole | undefined> {
    if (this.mode === 'local' || p.user.role === 'admin') return 'owner';
    return await this.projects.memberRole(projectId, p.user.id);
  }

  /** What this caller may do beyond their role: code and the server's disk (see policy.ts). */
  async capsFor(p: Principal): Promise<Capabilities> {
    if (this.mode === 'local') return ALL_CAPABILITIES;
    const s = await this.settings();
    return {
      code: s.codePolicy === 'everyone' || p.user.role === 'admin',
      filesystem: !!this.opts.folderRoot,
      ...(this.opts.folderRoot ? { folderRoot: this.opts.folderRoot } : {}),
      showPaths: false,
    };
  }

  /** A live project the caller can see. Others look like they don't exist (no probing for names). */
  async projectFor(p: Principal, idOrName: string): Promise<{ project: Project; role: ProjectRole }> {
    const project = await this.projects.get(idOrName);
    const role = await this.roleIn(p, project.id);
    if (!role) throw notFound('Project', idOrName);
    return { project, role };
  }

  /** Projects the caller can see, with their role in each. */
  async visibleProjects(p: Principal): Promise<(Project & { role: ProjectRole })[]> {
    const all = await this.projects.list();
    if (this.mode === 'local' || p.user.role === 'admin') return all.map((x) => ({ ...x, role: 'owner' as const }));
    const roles = await this.projects.rolesOf(p.user.id);
    return all.filter((x) => roles.has(x.id)).map((x) => ({ ...x, role: roles.get(x.id)! }));
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  /** Calls a project operation as `p`. The only way the HTTP API, CLI and MCP reach project data. */
  async callProject<T = any>(p: Principal, projectId: string, name: string, input: unknown): Promise<T> {
    const { project, role } = await this.projectFor(p, projectId);
    const engine = await this.engine(project.id);
    if (p.tokenId && engine.registry.get(name)?.mcp === false) throw new KalibraError('forbidden', 'This operation needs you to be signed in to the Kalibra app (not an access token)');
    return engine.call<T>(name, input, actorOf(p), { role, caps: await this.capsFor(p) });
  }

  /** Calls a hub operation (accounts, projects, members, settings) as `p`. */
  async call<T = any>(p: Principal, name: string, input: unknown, meta: { ip?: string } = {}): Promise<T> {
    return (await this.registry.call({ hub: this, principal: p, actor: actorOf(p), ip: meta.ip ?? '' }, name, input)) as T;
  }

  // ── Project engines ───────────────────────────────────────────────────────

  /** The engine of a live project, opened on first use and kept open. */
  async engine(projectId: string): Promise<Engine> {
    const project = await this.projects.get(projectId);
    let engine = this.engines.get(project.id);
    if (!engine) {
      // Concurrent first calls share one opening, so a project is never opened twice.
      let opening = this.opening.get(project.id);
      if (!opening) {
        const dir = resolve(this.dir, project.dir);
        const databases = this.opts.databases!;
        opening = (async () =>
          Engine.open({
            dir,
            db: await databases.project(project.id, dir),
            storage: this.opts.storage,
            coordinator: this.coordinator,
            projectId: project.id,
            runLease: this.opts.runLease,
            ...(this.opts.secretsFor ? { secrets: this.opts.secretsFor(dir) } : {}),
          }))().finally(() =>
          this.opening.delete(project.id),
        );
        this.opening.set(project.id, opening);
      }
      engine = await opening;
    }
    this.engines.delete(project.id); // re-inserted: the map stays in use order
    this.engines.set(project.id, engine);
    this.lastUsed.set(project.id, Date.now());
    await this.closeIdle(project.id);
    return engine;
  }

  /**
   * Keeps at most maxOpenProjects engines open by closing ones that sit idle (no runs, jobs, calls
   * or live listeners) and were not used recently. Busy or recent engines are never closed, so the
   * cap can be exceeded briefly rather than interrupt work.
   */
  private async closeIdle(keep: string) {
    const max = this.opts.maxOpenProjects ?? 64;
    if (this.engines.size <= max) return;
    const cutoff = Date.now() - IDLE_CLOSE_MS;
    for (const [id, engine] of this.engines) {
      if (this.engines.size <= max) break;
      if (id === keep || (this.lastUsed.get(id) ?? 0) > cutoff || !engine.isIdle()) continue;
      await this.closeEngine(id);
    }
  }

  /**
   * Opens every live project once, so runs left running by a crash are marked interrupted right
   * away. Engines over the open limit are closed again (they reopen on use).
   */
  async openAll() {
    const max = this.opts.maxOpenProjects ?? 64;
    for (const p of await this.projects.list()) {
      const fresh = !this.engines.has(p.id);
      const engine = await this.engine(p.id);
      if (fresh && this.engines.size > max && engine.isIdle()) await this.closeEngine(p.id);
    }
  }

  /** Closes a project's engine (when it moves to the trash). */
  async closeEngine(projectId: string) {
    const engine = this.engines.get(projectId);
    this.engines.delete(projectId);
    this.lastUsed.delete(projectId);
    await engine?.close();
  }

  /** How many project engines are open (for tests and diagnostics). */
  openEngineCount() {
    return this.engines.size;
  }

  /** `handOff`: another instance takes over; runs in progress stay resumable (see Engine.close). */
  async close(opts: { handOff?: boolean } = {}) {
    for (const stop of this.stopListening.splice(0)) stop();
    const open = [...this.engines.values()];
    this.engines.clear();
    for (const e of open) await e.close(opts);
    if (this.ownsCoordinator) await this.coordinator.close();
    await this.db.close();
    await this.opts.databases?.close();
  }
}

export { DEFAULT_PROJECT };

/** Compares secrets in constant time. */
function sameSecret(given: string, expected: string) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
