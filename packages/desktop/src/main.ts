import { createHash } from 'node:crypto';
import { app, BrowserWindow, Menu, nativeTheme, safeStorage, session, shell, type MenuItemConstructorOptions } from 'electron';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore, Hub } from '@kalibra/core';
import { newToken, startServer, type RunningServer } from '@kalibra/server';
import { browserUserAgent, connectPage, normalizeServerUrl, ServerList } from './server-list.js';

/*
 * Desktop shell: runs the hub (all your projects) + HTTP API on 127.0.0.1 with a per-launch token
 * and opens the web UI in a window. Single user, no sign-in; the same UI a team server serves to
 * browsers.
 */

const dir = process.env.KALIBRA_DIR || join(homedir(), 'Kalibra', 'default');
let hub: Hub | undefined;
let server: RunningServer | undefined;

// Secrets are encrypted with a key held by the OS keychain (macOS Keychain, Windows DPAPI, libsecret).
// Each project keeps its own secrets.enc in its folder.
function secretStore(projectDir: string) {
  const usable = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  if (!usable) console.warn('OS keychain encryption unavailable; secrets are stored with file permissions only.');
  return new FileSecretStore(join(projectDir, 'secrets.enc'), {
    encrypt: (s) => (usable ? safeStorage.encryptString(s) : Buffer.from(s, 'utf8')),
    decrypt: (b) => (usable ? safeStorage.decryptString(b) : b.toString('utf8')),
  });
}

async function boot() {
  mkdirSync(dir, { recursive: true });
  hub = new Hub({ dir, mode: 'local', secretsFor: secretStore });
  hub.openAll();
  const token = newToken();
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname);
  const cli = join(resources, 'cli', 'kalibra.mjs');
  server = await startServer({
    hub,
    token,
    staticDir: join(__dirname, 'web'),
    meta: {
      mode: 'desktop',
      version: app.getVersion(),
      // Coding agents launch the MCP bridge with Electron's bundled Node.
      mcp: { command: process.execPath, args: [cli, 'mcp', '--dir', dir], env: { ELECTRON_RUN_AS_NODE: '1' } },
    },
  });
  // Lets the MCP bridge and CLI find this engine (single writer, live UI updates).
  writeFileSync(join(dir, '.engine.json'), JSON.stringify({ url: server.url, token, pid: process.pid }), { mode: 0o600 });
  chmodSync(join(dir, '.engine.json'), 0o600); // `mode` only applies to new files
  return `${server.url}/?token=${token}`;
}

/** Same origin as the engine (a plain prefix check would also accept e.g. port 43170 for 4317). */
function isAppUrl(target: string) {
  try {
    return new URL(target).origin === new URL(server!.url).origin;
  } catch {
    return false;
  }
}

let localUrl = '';
const servers = new ServerList(join(app.getPath('userData'), 'servers.json'));
/** Open windows of team servers, by origin. */
const serverWindows = new Map<string, BrowserWindow>();

function createWindow(url: string) {
  localUrl = url;
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: 'Kalibra',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // External links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target) && !isAppUrl(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!isAppUrl(target)) {
      e.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });
  win.loadURL(url);
  return win;
}

/** The local window: focus it if open, otherwise open it. */
function showLocal() {
  const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && isAppUrl(x.webContents.getURL()));
  if (w) w.focus();
  else if (localUrl) createWindow(localUrl);
}

/**
 * A team server in its own window, with its own cookies (one session partition per server).
 * It behaves like a browser tab: the server's own login page, including sign-in providers.
 */
function openServer(origin: string) {
  const existing = serverWindows.get(origin);
  if (existing && !existing.isDestroyed()) return existing.focus();
  const partition = `persist:server-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
  const name = servers.list().find((s) => s.url === origin)?.name ?? new URL(origin).host;
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: `Kalibra — ${name}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition },
  });
  // Sign-in pages of providers (company SSO, GitHub, Google…) may load here; anything else opening
  // a new window goes to the browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!/^https?:/.test(target)) e.preventDefault();
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => serverWindows.delete(origin));
  serverWindows.set(origin, win);
  win.loadURL(origin);
}

/** Asks for a server address in a small window, checks the server answers, saves it and opens it. */
function connectToServer() {
  const win = new BrowserWindow({ width: 480, height: 340, resizable: false, minimizable: false, title: 'Connect to a team server', webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, javascript: false } });
  win.setMenuBarVisibility(false);
  win.webContents.on('will-navigate', async (e, target) => {
    e.preventDefault();
    if (!target.startsWith('kalibra-connect://')) return;
    const params = new URL(target).searchParams;
    if (target.startsWith('kalibra-connect://cancel')) return win.close();
    const typed = params.get('url') ?? '';
    try {
      const origin = normalizeServerUrl(typed);
      const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json() as Promise<{ name?: string }>).catch(() => undefined);
      if (health?.name !== 'kalibra') throw new Error(`No Kalibra server answered at ${origin}`);
      servers.add(origin, params.get('name') ?? undefined);
      buildMenu();
      win.close();
      openServer(origin);
    } catch (err: any) {
      win.loadURL(connectPage(err?.message ?? String(err), typed));
    }
  });
  win.loadURL(connectPage());
}

/** App menu, with a Servers menu: this computer, saved team servers, connect, remove. */
function buildMenu() {
  const saved = servers.list();
  const serversMenu: MenuItemConstructorOptions = {
    label: 'Servers',
    submenu: [
      { label: 'This computer', accelerator: 'CmdOrCtrl+0', click: showLocal },
      ...(saved.length ? [{ type: 'separator' as const }, ...saved.map((s, i) => ({ label: s.name, sublabel: s.url, accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, click: () => openServer(s.url) }))] : []),
      { type: 'separator' },
      { label: 'Connect to a team server…', click: connectToServer },
      ...(saved.length
        ? [{ label: 'Remove a server', submenu: saved.map((s) => ({ label: s.name, click: () => (servers.remove(s.url), serverWindows.get(s.url)?.close(), buildMenu()) })) }]
        : []),
    ],
  };
  const template: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, serversMenu, { role: 'windowMenu' }]
      : [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, serversMenu, { role: 'windowMenu' }];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(async () => {
    buildMenu();
    const url = await boot();
    createWindow(url);
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow(url));
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', async () => {
    try {
      if (existsSync(join(dir, '.engine.json'))) rmSync(join(dir, '.engine.json'));
    } catch {
      /* ignore */
    }
    await server?.close();
    hub?.close();
  });
}
