import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hub } from '@kalibra/core';
import { startServer, type RunningServer } from '../src/index.js';

describe('file uploads', () => {
  let dir: string;
  let hub: Hub;
  let srv: RunningServer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-up-'));
    hub = await Hub.open({ dir, mode: 'local' });
    srv = await startServer({ hub });
  });
  afterAll(async () => {
    await srv?.close();
    await hub?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams an upload to disk and serves the same bytes back', async () => {
    const body = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < body.length; i += 4096) body[i] = i % 251;
    const res = await fetch(`${srv.url}/kalibra/api/projects/default/files`, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-file-name': encodeURIComponent('long take.wav') }, body });
    const info = (await res.json()).data;
    expect(info).toMatchObject({ size: body.length, mime: 'audio/wav', name: 'long take.wav', hash: createHash('sha256').update(body).digest('hex') });
    const back = Buffer.from(await (await fetch(`${srv.url}/kalibra/api/projects/default/files/${info.hash}`)).arrayBuffer());
    expect(back.equals(body)).toBe(true);
  });
});
