import { z } from 'zod';
import type { Engine } from '../engine.js';
import { defineOp, type Actor } from '../registry.js';
import { cosine, Embeddings, LOCAL_DOWNLOAD_MB, LOCAL_MODEL } from '../providers/embeddings.js';
import { buildReport, cellText, isEmpty, type QualityRow } from '../quality/profile.js';
import { exactDuplicates, nearDuplicates, pickKeeper, rowText, SEMANTIC_LIMIT, semanticDuplicates, type DuplicateGroup } from '../quality/duplicates.js';
import { invalid } from '../util.js';
import { ConnectionSpec } from '../specs.js';

/*
 * Dataset quality tools: a health report, duplicate finding/cleanup and gap filling, plus the
 * operations behind the local embedding model (status, one-time download, test).
 */

const datasetRef = z.string().describe('Dataset id or name');

function loadRows(engine: Engine, dataset: string) {
  const ds = engine.repos.datasets.get(dataset);
  const rows: QualityRow[] = engine.repos.datasets.listRows(ds.id, { limit: 1_000_000 }).rows.map((r) => ({ id: r.id, data: r.data, tags: r.tags, status: r.status }));
  return { ds, rows };
}

const activeRows = (rows: QualityRow[]) => rows.filter((r) => r.status !== 'rejected');

async function findGroups(
  engine: Engine,
  rows: QualityRow[],
  i: { method: 'exact' | 'near' | 'semantic'; threshold?: number; columns?: string[]; connectionId?: string; model?: string },
): Promise<{ groups: DuplicateGroup[]; note?: string }> {
  if (i.method === 'exact') return { groups: exactDuplicates(rows, i.columns) };
  if (i.method === 'near') {
    const r = nearDuplicates(rows, i.threshold ?? 0.8, i.columns);
    return { groups: r.groups, note: r.truncated ? `Checked the first ${rows.length > 5000 ? 5000 : rows.length} rows only.` : undefined };
  }
  const use = rows.slice(0, SEMANTIC_LIMIT);
  const texts = use.map((r) => rowText(r, i.columns) || ' ');
  const emb = await engine.embeddings.embed(texts, i.connectionId ? { connectionId: i.connectionId, model: i.model || undefined } : {});
  return {
    groups: semanticDuplicates(use, emb.vectors, i.threshold ?? 0.92, i.columns),
    note: rows.length > SEMANTIC_LIMIT ? `Checked the first ${SEMANTIC_LIMIT} rows only (meaning-based search compares every pair).` : undefined,
  };
}

function rejectRest(engine: Engine, datasetId: string, rows: QualityRow[], groups: string[][], keep: 'first' | 'longest', actor: Actor) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const toReject: string[] = [];
  const kept: string[] = [];
  for (const g of groups) {
    const members = g.filter((id) => byId.has(id));
    if (members.length < 2) continue;
    const keeper = pickKeeper(members, byId, keep);
    kept.push(keeper);
    toReject.push(...members.filter((id) => id !== keeper));
  }
  const rejected = toReject.length ? engine.repos.datasets.setStatus(datasetId, toReject, 'rejected') : 0;
  if (rejected) engine.events.emit({ type: 'rows.changed', datasetId, count: rejected, actor });
  return { rejected, kept: kept.length };
}

export const qualityOps = [
  defineOp({
    name: 'dataset_quality',
    title: 'Dataset quality report',
    description:
      'Health report for a dataset: how full each column is, how balanced categories are (and which allowed values are missing), text length spread, how varied the wording is, exact copies, and plain-language flags with suggestions. Rejected rows are left out of coverage and variety.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ dataset: datasetRef }),
    handler: ({ engine }, i) => {
      const { ds, rows } = loadRows(engine, i.dataset);
      return { datasetId: ds.id, ...buildReport(ds.schema.columns, rows) };
    },
  }),

  defineOp({
    name: 'find_duplicates',
    title: 'Find duplicate rows',
    description:
      'Groups rows that are copies of each other. method "exact" ignores case, spacing and unicode variants; "near" catches small edits (character overlap ≥ threshold, default 0.8); "semantic" catches paraphrases using embeddings (cosine ≥ threshold, default 0.92; local model or a connection). Rejected rows are ignored. Compare on all columns or only the ones you list.',
    category: 'datasets',
    readOnly: true,
    input: z.object({
      dataset: datasetRef,
      method: z.enum(['exact', 'near', 'semantic']).default('near'),
      threshold: z.number().min(0).max(1).optional(),
      columns: z.array(z.string()).optional(),
      connectionId: z.string().optional().describe('Semantic only: use this connection\'s embedding model instead of the local one'),
      model: z.string().optional(),
    }),
    handler: async ({ engine }, i) => {
      const { ds, rows } = loadRows(engine, i.dataset);
      const unknown = (i.columns ?? []).filter((c) => !ds.schema.columns.some((k) => k.key === c));
      if (unknown.length) throw invalid(`Unknown columns: ${unknown.join(', ')}`);
      const active = activeRows(rows);
      const { groups, note } = await findGroups(engine, active, i);
      return { method: i.method, rowsChecked: Math.min(active.length, i.method === 'semantic' ? SEMANTIC_LIMIT : active.length), groups, duplicates: groups.reduce((n, g) => n + g.rowIds.length - 1, 0), note };
    },
  }),

  defineOp({
    name: 'resolve_duplicates',
    title: 'Keep one of each duplicate',
    description:
      'Marks all but one row of each duplicate group as rejected (nothing is deleted; rejected rows are skipped by runs). Pass the groups from find_duplicates, or omit them to find exact copies now. keep: "first" (oldest) or "longest" (most content).',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      groups: z.array(z.array(z.string()).min(2)).optional(),
      keep: z.enum(['first', 'longest']).default('first'),
      method: z.enum(['exact', 'near']).default('exact').describe('Used only when groups are omitted'),
    }),
    handler: async ({ engine, actor }, i) => {
      const { ds, rows } = loadRows(engine, i.dataset);
      const active = activeRows(rows);
      const groups = i.groups ?? (await findGroups(engine, active, { method: i.method })).groups.map((g) => g.rowIds);
      return rejectRest(engine, ds.id, active, groups, i.keep, actor);
    },
  }),

  defineOp({
    name: 'fill_gaps',
    title: 'Fill gaps in a column',
    description:
      'Generates rows for under-represented values of a column (e.g. accents, categories, intents) with a model connection, so every value gets enough test cases. Runs as a background job: it calls generate_rows once per value with targeted instructions. New rows start as needs_review. Returns { jobId } (or a result straight away when nothing needs filling).',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      column: z.string(),
      values: z.array(z.string()).optional().describe('Only fill these values (default: every value below the target)'),
      targetPerValue: z.number().int().min(1).max(500).optional().describe('Rows wanted per value (default: as many as the most common value has)'),
      maxPerValue: z.number().int().min(1).max(200).default(50),
      connectionId: z.string(),
      model: z.string().default(''),
    }),
    handler: ({ engine, actor }, i) => {
      const { ds, rows } = loadRows(engine, i.dataset);
      const col = ds.schema.columns.find((c) => c.key === i.column);
      if (!col) throw invalid(`Unknown column: ${i.column}`);
      if (['audio', 'image', 'file'].includes(col.type)) throw invalid('Gaps can only be filled for text-like columns');
      const counts = new Map<string, number>();
      for (const r of activeRows(rows)) {
        const v = r.data[col.key];
        if (isEmpty(v)) continue;
        for (const item of Array.isArray(v) ? v.map(cellText) : [cellText(v)]) counts.set(item, (counts.get(item) ?? 0) + 1);
      }
      for (const e of col.enum ?? []) if (!counts.has(e)) counts.set(e, 0);
      for (const v of i.values ?? []) if (!counts.has(v)) counts.set(v, 0);
      if (!counts.size) throw invalid(`"${i.column}" has no values yet. Add a few rows (or allowed values) first.`);
      const target = i.targetPerValue ?? Math.max(...counts.values());
      const plan = [...counts.entries()]
        .filter(([v]) => !i.values?.length || i.values.includes(v))
        .map(([value, before]) => ({ value, before, requested: Math.min(i.maxPerValue, Math.max(0, target - before)) }))
        .filter((p) => p.requested > 0);
      if (!plan.length) return { jobId: null, result: { totalAdded: 0, perValue: [], message: `Every value already has at least ${target} rows` } };

      const job = engine.jobs.start(
        'fill_gaps',
        `Fill gaps in ${ds.name}.${col.key}`,
        async (job) => {
          const perValue: { value: string; before: number; requested: number; added: number }[] = [];
          let total = 0;
          const all = plan.reduce((n, p) => n + p.requested, 0);
          for (const p of plan) {
            if (job.signal.aborted) break;
            job.progress(total, all, `Writing rows where ${col.key} = ${p.value}`);
            try {
              const res = await engine.call<{ added: number }>(
                'generate_rows',
                {
                  dataset: ds.id,
                  connectionId: i.connectionId,
                  model: i.model,
                  count: p.requested,
                  instructions: `Every row in this batch must have ${col.key} = "${p.value}" exactly. Vary everything else.`,
                },
                actor,
              );
              perValue.push({ ...p, added: res.added });
              total += res.added;
            } catch (e: any) {
              job.itemError(e?.message ?? String(e), p.value);
              perValue.push({ ...p, added: 0 });
            }
          }
          job.progress(total, all, 'Done');
          return { totalAdded: total, perValue };
        },
        actor,
        { datasetId: ds.id },
      );
      return { jobId: job.id, plan };
    },
  }),

  defineOp({
    name: 'embeddings_status',
    title: 'Embedding model status',
    description: 'Whether the free local embedding model (used for meaning-based similarity and duplicates) is downloaded, downloading or unavailable, and how big the one-time download is.',
    category: 'connections',
    readOnly: true,
    input: z.object({}),
    handler: async ({ engine }) => ({
      ...(await engine.embeddings.status()),
      downloadMb: LOCAL_DOWNLOAD_MB,
      dir: engine.embeddings instanceof Embeddings ? engine.embeddings.dir : undefined,
    }),
  }),

  defineOp({
    name: 'download_embedding_model',
    title: 'Download the local embedding model',
    description: `One-time download (about ${LOCAL_DOWNLOAD_MB} MB) of a small local embedding model (${LOCAL_MODEL}) so meaning-based checks and duplicate search work offline and for free. Runs as a background job; returns { jobId }.`,
    category: 'connections',
    input: z.object({}),
    handler: ({ engine, actor }) => {
      const emb = engine.embeddings;
      if (!(emb instanceof Embeddings)) throw invalid('Local embeddings are not available in this build');
      const job = engine.jobs.start(
        'download_embeddings',
        'Download local embedding model',
        async (job) => {
          await emb.downloadLocal((p) => job.progress(p.percent ?? 0, 100, p.message));
          return emb.status();
        },
        actor,
      );
      return { jobId: job.id };
    },
  }),

  defineOp({
    name: 'test_embeddings',
    title: 'Test embeddings',
    description: 'Embeds two similar sentences with the local model (or a connection\'s embedding model) and reports their similarity, vector size and latency.',
    category: 'connections',
    readOnly: true,
    input: z.object({
      connectionId: z.string().optional(),
      spec: z.record(z.string(), z.unknown()).optional().describe('Unsaved connection spec to test instead of a saved connection'),
      model: z.string().optional(),
    }),
    handler: async ({ engine }, i) => {
      const started = Date.now();
      const pair = ['Transfer fifteen hundred rupees to Priya.', 'Send 1500 rupees to Priya.'];
      let res;
      if (i.spec) {
        const spec = ConnectionSpec.parse(i.spec);
        const tmp = new Embeddings(() => ({ getConnection: () => spec, secrets: engine.secrets }));
        res = await tmp.embed(pair, { connectionId: 'unsaved', model: i.model || undefined });
      } else {
        res = await engine.embeddings.embed(pair, i.connectionId ? { connectionId: i.connectionId, model: i.model } : {});
      }
      return {
        ok: true,
        source: res.source,
        model: res.model,
        dims: res.vectors[0]?.length ?? 0,
        similarity: Math.round(cosine(res.vectors[0], res.vectors[1]) * 1000) / 1000,
        latencyMs: Date.now() - started,
      };
    },
  }),
];
