import { z } from 'zod';
import type { Engine } from './engine.js';
import { KalibraError } from './util.js';

/** Who is acting. Recorded on every change for provenance, and used for permissions on a server. */
export interface Actor {
  kind: 'user' | 'agent' | 'cli' | 'system';
  /** User id ("local" in local mode, where there is a single user). Agents and the CLI act for a user. */
  id: string;
  /** Display name at the time of the action, so history reads well even after renames. */
  name?: string;
  /** For agents: MCP client name (e.g. "claude-code") and the model it reports, when known. */
  client?: string;
  model?: string;
}

export const LOCAL_USER: Actor = { kind: 'user', id: 'local', name: 'You' };

/*
 * Project roles, lowest to highest. Every operation needs one of them (see `opAccess`):
 *   viewer  – read everything in the project
 *   editor  – also create, change, run and spend (model calls, test calls)
 *   owner   – also manage members, connections, secrets and anything that touches the server's disk
 */
export const PROJECT_ROLES = ['viewer', 'editor', 'owner'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export const roleAtLeast = (role: ProjectRole, needed: ProjectRole) => PROJECT_ROLES.indexOf(role) >= PROJECT_ROLES.indexOf(needed);

/**
 * What the host allows, beyond roles. Local mode allows everything; a team server can turn off
 * features that run code or read and write the server's own disk (see hub/policy.ts).
 */
export interface Capabilities {
  /** Save or run definitions that contain JavaScript (script targets, hooks, expressions, JS checks). */
  code: boolean;
  /** Read and write folders on the engine's machine (folder sync). */
  filesystem: boolean;
  /** When set, folder paths must be inside this directory. */
  folderRoot?: string;
  /** Show machine paths (workspace folder, model folder) in results. Off on servers. */
  showPaths: boolean;
}

export const ALL_CAPABILITIES: Capabilities = { code: true, filesystem: true, showPaths: true };

export interface OpContext {
  engine: Engine;
  actor: Actor;
  /** The caller's role in this project (always owner in local mode). Checked before the handler runs. */
  role: ProjectRole;
  caps: Capabilities;
}

export type OpCategory = 'datasets' | 'targets' | 'suites' | 'connections' | 'runs' | 'workspace';

/** Fields every operation has, whichever registry it lives in (project operations or hub operations). */
export interface BaseOpDef<C, I extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  title: string;
  description: string;
  category: string;
  input: I;
  readOnly?: boolean;
  destructive?: boolean;
  /** Hidden from MCP (secret handling, account management): agents never see or call these. */
  mcp?: false;
  /** Not shown in the activity feed (e.g. raw file uploads that are part of a bigger action). */
  quiet?: boolean;
  handler: (ctx: C, input: z.infer<I>) => Promise<O> | O;
}

/**
 * One engine operation = one feature. The UI, CLI, HTTP API and MCP tools are all generated
 * from this registry, so nothing exists in the UI that an agent cannot also do.
 */
export interface OpDef<I extends z.ZodType = z.ZodType, O = unknown> extends BaseOpDef<OpContext, I, O> {
  category: OpCategory;
  /**
   * Lowest project role allowed to call this. Defaults to viewer for read-only operations and
   * editor for the rest. Set it when that default is wrong, e.g. a read-only call that spends
   * money or uses secrets (editor), or one that manages secrets or the disk (owner).
   */
  access?: ProjectRole;
}

export function defineOp<I extends z.ZodType, O>(def: OpDef<I, O>): OpDef<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`Bad op name: ${def.name}`);
  return def;
}

/** The role an operation needs. */
export const opAccess = (def: OpDef<any, any>): ProjectRole => def.access ?? (def.readOnly ? 'viewer' : 'editor');

/**
 * A set of operations with input validation and an authorization hook. Project operations and
 * hub operations (accounts, projects, members) each have one.
 */
export class Registry<C extends { actor: Actor } = OpContext, D extends BaseOpDef<any, any, any> = OpDef<any, any>> {
  private ops = new Map<string, D>();

  /**
   * `authorize` throws when `ctx` may not call `def` (it runs before input validation);
   * `accessOf` names the permission an op needs, for describe().
   */
  constructor(private hooks: { authorize?: (def: D, ctx: C) => void; accessOf?: (def: D) => string } = {}) {}

  add(...defs: D[]) {
    for (const d of defs) {
      if (!/^[a-z][a-z0-9_]*$/.test(d.name)) throw new Error(`Bad op name: ${d.name}`);
      if (this.ops.has(d.name)) throw new Error(`Duplicate op: ${d.name}`);
      this.ops.set(d.name, d);
    }
  }

  get(name: string) {
    return this.ops.get(name);
  }

  list() {
    return [...this.ops.values()];
  }

  /** Public description of every op (for the API, CLI help and MCP tool generation). */
  describe() {
    return this.list().map((d) => ({
      name: d.name,
      title: d.title,
      description: d.description,
      category: d.category,
      readOnly: !!d.readOnly,
      destructive: !!d.destructive,
      mcp: d.mcp !== false,
      ...(this.hooks.accessOf ? { access: this.hooks.accessOf(d) } : {}),
      inputSchema: z.toJSONSchema(d.input, { io: 'input', unrepresentable: 'any' }),
    }));
  }

  async call(ctx: C, name: string, rawInput: unknown) {
    const def = this.ops.get(name);
    if (!def) throw new KalibraError('not_found', `Unknown operation: ${name}`);
    // Hidden from MCP is not enough: an agent can still name the op directly.
    if (def.mcp === false && ctx.actor.kind === 'agent') throw new KalibraError('forbidden', `${def.title} is only available in the Kalibra app`);
    this.hooks.authorize?.(def, ctx);
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new KalibraError('invalid', `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, parsed.error.issues);
    }
    return def.handler(ctx, parsed.data);
  }
}
