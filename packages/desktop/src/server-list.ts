import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * Team servers the desktop app can open, besides "This computer". Kept in the app's user data
 * folder. Each server opens in its own window with its own cookies, and signs in on its own
 * login page (passwords, company SSO, GitHub…), exactly like a browser.
 */

export interface SavedServer {
  name: string;
  url: string;
}

/** Normalises what someone typed into a server address: https by default, no path, no trailing slash. */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('Enter the server address');
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That is not a web address');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use an https:// address (http only for this computer)');
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address');
  return url.origin;
}

export class ServerList {
  constructor(private file: string) {}

  list(): SavedServer[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data) ? data.filter((s) => typeof s?.url === 'string' && typeof s?.name === 'string') : [];
    } catch {
      return [];
    }
  }

  add(url: string, name?: string): SavedServer {
    const origin = normalizeServerUrl(url);
    const server = { url: origin, name: name?.trim() || new URL(origin).host };
    this.save([...this.list().filter((s) => s.url !== origin), server]);
    return server;
  }

  remove(url: string) {
    this.save(this.list().filter((s) => s.url !== url));
  }

  private save(all: SavedServer[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
}

/** The browser identity for server windows: without "Electron", so providers like Google allow the sign-in page. */
export const browserUserAgent = (ua: string) => ua.replace(/\s(Electron|kalibra|@kalibra\/desktop)\/\S+/gi, '');

/** The "connect to a team server" form, as a self-contained page (no scripts; it submits to a kalibra-connect: URL we intercept). */
export function connectPage(error = '', value = '') {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>Connect to a team server</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action kalibra-connect:">
<style>
  :root { color-scheme: light dark; --bg:#faf9f5; --ink:#2b2a27; --muted:#6f6b63; --line:#e3ded3; --accent:#c96442; }
  @media (prefers-color-scheme: dark) { :root { --bg:#262624; --ink:#ece9e1; --muted:#a8a296; --line:#3d3b37; --accent:#e07a52; } }
  body { margin:0; font:14px/1.5 -apple-system, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  main { padding:28px 28px 20px; }
  h1 { font-size:17px; margin:0 0 6px; }
  p { color:var(--muted); margin:0 0 16px; }
  label { display:block; font-weight:600; margin:12px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  .err { color:#c0392b; margin-top:10px; }
  .row { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
  button { padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
</style></head><body><main>
<h1>Connect to a team server</h1>
<p>Open a Kalibra server your team runs. You sign in on its page; this computer's projects stay as they are.</p>
<form action="kalibra-connect://add" method="get">
  <label for="url">Server address</label>
  <input id="url" name="url" placeholder="kalibra.example.com" value="${esc(value)}" autofocus required>
  <label for="name">Name in the menu (optional)</label>
  <input id="name" name="name" placeholder="Team evals">
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <div class="row"><button type="submit" formaction="kalibra-connect://cancel" formnovalidate>Cancel</button><button class="primary" type="submit">Connect</button></div>
</form></main></body></html>`)}`;
}
