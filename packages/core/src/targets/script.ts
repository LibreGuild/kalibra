import WebSocket from 'ws';
import { runScript } from '../script.js';
import type { ScriptTargetConfig, TargetSpec } from '../specs.js';
import type { TargetCallContext, TargetCallResult } from './types.js';
import { describeError, failure, isFileValue, makeLogger, now } from './common.js';

/*
 * Script target: the user's own JS calls the app however it needs to (custom protocols, SDKs,
 * multi-step flows). Return an object of output fields, or a string for `output`.
 * A returned `metrics` object is merged into the measured metrics.
 */
export async function executeScript(spec: TargetSpec, ctx: TargetCallContext): Promise<TargetCallResult> {
  const cfg = spec.config as ScriptTargetConfig;
  const { logs, log } = makeLogger(ctx);
  const started = now();
  const readFile = async (value: unknown) => {
    if (!isFileValue(value)) throw new Error('readFile expects a file value (an audio, image or file column)');
    return ctx.env.loadFile!(value);
  };
  try {
    const result = await runScript(
      cfg.code,
      { row: ctx.row, vars: ctx.vars, row_id: ctx.rowId, fetch, WebSocket, readFile, log, llm: ctx.llm, signal: ctx.signal },
      { log, timeoutMs: cfg.timeoutMs, requireFrom: ctx.workspaceDir, filename: 'target.js' },
    );
    const metrics: Record<string, number> = { latency_ms: Math.round(now() - started) };
    let outputs: Record<string, unknown>;
    if (result && typeof result === 'object' && !Array.isArray(result) && !Buffer.isBuffer(result)) {
      const { metrics: extra, ...rest } = result as Record<string, any>;
      if (extra && typeof extra === 'object') Object.assign(metrics, extra);
      outputs = rest;
    } else {
      outputs = { output: result };
    }
    return { ok: true, outputs, metrics, logs, response: { body: result as unknown } };
  } catch (e) {
    const { message } = describeError(e, cfg.timeoutMs, ctx.signal);
    return failure(message, logs, { metrics: { latency_ms: Math.round(now() - started) }, retryable: /timed out/i.test(message) });
  }
}
