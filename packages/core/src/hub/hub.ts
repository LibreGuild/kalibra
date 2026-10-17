import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Db } from '../db.js';
import { Engine } from '../engine.js';
import { ALL_CAPABILITIES, Registry, type Actor, type Capabilities, type ProjectRole } from '../registry.js';
import type { SecretStore } from '../storage.js';
import { KalibraError, notFound, nowIso, parseJson } from '../util.js';
import { Accounts } from './accounts.js';
import { HUB_OPS, type HubOpContext, type HubOpDef } from './ops.js';
import { randomSecret } from './passwords.js';
import { DEFAULT_PROJECT, Projects } from './projects.js';
import { HUB_MIGRATIONS } from './schema.js';
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
  codePolicy: z
    .enum(['everyone', 'admins'])
    .default('everyone')
    .describe('Who may add or change JavaScript (script targets, hooks, script checks). It runs on the server with the server’s permissions.'),
  sessionDays: z.number().int().min(1).max(365).default(14).describe('How long a sign-in lasts'),
});
export type ServerSettings = z.infer<typeof ServerSettings>;

export interface HubOptions {
  /** The hub folder (KALIBRA_DIR, or ~/Kalibra/default). */
  dir: string;
  mode: HubMode;
  /** Secret store for a project folder. Defaults to a 0600 file in the folder; the desktop passes an OS-keychain one. */
  secretsFor?: (projectDir: string) => SecretStore;
  /** Server only: folder sync may only use folders inside this one. Unset turns folder sync off on servers. */
  folderRoot?: string;
}

export class Hub {
  readonly dir: string;
  readonly mode: HubMode;
  readonly db: Db;
  readonly accounts: Accounts;
  readonly projects: Projects;
  readonly registry = new Registry<HubOpContext, HubOpDef>({
    authorize: (def, ctx) => {
      if (def.serverOnly && this.mode === 'local') throw new KalibraError('unavailable', `${def.title} is only available on a team server`);
      if (def.access === 'admin' && ctx.principal.user.role !== 'admin') throw new KalibraError('forbidden', `${def.title} is for administrators`);
      // Tokens let agents and scripts work in projects; managing accounts needs someone signed in.
      if (def.mcp === false && ctx.principal.tokenId) throw new KalibraError('forbidden', `${def.title} needs you to be signed in to the Kalibra app (not an access token)`);
    },
    accessOf: (def) => def.access,
  });
  private engines = new Map<string, Engine>();
  /** One-time code that lets the first administrator be created on a fresh server (see completeSetup). */
  private setup?: string;

  constructor(private opts: HubOptions) {
    this.dir = resolve(opts.dir);
    this.mode = opts.mode;
    mkdirSync(this.dir, { recursive: true });
    this.db = new Db(join(this.dir, 'hub.db'), HUB_MIGRATIONS);
    this.accounts = new Accounts(this.db);
    this.projects = new Projects(this.db);
    this.projects.ensureDefault(this.mode === 'local' ? 'My project' : 'Default');
    this.registry.add(...HUB_OPS);
    this.accounts.pruneSessions();
    if (this.needsSetup()) this.setup = randomSecret(18);
  }

  // ── Settings and audit ────────────────────────────────────────────────────

  settings(): ServerSettings {
    const stored = parseJson<Record<string, unknown>>(this.db.get("SELECT value FROM settings WHERE key = 'server'")?.value, {});
    return ServerSettings.parse(stored);
  }

  updateSettings(patch: Partial<ServerSettings>): ServerSettings {
    const next = ServerSettings.parse({ ...this.settings(), ...patch });
    this.db.run("INSERT INTO settings (key, value) VALUES ('server', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
    return next;
  }

  /** Records a security-relevant event (sign-ins, account and permission changes). */
  audit(actor: Actor | { kind: 'anonymous'; id: string }, action: string, subject = '', details: unknown = {}, ip = '') {
    this.db.run('INSERT INTO audit (at, actor, action, subject, details, ip) VALUES (?, ?, ?, ?, ?, ?)', nowIso(), JSON.stringify(actor), action, subject, JSON.stringify(details ?? {}), ip.slice(0, 64));
  }

  // ── First administrator ───────────────────────────────────────────────────

  /** A server with no active administrator must be set up before anyone can sign in. */
  needsSetup() {
    return this.mode === 'server' && this.accounts.countAdmins() === 0;
  }

  /** The one-time setup code to print at startup (undefined once an administrator exists). */
  setupCode() {
    return this.needsSetup() ? (this.setup ??= randomSecret(18)) : undefined;
  }

  /** Creates the first administrator, with the code printed at startup. */
  async completeSetup(code: string, input: { username: string; password: string; name?: string; email?: string }, ip = ''): Promise<User> {
    const expected = this.setupCode();
    if (!expected) throw new KalibraError('conflict', 'This server is already set up. Sign in instead.');
    if (!code || code !== expected) {
      this.audit({ kind: 'anonymous', id: '' }, 'setup.failed', '', {}, ip);
      throw new KalibraError('forbidden', 'The setup code is wrong. Use the link printed when the server started.');
    }
    const user = await this.accounts.create({ ...input, role: 'admin' }, 'setup');
    this.setup = undefined;
    this.audit({ kind: 'user', id: user.id, name: user.name }, 'setup.completed', user.username, {}, ip);
    return user;
  }

  /** Creates (or resets) an administrator from configuration, e.g. KALIBRA_ADMIN_USERNAME/PASSWORD. */
  async ensureAdmin(username: string, password: string): Promise<User> {
    const existing = this.accounts.find(username);
    if (existing) {
      if (existing.role !== 'admin' || existing.disabled) this.accounts.update(existing.id, { role: 'admin', disabled: false });
      return this.accounts.get(existing.id);
    }
    const user = await this.accounts.create({ username, password, role: 'admin' }, 'config');
    this.audit({ kind: 'system', id: 'config' }, 'user.created', user.username, { role: 'admin', from: 'environment' });
    return user;
  }

  // ── Who is calling ────────────────────────────────────────────────────────

  /** The principal for local mode (desktop / npx), where the per-launch token already proved who it is. */
  localPrincipal(via: Principal['via'] = 'user', client?: string, model?: string): Principal {
    if (this.mode !== 'local') throw new KalibraError('forbidden', 'Sign in required');
    return { user: LOCAL_ACCOUNT, via, ...(client ? { client } : {}), ...(model ? { model } : {}) };
  }

  /** The caller's role in a project, or undefined when they may not see it at all. */
  roleIn(p: Principal, projectId: string): ProjectRole | undefined {
    if (this.mode === 'local' || p.user.role === 'admin') return 'owner';
    return this.projects.memberRole(projectId, p.user.id);
  }

  /** What this caller may do beyond their role: code and the server's disk (see policy.ts). */
  capsFor(p: Principal): Capabilities {
    if (this.mode === 'local') return ALL_CAPABILITIES;
    const s = this.settings();
    return {
      code: s.codePolicy === 'everyone' || p.user.role === 'admin',
      filesystem: !!this.opts.folderRoot,
      ...(this.opts.folderRoot ? { folderRoot: this.opts.folderRoot } : {}),
      showPaths: false,
    };
  }

  /** A live project the caller can see. Others look like they don't exist (no probing for names). */
  projectFor(p: Principal, idOrName: string): { project: Project; role: ProjectRole } {
    const project = this.projects.get(idOrName);
    const role = this.roleIn(p, project.id);
    if (!role) throw notFound('Project', idOrName);
    return { project, role };
  }

  /** Projects the caller can see, with their role in each. */
  visibleProjects(p: Principal): (Project & { role: ProjectRole })[] {
    const all = this.projects.list();
    if (this.mode === 'local' || p.user.role === 'admin') return all.map((x) => ({ ...x, role: 'owner' as const }));
    const roles = this.projects.rolesOf(p.user.id);
    return all.filter((x) => roles.has(x.id)).map((x) => ({ ...x, role: roles.get(x.id)! }));
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  /** Calls a project operation as `p`. The only way the HTTP API, CLI and MCP reach project data. */
  async callProject<T = any>(p: Principal, projectId: string, name: string, input: unknown): Promise<T> {
    const { project, role } = this.projectFor(p, projectId);
    const engine = this.engine(project.id);
    if (p.tokenId && engine.registry.get(name)?.mcp === false) throw new KalibraError('forbidden', 'This operation needs you to be signed in to the Kalibra app (not an access token)');
    return engine.call<T>(name, input, actorOf(p), { role, caps: this.capsFor(p) });
  }

  /** Calls a hub operation (accounts, projects, members, settings) as `p`. */
  async call<T = any>(p: Principal, name: string, input: unknown, meta: { ip?: string } = {}): Promise<T> {
    return (await this.registry.call({ hub: this, principal: p, actor: actorOf(p), ip: meta.ip ?? '' }, name, input)) as T;
  }

  // ── Project engines ───────────────────────────────────────────────────────

  /** The engine of a live project, opened on first use and kept open. */
  engine(projectId: string): Engine {
    const project = this.projects.get(projectId);
    let engine = this.engines.get(project.id);
    if (!engine) {
      const dir = resolve(this.dir, project.dir);
      engine = new Engine({ dir, ...(this.opts.secretsFor ? { secrets: this.opts.secretsFor(dir) } : {}) });
      this.engines.set(project.id, engine);
    }
    return engine;
  }

  /** Opens every live project, so runs left running by a crash are marked interrupted right away. */
  openAll() {
    for (const p of this.projects.list()) this.engine(p.id);
  }

  /** Closes a project's engine (when it moves to the trash). */
  closeEngine(projectId: string) {
    this.engines.get(projectId)?.close();
    this.engines.delete(projectId);
  }

  close() {
    for (const e of this.engines.values()) e.close();
    this.engines.clear();
    this.db.close();
  }
}

export { DEFAULT_PROJECT };
