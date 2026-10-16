import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine, type Actor } from '@kalibra/core';

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

/** A running engine writes its address here so the CLI and MCP bridge talk to it (one writer, live UI updates). */
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

/** Uniform way to call operations, whether the engine runs in another process or in this one. */
export interface OpsClient {
  call<T = any>(name: string, input: unknown): Promise<T>;
  describe(): Promise<any[]>;
  mode: 'remote' | 'local';
  close(): Promise<void>;
}

export async function connect(dir: string, actor: Actor): Promise<OpsClient> {
  const info = readEngineInfo(dir);
  if (info) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-kalibra-actor': JSON.stringify(actor) };
    if (info.token) headers.authorization = `Bearer ${info.token}`;
    const health = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    if (health?.ok) {
      return {
        mode: 'remote',
        async call(name, input) {
          const res = await fetch(`${info.url}/api/ops/${name}`, { method: 'POST', headers, body: JSON.stringify(input ?? {}) });
          const body: any = await res.json();
          if (!res.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${res.status}`), { code: body?.error?.code });
          return body.data;
        },
        async describe() {
          const res = await fetch(`${info.url}/api/ops`, { headers });
          return res.json() as Promise<any[]>;
        },
        async close() {},
      };
    }
  }
  const engine = new Engine({ dir });
  return {
    mode: 'local',
    call: (name, input) => engine.call(name, input, actor),
    describe: async () => engine.registry.describe(),
    async close() {
      engine.close();
    },
    // exposed for `kalibra run` to wait on local runs
    ...({ engine } as any),
  };
}
