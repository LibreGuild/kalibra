import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openEngine } from '../src/engine-client.js';

describe('openEngine', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'kalibra-cli-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('uses the plain secret file for CLI workspaces', async () => {
    const engine = openEngine(tmp());
    await engine.secrets.set('k', 'v');
    expect(await engine.secrets.get('k')).toBe('v');
    engine.close();
  });

  it('explains that desktop-encrypted secrets need the app instead of reading them as unset', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'secrets.enc'), 'opaque');
    const engine = openEngine(dir);
    await expect(engine.secrets.get('openai_api_key')).rejects.toThrow(/desktop app/);
    await expect(engine.secrets.list()).rejects.toMatchObject({ code: 'unavailable' });
    engine.close();
  });
});
