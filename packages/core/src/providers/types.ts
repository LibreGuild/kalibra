/** Access to configured model connections, used by LLM judges, model targets and data generation. */
export interface LlmClient {
  /** Plain text completion. */
  text(req: LlmRequest): Promise<LlmTextResult>;
  /** Structured output validated against a JSON Schema. */
  json<T = unknown>(req: LlmRequest & { schema: Record<string, unknown>; schemaName?: string }): Promise<LlmJsonResult<T>>;
}

export interface LlmRequest {
  connectionId: string;
  model?: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
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
