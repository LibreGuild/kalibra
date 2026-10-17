import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeEngineInfo } from '../src/engine-client.js';

describe('engine info file', () => {
  it('keeps the per-launch token private even when an older file was readable by others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kalibra-info-'));
    writeFileSync(join(dir, '.engine.json'), '{}', { mode: 0o644 });
    writeEngineInfo(dir, { url: 'http://127.0.0.1:1', token: 'secret-token', pid: process.pid });
    expect(statSync(join(dir, '.engine.json')).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});
