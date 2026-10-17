import { QueryClient, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useMatch } from 'react-router';

/*
 * Talking to Kalibra. Two kinds of calls:
 *   - project operations: datasets, targets, runs… always inside one project (/api/projects/<id>/ops/<op>)
 *   - hub operations: your account, projects, members, administration (/api/hub/<op>)
 *
 * The current project comes from the URL (/p/<id>/…). Queries of project operations carry the
 * project in their key, so switching projects never shows another project's data.
 */

/** Error from the engine, with its code (not_found, invalid, conflict, unauthorized, ...) and details. */
export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// ── Current project ─────────────────────────────────────────────────────────

const LAST_PROJECT = 'kalibra.project';
export const DEFAULT_PROJECT = 'default';

/** The project you were last in (remembered per browser), used when a URL does not name one. */
export function lastProject(): string {
  try {
    return localStorage.getItem(LAST_PROJECT) || DEFAULT_PROJECT;
  } catch {
    return DEFAULT_PROJECT;
  }
}

export function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* only remembered for this session */
  }
}

/** On sign-out: the next person on this browser should not start in this person's project. */
export function forgetProject() {
  try {
    localStorage.removeItem(LAST_PROJECT);
  } catch {
    /* nothing remembered */
  }
}

let currentProject = lastProject();

/** The project imperative `op()` calls go to. Set by the project layout before its pages render. */
export const getCurrentProject = () => currentProject;

/**
 * Switches the project for imperative calls and drops cached results that are not tied to a
 * project (custom queries keyed only by operation name), so nothing from the old project shows.
 */
export function setCurrentProject(id: string) {
  if (id === currentProject) return;
  currentProject = id;
  queryClient.removeQueries({ predicate: (q) => !isScopedKey(q.queryKey) });
}

const projectTag = (project: string) => ({ project });
const isScopedKey = (key: readonly unknown[]) => {
  const first = String(key[0] ?? '');
  if (first.startsWith('hub:') || first === 'auth-status' || first === 'meta') return true;
  const last = key[key.length - 1] as any;
  return !!last && typeof last === 'object' && typeof last.project === 'string' && key.length >= 3;
};

/** The project in the URL, or the last one used (on pages outside a project, e.g. Docs). */
export function useProjectId(): string {
  const deep = useMatch('/p/:projectId/*');
  const top = useMatch('/p/:projectId');
  return deep?.params.projectId ?? top?.params.projectId ?? currentProject;
}

// ── Requests ────────────────────────────────────────────────────────────────

/** Runs when the server says you are signed out or must change your password (see AuthGate). */
let onAuthProblem: (() => void) | undefined;
export const setAuthProblemHandler = (fn: () => void) => (onAuthProblem = fn);

async function request<T>(url: string, init: RequestInit = {}, fallback = 'Request failed'): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = body?.error?.code ?? (res.status === 401 ? 'unauthorized' : 'internal');
    if (code === 'unauthorized' || code === 'password_change_required') onAuthProblem?.();
    throw new ApiError(code, body?.error?.message ?? `${fallback} (HTTP ${res.status})`, body?.error?.details);
  }
  return body.data as T;
}

const post = (url: string, input: unknown) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) }) satisfies RequestInit;

const projectBase = (project: string) => `/api/projects/${encodeURIComponent(project)}`;

/** Calls one operation of a project (default: the current one). Every UI action goes through here, exactly like the CLI and MCP. */
export function op<T = any>(name: string, input: unknown = {}, project = currentProject): Promise<T> {
  return request<T>(`${projectBase(project)}/ops/${name}`, post('', input));
}

/** Calls a hub operation: account, projects, members, administration. */
export function hubOp<T = any>(name: string, input: unknown = {}): Promise<T> {
  return request<T>(`/api/hub/${name}`, post('', input));
}

/** Sign-in endpoints (setup, login, logout). */
export function authCall<T = any>(path: 'setup' | 'login' | 'logout', input: unknown = {}): Promise<T> {
  return request<T>(`/api/auth/${path}`, post('', input));
}

export interface UploadedFile {
  hash: string;
  size: number;
  mime: string;
  name?: string;
}

export async function uploadFile(file: File | Blob, name?: string): Promise<UploadedFile> {
  return request<UploadedFile>(
    `${projectBase(currentProject)}/files`,
    {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(name ?? (file as File).name ?? 'file'),
      },
      body: file,
    },
    'Upload failed',
  );
}

export const fileUrl = (hash: string, download = false) => `${projectBase(currentProject)}/files/${hash}${download ? '?download=1' : ''}`;

// ── Queries ─────────────────────────────────────────────────────────────────

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (n, e: any) => n < 1 && !['not_found', 'invalid', 'forbidden', 'unauthorized', 'password_change_required'].includes(e?.code),
    },
  },
});

/** Read a project operation with caching. Key = [opName, input, { project }]. */
export function useOp<T = any>(name: string, input: unknown = {}, opts: Partial<UseQueryOptions<T>> = {}) {
  const project = useProjectId();
  return useQuery<T>({ queryKey: [name, input, projectTag(project)], queryFn: () => op<T>(name, input, project), ...opts } as UseQueryOptions<T>);
}

/** Run a mutating project operation and refresh affected queries. */
export function useOpMutation<I = any, T = any>(name: string, opts: { invalidate?: string[]; onSuccess?: (data: T, input: I) => void } = {}) {
  const qc = useQueryClient();
  const project = useProjectId();
  return useMutation<T, ApiError, I>({
    mutationFn: (input: I) => op<T>(name, input, project),
    onSuccess: (data, input) => {
      for (const key of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: [key] });
      opts.onSuccess?.(data, input);
    },
  });
}

/** Read a hub operation (account, projects, admin). Key = ['hub:<op>', input]. */
export function useHubOp<T = any>(name: string, input: unknown = {}, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: [`hub:${name}`, input], queryFn: () => hubOp<T>(name, input), ...opts } as UseQueryOptions<T>);
}

/** Run a hub operation and refresh the hub queries it affects (names without the "hub:" prefix). */
export function useHubMutation<I = any, T = any>(name: string, opts: { invalidate?: string[]; onSuccess?: (data: T, input: I) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<T, ApiError, I>({
    mutationFn: (input: I) => hubOp<T>(name, input),
    onSuccess: (data, input) => {
      for (const key of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: [`hub:${key}`] });
      opts.onSuccess?.(data, input);
    },
  });
}

// ── Live updates ────────────────────────────────────────────────────────────

const INVALIDATE: Record<string, string[]> = {
  'dataset.changed': ['list_datasets', 'get_dataset_schema', 'list_dataset_versions', 'dataset_quality', 'get_workspace'],
  'rows.changed': ['list_rows', 'list_datasets', 'get_dataset_schema', 'dataset_quality', 'get_workspace'],
  'def.changed': ['list_targets', 'list_suites', 'list_connections', 'get_target', 'get_suite', 'get_connection', 'list_target_versions', 'get_workspace'],
  // Comparisons are groups of runs, so their views follow run progress too (including ones an agent starts).
  'run.updated': ['list_runs', 'get_run', 'list_comparisons', 'get_comparison', 'compare_rows', 'run_breakdown', 'get_failure_themes', 'suite_trend', 'compare_to_baseline'],
  // A batch of traces from the SDK, OpenTelemetry or the proxy was written (traces don't change after that).
  'traces.ingested': ['list_traces'],
  'result.updated': ['query_results', 'get_result'],
  activity: ['list_activity'],
  // Jobs: generation fills rows, fill_gaps adds them, cluster_failures writes themes.
  'job.updated': ['get_job', 'list_jobs', 'list_rows', 'list_datasets', 'dataset_quality', 'get_failure_themes'],
};

/** Subscribes to a project's live events and refreshes what changed — including edits made by teammates, agents or the CLI. */
export function useLiveEvents(project: string, enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Reconnect delay: grows while the server is unreachable (or refuses us), resets once connected.
    let delay = 2000;
    const pending = new Set<string>();
    let flush: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      es = new EventSource(`${projectBase(project)}/events`, { withCredentials: true });
      es.onopen = () => (delay = 2000);
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
        // EventSource hides the status code: re-check sign-in, so an ended session shows the sign-in page.
        onAuthProblem?.();
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => {
      es?.close();
      clearTimeout(retry);
      clearTimeout(flush);
    };
  }, [qc, project, enabled]);
}

// ── Server facts and sign-in state ──────────────────────────────────────────

export interface ServerMeta {
  mcp?: { command: string; args: string[]; env?: Record<string, string> };
  version?: string;
  mode?: 'desktop' | 'cli' | 'dev' | 'server';
  hubMode?: 'local' | 'server';
  dir?: string;
  publicUrl?: string;
}

/** Facts about the running server (version, how to start the MCP bridge). */
export function useMeta() {
  return useQuery<ServerMeta>({ queryKey: ['meta'], queryFn: () => request<ServerMeta>('/api/meta'), staleTime: Infinity });
}

export interface User {
  id: string;
  username: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  disabled: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AuthStatus {
  mode: 'local' | 'server';
  setupRequired: boolean;
  user: User | null;
  providers: { id: string; name: string; kind: 'oidc' | 'github' | 'proxy' }[];
  /** Whether username/password sign-in is offered (false when an administrator allows only providers). */
  passwordLogin?: boolean;
  /** Why a login gateway's sign-in was refused, when it was. */
  error?: string;
}

export const fetchAuthStatus = () => request<AuthStatus>('/api/auth/status');

/** Sign-in state: local (desktop) or team server, and who is signed in. */
export function useAuthStatus() {
  return useQuery<AuthStatus>({ queryKey: ['auth-status'], queryFn: fetchAuthStatus, staleTime: Infinity, retry: 1 });
}

/** The signed-in user's id, so history can say "You" for your own changes. */
let currentUserId = 'local';
export const setCurrentUser = (id: string) => (currentUserId = id);
export const getCurrentUserId = () => currentUserId;
