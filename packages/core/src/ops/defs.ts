import { z } from 'zod';
import { CHECK_TYPES } from '../checks/index.js';
import { LAYERS } from '../checks/types.js';
import { createLlmClient, inferModelKind, listModels, PROVIDERS } from '../providers/index.js';
import { encodeWav } from '../audio/wav.js';
import { defineOp, type OpDef } from '../registry.js';
import { ConnectionSpec, TargetSpec, type DefKind } from '../specs.js';
import { executeTarget, parseCurl } from '../targets/index.js';
import { invalid } from '../util.js';
import { assertCodeChange } from '../policy.js';

const LABEL: Record<DefKind, { one: string; many: string; about: string }> = {
  target: { one: 'target', many: 'targets', about: 'A target is the AI application under test: an HTTP API, a WebSocket service, a model + prompt, or a custom script.' },
  suite: { one: 'suite', many: 'suites', about: 'A suite is an ordered set of checks (status, schema, WER, LLM judge, ...) applied to every result.' },
  connection: { one: 'connection', many: 'connections', about: 'A connection is a model provider account used for LLM judges, model targets and data generation.' },
};

/** list/get/create/update/delete/versions for one definition kind. */
function defOps(kind: DefKind): OpDef<any, any>[] {
  const L = LABEL[kind];
  const category = kind === 'target' ? 'targets' : kind === 'suite' ? 'suites' : 'connections';
  const ref = z.string().describe(`${L.one} id or name`);
  const changed = (engine: any, id: string, actor: any) => engine.events.emit({ type: 'def.changed', kind, id, actor });
  // Connections hold the project's model accounts (and point at its secrets): only owners change them.
  const writeAccess = kind === 'connection' ? ('owner' as const) : undefined;
  return [
    defineOp({
      name: `list_${L.many}`,
      title: `List ${L.many}`,
      description: `Lists all ${L.many}. ${L.about}`,
      category,
      readOnly: true,
      input: z.object({}),
      handler: ({ engine }) => engine.repos.defs.list(kind),
    }),
    defineOp({
      name: `get_${L.one}`,
      title: `Get ${L.one}`,
      description: `Returns one ${L.one} with its full spec. Pass version to read an older version.`,
      category,
      readOnly: true,
      input: z.object({ id: ref, version: z.number().int().optional() }),
      handler: ({ engine }, i) => (i.version ? engine.repos.defs.getVersion(kind, i.id, i.version) : engine.repos.defs.get(kind, i.id)),
    }),
    defineOp({
      name: `create_${L.one}`,
      title: `Create ${L.one}`,
      description: `Creates a ${L.one}. ${L.about} Omitted spec fields get defaults.`,
      category,
      access: writeAccess,
      input: z.object({ name: z.string().min(1), description: z.string().default(''), spec: z.record(z.string(), z.unknown()) }),
      handler: ({ engine, actor }, i) => {
        const d = engine.repos.defs.create(kind, i, actor);
        changed(engine, d.id, actor);
        return d;
      },
    }),
    defineOp({
      name: `update_${L.one}`,
      title: `Update ${L.one}`,
      description: `Saves a new version of a ${L.one}. Pass baseVersion (the version you read) so a concurrent edit is not overwritten.`,
      category,
      access: writeAccess,
      input: z.object({
        id: ref,
        name: z.string().optional(),
        description: z.string().optional(),
        spec: z.record(z.string(), z.unknown()).optional(),
        baseVersion: z.number().int().optional(),
      }),
      handler: ({ engine, actor }, i) => {
        const d = engine.repos.defs.update(kind, i.id, i, actor, i.baseVersion);
        changed(engine, d.id, actor);
        return d;
      },
    }),
    defineOp({
      name: `delete_${L.one}`,
      title: `Delete ${L.one}`,
      description: `Moves a ${L.one} to the trash. Past runs keep the exact version they used.`,
      category,
      access: writeAccess,
      destructive: true,
      input: z.object({ id: ref }),
      handler: ({ engine, actor }, i) => {
        const d = engine.repos.defs.get(kind, i.id);
        engine.repos.defs.delete(kind, d.id);
        changed(engine, d.id, actor);
        return { deleted: d.id };
      },
    }),
    defineOp({
      name: `list_${L.one}_versions`,
      title: `List ${L.one} versions`,
      description: `Version history of a ${L.one}: who saved each version and when.`,
      category,
      readOnly: true,
      input: z.object({ id: ref }),
      handler: ({ engine }, i) => engine.repos.defs.versions(kind, i.id),
    }),
  ];
}

export const defOpsAll = [
  ...defOps('target'),
  ...defOps('suite'),
  ...defOps('connection'),

  defineOp({
    name: 'test_target',
    title: 'Try a target',
    description:
      'Calls a target once with one dataset row (or values you pass) and returns the rendered request, response, extracted outputs, metrics and logs. Works with unsaved specs, so you can try before saving.',
    category: 'targets',
    readOnly: true,
    // Calls the app with the project's secrets.
    access: 'editor',
    input: z.object({
      target: z.string().optional().describe('Saved target id or name'),
      spec: z.record(z.string(), z.unknown()).optional().describe('Unsaved target spec (overrides target)'),
      dataset: z.string().optional(),
      rowId: z.string().optional().describe('Row to use; defaults to the first row of the dataset'),
      values: z.record(z.string(), z.unknown()).optional().describe('Row values to use instead of a dataset row'),
    }),
    handler: async ({ engine }, i) => {
      const saved = i.target ? engine.repos.defs.get('target', i.target).spec : undefined;
      const spec = TargetSpec.parse(i.spec ?? saved);
      if (i.spec) assertCodeChange(saved ?? {}, spec, 'This target');
      let row: Record<string, unknown> = i.values ?? {};
      let rowId = 'manual';
      if (!i.values && (i.rowId || i.dataset)) {
        const r = i.rowId
          ? engine.repos.datasets.getRow(i.rowId)
          : engine.repos.datasets.listRows(engine.repos.datasets.get(i.dataset!).id, { limit: 1 }).rows[0];
        if (!r) throw invalid('The dataset has no rows yet');
        row = r.data;
        rowId = r.id;
      }
      const res = await executeTarget(spec, {
        row,
        rowId,
        vars: Object.fromEntries(spec.variables.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value])),
        env: engine.templateEnv(),
        blobs: engine.blobs,
        llm: engine.llm,
        signal: AbortSignal.timeout(180_000),
        workspaceDir: engine.dir,
      });
      return { ...res, rowId, row };
    },
  }),

  defineOp({
    name: 'parse_curl',
    title: 'Import a cURL command',
    description: 'Turns a cURL command (e.g. from browser devtools "Copy as cURL") into an HTTP target config.',
    category: 'targets',
    readOnly: true,
    input: z.object({ command: z.string().min(1) }),
    handler: (_ctx, i) => parseCurl(i.command),
  }),

  defineOp({
    name: 'list_check_types',
    title: 'List check types',
    description: 'All available check types with their layer, description, config fields and defaults.',
    category: 'suites',
    readOnly: true,
    input: z.object({}),
    handler: () => ({
      layers: LAYERS,
      types: CHECK_TYPES.map((t) => ({
        type: t.type,
        label: t.label,
        category: t.category,
        layer: t.layer,
        description: t.description,
        fields: t.fields,
        defaults: safeDefaults(t.config),
      })),
    }),
  }),

  defineOp({
    name: 'list_providers',
    title: 'List model providers',
    description: 'Model providers a connection can use.',
    category: 'connections',
    readOnly: true,
    input: z.object({}),
    handler: () => PROVIDERS,
  }),

  defineOp({
    name: 'test_connection',
    title: 'Test a connection',
    description:
      'Makes one small call through a connection and reports latency. Text models get a tiny prompt, image models draw a small test image, speech models say one sentence, transcription models transcribe a short clip. Works with unsaved specs.',
    category: 'connections',
    // Calls the provider with the project's keys.
    access: 'editor',
    readOnly: true,
    input: z.object({
      id: z.string().optional(),
      spec: z.record(z.string(), z.unknown()).optional(),
      model: z.string().default(''),
      kind: z.enum(['auto', 'text', 'image', 'speech', 'transcription']).default('auto'),
    }),
    handler: async ({ engine }, i) => {
      const spec = ConnectionSpec.parse(i.spec ?? engine.repos.defs.get('connection', i.id ?? '').spec);
      const client = createLlmClient(() => spec, engine.secrets);
      const kind =
        i.kind !== 'auto'
          ? i.kind
          : i.model
            ? inferModelKind(i.model)
            : spec.defaultModel
              ? inferModelKind(spec.defaultModel)
              : spec.imageModel ? 'image' : spec.speechModel ? 'speech' : spec.transcriptionModel ? 'transcription' : 'text';
      const model = i.model || (kind === 'image' ? spec.imageModel : kind === 'speech' ? spec.speechModel : kind === 'transcription' ? spec.transcriptionModel : '') || spec.defaultModel;
      const base = { connectionId: 'test', model };
      if (kind === 'image') {
        const r = await client.image({ ...base, prompt: 'A simple flat icon of a balance scale, centered, plain light background', options: spec.provider === 'openai' ? { quality: 'low' } : undefined });
        const file = await engine.blobs.put(Buffer.from(r.images[0].data), { mime: r.images[0].mime, name: 'connection-test.png' });
        return { ok: true, kind, model: r.model, latencyMs: r.latencyMs, file };
      }
      if (kind === 'speech') {
        const r = await client.speech({ ...base, text: 'Kalibra connection test. One, two, three.' });
        const file = await engine.blobs.put(Buffer.from(r.audio.data), { mime: r.audio.mime, name: 'connection-test.wav' });
        return { ok: true, kind, model: r.model, latencyMs: r.latencyMs, file };
      }
      if (kind === 'transcription') {
        const silence = encodeWav([new Float32Array(16000)], 16000);
        const r = await client.transcribe({ ...base, audio: { data: silence, mime: 'audio/wav' } });
        return { ok: true, kind, model: r.model, latencyMs: r.latencyMs, reply: r.text || '(silence transcribed as empty text)' };
      }
      const res = await client.text({ ...base, prompt: 'Reply with exactly: OK', maxOutputTokens: 512 });
      return { ok: true, kind, reply: res.text.trim() || '(empty reply — the model may have spent its budget thinking)', latencyMs: res.latencyMs, model: res.model };
    },
  }),

  defineOp({
    name: 'list_models',
    title: 'List models',
    description: 'Lists models available through a connection, when the provider supports listing.',
    category: 'connections',
    // Calls the provider with the project's keys.
    access: 'editor',
    readOnly: true,
    input: z.object({ id: z.string().optional(), spec: z.record(z.string(), z.unknown()).optional() }),
    handler: async ({ engine }, i) => {
      const spec = ConnectionSpec.parse(i.spec ?? engine.repos.defs.get('connection', i.id ?? '').spec);
      return listModels(spec, engine.secrets);
    },
  }),

  defineOp({
    name: 'list_secrets',
    title: 'List secret names',
    description: 'Names of stored secrets (values are never returned). Reference them in templates as {{secret.name}}.',
    category: 'connections',
    readOnly: true,
    input: z.object({}),
    handler: ({ engine }) => engine.secrets.list(),
  }),

  defineOp({
    name: 'set_secret',
    title: 'Set secret',
    description: 'Stores a secret value in the project\'s secret store (never in definitions or exports).',
    category: 'connections',
    access: 'owner',
    mcp: false,
    input: z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() }),
    handler: async ({ engine }, i) => {
      await engine.secrets.set(i.name, i.value);
      return { name: i.name };
    },
  }),

  defineOp({
    name: 'delete_secret',
    title: 'Delete secret',
    description: 'Removes a stored secret.',
    category: 'connections',
    access: 'owner',
    mcp: false,
    destructive: true,
    input: z.object({ name: z.string() }),
    handler: async ({ engine }, i) => {
      await engine.secrets.delete(i.name);
      return { deleted: i.name };
    },
  }),
];

function safeDefaults(schema: z.ZodType) {
  try {
    return schema.parse({});
  } catch {
    return {};
  }
}
