/*
 * Settings: what `kalibra.init()` was given, filled in from environment variables, and the one
 * question every call asks first — is the SDK on?
 *
 * Off means off: in production (or wherever `enabled` is false, `KALIBRA_ENABLED=false`, or there
 * is no key) the SDK hands your functions back untouched and never touches the network.
 */

export type Redactor = (value: unknown) => unknown;

export interface KalibraOptions {
  /**
   * Turn the SDK on or off. Typical: `enabled: process.env.NODE_ENV !== 'production'`.
   * `KALIBRA_ENABLED=false` (or `0`) always wins, as a kill switch.
   */
  enabled?: boolean;
  /** Where Kalibra runs (`KALIBRA_URL`). Default `http://127.0.0.1:4317`. */
  url?: string;
  /** Ingest key `kik_…` from Kalibra → Traces → Connect your app (`KALIBRA_KEY`). */
  key?: string;
  /** Project id or name (`KALIBRA_PROJECT`). Default `default`. */
  project?: string;
  /** Share of traces to keep, 0..1 (`KALIBRA_SAMPLE_RATE`). Eval rows are always kept. Default 1. */
  sampleRate?: number;
  /**
   * Remove personal data before sending: `true` (default) replaces emails, phone and card numbers
   * and API keys with `[redacted]`; `false` sends values as they are; a function gets each value
   * (after the built-in redaction is skipped) and returns what to send.
   */
  redact?: boolean | Redactor;
  /** Shown on every trace, e.g. `dev`, `staging` (`KALIBRA_ENVIRONMENT`). */
  environment?: string;
  /** Your app's version, e.g. `1.4.2` (`KALIBRA_RELEASE`). */
  release?: string;
  /** How often queued traces are sent. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Report problems sending traces to stderr (once each). Default true. */
  warnings?: boolean;
}

export interface ResolvedConfig {
  enabled: boolean;
  url: string;
  key: string;
  project: string;
  sampleRate: number;
  redact: boolean | Redactor;
  environment?: string;
  release?: string;
  flushIntervalMs: number;
  warnings: boolean;
}

/**
 * Kalibra serves everything under this path (same as BASE_PATH in the server), so a load balancer
 * can route on it. `url` is the server's origin; an address that already ends in /kalibra works too.
 */
export const BASE_PATH = '/kalibra';

/** "http://host:4317/kalibra/" → "http://host:4317". */
export const originOf = (url: string) => {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith(BASE_PATH) ? trimmed.slice(0, -BASE_PATH.length) : trimmed;
};

/** A Kalibra API address: `apiUrl(origin, '/projects/p/ingest/traces')`. */
export const apiUrl = (origin: string, path: string) => `${origin}${BASE_PATH}/api${path}`;

const OFF = new Set(['false', '0', 'off', 'no']);
const ON = new Set(['true', '1', 'on', 'yes']);

const env = (name: string): string | undefined => {
  const v = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return v === undefined || v === '' ? undefined : v;
};

/** `KALIBRA_ENABLED=false` turns the SDK off whatever the code says. */
export const killSwitch = () => OFF.has((env('KALIBRA_ENABLED') ?? '').toLowerCase());

export function resolveConfig(opts: KalibraOptions = {}): ResolvedConfig {
  const key = opts.key ?? env('KALIBRA_KEY') ?? '';
  const flag = (env('KALIBRA_ENABLED') ?? '').toLowerCase();
  const wanted = opts.enabled ?? (flag ? ON.has(flag) : true);
  const rate = opts.sampleRate ?? (env('KALIBRA_SAMPLE_RATE') !== undefined ? Number(env('KALIBRA_SAMPLE_RATE')) : 1);
  return {
    enabled: !killSwitch() && wanted && !!key,
    url: originOf(opts.url ?? env('KALIBRA_URL') ?? 'http://127.0.0.1:4317'),
    key,
    project: opts.project ?? env('KALIBRA_PROJECT') ?? 'default',
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
    redact: opts.redact ?? true,
    environment: opts.environment ?? env('KALIBRA_ENVIRONMENT'),
    release: opts.release ?? env('KALIBRA_RELEASE'),
    flushIntervalMs: Math.max(50, opts.flushIntervalMs ?? 1000),
    warnings: opts.warnings ?? true,
  };
}

/** What the tools of the current process do when no request says otherwise (`KALIBRA_TOOLS`). */
export const envToolMode = () => env('KALIBRA_TOOLS');
