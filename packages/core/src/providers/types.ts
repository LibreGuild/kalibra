/** Access to configured model connections, used by LLM judges, model targets and data generation. */
export interface LlmClient {
  /** Plain text completion. */
  text(req: LlmRequest): Promise<LlmTextResult>;
  /** Structured output validated against a JSON Schema. */
  json<T = unknown>(req: LlmRequest & { schema: Record<string, unknown>; schemaName?: string }): Promise<LlmJsonResult<T>>;
  /** Image generation. */
  image(req: ImageRequest): Promise<ImageResult>;
  /** Text-to-speech. */
  speech(req: SpeechRequest): Promise<SpeechResult>;
  /** Speech-to-text. */
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
}

export type ModelKind = 'text' | 'image' | 'speech' | 'transcription';

export interface MediaFile {
  data: Uint8Array;
  mime: string;
}

export interface ImageRequest {
  connectionId: string;
  model?: string;
  prompt: string;
  /** Reference images for edits / image-to-image, when the model supports it. */
  images?: MediaFile[];
  size?: string;
  aspectRatio?: string;
  n?: number;
  seed?: number;
  /** Provider-specific options, e.g. { quality: 'medium' } for OpenAI. */
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ImageResult {
  images: MediaFile[];
  latencyMs: number;
  model: string;
}

export interface SpeechRequest {
  connectionId: string;
  model?: string;
  text: string;
  voice?: string;
  instructions?: string;
  speed?: number;
  language?: string;
  format?: string;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface SpeechResult {
  audio: MediaFile;
  latencyMs: number;
  model: string;
}

export interface TranscribeRequest {
  connectionId: string;
  model?: string;
  audio: MediaFile;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  segments?: { text: string; startSecond: number; endSecond: number }[];
  language?: string;
  durationSeconds?: number;
  latencyMs: number;
  model: string;
}

export interface LlmRequest {
  connectionId: string;
  model?: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Images, audio or PDFs to show the model alongside the prompt (multimodal judges). */
  files?: MediaFile[];
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  model: string;
}

export interface LlmTextResult extends LlmUsage {
  text: string;
}

export interface LlmJsonResult<T> extends LlmUsage {
  value: T;
}
