/*
 * kalibra-sdk: report what happens inside your AI app to Kalibra, link it to eval runs, and make
 * tools replayable. Everything is optional and can be switched off for production; see README.
 *
 *   import { kalibra } from 'kalibra-sdk';
 *   kalibra.init({ enabled: process.env.NODE_ENV !== 'production', key: process.env.KALIBRA_KEY, project: 'Support bot' });
 *   export const answer = kalibra.trace('answer', async (q) => kalibra.step('llm', () => llm(q), { kind: 'llm' }));
 *
 * Module map:
 *   config.ts     settings and environment variables, the on/off decision
 *   tracer.ts     trace / step / handles / sampling / span limits
 *   context.ts    AsyncLocalStorage context (current trace, span, eval-run link)
 *   headers.ts    Kalibra request headers → middleware() / fromRequest()
 *   tools.ts      tool wrapper: live / record / replay / fault modes, canonical args hash
 *   exporter.ts   background queue and sending (batching, retries, limits)
 *   serialize.ts  bounded JSON-safe copies of inputs and outputs
 *   redact.ts     personal data and secret removal (runs at send time)
 *   evaluate.ts   evals as code (also exported from 'kalibra-sdk/eval')
 */

import { fromRequest, middleware, linkFromHeaders } from './headers.js';
import { tool, toolMode, canonicalJson, argsHash } from './tools.js';
import { currentSpan, currentTrace, flush, getConfig, init, isEnabled, shutdown, step, trace, SDK_VERSION } from './tracer.js';

export { init, trace, step, tool, middleware, fromRequest, flush, shutdown, currentTrace, currentSpan, isEnabled, getConfig, toolMode, canonicalJson, argsHash, linkFromHeaders, SDK_VERSION };
export { evaluate, KalibraEvalError, resolveConnection, toOutputs } from './evaluate.js';
export { redactString, redactValue, REDACTED } from './redact.js';
export { toJsonSafe, MAX_FIELD_BYTES } from './serialize.js';
export type { KalibraOptions, Redactor } from './config.js';
export type { SpanHandle, TraceHandle, TraceOptions, StepOptions, SpanKind } from './tracer.js';
export type { ToolMode } from './tools.js';
export type { HeaderSource } from './headers.js';
export type { RunLink } from './context.js';
export type { TraceIn, SpanIn } from './exporter.js';
export type { EvaluateOptions, EvaluateResult, EvalRow } from './evaluate.js';

/** The SDK as one object: `kalibra.init()`, `kalibra.trace()`, … */
export const kalibra = {
  init,
  trace,
  step,
  tool,
  middleware,
  fromRequest,
  flush,
  shutdown,
  currentTrace,
  currentSpan,
  isEnabled,
  get version() {
    return SDK_VERSION;
  },
};

export default kalibra;
