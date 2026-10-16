import type { LogEntry, Logger } from '../script.js';
import type { TemplateEnv } from '../template.js';
import type { BlobStore } from '../storage.js';
import type { TargetSpec } from '../specs.js';
import type { LlmClient } from '../providers/types.js';

/** Everything a target executor needs to call the app under test for one dataset row. */
export interface TargetCallContext {
  row: Record<string, unknown>;
  rowId: string;
  /** Target variables ({{vars.x}}). */
  vars: Record<string, string>;
  /** Template environment: secrets + file loading. */
  env: TemplateEnv;
  blobs: BlobStore;
  llm: LlmClient;
  signal: AbortSignal;
  log: Logger;
  /** Directory used for `require()` inside user scripts. */
  workspaceDir: string;
}

export interface TargetCallResult {
  /** True when the target produced a response (even a 4xx/5xx). False on transport errors. */
  ok: boolean;
  /** What was sent, with secret values masked. */
  request?: unknown;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    text?: string;
    /** WebSocket / SSE: received messages (bounded) with relative timestamps. */
    messages?: { t: number; dir: 'in' | 'out'; kind: string; data: unknown }[];
  };
  /** Named output fields. `output` is the main one that checks use by default. */
  outputs: Record<string, unknown>;
  /** Numbers in ms unless the name says otherwise: latency_ms, ttfb_ms, connect_ms, first_partial_ms, final_latency_ms, audio_ms, rtf, ... */
  metrics: Record<string, number>;
  error?: string;
  /** Whether retrying might help (timeouts, 429, 5xx, connection resets). */
  retryable?: boolean;
  logs: LogEntry[];
}

export type TargetExecutor = (spec: TargetSpec, ctx: TargetCallContext) => Promise<TargetCallResult>;
