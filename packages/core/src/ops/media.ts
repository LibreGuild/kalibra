import { z } from 'zod';
import { augmentAudio, describeEffects, type AudioEffect } from '../audio/augment.js';
import type { Engine } from '../engine.js';
import { mapLimit, type JobHandle } from '../jobs.js';
import { defineOp, type Actor, type OpDef } from '../registry.js';
import type { RowRecord } from '../repo/datasets.js';
import { RowStatus, type ColumnSpec, type ColumnType } from '../specs.js';
import { render } from '../template.js';
import { invalid } from '../util.js';

/*
 * Media for datasets: generate images and speech with model connections, transcribe audio into
 * reference text, and derive realistic audio variants (noise, phone line, room echo, …).
 * Every long operation runs as a background job and returns { jobId } immediately.
 */

const datasetRef = z.string().describe('Dataset id or name');
const scopeMode = z.enum(['fill_empty', 'overwrite']).default('fill_empty').describe('fill_empty: only rows where the column is empty; overwrite: every selected row');

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/opus': 'opus',
};

const slug = (s: string, max = 40) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'item';

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
const rowScope = (row: RowRecord) => ({ ...row.data, row: row.data, row_id: row.id, tags: row.tags });

function column(engine: Engine, datasetId: string, key: string, allowed: ColumnType[]): ColumnSpec {
  const ds = engine.repos.datasets.get(datasetId);
  const col = ds.schema.columns.find((c) => c.key === key);
  if (!col) throw invalid(`Column "${key}" does not exist in "${ds.name}". Add it first (update_dataset).`);
  if (!allowed.includes(col.type)) throw invalid(`Column "${key}" is ${col.type}; this needs a ${allowed.join(' or ')} column.`);
  return col;
}

function selectRows(engine: Engine, datasetId: string, opts: { rowIds?: string[]; limit?: number; filter?: (r: RowRecord) => boolean }) {
  let rows = engine.repos.datasets.listRows(datasetId, { ids: opts.rowIds, limit: 1_000_000 }).rows.filter((r) => r.status !== 'rejected' || opts.rowIds?.includes(r.id));
  if (opts.filter) rows = rows.filter(opts.filter);
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

function connectionProvider(engine: Engine, connectionId: string) {
  return engine.repos.defs.get('connection', connectionId).spec.provider as string;
}

/** Merges `patch` into a row's provenance (media provenance per column). */
function noteProvenance(engine: Engine, rowId: string, patch: Record<string, unknown>) {
  engine.db.run("UPDATE rows SET provenance = json_patch(COALESCE(provenance, '{}'), ?) WHERE id = ?", JSON.stringify(patch), rowId);
}

async function putFile(engine: Engine, data: Uint8Array, mime: string, base: string) {
  const info = await engine.blobs.put(Buffer.from(data), { mime, name: `${base}.${EXT[mime] ?? mime.split('/')[1] ?? 'bin'}` });
  return { blob: info.hash, name: info.name, mime: info.mime, size: info.size };
}

function setRowFile(engine: Engine, actor: Actor, row: RowRecord, col: string, file: unknown, extra: { tags?: string[]; status?: z.infer<typeof RowStatus> } = {}) {
  const updated = engine.repos.datasets.updateRow(row.id, { data: { [col]: file }, tags: extra.tags, status: extra.status }, actor);
  engine.events.emit({ type: 'rows.changed', datasetId: row.datasetId, count: 1, actor });
  return updated;
}

const summary = (o: { created?: number; updated?: number; skipped?: number; failed: number; total: number }) => o;

/** Runs a per-item job body and turns thrown errors into per-item failures. */
async function eachItem<T>(job: JobHandle, items: T[], concurrency: number, label: (item: T) => string, body: (item: T) => Promise<'created' | 'updated' | 'skipped'>) {
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0, total: items.length };
  let done = 0;
  job.progress(0, items.length);
  await mapLimit(items, concurrency, job.signal, async (item) => {
    try {
      counts[await body(item)]++;
    } catch (e: any) {
      if (job.signal.aborted) return;
      counts.failed++;
      job.itemError(e?.message ?? String(e), label(item));
    }
    job.progress(++done, items.length);
  });
  return summary(counts);
}

const effectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noise'), snrDb: z.number().min(-10).max(60).default(15), color: z.enum(['white', 'pink']).default('pink') }),
  z.object({ type: z.literal('telephone') }),
  z.object({ type: z.literal('reverb'), amount: z.number().min(0).max(1).default(0.5) }),
  z.object({ type: z.literal('gain'), db: z.number().min(-40).max(20).default(-12) }),
  z.object({ type: z.literal('clip'), level: z.number().min(0.01).max(1).default(0.3) }),
  z.object({ type: z.literal('speed'), rate: z.number().min(0.5).max(2).default(1.2) }),
  z.object({ type: z.literal('lowpass'), hz: z.number().min(200).max(8000).default(2000) }),
  z.object({ type: z.literal('dropouts'), percent: z.number().min(0).max(50).default(5) }),
]);

export const mediaOps: OpDef<any, any>[] = [
  defineOp({
    name: 'list_jobs',
    title: 'List background jobs',
    description: 'Recent background jobs (image and speech generation, transcription, audio variants) with their progress.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ limit: z.number().int().min(1).max(200).default(30) }),
    handler: ({ engine }, i) => engine.jobs.list(i.limit),
  }),

  defineOp({
    name: 'get_job',
    title: 'Get job status',
    description: 'Progress, per-item errors and the final result of a background job. Poll until status is completed, failed or cancelled.',
    category: 'datasets',
    readOnly: true,
    input: z.object({ jobId: z.string() }),
    handler: ({ engine }, i) => {
      const job = engine.jobs.get(i.jobId);
      if (!job) throw invalid(`Unknown job ${i.jobId} (jobs are kept in memory until the app restarts)`);
      return job;
    },
  }),

  defineOp({
    name: 'cancel_job',
    title: 'Cancel job',
    description: 'Stops a running background job. Items already finished stay in the dataset.',
    category: 'datasets',
    input: z.object({ jobId: z.string() }),
    handler: ({ engine }, i) => ({ cancelled: engine.jobs.cancel(i.jobId) }),
  }),

  defineOp({
    name: 'generate_images',
    title: 'Generate images into a dataset',
    description:
      'Draws images with an image model connection (e.g. GPT Image, Imagen) and stores them in an image column. ' +
      'mode fill_empty/overwrite renders `promptTemplate` per existing row (e.g. "A photo of {{item}} on a kitchen table"); ' +
      'mode new_rows adds one row per entry of `prompts`. New rows start as needs_review. Runs in the background: returns { jobId }; poll get_job.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      column: z.string().describe('Image (or file) column that receives the images'),
      mode: z.enum(['fill_empty', 'overwrite', 'new_rows']).default('fill_empty'),
      promptTemplate: z.string().default('').describe('Prompt per row; {{column}} placeholders use the row values. For new_rows, {{prompt}} is the prompt from the list.'),
      prompts: z.array(z.string()).default([]).describe('new_rows only: one new row per prompt'),
      promptColumn: z.string().default('').describe('new_rows only: text column that stores each prompt'),
      connectionId: z.string(),
      model: z.string().default('').describe('Image model; empty uses the connection image model'),
      size: z.string().default('').describe('e.g. 1024x1024, 1536x1024 (provider dependent)'),
      aspectRatio: z.string().default('').describe('e.g. 16:9 (providers that use aspect ratios instead of sizes)'),
      quality: z.enum(['', 'low', 'medium', 'high', 'auto']).default('').describe('OpenAI / Azure image quality'),
      rowIds: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      concurrency: z.number().int().min(1).max(8).default(2),
      status: RowStatus.optional().describe('Status for rows that get an image (new rows default to needs_review)'),
    }),
    handler: ({ engine, actor }, i) => {
      const ds = engine.repos.datasets.get(i.dataset);
      column(engine, ds.id, i.column, ['image', 'file']);
      if (i.mode === 'new_rows') {
        if (!i.prompts.filter((p) => p.trim()).length) throw invalid('new_rows needs at least one prompt');
        if (i.promptColumn) column(engine, ds.id, i.promptColumn, ['text']);
      } else if (!i.promptTemplate.trim()) throw invalid('promptTemplate is required');
      const provider = connectionProvider(engine, i.connectionId);
      const options = i.quality && (provider === 'openai' || provider === 'azure') ? { quality: i.quality } : undefined;

      const draw = async (prompt: string, signal: AbortSignal) => {
        const res = await engine.llm.image({ connectionId: i.connectionId, model: i.model || undefined, prompt, size: i.size || undefined, aspectRatio: i.aspectRatio || undefined, options, signal });
        if (!res.images.length) throw new Error('The model returned no image');
        return { res, file: await putFile(engine, res.images[0].data, res.images[0].mime, slug(prompt)) };
      };

      const job = engine.jobs.start(
        'generate_images',
        `Images for ${ds.name}`,
        async (job) => {
          if (i.mode === 'new_rows') {
            const prompts = i.prompts.map((p) => p.trim()).filter(Boolean).slice(0, i.limit ?? Infinity);
            return eachItem(job, prompts, i.concurrency, (p) => p.slice(0, 60), async (p) => {
              const prompt = i.promptTemplate.trim() ? await render(i.promptTemplate, { prompt: p }, engine.templateEnv()) : p;
              const { res, file } = await draw(prompt, job.signal);
              const data: Record<string, unknown> = { [i.column]: file };
              if (i.promptColumn) data[i.promptColumn] = p;
              const out = engine.repos.datasets.addRows(ds.id, [{ data, status: i.status ?? 'needs_review' }], actor, {
                provenance: { source: 'generated', kind: 'image', model: res.model, prompt, connectionId: i.connectionId },
              });
              if (out.rejected.length) throw new Error(out.rejected[0].errors.join('; '));
              engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: 1, actor });
              return 'created';
            });
          }
          const rows = selectRows(engine, ds.id, { rowIds: i.rowIds, limit: i.limit, filter: i.mode === 'fill_empty' ? (r) => isEmpty(r.data[i.column]) : undefined });
          return eachItem(job, rows, i.concurrency, (r) => r.id, async (row) => {
            const prompt = await render(i.promptTemplate, rowScope(row), engine.templateEnv());
            if (!prompt.trim()) return 'skipped';
            const { res, file } = await draw(prompt, job.signal);
            setRowFile(engine, actor, row, i.column, file, { status: i.status });
            noteProvenance(engine, row.id, { media: { [i.column]: { source: 'generated', kind: 'image', model: res.model, prompt } } });
            return 'updated';
          });
        },
        actor,
        { datasetId: ds.id },
      );
      return { jobId: job.id };
    },
  }),

  defineOp({
    name: 'generate_speech',
    title: 'Generate speech into a dataset',
    description:
      'Reads text from each row (textTemplate, e.g. "{{reference}}") aloud with a text-to-speech model and stores the WAV in an audio column. ' +
      'Voices rotate across rows and each row is tagged voice:<name>. instructionsTemplate steers accent, tone and pace on models that support it. ' +
      'Runs in the background: returns { jobId }.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      column: z.string().describe('Audio (or file) column that receives the speech'),
      textTemplate: z.string().default('{{reference}}'),
      voices: z.array(z.string()).default([]).describe('Voices to rotate through, e.g. ["alloy", "coral"]. Empty = provider default.'),
      instructionsTemplate: z.string().default('').describe('Optional speaking instructions, e.g. "Speak with an Indian English accent, slightly fast"'),
      speed: z.number().min(0.25).max(4).optional(),
      language: z.string().default(''),
      format: z.enum(['wav', 'mp3']).default('wav'),
      connectionId: z.string(),
      model: z.string().default('').describe('Speech model; empty uses the connection speech model'),
      mode: scopeMode,
      rowIds: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      concurrency: z.number().int().min(1).max(8).default(3),
      status: RowStatus.optional(),
    }),
    handler: ({ engine, actor }, i) => {
      const ds = engine.repos.datasets.get(i.dataset);
      column(engine, ds.id, i.column, ['audio', 'file']);
      if (!i.textTemplate.trim()) throw invalid('textTemplate is required');
      const rows = selectRows(engine, ds.id, { rowIds: i.rowIds, limit: i.limit, filter: i.mode === 'fill_empty' ? (r) => isEmpty(r.data[i.column]) : undefined });
      const voiceFor = new Map(rows.map((r, n) => [r.id, i.voices.length ? i.voices[n % i.voices.length] : '']));

      const job = engine.jobs.start(
        'generate_speech',
        `Speech for ${ds.name}`,
        async (job) =>
          eachItem(job, rows, i.concurrency, (r) => r.id, async (row) => {
            const env = engine.templateEnv();
            const text = (await render(i.textTemplate, rowScope(row), env)).trim();
            if (!text) return 'skipped';
            const voice = voiceFor.get(row.id) || undefined;
            const instructions = i.instructionsTemplate ? (await render(i.instructionsTemplate, rowScope(row), env)).trim() : undefined;
            const res = await engine.llm.speech({ connectionId: i.connectionId, model: i.model || undefined, text, voice, instructions, speed: i.speed, language: i.language || undefined, format: i.format, signal: job.signal });
            const file = await putFile(engine, res.audio.data, res.audio.mime, `${slug(text, 32)}${voice ? `-${voice}` : ''}`);
            const tags = voice ? [...row.tags.filter((t) => !t.startsWith('voice:')), `voice:${voice}`] : undefined;
            setRowFile(engine, actor, row, i.column, file, { tags, status: i.status });
            noteProvenance(engine, row.id, { media: { [i.column]: { source: 'generated', kind: 'speech', model: res.model, voice: voice ?? null, instructions: instructions ?? null } } });
            return 'updated';
          }),
        actor,
        { datasetId: ds.id },
      );
      return { jobId: job.id };
    },
  }),

  defineOp({
    name: 'transcribe_rows',
    title: 'Transcribe audio into a column',
    description:
      'Transcribes the audio in each row with a speech-to-text model connection and writes the text into a text column. ' +
      'Useful to bootstrap reference transcripts; rows are set to needs_review so a person can correct them. Returns { jobId }.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      audioColumn: z.string(),
      textColumn: z.string(),
      connectionId: z.string(),
      model: z.string().default('').describe('Transcription model; empty uses the connection transcription model'),
      mode: scopeMode,
      rowIds: z.array(z.string()).optional(),
      limit: z.number().int().positive().optional(),
      concurrency: z.number().int().min(1).max(8).default(3),
      status: RowStatus.default('needs_review'),
    }),
    handler: ({ engine, actor }, i) => {
      const ds = engine.repos.datasets.get(i.dataset);
      column(engine, ds.id, i.audioColumn, ['audio', 'file']);
      column(engine, ds.id, i.textColumn, ['text']);
      const rows = selectRows(engine, ds.id, {
        rowIds: i.rowIds,
        limit: i.limit,
        filter: (r) => !isEmpty(r.data[i.audioColumn]) && (i.mode === 'overwrite' || isEmpty(r.data[i.textColumn])),
      });
      const job = engine.jobs.start(
        'transcribe_rows',
        `Transcripts for ${ds.name}`,
        async (job) =>
          eachItem(job, rows, i.concurrency, (r) => r.id, async (row) => {
            const file = row.data[i.audioColumn] as any;
            if (!file?.blob) return 'skipped';
            const bytes = await engine.blobs.get(file.blob);
            const res = await engine.llm.transcribe({ connectionId: i.connectionId, model: i.model || undefined, audio: { data: bytes, mime: file.mime || engine.blobs.info(file.blob)?.mime || 'audio/wav' }, signal: job.signal });
            engine.repos.datasets.updateRow(row.id, { data: { [i.textColumn]: res.text.trim() }, status: i.status }, actor);
            noteProvenance(engine, row.id, { media: { [i.textColumn]: { source: 'transcribed', model: res.model, language: res.language ?? null } } });
            engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: 1, actor });
            return 'updated';
          }),
        actor,
        { datasetId: ds.id },
      );
      return { jobId: job.id };
    },
  }),

  defineOp({
    name: 'augment_audio',
    title: 'Make audio variants',
    description:
      'Creates harder versions of audio rows: background noise at a chosen SNR, phone-line quality, room echo, quiet or clipped speakers, faster speech, dropouts. ' +
      'Each source row × recipe becomes a new row (same values, augmented audio, tag aug:<recipe>), so you can compare WER on clean vs. degraded audio. ' +
      'Deterministic: the same row and recipe always give the same audio. Returns { jobId }.',
    category: 'datasets',
    input: z.object({
      dataset: datasetRef,
      sourceColumn: z.string().describe('Audio column to transform'),
      recipes: z
        .array(z.object({ name: z.string().min(1), effects: z.array(effectSchema).min(1) }))
        .min(1)
        .describe('Each recipe applies its effects in order, e.g. { name: "cafe-10db", effects: [{ type: "noise", snrDb: 10, color: "pink" }] }'),
      rowIds: z.array(z.string()).optional(),
      onlyTags: z.array(z.string()).optional().describe('Only rows with any of these tags'),
      includeAugmented: z.boolean().default(false).describe('Also transform rows that are already variants'),
      tags: z.array(z.string()).default([]).describe('Extra tags for the new rows'),
      limit: z.number().int().positive().optional(),
      concurrency: z.number().int().min(1).max(8).default(4),
    }),
    handler: ({ engine, actor }, i) => {
      const ds = engine.repos.datasets.get(i.dataset);
      column(engine, ds.id, i.sourceColumn, ['audio', 'file']);
      const rows = selectRows(engine, ds.id, {
        rowIds: i.rowIds,
        limit: i.limit,
        filter: (r) =>
          !isEmpty(r.data[i.sourceColumn]) &&
          (i.includeAugmented || !r.tags.some((t) => t.startsWith('aug:'))) &&
          (!i.onlyTags?.length || r.tags.some((t) => i.onlyTags!.includes(t))),
      });
      const items = rows.flatMap((row) => i.recipes.map((recipe) => ({ row, recipe })));
      const job = engine.jobs.start(
        'augment_audio',
        `Audio variants for ${ds.name}`,
        async (job) =>
          eachItem(job, items, i.concurrency, (x) => `${x.row.id} × ${x.recipe.name}`, async ({ row, recipe }) => {
            const file = row.data[i.sourceColumn] as any;
            if (!file?.blob) return 'skipped';
            const bytes = await engine.blobs.get(file.blob);
            const { wav } = await augmentAudio(bytes, file.mime || engine.blobs.info(file.blob)?.mime, recipe.effects as AudioEffect[], `${row.id}:${recipe.name}`);
            const base = (file.name ?? 'audio').replace(/\.[a-z0-9]+$/i, '');
            const out = await putFile(engine, wav, 'audio/wav', `${base}.${slug(recipe.name, 24)}`);
            const tag = `aug:${slug(recipe.name, 32)}`;
            const res = engine.repos.datasets.addRows(
              ds.id,
              [{ data: { ...row.data, [i.sourceColumn]: out }, tags: [...new Set([...row.tags, tag, ...i.tags])], status: row.status, split: row.split }],
              actor,
              { provenance: { source: 'augmented', from: row.id, recipe: recipe.name, effects: describeEffects(recipe.effects as AudioEffect[]) } },
            );
            if (res.rejected.length) {
              if (res.rejected[0].duplicateOf) return 'skipped';
              throw new Error(res.rejected[0].errors.join('; '));
            }
            engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: 1, actor });
            return 'created';
          }),
        actor,
        { datasetId: ds.id },
      );
      return { jobId: job.id, items: items.length };
    },
  }),
];
