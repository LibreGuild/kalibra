/*
 * Where the SDK keeps "what is running now": the current trace and span, and the link to a Kalibra
 * eval row when the request came from a Kalibra run. It travels with async calls through Node's
 * AsyncLocalStorage, so nested `trace`/`step`/`tool` calls find their parent without arguments.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceState, SpanState } from './tracer.js';

/** Set from the headers Kalibra sends to your app during an eval run (see headers.ts). */
export interface RunLink {
  runId?: string;
  resultId?: string;
  /** From `traceparent`: the first trace in this request uses it as its id. */
  traceId?: string;
  parentSpanId?: string;
  /** `x-kalibra-tools`: live | record | replay | replay-strict | fault:… */
  tools?: string;
  /** Code runs (evaluate): the dataset row this task call is for. */
  rowId?: string;
  /** Code runs: ids of the traces this task call produced. */
  traceIds?: string[];
  usedTraceId?: boolean;
}

export interface Ctx {
  link?: RunLink;
  trace?: TraceState;
  /** The innermost open span; new spans become its children. */
  span?: SpanState;
  /** Inside a trace that was not sampled: nested calls skip all work. */
  unsampled?: boolean;
}

export const storage = new AsyncLocalStorage<Ctx>();

export const current = (): Ctx | undefined => storage.getStore();
