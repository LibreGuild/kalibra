import { z } from 'zod';

/*
 * Every user-facing definition is described here once. The UI forms, the HTTP API, the CLI and the
 * MCP tools all validate against these schemas. Design rule: every structured option has a
 * script escape hatch, so users are never blocked by what the forms happen to support.
 */

export const KV = z.object({
  key: z.string(),
  value: z.string().default(''),
  enabled: z.boolean().default(true),
});
export type KV = z.infer<typeof KV>;

// ── Datasets ────────────────────────────────────────────────────────────────

export const ColumnType = z.enum(['text', 'number', 'boolean', 'json', 'list', 'messages', 'audio', 'image', 'file']);
export type ColumnType = z.infer<typeof ColumnType>;

export const ColumnSpec = z.object({
  key: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, digits and _ (must not start with a digit)')
    .describe('Column name used in templates, e.g. {{question}}'),
  type: ColumnType.default('text'),
  description: z.string().default('').describe('What this column holds. Shown to people and to coding agents filling the data.'),
  required: z.boolean().default(false),
  enum: z.array(z.string()).optional().describe('Allowed values (optional)'),
});
export type ColumnSpec = z.infer<typeof ColumnSpec>;

export const DatasetSchema = z.object({
  columns: z.array(ColumnSpec).default([]),
  instructions: z
    .string()
    .default('')
    .describe('How rows should be written: tone, coverage, distributions, rules. Used by generators and agents.'),
});
export type DatasetSchema = z.infer<typeof DatasetSchema>;

/** A file-typed cell (audio, image, file) points at a blob by content hash. */
export const FileValue = z.object({
  blob: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().optional(),
  mime: z.string().optional(),
  size: z.number().optional(),
});
export type FileValue = z.infer<typeof FileValue>;

export const RowStatus = z.enum(['draft', 'needs_review', 'approved', 'rejected']);
export type RowStatus = z.infer<typeof RowStatus>;

// ── Targets (the app under test) ────────────────────────────────────────────

export const Auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().describe('Template, e.g. {{secret.my_api_key}}') }),
  z.object({
    type: z.literal('api_key'),
    name: z.string().default('x-api-key'),
    value: z.string(),
    in: z.enum(['header', 'query']).default('header'),
  }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
]);
export type Auth = z.infer<typeof Auth>;

export const Extractor = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe('Output field name. "output" is the main one.'),
  from: z
    .enum(['json', 'text', 'header', 'status', 'regex', 'expression'])
    .default('json')
    .describe('json: JSONPath into the body; text: whole body; header: a response header; regex: first group; expression: JS'),
  path: z.string().default('').describe('JSONPath ($.answer), header name, regex, or JS expression depending on "from"'),
});
export type Extractor = z.infer<typeof Extractor>;

export const HttpBody = z.object({
  type: z.enum(['none', 'json', 'text', 'form', 'multipart', 'binary']).default('none'),
  content: z.string().default('').describe('Body template for json/text. In JSON, {{var}} inside quotes is escaped for you; use {{var | json}} for raw JSON values.'),
  contentType: z.string().default(''),
  form: z.array(KV).default([]),
  parts: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['text', 'file']).default('text'),
        value: z.string().default('').describe('Text template, or for files the column holding the file, e.g. {{audio}}'),
        filename: z.string().default(''),
        contentType: z.string().default(''),
      }),
    )
    .default([]),
  binary: z.string().default('').describe('Template resolving to a file column for raw binary bodies, e.g. {{audio}}'),
});

export const HttpTarget = z.object({
  kind: z.literal('http'),
  method: z.string().default('POST'),
  url: z.string().default(''),
  query: z.array(KV).default([]),
  headers: z.array(KV).default([]),
  auth: Auth.default({ type: 'none' }),
  body: HttpBody.prefault({ type: 'none' }),
  streaming: z
    .object({
      mode: z.enum(['none', 'sse', 'ndjson']).default('none'),
      textPath: z.string().default('').describe('JSONPath of the text in each event, e.g. $.choices[0].delta.content'),
      doneWhen: z.string().default('').describe('Optional JS expression on `event`; stops reading when true'),
    })
    .prefault({ mode: 'none' }),
  outputs: z.array(Extractor).default([{ name: 'output', from: 'text', path: '' }]),
  timeoutMs: z.number().int().positive().default(60000),
  followRedirects: z.boolean().default(true),
  scripts: z
    .object({
      beforeRequest: z.string().default('').describe('JS run before sending; may modify `request` and return it'),
      afterResponse: z.string().default('').describe('JS run after the response; return an object of output fields'),
    })
    .prefault({}),
});

export const WsMessage = z.object({
  type: z.enum(['text', 'json', 'binary_base64']).default('json'),
  content: z.string().default(''),
  delayMs: z.number().int().min(0).default(0),
});

export const WsTarget = z.object({
  kind: z.literal('websocket'),
  url: z.string().default(''),
  headers: z.array(KV).default([]),
  query: z.array(KV).default([]),
  auth: Auth.default({ type: 'none' }),
  subprotocols: z.array(z.string()).default([]),
  connectTimeoutMs: z.number().int().positive().default(10000),
  timeoutMs: z.number().int().positive().default(120000),
  onOpen: z.array(WsMessage).default([]).describe('Messages sent right after connecting (e.g. a start/config message)'),
  waitForOpenAck: z.string().default('').describe('Optional JS expression on `msg`; wait for a matching message before sending audio'),
  audio: z
    .object({
      enabled: z.boolean().default(false),
      source: z.string().default('{{audio}}').describe('Template resolving to the audio file column'),
      encoding: z
        .enum(['pcm_s16le', 'pcm_f32le', 'mulaw', 'alaw', 'file'])
        .default('pcm_s16le')
        .describe('file = send the original file bytes, chunked, without decoding'),
      sampleRate: z.number().int().positive().default(16000),
      channels: z.number().int().min(1).max(2).default(1),
      frameMs: z.number().int().positive().default(20),
      sendAs: z.enum(['binary', 'text']).default('binary'),
      textTemplate: z
        .string()
        .default('{"audio": "{{chunk_base64}}"}')
        .describe('For sendAs=text. Variables: chunk_base64, seq, offset_ms, is_last, plus row columns'),
      pacing: z.enum(['realtime', 'fast']).default('realtime'),
      speed: z.number().positive().default(1).describe('For realtime pacing: 2 = twice real time'),
      trailingSilenceMs: z.number().int().min(0).default(0),
    })
    .prefault({}),
  afterAudio: z.array(WsMessage).default([]).describe('Messages sent after the last audio frame (e.g. a stop message)'),
  incoming: z
    .object({
      format: z.enum(['json', 'text']).default('json'),
      ignoreWhen: z.string().default('').describe('JS expression on `msg`; ignored messages are kept in the log only'),
      textPath: z.string().default('').describe('JSONPath of the transcript/text in a message, e.g. $.channel.alternatives[0].transcript'),
      isFinal: z.string().default('').describe('JS expression on `msg` marking a final (not partial) result, e.g. msg.is_final === true'),
      doneWhen: z.enum(['final_after_audio', 'close', 'expression', 'idle']).default('final_after_audio'),
      doneExpression: z.string().default(''),
      idleMs: z.number().int().positive().default(1500),
      join: z.enum(['space', 'newline', 'concat', 'last']).default('space').describe('How final segments combine into the output'),
    })
    .prefault({}),
  outputs: z.array(Extractor).default([]).describe('Extra fields, evaluated against the collected `messages` and `state`'),
  scripts: z
    .object({
      onMessage: z.string().default('').describe('JS run for every message; may update `state` and return {partial, final, done, ignore}'),
      session: z.string().default('').describe('Full control: JS that drives the whole session itself (overrides the settings above)'),
    })
    .prefault({}),
});

export const ScriptTarget = z.object({
  kind: z.literal('script'),
  code: z.string().default('// row, vars, fetch, WebSocket, readFile(file) are available\nreturn { output: row.input };'),
  timeoutMs: z.number().int().positive().default(60000),
});

export const ModelTarget = z.object({
  kind: z.literal('model'),
  connectionId: z.string().default(''),
  model: z.string().default(''),
  system: z.string().default(''),
  prompt: z.string().default('{{input}}'),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const TargetSpec = z.object({
  variables: z.array(KV).default([]).describe('Values available as {{vars.name}} (base URLs, model names, ...)'),
  config: z.discriminatedUnion('kind', [HttpTarget, WsTarget, ScriptTarget, ModelTarget]),
});
export type TargetSpec = z.infer<typeof TargetSpec>;
export type HttpTargetConfig = z.infer<typeof HttpTarget>;
export type WsTargetConfig = z.infer<typeof WsTarget>;
export type ScriptTargetConfig = z.infer<typeof ScriptTarget>;
export type ModelTargetConfig = z.infer<typeof ModelTarget>;

// ── Suites (layered checks) ─────────────────────────────────────────────────

export const CheckSpec = z.object({
  id: z.string(),
  type: z.string().describe('Check type, e.g. status, json_schema, wer, llm_judge, script'),
  name: z.string().default(''),
  enabled: z.boolean().default(true),
  gate: z.boolean().default(false).describe('If a gate fails, later layers are skipped for that row'),
  weight: z.number().min(0).default(1),
  applyWhen: z.string().default('').describe('Optional JS expression; the check runs only when it is true'),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

export const SuiteSpec = z.object({
  checks: z.array(CheckSpec).default([]),
  passRule: z.enum(['all', 'weighted']).default('all').describe('all: every check must pass; weighted: weighted score ≥ passThreshold'),
  passThreshold: z.number().min(0).max(1).default(1),
});
export type SuiteSpec = z.infer<typeof SuiteSpec>;

// ── Connections (model providers for judging and generation) ────────────────

export const ConnectionSpec = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'openai_compatible', 'azure', 'bedrock', 'vertex']),
  baseUrl: z.string().default(''),
  apiKeySecret: z.string().default('').describe('Name of the secret holding the API key'),
  headers: z.array(KV).default([]),
  defaultModel: z.string().default(''),
  models: z.array(z.string()).default([]),
  options: z.record(z.string(), z.unknown()).default({}).describe('Provider-specific settings (region, project, resource, auth mode, ...)'),
});
export type ConnectionSpec = z.infer<typeof ConnectionSpec>;

// ── Runs ────────────────────────────────────────────────────────────────────

export const RunSettings = z.object({
  concurrency: z.number().int().min(1).max(256).default(4),
  retries: z.number().int().min(0).max(10).default(2),
  repetitions: z.number().int().min(1).max(20).default(1),
  limit: z.number().int().positive().optional().describe('Only run the first N rows'),
  rowIds: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().describe('Only rows having any of these tags'),
  includeStatuses: z.array(RowStatus).default(['approved', 'needs_review', 'draft']),
  delayMs: z.number().int().min(0).default(0),
});
export type RunSettings = z.infer<typeof RunSettings>;

export const DEF_KINDS = {
  target: TargetSpec,
  suite: SuiteSpec,
  connection: ConnectionSpec,
} as const;
export type DefKind = keyof typeof DEF_KINDS;
