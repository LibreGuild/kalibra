#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Engine } from '@kalibra/core';
import { newToken, startServer } from '@kalibra/server';
import { clearEngineInfo, connect, defaultDir, writeEngineInfo } from './engine-client.js';
import { runMcp } from './mcp.js';

// node:sqlite prints an ExperimentalWarning on load; it is expected and noisy for CLI users.
const emit = process.emitWarning;
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w).includes('SQLite')) return;
  return (emit as any).call(process, w, ...rest);
}) as typeof process.emitWarning;

const HELP = `Kalibra — local-first evaluation for AI applications

Usage:
  kalibra serve [--port 4317] [--host 127.0.0.1] [--no-token] [--open]   Start the engine + web UI
  kalibra mcp                                                            MCP server (stdio) for coding agents
  kalibra run --dataset D --target T --suite S [--name N] [--min-pass 0.9] [--json]
  kalibra ops                                                            List operations
  kalibra op <name> ['<json input>']                                     Call any operation

Options:
  --dir <path>   Workspace folder (default: $KALIBRA_DIR or ~/Kalibra/default)
  --dev          Development mode (workspace ./.kalibra-dev, allows the Vite dev server)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      dev: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
      'no-token': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      dataset: { type: 'string' },
      target: { type: 'string' },
      suite: { type: 'string' },
      name: { type: 'string' },
      'min-pass': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, ...rest] = positionals;
  const dir = values.dir ? resolve(values.dir) : defaultDir(values.dev);

  if (!cmd || values.help) return void process.stdout.write(HELP);

  if (cmd === 'serve') {
    const engine = new Engine({ dir });
    const token = values.dev || values['no-token'] ? undefined : newToken();
    const here = dirname(fileURLToPath(import.meta.url));
    const staticDir = [join(here, 'web'), join(here, '../../web/dist')].find((d) => existsSync(join(d, 'index.html')));
    const srv = await startServer({
      engine,
      host: values.host ?? '127.0.0.1',
      port: values.port ? Number(values.port) : values.dev ? 4317 : 0,
      token,
      staticDir,
      allowedOrigins: values.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
      meta: { mode: values.dev ? 'dev' : 'cli', version: '0.1.0', mcp: mcpCommand(dir) },
    });
    writeEngineInfo(dir, { url: srv.url, token, pid: process.pid });
    const openUrl = token ? `${srv.url}/?token=${token}` : srv.url;
    console.log(`Kalibra engine running\n  workspace: ${dir}\n  url:       ${openUrl}${staticDir ? '' : '\n  (UI not built — use the Vite dev server on http://localhost:5173)'}`);
    if (values.open) {
      const { exec } = await import('node:child_process');
      exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${openUrl}"`);
    }
    const stop = async () => {
      clearEngineInfo(dir);
      await srv.close();
      engine.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'mcp') return runMcp(dir);

  const client = await connect(dir, { kind: 'cli', id: 'cli' });
  try {
    if (cmd === 'ops') {
      for (const o of await client.describe()) console.log(`${o.name.padEnd(28)} ${o.description.split('. ')[0]}`);
    } else if (cmd === 'op') {
      const [name, json] = rest;
      if (!name) throw new Error('Usage: kalibra op <name> [json]');
      console.log(JSON.stringify(await client.call(name, json ? JSON.parse(json) : {}), null, 2));
    } else if (cmd === 'run') {
      if (!values.dataset || !values.target || !values.suite) throw new Error('kalibra run needs --dataset, --target and --suite');
      const run = await client.call('start_run', { dataset: values.dataset, target: values.target, suite: values.suite, name: values.name });
      let cur = run;
      while (['queued', 'running'].includes(cur.status)) {
        await new Promise((r) => setTimeout(r, 500));
        cur = await client.call('get_run', { runId: run.id });
        if (!values.json) process.stderr.write(`\r${cur.done}/${cur.total} rows`);
      }
      if (!values.json) process.stderr.write('\n');
      const s = cur.summary ?? {};
      if (values.json) console.log(JSON.stringify(cur, null, 2));
      else {
        console.log(`${cur.name}: ${cur.status}. Pass rate ${fmtPct(s.passRate)} (${s.passed}/${(s.passed ?? 0) + (s.failed ?? 0)})`);
        for (const c of s.checks ?? []) console.log(`  ${c.name.padEnd(30)} ${fmtPct(c.passRate)}${c.corpus ? `  corpus ${c.corpus.metric} ${fmtPct(c.corpus.value)}` : ''}`);
      }
      const min = values['min-pass'] ? Number(values['min-pass']) : undefined;
      if (cur.status !== 'completed' || (min !== undefined && (s.passRate ?? 0) < min)) process.exitCode = 1;
    } else {
      throw new Error(`Unknown command "${cmd}". Run kalibra --help.`);
    }
  } finally {
    await client.close();
  }
}

/** How a coding agent should launch the MCP bridge for this workspace (shown on the Coding agents page). */
function mcpCommand(dir: string) {
  const self = fileURLToPath(import.meta.url);
  return self.endsWith('.ts')
    ? { command: 'npx', args: ['tsx', self, 'mcp', '--dir', dir] }
    : { command: process.execPath, args: [self, 'mcp', '--dir', dir] };
}

const fmtPct = (v: number | null | undefined) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
