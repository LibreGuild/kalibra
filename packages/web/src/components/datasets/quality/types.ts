/** Shapes returned by the dataset quality operations (see packages/core/src/quality). */

export interface ColumnQuality {
  key: string;
  type: string;
  filled: number;
  empty: number;
  fillRate: number;
  distinct: number;
  categorical: boolean;
  topValues?: { value: string; count: number; share: number }[];
  missingValues?: string[];
  length?: { min: number; median: number; p90: number; max: number; histogram: { from: number; to: number; count: number }[] };
  diversity?: { distinct1: number; distinct2: number; compressionRatio: number; selfBleu: number | null; sampled: number };
}

export interface QualityFlag {
  level: 'info' | 'warn';
  kind: 'empty' | 'imbalanced' | 'missing_values' | 'low_variety' | 'duplicates' | 'small';
  column?: string;
  message: string;
  suggestion: string;
}

export interface QualityReport {
  datasetId: string;
  rows: number;
  statuses: Record<string, number>;
  tags: { tag: string; count: number }[];
  columns: ColumnQuality[];
  exactDuplicateRows: number;
  flags: QualityFlag[];
}

export interface DuplicateGroup {
  rowIds: string[];
  similarity: number;
  previews: string[];
}

export interface EmbeddingsStatus {
  local: 'ready' | 'not_downloaded' | 'downloading' | 'unavailable';
  model: string;
  detail?: string;
  downloadMb: number;
}
