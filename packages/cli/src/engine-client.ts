import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PROJECT, FileSecretStore, Hub, KalibraError, type Actor, type HubMode, type HubOptions, type SecretStore } from '@kalibra/core';

/*
 * How the CLI and the MCP bridge reach Kalibra, in order of preference:
 *   1. a team server:            --server URL (or KALIBRA_URL) + KALIBRA_TOKEN (a personal access token)
 *   2. a running desktop/npx app: its address and per-launch token in <dir>/.engine.json
 *   3. nothing running:          open the hub in this process (single-user, local mode)
 * Either way you get the same OpsClient: project operations in the current project, plus hub
 * operations (projects, your account).
 */

/** Where the default workspace lives. KALIBRA_DIR or --dir override it. */
export function defaultDir(dev = false) {
  if (process.env.KALIBRA_DIR) return resolve(process.env.KALIBRA_DIR);
  return dev ? resolve('.kalibra-dev') : join(homedir(), 'Kalibra', 'default');
}

export interface EngineInfo {
  url: string;
  token?: string;
  pid: number;
}

const infoFile = (dir: string) => join(dir, '.engine.json');

/** A running local engine writes its address here so the CLI and MCP bridge talk to it (one writer, live UI updates). */
export function writeEngineInfo(dir: string, info: EngineInfo) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(infoFile(dir), JSON.stringify(info), { mode: 0o600 });
}

export function clearEngineInfo(dir: string) {
  try {
    const cur = JSON.parse(readFileSync(infoFile(dir), 'utf8'));
    if (cur.pid === process.pid) rmSync(infoFile(dir));
  } catch {
    /* nothing to clear */
  }
}

function readEngineInfo(dir: string): EngineInfo | undefined {
  if (!existsSync(infoFile(dir))) return undefined;
  try {
    const info = JSON.parse(readFileSync(infoFile(dir), 'utf8')) as EngineInfo;
    process.kill(info.pid, 0); // throws if the process is gone
    return info;
  } catch {
    return undefined;
  }
}

/**
 * Secrets of a project folder. The desktop app encrypts them with the OS keychain (secrets.enc),
 * which only it can read; without the app they fail with a clear message instead of reading as unset.
 */
export function secretsFor(projectDir: string): SecretStore {
  if (!existsSync(join(projectDir, 'secrets.enc'))) return new FileSecretStore(join(projectDir, 'secrets.json'));
  const locked = async (): Promise<never> => {
    throw new KalibraError('unavailable', 'Secrets in this workspace are encrypted by the Kalibra desktop app. Open the app and try again: the CLI and coding agents then connect to it.');
  };
  return { get: locked, set: locked, delete: locked, list: locked };
}

/** The hub for a folder, opened in this process. */
export function openHub(dir: string, mode: HubMode = 'local', opts: Pick<HubOptions, 'folderRoot' | 'publicUrl' | 'authProviders'> = {}) {
  return new Hub({ dir, mode, secretsFor, ...opts });
}

/** Uniform way to call operations, whether Kalibra runs in another process or in this one. */
export interface OpsClient {
  /** A project operation, in the current project. */
  call<T = any>(name: string, input: unknown): Promise<T>;
  /** A hub operation (projects, your account). */
  hub<T = any>(name: string, input: unknown): Promise<T>;
  /** Project operations, then hub operations (marked `hub: true`). */
  describe(): Promise<any[]>;
  /** The current project (id or name as given). */
  project(): string;
  /** Switches project after checking it exists and you can open it. */
  useProject(idOrName: string): Promise<any>;
  mode: 'remote' | 'local';
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Team server address (else KALIBRA_URL). */
  server?: string;
  /** Personal access token (else KALIBRA_TOKEN). */
  token?: string;
  /** Project id or name (else KALIBRA_PROJECT, else the default project or your first one). */
  project?: string;
}

export async function connect(dir: string, actor: Actor, opts: ConnectOptions = {}): Promise<OpsClient> {
  const server = (opts.server ?? process.env.KALIBRA_URL)?.replace(/\/$/, '');
  if (server) {
    const token = opts.token ?? process.env.KALIBRA_TOKEN;
    if (!token) throw new Error('Set KALIBRA_TOKEN to a personal access token (create one in Kalibra under Account → Access tokens)');
    return remote(server, token, actor, opts.project);
  }
  const info = readEngineInfo(dir);
  if (info) {
    const health = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    if (health?.ok) return remote(info.url, info.token, actor, opts.project);
  }
  return inProcess(dir, actor, opts.project);
}

async function remote(url: string, token: string | undefined, actor: Actor, wanted?: string): Promise<OpsClient> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-kalibra-actor': JSON.stringify(actor) };
  if (token) headers.authorization = `Bearer ${token}`;
  const post = async (path: string, input: unknown) => {
    const res = await fetch(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${res.status}`), { code: body?.error?.code });
    return body.data;
  };
  const get = async (path: string) => {
    const res = await fetch(`${url}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    return res.json() as Promise<any[]>;
  };
  let project = await pickProject((name, input) => post(`/api/hub/${name}`, input), wanted);
  return {
    mode: 'remote',
    call: (name, input) => post(`/api/projects/${encodeURIComponent(project)}/ops/${name}`, input),
    hub: (name, input) => post(`/api/hub/${name}`, input),
    describe: async () => [...(await get(`/api/projects/${encodeURIComponent(project)}/ops`)), ...(await get('/api/hub')).map((o) => ({ ...o, hub: true }))],
    project: () => project,
    async useProject(idOrName) {
      const p = await post('/api/hub/get_project', { project: idOrName });
      project = p.id;
      return p;
    },
    async close() {},
  };
}

async function inProcess(dir: string, actor: Actor, wanted?: string): Promise<OpsClient> {
  const hub = openHub(dir);
  const principal = hub.localPrincipal(actor.kind === 'agent' || actor.kind === 'cli' ? actor.kind : 'user', actor.client, actor.model);
  let project = await pickProject((name, input) => hub.call(principal, name, input), wanted);
  return {
    mode: 'local',
    call: (name, input) => hub.callProject(principal, project, name, input),
    hub: (name, input) => hub.call(principal, name, input),
    describe: async () => [...hub.engine(project).registry.describe(), ...hub.registry.describe().map((o) => ({ ...o, hub: true }))],
    project: () => project,
    async useProject(idOrName) {
      const p = await hub.call<any>(principal, 'get_project', { project: idOrName });
      project = p.id;
      return p;
    },
    async close() {
      hub.close();
    },
    // exposed for `kalibra run` to wait on local runs
    ...({ hub } as any),
  };
}

/** The project to start in: the one asked for, else the default project, else the first you can open. */
async function pickProject(hubCall: (name: string, input: unknown) => Promise<any>, wanted?: string): Promise<string> {
  const asked = wanted ?? process.env.KALIBRA_PROJECT;
  if (asked) return (await hubCall('get_project', { project: asked })).id;
  const list: { id: string }[] = await hubCall('list_projects', {});
  return (list.find((p) => p.id === DEFAULT_PROJECT) ?? list[0])?.id ?? DEFAULT_PROJECT;
}
