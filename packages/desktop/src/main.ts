import { app, BrowserWindow, Menu, nativeTheme, safeStorage, shell } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore, Hub } from '@kalibra/core';
import { newToken, startServer, type RunningServer } from '@kalibra/server';

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

function createWindow(url: string) {
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
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
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
