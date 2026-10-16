/*
 * Text embeddings for semantic similarity, near-duplicate detection and failure clustering.
 * Two sources: a small local model (free, offline after a one-time download) or a model
 * connection's embedding model. Implementation lives here; callers use the Embedder interface.
 */

export interface EmbedOptions {
  /** Use this connection's embedding model instead of the local one. */
  connectionId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  source: 'local' | 'connection';
}

export interface EmbedderStatus {
  local: 'ready' | 'not_downloaded' | 'downloading' | 'unavailable';
  model: string;
  detail?: string;
}

export interface Embedder {
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>;
  status(): Promise<EmbedderStatus>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Placeholder until the local model is wired in; connection embeddings come with the real implementation. */
export class UnavailableEmbedder implements Embedder {
  async embed(): Promise<EmbedResult> {
    throw new Error('Embeddings are not available yet');
  }
  async status(): Promise<EmbedderStatus> {
    return { local: 'unavailable', model: '' };
  }
}
