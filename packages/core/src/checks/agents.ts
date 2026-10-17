import { z } from 'zod';
import { toText } from '../template.js';
import type { CheckScope } from './types.js';
import { defineCheck, fail, pass, skip, toNumber, value, verdict } from './common.js';

/*
 * Checks over what an agent did, not just what it answered: which tools it called, with which
 * arguments, in which order, and how many steps it took (docs/design/sdk-and-traces.md §7).
 *
 * Where the facts come from, first match wins:
 *   - `tool_calls` / `steps` in the check scope (filled from traces sent by the SDK, OpenTelemetry
 *     or the proxy, joined to the eval row);
 *   - `outputs.tool_calls` / `outputs.steps` (an API-only app returns them in its response and the
 *     target maps them with extractors; no SDK needed).
 * When neither exists the checks skip and say how to provide them.
 */

export interface ToolCall {
  name: string;
  args: unknown;
  output?: unknown;
  error?: string;
}

export interface Step {
  name: string;
  kind: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

/** Parses JSON text into a value; other values pass through. */
const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
};

const asArray = (v: unknown): unknown[] | undefined => {
  const p = parsed(v);
  return Array.isArray(p) ? p : undefined;
};

/** The spans of this result, in order (undefined when nothing was recorded). */
export function stepsOf(scope: Record<string, unknown>): Step[] | undefined {
  const raw = asArray(scope.steps) ?? asArray((scope.outputs as any)?.steps);
  if (!raw) return undefined;
  return raw
    .filter((s): s is Record<string, any> => !!s && typeof s === 'object')
    .map((s) => ({ name: toText(s.name ?? ''), kind: toText(s.kind ?? 'step'), input: s.input, output: s.output, error: s.error ? toText(s.error) : undefined }));
}

/** Tool calls of this result, normalized; undefined when the app reported nothing about tools. */
export function toolCallsOf(scope: Record<string, unknown>): ToolCall[] | undefined {
  const raw = asArray(scope.tool_calls) ?? asArray((scope.outputs as any)?.tool_calls);
  if (raw) {
    return raw
      .filter((c): c is Record<string, any> => !!c && typeof c === 'object')
      .map((c) => {
        // Also accept OpenAI's shape: { function: { name, arguments: "<json>" } }.
        const fn = c.function && typeof c.function === 'object' ? c.function : undefined;
        return {
          name: toText(c.name ?? c.tool ?? fn?.name ?? ''),
          args: parsed(c.args ?? c.arguments ?? c.input ?? fn?.arguments ?? {}),
          output: c.output ?? c.result,
          error: c.error ? toText(c.error) : undefined,
        };
      });
  }
  const steps = stepsOf(scope);
  if (!steps) return undefined;
  return steps.filter((s) => s.kind === 'tool').map((s) => ({ name: s.name, args: parsed(s.input ?? {}), output: s.output, error: s.error }));
}

/**
 * Partial deep match: every key in `expected` must match in `actual`; extra keys in `actual` are
 * fine. Arrays match when each expected element matches some actual element. Scalars compare as
 * text, so 12 matches "12".
 */
export function matchesPartially(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null || actual === undefined;
  if (Array.isArray(expected)) {
    const list = asArray(actual);
    return !!list && expected.every((e) => list.some((a) => matchesPartially(a, e)));
  }
  if (typeof expected === 'object') {
    const obj = parsed(actual);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => matchesPartially((obj as Record<string, unknown>)[k], v));
  }
  if (actual === null || actual === undefined || typeof actual === 'object') return false;
  return String(actual).trim() === String(expected).trim();
}

/** Resolves {{templates}} in every string of an expected-args object (keeping types for a lone {{x}}). */
async function renderDeep(v: unknown, ctx: CheckScope): Promise<unknown> {
  if (typeof v === 'string') return v.includes('{{') ? value(v, ctx) : v;
  if (Array.isArray(v)) return Promise.all(v.map((x) => renderDeep(x, ctx)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await renderDeep(x, ctx);
    return out;
  }
  return v;
}

const NO_TOOLS = 'No tool calls recorded for this result. Send traces with the Kalibra SDK, or return a tool_calls field from your app and map it in the target.';
const names = (calls: ToolCall[]) => [...new Set(calls.map((c) => c.name))].join(', ') || 'none';
const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

export const toolCalledCheck = defineCheck({
  type: 'tool_called',
  label: 'Called a tool',
  category: 'agents',
  layer: 2,
  description: 'Passes when the agent called a tool (optionally with matching arguments) between a minimum and maximum number of times.',
  config: z.object({
    name: z.string().default(''),
    args: z.string().default('').describe('JSON with the arguments that must match; other arguments are ignored'),
    min: z.number().int().min(0).default(1),
    max: z.number().int().min(0).optional(),
  }),
  fields: [
    { key: 'name', label: 'Tool name', kind: 'text', placeholder: 'refund_order', help: 'The tool the agent should call, exactly as it is named in your app.' },
    {
      key: 'args',
      label: 'Arguments (optional)',
      kind: 'json',
      placeholder: '{ "order_id": "{{order_id}}" }',
      help: 'Only the arguments you list are compared; others are ignored. Use {{column}} for values from the row. Nested objects and lists match partially too.',
    },
    { key: 'min', label: 'At least', kind: 'number', default: 1, help: 'Minimum number of matching calls. Use 0 with "At most" to cap calls.' },
    { key: 'max', label: 'At most', kind: 'number', help: 'Maximum number of matching calls (leave empty for no limit).' },
  ],
  async run(cfg, ctx) {
    if (!cfg.name.trim()) return fail({ reason: 'Set the tool name' });
    const calls = toolCallsOf(ctx.scope);
    if (!calls) return skip(NO_TOOLS);
    let expected: unknown;
    if (cfg.args.trim()) {
      try {
        expected = await renderDeep(JSON.parse(cfg.args), ctx);
      } catch (e: any) {
        return fail({ reason: `Arguments are not valid JSON: ${e?.message ?? e}` });
      }
    }
    const sameName = calls.filter((c) => c.name === cfg.name);
    const matching = sameName.filter((c) => matchesPartially(c.args, expected));
    const n = matching.length;
    const ok = n >= cfg.min && (cfg.max === undefined || n <= cfg.max);
    const range = cfg.max === undefined ? `at least ${cfg.min}` : cfg.min === cfg.max ? `exactly ${cfg.min}` : `${cfg.min}–${cfg.max}`;
    let reason: string;
    if (ok) reason = `${cfg.name} called ${n}×${expected === undefined ? '' : ' with matching arguments'} (${range})`;
    else if (!sameName.length) reason = `${cfg.name} was not called (called: ${names(calls)})`;
    else if (!n) reason = `${cfg.name} was called ${sameName.length}× but the arguments differ, e.g. ${short(sameName[0].args)}`;
    else reason = `${cfg.name} called ${n}× with matching arguments; expected ${range}`;
    return verdict(ok, { value: n, reason, details: { matching: n, calls: sameName.map((c) => c.args), allTools: calls.map((c) => c.name) } });
  },
});

export const toolNotCalledCheck = defineCheck({
  type: 'tool_not_called',
  label: 'Did not call tools',
  category: 'agents',
  layer: 2,
  description: 'Fails when the agent called any of the listed tools, e.g. something destructive it must never use on its own.',
  config: z.object({ names: z.array(z.string()).default([]) }),
  fields: [{ key: 'names', label: 'Forbidden tools', kind: 'list', default: [], help: 'Tool names the agent must not call for this kind of request, e.g. delete_account.' }],
  async run(cfg, ctx) {
    const forbidden = cfg.names.map((n) => n.trim()).filter(Boolean);
    if (!forbidden.length) return fail({ reason: 'List at least one tool name' });
    const calls = toolCallsOf(ctx.scope);
    if (!calls) return skip(NO_TOOLS);
    const hit = [...new Set(calls.map((c) => c.name).filter((n) => forbidden.includes(n)))];
    return verdict(!hit.length, { reason: hit.length ? `Called ${hit.join(', ')}` : `None of ${forbidden.join(', ')} was called`, details: { called: hit } });
  },
});

export const toolOrderCheck = defineCheck({
  type: 'tool_order',
  label: 'Tools in order',
  category: 'agents',
  layer: 2,
  description: 'Passes when the tool calls contain this sequence in order (other calls may come in between), e.g. look up the order before refunding it.',
  config: z.object({ sequence: z.array(z.string()).default([]) }),
  fields: [{ key: 'sequence', label: 'Sequence', kind: 'list', default: [], help: 'Tool names in the order they must happen, e.g. find_order, refund_order. Other calls may happen in between.' }],
  async run(cfg, ctx) {
    const seq = cfg.sequence.map((n) => n.trim()).filter(Boolean);
    if (seq.length < 2) return fail({ reason: 'List at least two tool names' });
    const calls = toolCallsOf(ctx.scope);
    if (!calls) return skip(NO_TOOLS);
    let i = 0;
    for (const c of calls) if (c.name === seq[i]) i++;
    const ok = i >= seq.length;
    const order = calls.map((c) => c.name).join(' → ') || 'no calls';
    return verdict(ok, {
      score: seq.length ? i / seq.length : 0,
      reason: ok ? `Called ${seq.join(' → ')} in order` : `Missing "${seq[i]}" after ${i ? seq.slice(0, i).join(' → ') : 'the start'} (calls: ${order})`,
      details: { matched: i, calls: calls.map((c) => c.name) },
    });
  },
});

export const stepLimitsCheck = defineCheck({
  type: 'step_limits',
  label: 'Step limits',
  category: 'agents',
  layer: 2,
  description: 'Fails when the agent took too many steps, model calls or tool calls (loops, retries, wasted tokens).',
  config: z.object({
    maxSteps: z.number().int().min(0).optional(),
    maxLlmCalls: z.number().int().min(0).optional(),
    maxToolCalls: z.number().int().min(0).optional(),
  }),
  fields: [
    { key: 'maxSteps', label: 'Most steps', kind: 'number', help: 'Every recorded span counts as a step (model calls, tools, retrieval, your own steps).' },
    { key: 'maxLlmCalls', label: 'Most model calls', kind: 'number', help: 'Spans of kind "llm".' },
    { key: 'maxToolCalls', label: 'Most tool calls', kind: 'number' },
  ],
  async run(cfg, ctx) {
    const limits = [cfg.maxSteps, cfg.maxLlmCalls, cfg.maxToolCalls].map((v) => toNumber(v));
    if (limits.every((v) => v === undefined)) return fail({ reason: 'Set at least one limit' });
    const steps = stepsOf(ctx.scope);
    const calls = toolCallsOf(ctx.scope);
    if (!steps && !calls) return skip('No steps recorded for this result. Send traces with the Kalibra SDK, or return steps / tool_calls from your app.');
    const counts = {
      steps: steps?.length ?? calls?.length ?? 0,
      llm: steps?.filter((s) => s.kind === 'llm').length ?? 0,
      tools: calls?.length ?? 0,
    };
    const over: string[] = [];
    if (cfg.maxSteps !== undefined && counts.steps > cfg.maxSteps) over.push(`${counts.steps} steps (max ${cfg.maxSteps})`);
    if (cfg.maxLlmCalls !== undefined && counts.llm > cfg.maxLlmCalls) over.push(`${counts.llm} model calls (max ${cfg.maxLlmCalls})`);
    if (cfg.maxToolCalls !== undefined && counts.tools > cfg.maxToolCalls) over.push(`${counts.tools} tool calls (max ${cfg.maxToolCalls})`);
    if (over.length) return fail({ value: counts.steps, reason: over.join(', '), details: counts });
    return pass({ value: counts.steps, reason: `${counts.steps} steps, ${counts.llm} model calls, ${counts.tools} tool calls`, details: counts });
  },
});

export const agentChecks = [toolCalledCheck, toolNotCalledCheck, toolOrderCheck, stepLimitsCheck];
