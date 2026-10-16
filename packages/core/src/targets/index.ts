import type { z } from 'zod';
import { HttpTarget, ModelTarget, ScriptTarget, WsTarget, type TargetSpec } from '../specs.js';
import type { TargetCallContext, TargetCallResult } from './types.js';
import { executeHttp } from './http.js';
import { executeWebSocket } from './websocket.js';
import { executeScript } from './script.js';
import { executeModel } from './model.js';

export type { TargetCallContext, TargetCallResult, TargetExecutor } from './types.js';
export { parseCurl } from './curl.js';

const SCHEMAS: Record<string, z.ZodType> = { http: HttpTarget, websocket: WsTarget, script: ScriptTarget, model: ModelTarget };

/**
 * Fills every nested default. zod's `.default({})` returns the default object without parsing it,
 * so a second parse is what fills the fields inside nested objects (scripts, audio, incoming, …).
 */
export function normalizeTargetConfig<T extends TargetSpec['config']>(config: T): T {
  const schema = SCHEMAS[config.kind];
  return schema ? (schema.parse(schema.parse(config)) as T) : config;
}

/** Calls the app under test for one row, dispatching on the target kind. Never throws. */
export async function executeTarget(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  try {
    const normalized = { ...spec, variables: spec.variables ?? [], config: normalizeTargetConfig(spec.config) };
    switch (normalized.config.kind) {
      case 'http':
        return await executeHttp(normalized, ctx);
      case 'websocket':
        return await executeWebSocket(normalized, ctx);
      case 'script':
        return await executeScript(normalized, ctx);
      case 'model':
        return await executeModel(normalized, ctx);
      default:
        return { ok: false, outputs: {}, metrics: {}, logs: [], error: `Unknown target kind: ${(spec.config as any).kind}`, retryable: false };
    }
  } catch (e) {
    return {
      ok: false,
      outputs: {},
      metrics: {},
      logs: [{ at: Date.now(), level: 'error', message: (e as Error).stack ?? String(e) }],
      error: e instanceof Error && e.name === 'ZodError' ? `Invalid target settings: ${e.message}` : `Unexpected error: ${(e as Error).message}`,
      retryable: false,
    };
  }
}
