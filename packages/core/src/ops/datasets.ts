import { z } from 'zod';
import Papa from 'papaparse';
import { defineOp } from '../registry.js';
import { ColumnSpec, DatasetSchema, RowStatus, type ColumnType } from '../specs.js';
import { invalid, mapSeq } from '../util.js';

const datasetRef = z.string().describe('Dataset id or name');
const rowInput = z.object({
  data: z.record(z.string(), z.unknown()).describe('Column values keyed by column name. File columns take { blob: "<sha256>" } from an upload.'),
  tags: z.array(z.string()).optional(),
  status: RowStatus.optional(),
  split: z.string().nullable().optional(),
});

export const datasetOps = [
  defineOp({
    name: 'list_datasets',
    title: 'List datasets',
    description: 'Lists all datasets with row counts and how many rows wait for review.',
    category: 'datasets',
    readOnly: true,
    input: z.object({}),
    handler: async ({ engine }) => await engine.repos.datasets.list(),
  }),

  defineOp({
    name: 'get_dataset_schema',
    title: 'Get dataset schema',
    description:
      'Returns a dataset\'s columns (name, type, description, allowed values), its generation instructions, row counts by status and tag, and a few sample rows. Read this before adding rows.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ dataset: datasetRef, sampleRows: z.number().int().min(0).max(20).default(3) }),
    handler: async ({ engine }, { dataset, sampleRows }) => {
      const ds = await engine.repos.datasets.get(dataset);
      const stats = await engine.repos.datasets.stats(ds.id);
      const samples = sampleRows ? (await engine.repos.datasets.listRows(ds.id, { limit: sampleRows, status: ['approved'] })).rows : [];
      return {
        id: ds.id,
        name: ds.name,
        description: ds.description,
        revision: ds.revision,
        columns: ds.schema.columns,
        instructions: ds.schema.instructions,
        stats,
        sampleRows: samples.map((r) => ({ id: r.id, data: r.data, tags: r.tags })),
      };
    },
  }),

  defineOp({
    name: 'create_dataset',
    title: 'Create dataset',
    description: 'Creates a dataset with typed columns and optional generation instructions.',
    category: 'datasets',
    input: z.object({
      name: z.string().min(1),
      description: z.string().default(''),
      columns: z.array(ColumnSpec).default([]),
      instructions: z.string().default(''),
    }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.create({ name: i.name, description: i.description, schema: { columns: i.columns, instructions: i.instructions } }, actor);
      engine.events.emit({ type: 'dataset.changed', datasetId: ds.id, actor });
      return ds;
    },
  }),

  defineOp({
    name: 'update_dataset',
    title: 'Update dataset',
    description: 'Renames a dataset or changes its description, columns or instructions. Pass baseRevision to avoid overwriting someone else\'s change.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      name: z.string().optional(),
      description: z.string().optional(),
      columns: z.array(ColumnSpec).optional(),
      instructions: z.string().optional(),
      baseRevision: z.number().int().optional(),
    }),
    handler: async ({ engine, actor }, i) => {
      // Read and merge in one transaction, so a concurrent change to the other half of the schema isn't lost.
      const ds = await engine.db.tx(async () => {
        const cur = await engine.repos.datasets.get(i.dataset);
        const schema = i.columns || i.instructions !== undefined ? { columns: i.columns ?? cur.schema.columns, instructions: i.instructions ?? cur.schema.instructions } : undefined;
        return await engine.repos.datasets.update(cur.id, { name: i.name, description: i.description, schema }, i.baseRevision);
      });
      engine.events.emit({ type: 'dataset.changed', datasetId: ds.id, actor });
      return ds;
    },
  }),

  defineOp({
    name: 'delete_dataset',
    title: 'Delete dataset',
    description: 'Moves a dataset to the trash. Runs that used it keep their results.',
    category: 'datasets',
    destructive: true,
    input: z.object({ dataset: datasetRef }),
    handler: async ({ engine, actor }, { dataset }) => {
      const ds = await engine.repos.datasets.get(dataset);
      await engine.repos.datasets.delete(ds.id);
      engine.events.emit({ type: 'dataset.changed', datasetId: ds.id, actor });
      return { deleted: ds.id };
    },
  }),

  defineOp({
    name: 'list_rows',
    title: 'List rows',
    description: 'Pages through a dataset\'s rows. Filter by status, tag or text.',
    category: 'datasets',
    readOnly: true,
    input: z.object({
      dataset: datasetRef,
      status: z.array(RowStatus).optional(),
      tag: z.string().optional(),
      search: z.string().optional(),
      ids: z.array(z.string()).optional().describe('Only these row ids'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    handler: async ({ engine }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      return await engine.repos.datasets.listRows(ds.id, i);
    },
  }),

  defineOp({
    name: 'add_dataset_rows',
    title: 'Add rows',
    description:
      'Adds rows to a dataset (up to 200 per call). Each row is validated against the columns; invalid or duplicate rows are rejected individually with reasons, the rest are added. Rows added by agents start as "needs_review" unless a status is given.',
    category: 'datasets',
    input: z.object({ dataset: datasetRef, rows: z.array(rowInput).min(1).max(200) }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const res = await engine.repos.datasets.addRows(ds.id, i.rows, actor, {
        defaultStatus: actor.kind === 'agent' ? 'needs_review' : 'approved',
        provenance: { source: actor.kind === 'agent' ? 'agent' : 'manual', client: actor.client, model: actor.model },
      });
      if (res.added.length) engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: res.added.length, actor });
      return res;
    },
  }),

  defineOp({
    name: 'update_row',
    title: 'Update row',
    description: 'Changes one row\'s values, tags, status or split. Pass baseRev (from the row) to avoid overwriting a newer edit.',
    category: 'datasets',
    input: z.object({
      rowId: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
      tags: z.array(z.string()).optional(),
      status: RowStatus.optional(),
      split: z.string().nullable().optional(),
      baseRev: z.number().int().optional(),
    }),
    handler: async ({ engine, actor }, i) => {
      const row = await engine.repos.datasets.updateRow(i.rowId, i, actor, i.baseRev);
      engine.events.emit({ type: 'rows.changed', datasetId: row.datasetId, count: 1, actor });
      return row;
    },
  }),

  defineOp({
    name: 'set_rows_status',
    title: 'Set row status',
    description: 'Approves, rejects or re-queues rows for review in bulk.',
    category: 'datasets',
    input: z.object({ dataset: datasetRef, rowIds: z.array(z.string()).min(1), status: RowStatus }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const updated = await engine.repos.datasets.setStatus(ds.id, i.rowIds, i.status);
      engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: updated, actor });
      return { updated };
    },
  }),

  defineOp({
    name: 'delete_rows',
    title: 'Delete rows',
    description: 'Moves rows to the trash. Earlier dataset versions and runs keep them.',
    category: 'datasets',
    destructive: true,
    input: z.object({ dataset: datasetRef, rowIds: z.array(z.string()).min(1) }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const deleted = await engine.repos.datasets.deleteRows(ds.id, i.rowIds);
      engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: deleted, actor });
      return { deleted };
    },
  }),

  defineOp({
    name: 'create_dataset_version',
    title: 'Save dataset version',
    description: 'Freezes the current rows as an immutable, numbered version. Runs always record the version they used.',
    category: 'datasets',
    input: z.object({ dataset: datasetRef, note: z.string().default('') }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const v = await engine.repos.datasets.createVersion(ds.id, i.note, actor);
      engine.events.emit({ type: 'dataset.changed', datasetId: ds.id, actor });
      return v;
    },
  }),

  defineOp({
    name: 'list_dataset_versions',
    title: 'List dataset versions',
    description: 'Lists saved versions of a dataset.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ dataset: datasetRef }),
    handler: async ({ engine }, i) => await engine.repos.datasets.listVersions(i.dataset),
  }),

  defineOp({
    name: 'import_rows',
    title: 'Import rows from a file',
    description:
      'Imports rows from an uploaded CSV, JSONL or JSON file (pass its blob hash). Map file columns to dataset columns; unknown columns can be created automatically. Values in file-typed columns are matched by file name against `files` (name → uploaded blob hash).',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      blob: z.string(),
      format: z.enum(['auto', 'csv', 'jsonl', 'json']).default('auto'),
      mapping: z.record(z.string(), z.string()).optional().describe('source column → dataset column; omitted = same names'),
      createColumns: z.boolean().default(true),
      files: z.record(z.string(), z.string()).default({}).describe('file name → blob hash, for audio/image/file columns'),
      status: RowStatus.optional(),
      tags: z.array(z.string()).default([]),
    }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const info = await engine.blobs.info(i.blob);
      const text = (await engine.blobs.get(i.blob)).toString('utf8');
      const records = parseRecords(text, i.format === 'auto' ? guessFormat(info?.name, text) : i.format);
      if (!records.length) throw invalid('The file contains no rows');

      const sourceCols = [...new Set(records.flatMap((r) => Object.keys(r)))];
      const mapping = i.mapping ?? Object.fromEntries(sourceCols.map((c) => [c, c]));
      let columns = ds.schema.columns;
      // Compare by the column key the value is stored under, or re-importing "user question" would add user_question twice.
      const missing = new Map<string, string>();
      for (const dst of Object.values(mapping)) {
        if (dst && !columns.some((k) => k.key === safeKey(dst)) && !missing.has(safeKey(dst))) missing.set(safeKey(dst), dst);
      }
      if (missing.size) {
        if (!i.createColumns) throw invalid(`Unknown columns: ${[...missing.values()].join(', ')}`);
        const added = [...missing].map(([key, dst]) => ColumnSpec.parse({ key, type: inferType(records.map((r) => r[sourceKey(mapping, dst)])) }));
        // Added to the schema as it is now (the file was read meanwhile), not to the copy read before.
        columns = await engine.db.tx(async () => {
          const cur = await engine.repos.datasets.get(ds.id);
          const next = [...cur.schema.columns, ...added.filter((a) => !cur.schema.columns.some((c) => c.key === a.key))];
          await engine.repos.datasets.update(ds.id, { schema: { ...cur.schema, columns: next } });
          return next;
        });
      }
      const fileCols = new Set(columns.filter((c) => ['audio', 'image', 'file'].includes(c.type)).map((c) => c.key));
      const unmatched = new Set<string>();
      const rows = await mapSeq(records, async (rec) => {
        const data: Record<string, unknown> = {};
        for (const [src, dst] of Object.entries(mapping)) {
          if (!dst) continue;
          let v = rec[src];
          const key = safeKey(dst);
          if (fileCols.has(key) && typeof v === 'string' && v) {
            const name = v.split(/[\\/]/).pop()!;
            const hash = i.files[name] ?? i.files[v];
            if (hash) v = { blob: hash, name, mime: (await engine.blobs.info(hash))?.mime };
            else unmatched.add(name);
          }
          data[key] = v;
        }
        return { data, tags: i.tags, status: i.status };
      });
      const res = await engine.repos.datasets.addRows(ds.id, rows, actor, { provenance: { source: 'import', file: info?.name } });
      engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: res.added.length, actor });
      return { ...res, unmatchedFiles: [...unmatched] };
    },
  }),

  defineOp({
    name: 'export_dataset',
    title: 'Export dataset',
    description: 'Exports rows as CSV or JSONL (stored as a blob you can download). File columns export as file names plus blob hashes.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ dataset: datasetRef, format: z.enum(['csv', 'jsonl']).default('jsonl'), status: z.array(RowStatus).optional() }),
    handler: async ({ engine }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const { rows } = await engine.repos.datasets.listRows(ds.id, { status: i.status, limit: 1_000_000 });
      const flat = rows.map((r) => ({ row_id: r.id, ...r.data, tags: r.tags.join(','), status: r.status }));
      const text =
        i.format === 'csv'
          ? Papa.unparse(flat.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? ((v as any).blob ? (v as any).name ?? (v as any).blob : JSON.stringify(v)) : v]))))
          : flat.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const blob = await engine.blobs.put(Buffer.from(text, 'utf8'), { mime: i.format === 'csv' ? 'text/csv' : 'application/jsonl', name: `${ds.name}.${i.format}` });
      return { ...blob, rows: rows.length };
    },
  }),

  defineOp({
    name: 'generate_rows',
    title: 'Generate rows with a model',
    description:
      'Uses a model connection to write new rows that follow the dataset\'s columns and instructions. New rows start as "needs_review". File columns are left empty.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      connectionId: z.string(),
      model: z.string().default(''),
      count: z.number().int().min(1).max(500).default(10),
      instructions: z.string().default('').describe('Extra guidance for this batch, added to the dataset instructions'),
      batchSize: z.number().int().min(1).max(50).default(10),
      temperature: z.number().min(0).max(2).default(1),
    }),
    handler: async ({ engine, actor }, i) => {
      const ds = await engine.repos.datasets.get(i.dataset);
      const cols = ds.schema.columns.filter((c) => !['audio', 'image', 'file'].includes(c.type));
      if (!cols.length) throw invalid('This dataset has no text-like columns to generate');
      const properties = Object.fromEntries(cols.map((c) => [c.key, jsonTypeFor(c.type, c.enum, c.description)]));
      const schema = {
        type: 'object',
        properties: { rows: { type: 'array', items: { type: 'object', properties, required: cols.filter((c) => c.required).map((c) => c.key), additionalProperties: false } } },
        required: ['rows'],
        additionalProperties: false,
      };
      let added = 0;
      const rejected: unknown[] = [];
      let calls = 0;
      while (added < i.count && calls < Math.ceil(i.count / i.batchSize) + 3) {
        calls++;
        const want = Math.min(i.batchSize, i.count - added);
        const examples = (await engine.repos.datasets.listRows(ds.id, { limit: 5 })).rows.map((r) => r.data);
        const prompt = [
          `Write ${want} new, diverse test rows for the dataset "${ds.name}".`,
          ds.description && `Dataset description: ${ds.description}`,
          `Columns:\n${cols.map((c) => `- ${c.key} (${c.type}${c.enum ? `: one of ${c.enum.join(', ')}` : ''})${c.description ? `: ${c.description}` : ''}`).join('\n')}`,
          ds.schema.instructions && `Instructions:\n${ds.schema.instructions}`,
          i.instructions && `For this batch:\n${i.instructions}`,
          examples.length && `Existing rows (do not repeat them):\n${examples.map((e) => JSON.stringify(e)).join('\n')}`,
        ].filter(Boolean).join('\n\n');
        const res = await engine.llm.json<{ rows: Record<string, unknown>[] }>({
          connectionId: i.connectionId,
          model: i.model,
          system: 'You create realistic, varied evaluation data. Follow the column types exactly. Return only the requested JSON.',
          prompt,
          temperature: i.temperature,
          schema,
        });
        const out = await engine.repos.datasets.addRows(ds.id, (res.value?.rows ?? []).slice(0, want).map((data) => ({ data })), actor, {
          defaultStatus: 'needs_review',
          provenance: { source: 'generated', connectionId: i.connectionId, model: res.model },
        });
        added += out.added.length;
        rejected.push(...out.rejected);
        engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: out.added.length, actor });
      }
      return { added, rejected, calls };
    },
  }),
];

function jsonTypeFor(type: ColumnType, enumValues?: string[], description?: string) {
  const d = description ? { description } : {};
  switch (type) {
    case 'number':
      return { type: 'number', ...d };
    case 'boolean':
      return { type: 'boolean', ...d };
    case 'list':
      return { type: 'array', items: { type: 'string' }, ...d };
    case 'messages':
      return { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } }, required: ['role', 'content'], additionalProperties: false }, ...d };
    case 'json':
      return { type: 'string', description: `${description ?? ''} (JSON encoded as a string)`.trim() };
    default:
      return enumValues?.length ? { type: 'string', enum: enumValues, ...d } : { type: 'string', ...d };
  }
}

function guessFormat(name: string | undefined, text: string): 'csv' | 'jsonl' | 'json' {
  const ext = name?.split('.').pop()?.toLowerCase();
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  const t = text.trimStart();
  if (t.startsWith('[')) return 'json';
  if (t.startsWith('{')) return 'jsonl';
  return 'csv';
}

function parseRecords(text: string, format: 'csv' | 'jsonl' | 'json'): Record<string, unknown>[] {
  if (format === 'json') {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : [v];
  }
  if (format === 'jsonl') {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l, n) => {
      let v: any;
      try {
        v = JSON.parse(l);
      } catch {
        throw invalid(`Line ${n + 1} is not valid JSON`);
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`Line ${n + 1} is not a JSON object`);
      return v.item && typeof v.item === 'object' ? v.item : v; // OpenAI Evals {"item": {...}}
    });
  }
  const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  return parsed.data;
}

const safeKey = (k: string) => k.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'column';
const sourceKey = (mapping: Record<string, string>, dst: string) => Object.keys(mapping).find((k) => mapping[k] === dst) ?? dst;

function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => v !== undefined && v !== null && v !== '');
  if (!present.length) return 'text';
  if (present.every((v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)))) return 'number';
  if (present.every((v) => typeof v === 'boolean' || v === 'true' || v === 'false')) return 'boolean';
  if (present.every((v) => Array.isArray(v))) return present.every((v) => (v as any[]).every((m) => m && typeof m === 'object' && 'role' in m)) ? 'messages' : 'list';
  if (present.every((v) => typeof v === 'object')) return 'json';
  if (present.every((v) => typeof v === 'string' && /\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(v))) return 'audio';
  if (present.every((v) => typeof v === 'string' && /\.(png|jpe?g|gif|webp)$/i.test(v))) return 'image';
  return 'text';
}

export { DatasetSchema };
