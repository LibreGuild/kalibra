import { z } from 'zod';
import { render, renderValue, toText } from '../template.js';
import type { MediaFile } from '../providers/types.js';
import { evalExpression, runScript } from '../script.js';
import { defineCheck, errorOutcome, fail, pass, round, verdict } from './common.js';

/* Layer 5: judgment — LLM-as-judge, custom scripts and expressions (the escape hatch for anything else). */

export const DEFAULT_JUDGE_CRITERIA =
  'Does the output correctly and completely do what the input asks, without inventing facts? ' +
  'If a reference is given, the output must agree with it in meaning (wording may differ).';

export const DEFAULT_JUDGE_PROMPT = `You are grading the output of an AI application.

## Criteria
{{criteria}}

## Test case (input data)
{{row | json}}

## Output to grade
{{output}}

## Reference answer (may be empty)
{{reference}}`;

const JUDGE_SYSTEM =
  'You are a strict, fair evaluator. First write short reasoning that checks the output against each part of the criteria, ' +
  'then give the verdict. Answer "pass" only if the output fully meets the criteria; otherwise answer "fail". ' +
  'Do not reward length or confident tone. Use the score field for how well it meets the criteria, from 0 to 1.';

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'Short critique written before deciding' },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['reasoning', 'verdict'],
  additionalProperties: false,
};

interface JudgeAnswer {
  reasoning: string;
  verdict: 'pass' | 'fail';
  score?: number;
}

export const llmJudgeCheck = defineCheck({
  type: 'llm_judge',
  label: 'LLM judge',
  category: 'judgment',
  layer: 5,
  description: 'A language model grades the output against your criteria and answers pass or fail with reasoning.',
  config: z.object({
    connectionId: z.string().default(''),
    model: z.string().default(''),
    criteria: z.string().default(DEFAULT_JUDGE_CRITERIA),
    reference: z.string().default('{{expected | default("")}}'),
    prompt: z.string().default(DEFAULT_JUDGE_PROMPT),
    repetitions: z.number().int().min(1).max(9).default(1),
    temperature: z.number().min(0).max(2).default(0),
    attachments: z.array(z.string()).default([]),
  }),
  fields: [
    { key: 'connectionId', label: 'Connection', kind: 'connection', help: 'Which model provider grades the output. Add providers on the Connections page.' },
    { key: 'model', label: 'Model', kind: 'model', help: 'The judge model. A different model family from the one being tested avoids self-preference bias.' },
    {
      key: 'criteria',
      label: 'Criteria',
      kind: 'textarea',
      default: DEFAULT_JUDGE_CRITERIA,
      help: 'What a passing output must do. Specific, yes/no criteria give the most reliable judges; split unrelated criteria into separate judges.',
    },
    { key: 'reference', label: 'Reference answer', kind: 'template', default: '{{expected | default("")}}', help: 'Optional correct answer shown to the judge, usually a dataset column. Leave empty if there is none.' },
    {
      key: 'prompt',
      label: 'Prompt template',
      kind: 'textarea',
      default: DEFAULT_JUDGE_PROMPT,
      help: 'Full control over what the judge sees. {{criteria}} and {{reference}} insert the fields above; any row column or output field also works.',
    },
    { key: 'repetitions', label: 'Repetitions', kind: 'number', default: 1, help: 'Ask the judge several times and take the majority vote. Use 3 or 5 when single verdicts flip between runs.' },
    { key: 'temperature', label: 'Temperature', kind: 'number', default: 0, help: 'Randomness of the judge. 0 is the most consistent.' },
    {
      key: 'attachments',
      label: 'Attachments',
      kind: 'list',
      default: [],
      help: 'Images or audio the judge should see, e.g. {{output}} for a generated image or {{image}} for an input photo. Needs a judge model that accepts files.',
    },
  ],
  async run(cfg, ctx) {
    if (!cfg.connectionId) return errorOutcome('Choose a connection for the judge');
    const reference = toText(await render(cfg.reference, ctx.scope, ctx.env));
    const scope = { ...ctx.scope, criteria: cfg.criteria, reference };
    const prompt = await render(cfg.prompt, scope, ctx.env);
    const files = await loadAttachments(cfg.attachments, ctx);
    const runs: JudgeAnswer[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let model = cfg.model;
    for (let i = 0; i < cfg.repetitions; i++) {
      const r = await ctx.llm.json<JudgeAnswer>({
        connectionId: cfg.connectionId,
        model: cfg.model || undefined,
        system: JUDGE_SYSTEM,
        prompt,
        temperature: cfg.temperature,
        schema: JUDGE_SCHEMA,
        schemaName: 'judgement',
        files: files.length ? files.map((f) => f.file) : undefined,
        signal: ctx.signal,
      });
      runs.push(judgeAnswer(r.value));
      inputTokens += r.inputTokens ?? 0;
      outputTokens += r.outputTokens ?? 0;
      latencyMs += r.latencyMs;
      model = r.model;
    }
    const passes = runs.filter((r) => r.verdict === 'pass').length;
    const ok = passes > runs.length / 2;
    const chosen = runs.find((r) => (r.verdict === 'pass') === ok) ?? runs[0];
    const scores = runs.map((r) => r.score).filter((s): s is number => typeof s === 'number');
    return verdict(ok, {
      score: runs.length > 1 ? passes / runs.length : scores[0] ?? (ok ? 1 : 0),
      reason: chosen.reasoning.slice(0, 300),
      details: {
        reasoning: chosen.reasoning,
        verdicts: runs.map((r) => r.verdict),
        runs,
        meanScore: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined,
        usage: { model, inputTokens, outputTokens, latencyMs },
        prompt,
        attachments: files.map((f) => ({ name: f.name, mime: f.file.mime, bytes: f.file.data.byteLength })),
      },
    });
  },
});

export const scriptCheck = defineCheck({
  type: 'script',
  label: 'Custom script',
  category: 'judgment',
  layer: 5,
  description: 'Your own JavaScript decides pass/fail. Use it for any rule the built-in checks do not cover.',
  config: z.object({
    code: z.string().default("// Available: output, outputs, row, response, metrics, vars, error, log\n// Return true/false, a score from 0 to 1, or { pass, score, reason }\nreturn String(output).length > 0;"),
    timeoutMs: z.number().int().positive().default(10000),
  }),
  fields: [
    {
      key: 'code',
      label: 'Script',
      kind: 'code',
      help: 'JavaScript function body. Return true/false, a number from 0 to 1 (≥ 0.5 passes), or an object { pass, score, value, reason, details }. require() works for Node built-ins and packages in your workspace.',
    },
    { key: 'timeoutMs', label: 'Timeout (ms)', kind: 'number', default: 10000, help: 'The check errors if the script runs longer than this.' },
  ],
  async run(cfg, ctx) {
    const s = ctx.scope;
    let out: unknown;
    try {
      out = await runScript(
        cfg.code,
        {
          output: s.output, outputs: s.outputs, row: s.row, response: s.response, metrics: s.metrics, vars: s.vars, error: s.error,
          log: (...a: unknown[]) => ctx.log('info', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
        },
        { timeoutMs: cfg.timeoutMs, log: ctx.log, requireFrom: ctx.workspaceDir, filename: 'check.js' },
      );
    } catch (e) {
      return errorOutcome(`Script error: ${(e as Error).message}`);
    }
    if (typeof out === 'boolean') return out ? pass() : fail();
    if (typeof out === 'number' && Number.isFinite(out)) return verdict(out >= 0.5, { score: out, value: out, reason: `Score ${round(out, 3)}` });
    if (out && typeof out === 'object' && 'pass' in out) {
      const o = out as { pass: unknown; score?: number; value?: number; reason?: string; details?: Record<string, unknown> };
      return verdict(!!o.pass, {
        score: typeof o.score === 'number' ? o.score : o.pass ? 1 : 0,
        value: typeof o.value === 'number' ? o.value : undefined,
        reason: o.reason,
        details: o.details,
      });
    }
    return errorOutcome('Script must return true/false, a number, or { pass, ... }');
  },
});

export const expressionCheck = defineCheck({
  type: 'expression',
  label: 'Expression',
  category: 'judgment',
  layer: 5,
  description: 'A one-line JavaScript condition, e.g. outputs.items.length >= 3. True passes.',
  config: z.object({ expression: z.string().default('String(output).length > 0') }),
  fields: [
    {
      key: 'expression',
      label: 'Condition',
      kind: 'text',
      default: 'String(output).length > 0',
      help: 'Any JavaScript expression. Variables: output, outputs, row and its columns, response, metrics, vars, error.',
    },
  ],
  async run(cfg, ctx) {
    let v: unknown;
    try {
      v = evalExpression(cfg.expression, ctx.scope);
    } catch (e) {
      return errorOutcome(`Expression error: ${(e as Error).message}`);
    }
    return verdict(!!v, { reason: v ? 'True' : `False (${toText(v).slice(0, 80) || String(v)})` });
  },
});

/**
 * Only OpenAI enforces the answer schema; other providers can answer "Pass", leave out the reasoning
 * or score on another scale. Normalize so one odd answer can't crash the check or skew averages.
 */
function judgeAnswer(raw: unknown): JudgeAnswer {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const score = typeof v.score === 'number' && Number.isFinite(v.score) ? Math.max(0, Math.min(1, v.score)) : undefined;
  return {
    reasoning: typeof v.reasoning === 'string' ? v.reasoning : '',
    verdict: String(v.verdict ?? '').trim().toLowerCase() === 'pass' ? 'pass' : 'fail',
    ...(score === undefined ? {} : { score }),
  };
}

/** Resolves attachment templates to files; non-file values (or missing ones) are skipped. */
async function loadAttachments(templates: string[], ctx: Parameters<typeof llmJudgeCheck.run>[1]): Promise<{ name: string; file: MediaFile }[]> {
  const out: { name: string; file: MediaFile }[] = [];
  for (const tpl of templates.map((s) => s.trim()).filter(Boolean)) {
    const v = await renderValue(tpl, ctx.scope, ctx.env).catch(() => undefined);
    for (const item of Array.isArray(v) ? v : [v]) {
      if (!item || typeof item !== 'object' || typeof (item as any).blob !== 'string' || !ctx.env.loadFile) continue;
      const data = await ctx.env.loadFile(item);
      out.push({ name: (item as any).name ?? tpl, file: { data, mime: (item as any).mime || guessMime(data) } });
    }
  }
  return out;
}

function guessMime(b: Uint8Array): string {
  const head = Buffer.from(b.subarray(0, 12)).toString('latin1');
  if (b[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (head.startsWith('%PDF')) return 'application/pdf';
  return 'application/octet-stream';
}
