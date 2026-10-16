import { z } from 'zod';
import type { Engine } from './engine.js';
import { KalibraError } from './util.js';

/** Who is acting. Recorded on every change for provenance (and, in server mode, permissions). */
export interface Actor {
  kind: 'user' | 'agent' | 'cli' | 'system';
  id: string;
  /** For agents: MCP client name (e.g. "claude-code") and the model it reports, when known. */
  client?: string;
  model?: string;
}

export const LOCAL_USER: Actor = { kind: 'user', id: 'local' };

export interface OpContext {
  engine: Engine;
  actor: Actor;
}

export type OpCategory = 'datasets' | 'targets' | 'suites' | 'connections' | 'runs' | 'workspace';

/**
 * One engine operation = one feature. The UI, CLI, HTTP API and MCP tools are all generated
 * from this registry, so nothing exists in the UI that an agent cannot also do.
 */
export interface OpDef<I extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  title: string;
  description: string;
  category: OpCategory;
  input: I;
  readOnly?: boolean;
  destructive?: boolean;
  /** Hidden from MCP (only for secret handling: agents never see or set secret values). */
  mcp?: false;
  /** Not shown in the activity feed (e.g. raw file uploads that are part of a bigger action). */
  quiet?: boolean;
  handler: (ctx: OpContext, input: z.infer<I>) => Promise<O> | O;
}

export function defineOp<I extends z.ZodType, O>(def: OpDef<I, O>): OpDef<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`Bad op name: ${def.name}`);
  return def;
}

export class Registry {
  private ops = new Map<string, OpDef<any, any>>();

  add(...defs: OpDef<any, any>[]) {
    for (const d of defs) {
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
      inputSchema: z.toJSONSchema(d.input, { io: 'input', unrepresentable: 'any' }),
    }));
  }

  async call(ctx: OpContext, name: string, rawInput: unknown) {
    const def = this.ops.get(name);
    if (!def) throw new KalibraError('not_found', `Unknown operation: ${name}`);
    // Hidden from MCP is not enough: an agent can still name the op directly.
    if (def.mcp === false && ctx.actor.kind === 'agent') throw new KalibraError('forbidden', `${def.title} is only available in the Kalibra app`);
    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new KalibraError('invalid', `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`, parsed.error.issues);
    }
    return def.handler(ctx, parsed.data);
  }
}
