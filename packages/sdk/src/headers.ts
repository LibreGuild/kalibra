/*
 * Linking traces to Kalibra eval runs. During a run Kalibra calls your app with these headers:
 *
 *   traceparent: 00-<traceId>-<spanId>-01   (W3C Trace Context)
 *   x-kalibra-run: <runId>
 *   x-kalibra-result: <resultId>            (the eval row)
 *   x-kalibra-tools: live | record | replay | replay-strict | fault:timeout | fault:error | fault:empty
 *
 * `middleware()` (Express/Connect) or `fromRequest(req)` (anything else) reads them, so the traces
 * your code produces for that request are attached to the right row in Kalibra.
 */

import { current, storage, type RunLink } from './context.js';

/** Node IncomingMessage, a fetch Request, a Headers object, or a plain header object. */
export type HeaderSource =
  | { headers: Record<string, string | string[] | undefined> | { get(name: string): string | null } }
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function getter(src: HeaderSource): (name: string) => string | undefined {
  const holder: any = src && typeof (src as any).headers === 'object' && (src as any).headers !== null ? (src as any).headers : src;
  if (holder && typeof holder.get === 'function') {
    return (name) => holder.get(name) ?? undefined;
  }
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(holder ?? {})) lower[k.toLowerCase()] = v;
  return (name) => {
    const v = lower[name];
    return Array.isArray(v) ? (v[0] as string | undefined) : typeof v === 'string' ? v : undefined;
  };
}

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ID = /^[\w.:-]{1,128}$/;

/** Reads the Kalibra headers. Undefined when the request did not come from Kalibra. */
export function linkFromHeaders(src: HeaderSource): RunLink | undefined {
  const get = getter(src);
  const link: RunLink = {};
  const tp = TRACEPARENT.exec((get('traceparent') ?? '').trim().toLowerCase());
  if (tp && !/^0+$/.test(tp[1])) {
    link.traceId = tp[1];
    link.parentSpanId = tp[2];
  }
  const run = get('x-kalibra-run')?.trim();
  const result = get('x-kalibra-result')?.trim();
  const tools = get('x-kalibra-tools')?.trim();
  if (run && ID.test(run)) link.runId = run;
  if (result && ID.test(result)) link.resultId = result;
  if (tools && /^[a-z:-]{1,40}$/.test(tools)) link.tools = tools;
  // A traceparent alone is ordinary distributed tracing, not a Kalibra run: keep our own ids then.
  if (!link.runId && !link.resultId && !link.tools) return undefined;
  return link;
}

/**
 * Attaches traces of the current request to the Kalibra eval row it belongs to.
 *
 *   fromRequest(req, () => handle(req))   runs `handle` linked (preferred)
 *   fromRequest(req)                       links the rest of the current async flow
 */
export function fromRequest<T>(src: HeaderSource, fn: () => T): T;
export function fromRequest(src: HeaderSource): RunLink | undefined;
export function fromRequest<T>(src: HeaderSource, fn?: () => T): T | RunLink | undefined {
  let link: RunLink | undefined;
  try {
    link = linkFromHeaders(src);
  } catch {
    link = undefined;
  }
  if (!fn) {
    if (link) storage.enterWith({ ...current(), link });
    return link;
  }
  return link ? storage.run({ ...current(), link }, fn) : fn();
}

/** Express / Connect middleware: `app.use(kalibra.middleware())`. */
export function middleware() {
  return (req: HeaderSource, _res: unknown, next: (err?: unknown) => void) => {
    let link: RunLink | undefined;
    try {
      link = linkFromHeaders(req);
    } catch {
      link = undefined;
    }
    if (link) storage.run({ ...current(), link }, () => next());
    else next();
  };
}
