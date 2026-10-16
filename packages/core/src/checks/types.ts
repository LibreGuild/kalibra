import type { z } from 'zod';
import type { Logger } from '../script.js';
import type { TemplateEnv } from '../template.js';
import type { LlmClient } from '../providers/types.js';

export type CheckStatus = 'pass' | 'fail' | 'skip' | 'error';

/**
 * Layers run in order. If a check marked as a gate fails, later layers are skipped for that row,
 * so cheap structural failures never pay for expensive judges.
 */
export const LAYERS = [
  { id: 0, name: 'Transport', hint: 'Did the call succeed? Status, latency, errors.' },
  { id: 1, name: 'Structure', hint: 'Is the response the right shape? JSON, schema.' },
  { id: 2, name: 'Fields', hint: 'Do specific fields hold the right kind of values?' },
  { id: 3, name: 'Content', hint: 'Exact, contains, regex, numeric, fuzzy comparisons.' },
  { id: 4, name: 'Reference metrics', hint: 'WER/CER, BLEU, ROUGE, similarity against expected values.' },
  { id: 5, name: 'Judgment', hint: 'LLM-as-judge and custom scripts.' },
] as const;

export interface CheckScope {
  /** Template/expression scope: row columns at top level, plus row, output, outputs, response, metrics, vars, error. */
  scope: Record<string, unknown>;
  env: TemplateEnv;
  llm: LlmClient;
  log: Logger;
  workspaceDir: string;
  signal: AbortSignal;
}

export interface CheckOutcome {
  status: CheckStatus;
  /** Normalized 0..1 where higher is better, when meaningful. */
  score?: number;
  /** The raw metric (e.g. WER 0.12, latency 840). */
  value?: number;
  threshold?: number;
  /** One line for the results grid. */
  reason?: string;
  /** Anything richer for the detail view (alignment ops, judge rationale, diffs, counts for corpus metrics). */
  details?: Record<string, unknown>;
}

export interface CheckResult extends CheckOutcome {
  id: string;
  type: string;
  name: string;
  layer: number;
  gate: boolean;
  weight: number;
  durationMs: number;
}

export interface CheckField {
  key: string;
  label: string;
  kind: 'template' | 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'code' | 'json' | 'list' | 'connection' | 'model';
  help?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  default?: unknown;
}

/** A check type: metadata for the UI + the implementation. */
export interface CheckType<C = any> {
  type: string;
  label: string;
  category: 'transport' | 'structure' | 'fields' | 'content' | 'reference' | 'judgment';
  layer: number;
  description: string;
  /** Config schema (zod) – also drives validation for API/MCP callers. */
  config: z.ZodType<C>;
  /** Form layout hints for the UI. */
  fields: CheckField[];
  run(config: C, ctx: CheckScope): Promise<CheckOutcome>;
}
