import { z } from 'zod';
import type { Engine } from '../engine.js';
import { mapLimit } from '../jobs.js';
import { defineOp, type OpDef } from '../registry.js';
import { evaluateChecks } from '../runner/evaluate.js';
import type { MediaFile } from '../providers/types.js';
import type { LogEntry } from '../script.js';
import { SuiteSpec } from '../specs.js';
import { render } from '../template.js';
import { attachPromptFiles } from '../targets/common.js';
import { invalid, mapSeq } from '../util.js';

/*
 * Prompt playground: one prompt template, a few rows (from a dataset or typed in), up to four
 * model variants side by side. Optional suite scoring uses the same checks as real runs. Files
 * referenced by the prompt ({{image}}, {{audio}}) are attached to the request instead of inlined.
 */

const MAX_ROWS = 25;
const MAX_OUTPUT = 50_000;

const Variant = z.object({
  connectionId: z.string().min(1),
  model: z.string().default(''),
  temperature: z.number().min(0).max(2).optional(),
  label: z.string().default(''),
});

const RunInput = z.object({
  system: z.string().default(''),
  prompt: z.string().min(1).describe('Prompt template, e.g. "Summarise: {{text}}"'),
  variants: z.array(Variant).min(1).max(4),
  dataset: z.string().optional().describe('Take rows from this dataset'),
  rowIds: z.array(z.string()).max(MAX_ROWS).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).default(5).describe('With a dataset and no rowIds: the first N rows'),
  values: z.array(z.record(z.string(), z.unknown())).max(MAX_ROWS).optional().describe('Typed-in rows instead of a dataset'),
  suite: z.string().optional().describe('Score each output with this suite'),
  maxOutputTokens: z.number().int().min(1).max(32000).optional(),
});
type RunInput = z.infer<typeof RunInput>;

interface Cell {
  variant: number;
  output: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  passed?: boolean | null;
  score?: number | null;
  checks?: unknown[];
  error?: string;
}

async function collectRows(engine: Engine, i: RunInput) {
  if (i.values?.length && i.dataset) throw invalid('Use either a dataset or typed-in values, not both');
  if (i.values?.length) return i.values.map((v) => ({ rowId: undefined as string | undefined, data: v }));
  if (!i.dataset) throw invalid('Pick a dataset or type in at least one row of values');
  const ds = await engine.repos.datasets.get(i.dataset);
  const rows = i.rowIds?.length
    ? (await engine.repos.datasets.listRows(ds.id, { ids: i.rowIds, limit: MAX_ROWS })).rows
    : (await engine.repos.datasets.listRows(ds.id, { limit: i.limit, status: ['approved', 'needs_review', 'draft'] })).rows;
  if (!rows.length) throw invalid('No rows to try: the dataset is empty or the ids did not match');
  return rows.slice(0, MAX_ROWS).map((r) => ({ rowId: r.id as string | undefined, data: r.data }));
}

/** Renders system + prompt for a row; file values used by the prompt become attachments. */
async function prepare(engine: Engine, i: RunInput, data: Record<string, unknown>) {
  const env = engine.templateEnv();
  const { scope, files } = await attachPromptFiles([i.prompt, i.system], { ...data, row: data }, engine.blobs);
  return { system: await render(i.system, scope, env), prompt: await render(i.prompt, scope, env), files: files.map(({ data: d, mime }): MediaFile => ({ data: d, mime })) };
}

async function playground(engine: Engine, i: RunInput, onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const rows = await collectRows(engine, i);
  const suite = i.suite ? SuiteSpec.parse((await engine.repos.defs.get('suite', i.suite)).spec) : null;
  const grid = rows.map((r, index) => ({ index, rowId: r.rowId, values: r.data, cells: [] as Cell[] }));
  const work = grid.flatMap((row) => i.variants.map((_, v) => ({ row, v })));
  let done = 0;
  const ac = new AbortController();
  signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true });

  await mapLimit(work, 4, ac.signal, async ({ row, v }) => {
    const variant = i.variants[v];
    const cell: Cell = { variant: v, output: '' };
    try {
      const p = await prepare(engine, i, row.values);
      const res = await engine.llm.text({
        connectionId: variant.connectionId,
        model: variant.model || undefined,
        system: p.system || undefined,
        prompt: p.prompt,
        files: p.files.length ? p.files : undefined,
        temperature: variant.temperature,
        maxOutputTokens: i.maxOutputTokens,
        signal: ac.signal,
      });
      cell.output = res.text.length > MAX_OUTPUT ? `${res.text.slice(0, MAX_OUTPUT)}… (truncated)` : res.text;
      cell.latencyMs = res.latencyMs;
      cell.inputTokens = res.inputTokens;
      cell.outputTokens = res.outputTokens;
      if (suite) {
        const logs: LogEntry[] = [];
        const metrics: Record<string, number> = { latency_ms: res.latencyMs };
        if (res.inputTokens !== undefined) metrics.input_tokens = res.inputTokens;
        if (res.outputTokens !== undefined) metrics.output_tokens = res.outputTokens;
        const scope = { ...row.values, row: row.values, row_id: row.rowId ?? `manual-${row.index + 1}`, output: res.text, outputs: { output: res.text }, response: {}, metrics, vars: {}, error: '' };
        const ev = await evaluateChecks(suite, {
          scope,
          env: engine.templateEnv(),
          llm: engine.llm,
          embed: engine.embeddings,
          log: (level, message) => logs.push({ at: Date.now(), level, message }),
          workspaceDir: engine.dir,
          signal: ac.signal,
        });
        cell.passed = ev.passed;
        cell.score = ev.score;
        cell.checks = ev.checks.map((c) => ({ id: c.id, name: c.name, status: c.status, reason: c.reason, value: c.value }));
      }
    } catch (e: any) {
      // One failing call never sinks the rest of the grid.
      cell.error = e?.message ?? String(e);
    }
    row.cells.push(cell);
    onProgress?.(++done, work.length);
  });

  for (const row of grid) row.cells.sort((a, b) => a.variant - b.variant);
  const variants = await mapSeq(i.variants, async (variant, v) => {
    const cells = grid.map((r) => r.cells.find((c) => c.variant === v)).filter((c): c is Cell => !!c);
    const ok = cells.filter((c) => !c.error);
    const lat = ok.map((c) => c.latencyMs).filter((x): x is number => typeof x === 'number');
    const scored = ok.filter((c) => typeof c.passed === 'boolean');
    return {
      index: v,
      label: variant.label || `${(await engine.repos.defs.get('connection', variant.connectionId)).name}${variant.model ? ` · ${variant.model}` : ''}`,
      connectionId: variant.connectionId,
      model: variant.model,
      temperature: variant.temperature,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      outputTokens: ok.reduce((s, c) => s + (c.outputTokens ?? 0), 0),
      errors: cells.length - ok.length,
      passRate: scored.length ? Math.round((scored.filter((c) => c.passed).length / scored.length) * 10000) / 10000 : null,
    };
  });
  return { system: i.system, prompt: i.prompt, suite: i.suite ?? null, rows: grid, variants };
}

export const playgroundOps: OpDef<any, any>[] = [
  defineOp({
    name: 'playground_run',
    title: 'Try a prompt in the playground',
    description:
      'Runs one prompt template over a few rows (dataset rows or typed-in values, up to 25) with up to 4 model variants side by side, optionally scoring each output with a suite. A single call returns { result } directly; more calls run as a background job and return { jobId } (the job result has the grid).',
    category: 'targets',
    input: RunInput,
    handler: async ({ engine, actor }, i) => {
      for (const v of i.variants) await engine.repos.defs.get('connection', v.connectionId);
      if (i.suite) await engine.repos.defs.get('suite', i.suite);
      const rows = await collectRows(engine, i);
      const calls = rows.length * i.variants.length;
      if (calls === 1) return { result: await playground(engine, i) };
      const job = engine.jobs.start('playground', `Playground: ${calls} calls`, (job) => playground(engine, i, (d, t) => job.progress(d, t), job.signal), actor);
      return { jobId: job.id };
    },
  }),

  defineOp({
    name: 'save_playground_target',
    title: 'Save a playground prompt as a target',
    description: 'Creates a model target (text task) from a playground prompt, connection and model, so it can be run on a whole dataset and compared.',
    category: 'targets',
    input: z.object({
      name: z.string().min(1),
      description: z.string().default(''),
      system: z.string().default(''),
      prompt: z.string().min(1),
      connectionId: z.string().min(1),
      model: z.string().default(''),
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().min(1).max(32000).optional(),
    }),
    handler: async ({ engine, actor }, i) => {
      await engine.repos.defs.get('connection', i.connectionId);
      const target = await engine.repos.defs.create(
        'target',
        {
          name: i.name,
          description: i.description || 'Saved from the playground',
          spec: {
            variables: [],
            config: { kind: 'model', task: 'text', connectionId: i.connectionId, model: i.model, system: i.system, prompt: i.prompt, temperature: i.temperature, maxOutputTokens: i.maxOutputTokens },
          },
        },
        actor,
      );
      engine.events.emit({ type: 'def.changed', kind: 'target', id: target.id, actor });
      return target;
    },
  }),
];
