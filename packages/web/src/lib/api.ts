import { QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';

/** Error from the engine, with its code (not_found, invalid, conflict, ...) and details. */
export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

/** Calls one engine operation. Every UI action goes through here, exactly like the CLI and MCP. */
export async function op<T = any>(name: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`/api/ops/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error?.code ?? 'internal', body?.error?.message ?? `HTTP ${res.status}`, body?.error?.details);
  return body.data as T;
}

export interface UploadedFile {
  hash: string;
  size: number;
  mime: string;
  name?: string;
}

export async function uploadFile(file: File | Blob, name?: string): Promise<UploadedFile> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(name ?? (file as File).name ?? 'file'),
    },
    credentials: 'same-origin',
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error?.code ?? 'internal', body?.error?.message ?? `Upload failed (HTTP ${res.status})`);
  return body.data;
}

export const fileUrl = (hash: string, download = false) => `/api/files/${hash}${download ? '?download=1' : ''}`;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: (n, e: any) => n < 1 && e?.code !== 'not_found' && e?.code !== 'invalid' },
  },
});

/** Read an operation result with caching. Key = [opName, input]. */
export function useOp<T = any>(name: string, input: unknown = {}, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [name, input], queryFn: () => op<T>(name, input), ...opts } as UseQueryOptions<T>);
}

/** Run a mutating operation and refresh affected queries. */
export function useOpMutation<I = any, T = any>(name: string, opts: { invalidate?: string[]; onSuccess?: (data: T, input: I) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<T, ApiError, I>({
    mutationFn: (input: I) => op<T>(name, input),
    onSuccess: (data, input) => {
      for (const key of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: [key] });
      opts.onSuccess?.(data, input);
    },
  });
}

const INVALIDATE: Record<string, string[]> = {
  'dataset.changed': ['list_datasets', 'get_dataset_schema', 'list_dataset_versions', 'dataset_quality', 'get_workspace'],
  'rows.changed': ['list_rows', 'list_datasets', 'get_dataset_schema', 'dataset_quality', 'get_workspace'],
  'def.changed': ['list_targets', 'list_suites', 'list_connections', 'get_target', 'get_suite', 'get_connection', 'list_target_versions', 'get_workspace'],
  // Comparisons are groups of runs, so their views follow run progress too (including ones an agent starts).
  'run.updated': ['list_runs', 'get_run', 'list_comparisons', 'get_comparison', 'compare_rows', 'run_breakdown', 'get_failure_themes', 'suite_trend'],
  'result.updated': ['query_results', 'get_result'],
  activity: ['list_activity'],
  // Jobs: generation fills rows, fill_gaps adds them, cluster_failures writes themes.
  'job.updated': ['get_job', 'list_jobs', 'list_rows', 'list_datasets', 'dataset_quality', 'get_failure_themes'],
};

/** Subscribes to live engine events and refreshes what changed — including edits made by agents or the CLI. */
export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      es = new EventSource('/api/events', { withCredentials: true });
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data);
          for (const key of INVALIDATE[e.type] ?? []) pending.add(key);
          flush ??= setTimeout(() => {
            for (const key of pending) qc.invalidateQueries({ queryKey: [key] });
            pending.clear();
            flush = undefined;
          }, 250);
        } catch {
          /* ignore malformed event */
        }
      };
      es.onerror = () => {
        es?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
      clearTimeout(flush);
    };
  }, [qc]);
}

export interface ServerMeta {
  mcp?: { command: string; args: string[]; env?: Record<string, string> };
  version?: string;
  mode?: 'desktop' | 'cli' | 'dev';
  dir?: string;
}

/** Facts about the running server (version, how to start the MCP bridge). */
export function useMeta() {
  return useQuery<ServerMeta>({
    queryKey: ['meta'],
    queryFn: async () => {
      const res = await fetch('/api/meta', { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(body?.error?.code ?? 'internal', body?.error?.message ?? `HTTP ${res.status}`);
      return body.data;
    },
    staleTime: Infinity,
  });
}
