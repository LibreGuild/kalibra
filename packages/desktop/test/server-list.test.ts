import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserUserAgent, connectPage, normalizeServerUrl, ServerList } from '../src/server-list.js';

describe('desktop team servers', () => {
  it('normalises addresses and refuses unsafe ones', () => {
    expect(normalizeServerUrl('kalibra.example.com')).toBe('https://kalibra.example.com');
    expect(normalizeServerUrl(' https://kalibra.example.com/p/x/runs ')).toBe('https://kalibra.example.com');
    expect(normalizeServerUrl('http://localhost:4317')).toBe('http://localhost:4317');
    expect(() => normalizeServerUrl('http://kalibra.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('https://user:pw@kalibra.example.com')).toThrow(/user name/);
    expect(() => normalizeServerUrl('')).toThrow(/Enter/);
    expect(() => normalizeServerUrl('ftp://x')).toThrow(/https/);
  });

  it('saves, replaces and removes servers in a private file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-desk-'));
    const file = join(dir, 'servers.json');
    const list = new ServerList(file);
    expect(list.list()).toEqual([]);
    list.add('kalibra.example.com', 'Team');
    list.add('https://kalibra.example.com', 'Renamed');
    list.add('https://other.example.com');
    expect(list.list()).toEqual([
      { url: 'https://kalibra.example.com', name: 'Renamed' },
      { url: 'https://other.example.com', name: 'other.example.com' },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    list.remove('https://other.example.com');
    expect(list.list().length).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))[0].name).toBe('Renamed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('presents a plain browser identity to sign-in providers', () => {
    expect(browserUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Electron/44.8.0 Safari/537.36')).toBe('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36');
  });

  it('escapes what it shows back in the connect form', () => {
    const page = decodeURIComponent(connectPage('<b>bad</b>', '"><script>'));
    expect(page).not.toContain('<script>');
    expect(page).toContain('&#60;b&#62;bad');
  });
});
