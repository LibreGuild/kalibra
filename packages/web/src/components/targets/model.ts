/*
 * Browser-side mirror of the target spec (packages/core/src/specs.ts). The engine validates and
 * fills defaults on save; these types only describe what the editor works with.
 */

export interface KV {
  key: string;
  value: string;
  enabled: boolean;
}

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api_key'; name: string; value: string; in: 'header' | 'query' }
  | { type: 'basic'; username: string; password: string };

export interface Extractor {
  name: string;
  from: 'json' | 'text' | 'header' | 'status' | 'regex' | 'expression';
  path: string;
}

export interface MultipartPart {
  name: string;
  kind: 'text' | 'file';
  value: string;
  filename: string;
  contentType: string;
}

export interface HttpConfig {
  kind: 'http';
  method: string;
  url: string;
  query: KV[];
  headers: KV[];
  auth: Auth;
  body: {
    type: 'none' | 'json' | 'text' | 'form' | 'multipart' | 'binary';
    content: string;
    contentType: string;
    form: KV[];
    parts: MultipartPart[];
    binary: string;
  };
  streaming: { mode: 'none' | 'sse' | 'ndjson'; textPath: string; doneWhen: string };
  outputs: Extractor[];
  timeoutMs: number;
  followRedirects: boolean;
  scripts: { beforeRequest: string; afterResponse: string };
}

export interface WsMessage {
  type: 'text' | 'json' | 'binary_base64';
  content: string;
  delayMs: number;
}

export interface WsConfig {
  kind: 'websocket';
  url: string;
  headers: KV[];
  query: KV[];
  auth: Auth;
  subprotocols: string[];
  connectTimeoutMs: number;
  timeoutMs: number;
  onOpen: WsMessage[];
  waitForOpenAck: string;
  audio: {
    enabled: boolean;
    source: string;
    encoding: 'pcm_s16le' | 'pcm_f32le' | 'mulaw' | 'alaw' | 'file';
    sampleRate: number;
    channels: number;
    frameMs: number;
    sendAs: 'binary' | 'text';
    textTemplate: string;
    pacing: 'realtime' | 'fast';
    speed: number;
    trailingSilenceMs: number;
  };
  afterAudio: WsMessage[];
  incoming: {
    format: 'json' | 'text';
    ignoreWhen: string;
    textPath: string;
    isFinal: string;
    doneWhen: 'final_after_audio' | 'close' | 'expression' | 'idle';
    doneExpression: string;
    idleMs: number;
    join: 'space' | 'newline' | 'concat' | 'last';
  };
  outputs: Extractor[];
  scripts: { onMessage: string; session: string };
}

export interface ScriptConfig {
  kind: 'script';
  code: string;
  timeoutMs: number;
}

export type ModelTask = 'text' | 'image' | 'speech' | 'transcription';

export interface ModelConfig {
  kind: 'model';
  /** text: prompt → reply; image: prompt → image; speech: prompt → audio; transcription: audio → text. */
  task?: ModelTask;
  connectionId: string;
  model: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  size?: string;
  aspectRatio?: string;
  quality?: '' | 'low' | 'medium' | 'high' | 'auto';
  voice?: string;
  instructions?: string;
  audio?: string;
}

export type TargetConfig = HttpConfig | WsConfig | ScriptConfig | ModelConfig;
export type TargetKind = TargetConfig['kind'];

export interface TargetSpec {
  variables: KV[];
  config: TargetConfig;
}

export interface TargetRecord {
  id: string;
  name: string;
  description: string;
  version: number;
  spec: TargetSpec;
  updatedAt: string;
  updatedBy?: { kind?: string; client?: string; id?: string };
}

export const KIND_LABEL: Record<TargetKind, string> = {
  http: 'HTTP API',
  websocket: 'WebSocket',
  model: 'Model + prompt',
  script: 'Custom script',
};

export const KIND_TONE: Record<TargetKind, 'info' | 'accent' | 'ok' | 'neutral'> = {
  http: 'info',
  websocket: 'accent',
  model: 'ok',
  script: 'neutral',
};

/* Defaults ──────────────────────────────────────────────────────────────── */

const emptyKV = (): KV[] => [];

export function defaultHttp(): HttpConfig {
  return {
    kind: 'http',
    method: 'POST',
    url: '{{vars.base_url}}/api/chat',
    query: emptyKV(),
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    auth: { type: 'none' },
    body: { type: 'json', content: '{\n  "message": "{{input}}"\n}', contentType: '', form: [], parts: [], binary: '' },
    streaming: { mode: 'none', textPath: '', doneWhen: '' },
    outputs: [{ name: 'output', from: 'json', path: '$' }],
    timeoutMs: 60000,
    followRedirects: true,
    scripts: { beforeRequest: '', afterResponse: '' },
  };
}

export function defaultWs(): WsConfig {
  return applyWsPattern(
    {
      kind: 'websocket',
      url: '{{vars.ws_url}}',
      headers: [],
      query: [],
      auth: { type: 'none' },
      subprotocols: [],
      connectTimeoutMs: 10000,
      timeoutMs: 120000,
      onOpen: [],
      waitForOpenAck: '',
      audio: {
        enabled: false,
        source: '{{audio}}',
        encoding: 'pcm_s16le',
        sampleRate: 16000,
        channels: 1,
        frameMs: 20,
        sendAs: 'binary',
        textTemplate: '{"audio": "{{chunk_base64}}"}',
        pacing: 'realtime',
        speed: 1,
        trailingSilenceMs: 0,
      },
      afterAudio: [],
      incoming: { format: 'json', ignoreWhen: '', textPath: '', isFinal: '', doneWhen: 'final_after_audio', doneExpression: '', idleMs: 1500, join: 'space' },
      outputs: [],
      scripts: { onMessage: '', session: '' },
    },
    'pcm_json',
  );
}

export function defaultScript(): ScriptConfig {
  return {
    kind: 'script',
    timeoutMs: 60000,
    code: `// Call your app any way you like and return the outputs.
// Available: row, vars, fetch, WebSocket, readFile(fileValue), llm, log
const res = await fetch(vars.base_url + '/api/chat', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: row.input }),
});
const body = await res.json();
return { output: body.answer, raw: body };
`,
  };
}

export function defaultModel(): ModelConfig {
  return { kind: 'model', task: 'text', connectionId: '', model: '', system: '', prompt: '{{input}}', size: '', aspectRatio: '', quality: '', voice: '', instructions: '', audio: '{{audio}}' };
}

export function defaultConfig(kind: TargetKind): TargetConfig {
  switch (kind) {
    case 'http':
      return defaultHttp();
    case 'websocket':
      return defaultWs();
    case 'script':
      return defaultScript();
    case 'model':
      return defaultModel();
  }
}

export function defaultVariables(kind: TargetKind): KV[] {
  if (kind === 'http' || kind === 'script') return [{ key: 'base_url', value: 'http://localhost:3000', enabled: true }];
  if (kind === 'websocket') return [{ key: 'ws_url', value: 'ws://localhost:3000/ws', enabled: true }];
  return [];
}

/* WebSocket patterns ────────────────────────────────────────────────────── */

export type WsPattern = 'pcm_json' | 'base64_json' | 'text_chat';

export const WS_PATTERNS: { id: WsPattern; label: string; hint: string }[] = [
  { id: 'pcm_json', label: 'Binary PCM frames + JSON start/stop', hint: 'Common for speech-to-text: a JSON start message, raw audio frames, a JSON stop message.' },
  { id: 'base64_json', label: 'Base64 audio inside JSON messages', hint: 'Audio chunks are base64 strings inside JSON text messages.' },
  { id: 'text_chat', label: 'Plain text chat over WebSocket', hint: 'Send one message per row and collect the reply. No audio.' },
];

export function applyWsPattern(c: WsConfig, pattern: WsPattern): WsConfig {
  switch (pattern) {
    case 'pcm_json':
      return {
        ...c,
        onOpen: [{ type: 'json', content: '{"type": "start", "sample_rate": 16000, "encoding": "pcm_s16le"}', delayMs: 0 }],
        audio: { ...c.audio, enabled: true, encoding: 'pcm_s16le', sampleRate: 16000, channels: 1, frameMs: 20, sendAs: 'binary', pacing: 'realtime', speed: 1 },
        afterAudio: [{ type: 'json', content: '{"type": "stop"}', delayMs: 0 }],
        incoming: { ...c.incoming, format: 'json', textPath: '$.text', isFinal: "msg.is_final === true || msg.type === 'final'", doneWhen: 'final_after_audio', join: 'space' },
      };
    case 'base64_json':
      return {
        ...c,
        onOpen: [{ type: 'json', content: '{"type": "start", "sample_rate": 16000}', delayMs: 0 }],
        audio: {
          ...c.audio,
          enabled: true,
          encoding: 'pcm_s16le',
          sampleRate: 16000,
          channels: 1,
          frameMs: 100,
          sendAs: 'text',
          textTemplate: '{"type": "audio", "data": "{{chunk_base64}}"}',
          pacing: 'realtime',
          speed: 1,
        },
        afterAudio: [{ type: 'json', content: '{"type": "stop"}', delayMs: 0 }],
        incoming: { ...c.incoming, format: 'json', textPath: '$.text', isFinal: "msg.is_final === true || msg.type === 'final'", doneWhen: 'final_after_audio', join: 'space' },
      };
    case 'text_chat':
      return {
        ...c,
        onOpen: [{ type: 'json', content: '{"message": "{{input}}"}', delayMs: 0 }],
        audio: { ...c.audio, enabled: false },
        afterAudio: [],
        incoming: { ...c.incoming, format: 'json', textPath: '$.text', isFinal: '', doneWhen: 'idle', idleMs: 1500, join: 'concat' },
      };
  }
}

/** Short description of where a target points, for lists. */
export function endpointOf(spec: TargetSpec | undefined): string {
  const c = spec?.config;
  if (!c) return '';
  if (c.kind === 'http') return `${c.method} ${c.url}`;
  if (c.kind === 'websocket') return c.url;
  if (c.kind === 'model') return `${c.task && c.task !== 'text' ? `${c.task} · ` : ''}${c.model || 'connection default model'}`;
  return 'custom script';
}
