export type ColumnType = 'text' | 'number' | 'boolean' | 'json' | 'list' | 'messages' | 'audio' | 'image' | 'file';
export type RowStatus = 'draft' | 'needs_review' | 'approved' | 'rejected';

export interface ColumnDef {
  key: string;
  type: ColumnType;
  description: string;
  required: boolean;
  enum?: string[];
}

export interface DatasetSchemaResp {
  id: string;
  name: string;
  description: string;
  revision: number;
  columns: ColumnDef[];
  instructions: string;
  stats: { total: number; byStatus: Partial<Record<RowStatus, number>>; tags: { tag: string; count: number }[] };
}

export interface RowRecord {
  id: string;
  datasetId: string;
  seq: number;
  rev: number;
  data: Record<string, unknown>;
  tags: string[];
  status: RowStatus;
  split: string | null;
  provenance: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AddRowsResult {
  added: string[] | number;
  rejected: { index: number; errors: string[]; duplicateOf?: string }[];
  warnings?: { index: number; message: string }[];
  unmatchedFiles?: string[];
  total?: number;
}

export const FILE_TYPES: ColumnType[] = ['audio', 'image', 'file'];
export const isFileType = (t: ColumnType) => FILE_TYPES.includes(t);
