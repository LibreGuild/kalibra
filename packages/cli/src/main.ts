#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { newToken, startServer } from '@kalibra/server';
import { providersFromEnv } from '@kalibra/core';
import { randomBytes } from 'node:crypto';
import { clearEngineInfo, connect, defaultDir, openHub, writeEngineInfo } from './engine-client.js';
import { runMcp } from './mcp.js';

// node:sqlite prints an ExperimentalWarning on load; it is expected and noisy for CLI users.
const emit = process.emitWarning;
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(w).includes('SQLite')) return;
  return (emit as any).call(process, w, ...rest);
}) as typeof process.emitWarning;

const HELP = `Kalibra — local-first evaluation for AI applications

Usage:
  kalibra                                     Start Kalibra on this computer and open it in your browser
  kalibra serve [--port 4317] [--open]        Start the engine + web UI (single user, no sign-in)
  kalibra server                              Run as a team server: sign-in, users, project members
  kalibra mcp [--project P]                   MCP server (stdio) for coding agents
  kalibra run --dataset D --target T --suite S [--name N] [--min-pass 0.9] [--json]
  kalibra projects                            List projects
  kalibra ops                                 List operations
  kalibra op <name> ['<json input>']          Call any operation
  kalibra users <list|create|reset-password|make-admin> [username] [--password P]
                                              Manage accounts of a team server from its machine (recovery)

Options:
  --dir <path>         Data folder (default: $KALIBRA_DIR or ~/Kalibra/default)
  --project <p>        Project id or name (default: $KALIBRA_PROJECT or the default project)
  --server <url>       Talk to a team server (with KALIBRA_TOKEN set to an access token)
  --dev                Development mode (data in ./.kalibra-dev, allows the Vite dev server)

Team server (kalibra server, or kalibra serve with KALIBRA_MODE=server):
  --host <addr>        Listen address (default 127.0.0.1; put a TLS reverse proxy in front)
  --public-url <url>   The address people use, e.g. https://kalibra.example.com ($KALIBRA_PUBLIC_URL)
  --trust-proxy        Trust X-Forwarded-* headers from that proxy ($KALIBRA_TRUST_PROXY=1)
  --folder-root <dir>  Allow folder sync inside this folder only ($KALIBRA_FOLDER_ROOT; off otherwise)
  KALIBRA_ADMIN_USERNAME / KALIBRA_ADMIN_PASSWORD create the first administrator at start.
`;

const VERSION = '0.1.0';

async function main() {
  if (typeof (process as any).getBuiltinModule !== 'function' || !(process as any).getBuiltinModule('node:sqlite')) {
    console.error(`Kalibra needs Node.js 22.13 or newer (you have ${process.version}). Get it from https://nodejs.org`);
    process.exit(1);
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: 'string' },
      dev: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string' },
      'no-token': { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      server: { type: 'string' },
      project: { type: 'string' },
      'public-url': { type: 'string' },
      'trust-proxy': { type: 'boolean', default: false },
      'folder-root': { type: 'string' },
      password: { type: 'string' },
      dataset: { type: 'string' },
      target: { type: 'string' },
      suite: { type: 'string' },
      name: { type: 'string' },
      'min-pass': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return void process.stdout.write(HELP);
  // `npx kalibra` with no command: start and open the UI.
  const [cmd = 'serve', ...rest] = positionals;
  if (!positionals.length) values.open = true;
  const dir = values.dir ? resolve(values.dir) : defaultDir(values.dev);
  if (cmd === 'server' || (cmd === 'serve' && process.env.KALIBRA_MODE === 'server')) return serveTeam(dir, values);
  if (cmd === 'serve') return serveLocal(dir, values);
  if (cmd === 'mcp') return runMcp(dir, { server: values.server, project: values.project });
  if (cmd === 'users') return users(dir, rest, values.password);

  const client = await connect(dir, { kind: 'cli', id: 'cli' }, { server: values.server, project: values.project });
  try {
    if (cmd === 'ops') {
      for (const o of await client.describe()) console.log(`${o.name.padEnd(28)} ${o.description.split('. ')[0]}`);
    } else if (cmd === 'projects') {
      for (const p of await client.hub<any[]>('list_projects', {})) console.log(`${p.id.padEnd(24)} ${p.name}${p.role ? `  (${p.role})` : ''}`);
    } else if (cmd === 'op') {
      const [name, json] = rest;
      if (!name) throw new Error('Usage: kalibra op <name> [json]');
      const input = json ? JSON.parse(json) : {};
      const isHub = (await client.describe()).some((o) => o.hub && o.name === name);
      console.log(JSON.stringify(await (isHub ? client.hub(name, input) : client.call(name, input)), null, 2));
    } else if (cmd === 'run') {
      if (!values.dataset || !values.target || !values.suite) throw new Error('kalibra run needs --dataset, --target and --suite');
      const run = await client.call('start_run', { dataset: values.dataset, target: values.target, suite: values.suite, name: values.name });
      for (const w of run.warnings ?? []) process.stderr.write(`Warning: ${w.message}\n`);
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

type Flags = Record<string, string | boolean | undefined>;

const staticUi = () => {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, 'web'), join(here, '../../web/dist')].find((d) => existsSync(join(d, 'index.html')));
};

/** Single-user Kalibra on this computer (what `npx kalibra` and the desktop app run). */
async function serveLocal(dir: string, values: Flags) {
  const hub = openHub(dir, 'local');
  hub.openAll();
  const token = values.dev || values['no-token'] ? undefined : newToken();
  const host = String(values.host ?? '127.0.0.1');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(`Warning: listening on ${host} makes Kalibra reachable from other machines${token ? '' : ' with no token: anyone on the network can use the API, including script targets'}. For a team, use kalibra server.`);
  }
  const staticDir = staticUi();
  const srv = await startServer({
    hub,
    host,
    port: values.port ? Number(values.port) : values.dev ? 4317 : 0,
    token,
    staticDir,
    allowedOrigins: values.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
    meta: { mode: values.dev ? 'dev' : 'cli', version: VERSION, mcp: mcpCommand(dir) },
  });
  writeEngineInfo(dir, { url: srv.url, token, pid: process.pid });
  const openUrl = token ? `${srv.url}/?token=${token}` : srv.url;
  console.log(`Kalibra running\n  data: ${dir}\n  url:  ${openUrl}${staticDir ? '' : '\n  (UI not built — use the Vite dev server on http://localhost:5173)'}`);
  if (values.open) {
    const { exec } = await import('node:child_process');
    exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${openUrl}"`);
  }
  onStop(async () => {
    clearEngineInfo(dir);
    await srv.close();
    hub.close();
  });
}

/** A team server: everyone signs in; projects have members and roles. */
async function serveTeam(dir: string, values: Flags) {
  const folderRoot = (values['folder-root'] as string | undefined) ?? process.env.KALIBRA_FOLDER_ROOT;
  const publicUrl = (values['public-url'] as string | undefined) ?? process.env.KALIBRA_PUBLIC_URL;
  const hub = openHub(dir, 'server', { ...(folderRoot ? { folderRoot: resolve(folderRoot) } : {}), publicUrl, authProviders: providersFromEnv() });
  hub.openAll();
  const adminUser = process.env.KALIBRA_ADMIN_USERNAME;
  const adminPassword = process.env.KALIBRA_ADMIN_PASSWORD;
  if (adminUser && adminPassword && hub.needsSetup()) await hub.ensureAdmin(adminUser, adminPassword);
  const host = String(values.host ?? process.env.KALIBRA_HOST ?? '127.0.0.1');
  const srv = await startServer({
    hub,
    host,
    port: values.port ? Number(values.port) : Number(process.env.KALIBRA_PORT ?? 4317),
    staticDir: staticUi(),
    publicUrl,
    trustProxy: !!values['trust-proxy'] || process.env.KALIBRA_TRUST_PROXY === '1',
    allowedOrigins: values.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
    meta: { mode: 'server', version: VERSION },
  });
  const base = publicUrl?.replace(/\/$/, '') ?? srv.url;
  console.log(`Kalibra team server running\n  data: ${dir}\n  url:  ${base}`);
  if (!publicUrl?.startsWith('https:')) console.warn('  Note: serve it over HTTPS (a reverse proxy with TLS) and pass --public-url, so passwords and sessions stay private.');
  if (!folderRoot) console.log('  Folder sync is off (set --folder-root to allow it inside one folder).');
  const providers = hub.providers.enabled();
  if (providers.length) console.log(`  Sign-in: password${hub.settings().passwordLogin ? '' : ' (administrators only)'}, ${providers.map((p) => p.name).join(', ')}`);
  if (providers.some((p) => p.kind !== 'proxy') && !publicUrl) console.warn('  Note: set --public-url so sign-in providers send people back to the right address.');
  const code = hub.setupCode();
  if (code) console.log(`\n  No administrator yet. Open this link to create one:\n  ${base}/setup?code=${code}\n`);
  onStop(async () => {
    await srv.close();
    hub.close();
  });
}

function onStop(fn: () => Promise<void>) {
  const stop = async () => {
    await fn();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * Account recovery for whoever runs the server (forgotten admin password, locked out). Works on
 * the data folder directly, so it needs access to the server's disk, not a sign-in.
 */
async function users(dir: string, args: string[], password?: string) {
  const [action, username] = args;
  const hub = openHub(dir, 'server');
  try {
    const temp = () => password ?? randomBytes(12).toString('base64url');
    if (action === 'list' || !action) {
      for (const u of hub.accounts.list()) console.log(`${u.username.padEnd(24)} ${u.role.padEnd(6)} ${u.disabled ? 'disabled' : 'active'}  ${u.name}`);
    } else if (!username) {
      throw new Error(`Usage: kalibra users ${action} <username> [--password P]`);
    } else if (action === 'create') {
      const pw = temp();
      await hub.accounts.create({ username, password: pw, role: 'admin', mustChangePassword: !password }, 'cli');
      hub.audit({ kind: 'cli', id: 'cli' }, 'user.created', username, { role: 'admin', from: 'cli' });
      console.log(`Created administrator ${username}${password ? '' : ` with temporary password: ${pw}\nThey choose a new one at first sign-in.`}`);
    } else if (action === 'reset-password') {
      const user = hub.accounts.find(username);
      if (!user) throw new Error(`No user "${username}"`);
      const pw = temp();
      await hub.accounts.setPassword(user.id, pw, { mustChange: !password });
      hub.accounts.revokeAllSessions(user.id);
      hub.audit({ kind: 'cli', id: 'cli' }, 'password.reset', user.username, { from: 'cli' });
      console.log(`Password of ${user.username} reset${password ? '' : ` to: ${pw}\nThey choose a new one at next sign-in.`}`);
    } else if (action === 'make-admin') {
      const user = hub.accounts.find(username);
      if (!user) throw new Error(`No user "${username}"`);
      hub.accounts.update(user.id, { role: 'admin', disabled: false });
      hub.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
      hub.audit({ kind: 'cli', id: 'cli' }, 'user.updated', user.username, { role: 'admin', disabled: false, from: 'cli' });
      console.log(`${user.username} is now an active administrator`);
    } else {
      throw new Error(`Unknown action "${action}". Use list, create, reset-password or make-admin.`);
    }
  } finally {
    hub.close();
  }
}

/** How a coding agent should launch the MCP bridge for this workspace (shown on the Coding agents page). */
function mcpCommand(dir: string) {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith('.ts')) return { command: 'npx', args: ['tsx', self, 'mcp', '--dir', dir] };
  // Launched through npx: the cached copy can be cleaned up, so point agents at npx too.
  if (/[\\/]_npx[\\/]/.test(self)) return { command: 'npx', args: ['-y', `kalibra@${VERSION}`, 'mcp', '--dir', dir] };
  return { command: process.execPath, args: [self, 'mcp', '--dir', dir] };
}

const fmtPct = (v: number | null | undefined) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
