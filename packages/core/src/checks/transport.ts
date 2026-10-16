import { z } from 'zod';
import { toText } from '../template.js';
import { defineCheck, fail, pass, skip, verdict } from './common.js';

/* Layer 0: did the call to the app succeed at all? */

/** Matches a status against "200", "2xx", "200-299" tokens separated by commas or spaces. */
export function statusMatches(status: number, expected: string): boolean {
  const tokens = expected.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return status >= 200 && status < 300;
  return tokens.some((t) => {
    const tok = t.toLowerCase();
    if (/^\d{3}$/.test(tok)) return status === Number(tok);
    if (/^\dxx$/.test(tok)) return Math.floor(status / 100) === Number(tok[0]);
    const range = tok.match(/^(\d{3})-(\d{3})$/);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);
    return false;
  });
}

export const statusCheck = defineCheck({
  type: 'status',
  label: 'Status code',
  category: 'transport',
  layer: 0,
  description: 'Checks the HTTP status code of the response, e.g. 200 or any 2xx.',
  config: z.object({ expected: z.string().default('2xx') }),
  fields: [
    {
      key: 'expected',
      label: 'Expected status',
      kind: 'text',
      default: '2xx',
      placeholder: '2xx',
      help: 'One or more codes separated by commas: an exact code (200), a class (2xx) or a range (200-299).',
    },
  ],
  async run(cfg, ctx) {
    const status = (ctx.scope.response as any)?.status;
    const error = toText(ctx.scope.error);
    if (typeof status !== 'number') {
      if (error) return fail({ reason: `No response: ${error}` });
      return skip('No status code (not an HTTP response)');
    }
    const ok = statusMatches(status, cfg.expected);
    return verdict(ok, { value: status, reason: ok ? `Status ${status}` : `Status ${status}, expected ${cfg.expected}` });
  },
});

export const latencyCheck = defineCheck({
  type: 'latency',
  label: 'Latency',
  category: 'transport',
  layer: 0,
  description: 'Fails when a timing metric (total latency, time to first token, …) is above a limit.',
  config: z.object({ metric: z.string().default('latency_ms'), max: z.number().nonnegative().default(2000) }),
  fields: [
    {
      key: 'metric',
      label: 'Metric',
      kind: 'select',
      default: 'latency_ms',
      options: [
        { value: 'latency_ms', label: 'Total latency' },
        { value: 'ttfb_ms', label: 'Time to first byte' },
        { value: 'ttft_ms', label: 'Time to first token' },
        { value: 'connect_ms', label: 'Connection time' },
        { value: 'first_partial_ms', label: 'Time to first partial (streaming STT)' },
        { value: 'final_latency_ms', label: 'Final latency (streaming STT)' },
      ],
      help: 'Which timing to check. Any metric your target records can be typed in.',
    },
    { key: 'max', label: 'Maximum (ms)', kind: 'number', default: 2000, help: 'The check fails when the metric is above this many milliseconds.' },
  ],
  async run(cfg, ctx) {
    const v = (ctx.scope.metrics as Record<string, number> | undefined)?.[cfg.metric];
    if (typeof v !== 'number') return skip(`Metric "${cfg.metric}" was not recorded`);
    return verdict(v <= cfg.max, { value: v, threshold: cfg.max, reason: `${Math.round(v)} ms (max ${cfg.max} ms)` });
  },
});

export const noErrorCheck = defineCheck({
  type: 'no_error',
  label: 'No error',
  category: 'transport',
  layer: 0,
  description: 'Passes when the call finished without a transport or script error.',
  config: z.object({}),
  fields: [],
  async run(_cfg, ctx) {
    const error = toText(ctx.scope.error);
    return error ? fail({ reason: error }) : pass({ reason: 'No error' });
  },
});
