import { z } from 'zod';
import { defineOp, type OpDef } from '../registry.js';
import type { Trace } from '../traces/types.js';
import { invalid, mapSeq } from '../util.js';

/*
 * Traces your app sent (SDK, OpenTelemetry, the OpenAI proxy) and tool recordings for replay.
 * Ingest itself is not an operation: it is a fast HTTP endpoint (server: /ingest/traces, /otlp,
 * /proxy, /ingest/tools) that queues writes. See docs/design/sdk-and-traces.md.
 */

const filter = {
  name: z.string().max(200).optional(),
  status: z.enum(['ok', 'error']).optional(),
  source: z.enum(['sdk', 'otel', 'proxy']).optional(),
  since: z.string().optional().describe('ISO time'),
  until: z.string().optional().describe('ISO time'),
  search: z.string().max(200).optional().describe('Text in the name, input, output or error'),
  runId: z.string().optional(),
  resultId: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional().describe('Exact metadata values, e.g. { "environment": "prod" }'),
};

const PREVIEW = 300;
/** A short text of an input or output for lists. */
function preview(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s;
}

/** A value inside a trace by path: "input", "output.answer", "metadata.user", "name", "error", "tags". */
function pick(trace: Trace, path: string): unknown {
  const [head, ...rest] = path.split('.');
  if (!['input', 'output', 'metadata', 'name', 'error', 'tags', 'id'].includes(head)) throw invalid(`Unknown trace field "${head}" (use input, output, metadata, name, error, tags or id)`);
  let v: any = (trace as any)[head];
  for (const k of rest) {
    if (v === undefined || v === null) return undefined;
    v = Array.isArray(v) && /^\d+$/.test(k) ? v[Number(k)] : v[k];
  }
  return v;
}

export const traceOps: OpDef<any, any>[] = [
  defineOp({
    name: 'list_traces',
    title: 'List traces',
    description:
      'Traces your app sent (SDK, OpenTelemetry or the OpenAI proxy), newest first: what came in, what went out, how long it took, and how many steps (model calls, tool calls, retrievals) it had. Filter by name, status, source, time, text, run or metadata.',
    category: 'runs',
    readOnly: true,
    input: z.object({ ...filter, limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    handler: async ({ engine }, i) => {
      await engine.traces.flush();
      const { total, traces } = await engine.traces.repo.list(i);
      return {
        total,
        traces: traces.map(({ input, output, ...t }) => ({ ...t, inputPreview: preview(input), outputPreview: preview(output) })),
      };
    },
  }),

  defineOp({
    name: 'get_trace',
    title: 'Get a trace',
    description: 'One trace with all its spans (steps), each with its input, output, timing and attributes (model, tokens, tool, documents). Spans link to their parent with parentId.',
    category: 'runs',
    readOnly: true,
    input: z.object({ id: z.string() }),
    handler: async ({ engine }, i) => {
      await engine.traces.flush();
      return await engine.traces.repo.get(i.id);
    },
  }),

  defineOp({
    name: 'delete_traces',
    title: 'Delete traces',
    description: 'Deletes traces by id, or every trace matching a filter. Traces that belong to runs keep their steps on the run rows.',
    category: 'runs',
    destructive: true,
    input: z.object({ ids: z.array(z.string()).max(1000).optional(), ...filter, all: z.boolean().default(false).describe('Required to delete by filter (or everything) instead of by ids') }),
    handler: async ({ engine }, i) => {
      await engine.traces.flush();
      if (i.ids?.length) return { deleted: await engine.traces.repo.delete(i.ids) };
      if (!i.all) throw invalid('Give ids, or all: true to delete every trace matching the filter');
      const { ids, all, ...q } = i;
      return { deleted: await engine.traces.repo.deleteWhere(q) };
    },
  }),

  defineOp({
    name: 'traces_to_dataset',
    title: 'Add traces to a dataset',
    description:
      'Turns real traces into dataset rows, e.g. a question users asked becomes a test case. mapping says which part of the trace fills each column: "input", "output", "input.question", "output.answer", "metadata.user", "name". Rows start as needs_review by default.',
    category: 'datasets',
    input: z.object({
      traceIds: z.array(z.string()).min(1).max(200),
      dataset: z.string().describe('Dataset id or name'),
      mapping: z.record(z.string(), z.string()).describe('Column → trace field path'),
      status: z.enum(['approved', 'needs_review', 'draft']).default('needs_review'),
      tags: z.array(z.string()).default(['from-trace']),
    }),
    handler: async ({ engine, actor }, i) => {
      await engine.traces.flush();
      const ds = await engine.repos.datasets.get(i.dataset);
      const columns = new Map(ds.schema.columns.map((c) => [c.key, c]));
      for (const col of Object.keys(i.mapping)) if (!columns.has(col)) throw invalid(`The dataset has no column "${col}"`);
      const missing: string[] = [];
      const rows = (await mapSeq(i.traceIds, async (id) => {
        let trace: Trace;
        try {
          trace = await engine.traces.repo.get(id);
        } catch {
          missing.push(id);
          return [];
        }
        const data: Record<string, unknown> = {};
        for (const [col, path] of Object.entries(i.mapping)) {
          const v = pick(trace, path);
          if (v === undefined) continue;
          // Text-like columns get text; structured columns keep the value.
          const type = columns.get(col)!.type;
          data[col] = ['json', 'list', 'messages'].includes(type) || typeof v !== 'object' ? v : JSON.stringify(v);
          if (type === 'number' && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) data[col] = Number(v);
        }
        return [{ data, status: i.status, tags: i.tags }];
      })).flat();
      const res = await engine.repos.datasets.addRows(ds.id, rows, actor, { provenance: { source: 'trace', traceIds: i.traceIds.slice(0, 50) } });
      if (res.added.length) engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: res.added.length, actor });
      return { ...res, missing };
    },
  }),

  defineOp({
    name: 'get_trace_settings',
    title: 'Trace settings',
    description: 'How long traces are kept, where the OpenAI proxy forwards calls, and how much is stored.',
    category: 'runs',
    readOnly: true,
    input: z.object({}),
    handler: async ({ engine }) => {
      await engine.traces.flush();
      return { ...(await engine.traces.settings()), ...(await engine.traces.repo.counts()), toolRecordings: (await engine.traces.tools.list({ limit: 1 })).total };
    },
  }),

  defineOp({
    name: 'set_trace_settings',
    title: 'Change trace settings',
    description: 'Changes how many days traces are kept (traces belonging to runs are kept with the run) and the OpenAI proxy upstream (https).',
    category: 'runs',
    access: 'owner',
    input: z.object({ retentionDays: z.number().int().min(1).max(3650).optional(), proxyOpenaiUpstream: z.string().max(500).optional() }),
    handler: async ({ engine }, i) => {
      const next = await engine.traces.setSettings(i);
      await engine.traces.prune();
      return next;
    },
  }),

  defineOp({
    name: 'list_tool_recordings',
    title: 'Tool recordings',
    description: 'Tool responses recorded during runs (tools mode "record"), replayed by the SDK in "replay" mode so evals are fast, free and never touch real systems.',
    category: 'runs',
    readOnly: true,
    input: z.object({ tool: z.string().optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }),
    handler: async ({ engine }, i) => await engine.traces.tools.list(i),
  }),

  defineOp({
    name: 'delete_tool_recordings',
    title: 'Delete tool recordings',
    description: 'Deletes recordings of one tool, specific ones by args hash, or all of them (all: true).',
    category: 'runs',
    destructive: true,
    input: z.object({ tool: z.string().optional(), argsHashes: z.array(z.string()).max(1000).optional(), all: z.boolean().default(false) }),
    handler: async ({ engine }, i) => {
      if (!i.tool && !i.argsHashes?.length && !i.all) throw invalid('Give a tool, argsHashes, or all: true');
      return { deleted: await engine.traces.tools.delete(i) };
    },
  }),
];
