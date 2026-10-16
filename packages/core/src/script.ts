import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

/*
 * User scripts are the escape hatch for anything the forms don't cover.
 * Trust model (desktop): scripts written in your own workspace run with your user's permissions,
 * like npm scripts or Postman pre-request scripts. Server mode must replace this runner with an
 * isolated sandbox before scripts from other users are accepted.
 */

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type Logger = (level: LogEntry['level'], message: string) => void;

const exprCache = new Map<string, vm.Script>();

function baseGlobals(log?: Logger) {
  const fmt = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  return {
    console: {
      log: (...a: unknown[]) => log?.('info', fmt(a)),
      info: (...a: unknown[]) => log?.('info', fmt(a)),
      warn: (...a: unknown[]) => log?.('warn', fmt(a)),
      error: (...a: unknown[]) => log?.('error', fmt(a)),
    },
    Buffer,
    crypto,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
    atob,
    btoa,
  };
}

function safeStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Evaluates a short JS expression (e.g. `msg.is_final === true`) against `scope`. Synchronous, 250 ms budget. */
export function evalExpression(expr: string, scope: Record<string, unknown>): unknown {
  let script = exprCache.get(expr);
  if (!script) {
    script = new vm.Script(`(${expr}\n)`, { filename: 'expression.js' });
    exprCache.set(expr, script);
  }
  const ctx = vm.createContext({ ...baseGlobals(), ...scope });
  return script.runInContext(ctx, { timeout: 250 });
}

export interface RunScriptOptions {
  timeoutMs?: number;
  log?: Logger;
  /** Directory used to resolve `require()` of packages installed by the user. */
  requireFrom?: string;
  filename?: string;
}

/**
 * Runs a script body as an async function. Every key of `args` is a local variable.
 * `return` provides the result. `require` loads Node built-ins or packages from the workspace.
 */
export async function runScript(code: string, args: Record<string, unknown>, opts: RunScriptOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const req = createRequire((opts.requireFrom ?? process.cwd()) + '/');
  const ctx = vm.createContext({ ...baseGlobals(opts.log), require: req, ...args });
  const names = Object.keys(args).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  const source = `(async function (${names.join(', ')}) {\n${code}\n})`;
  const fn = new vm.Script(source, { filename: opts.filename ?? 'script.js' }).runInContext(ctx, { timeout: timeoutMs });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(...names.map((n) => args[n])), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
