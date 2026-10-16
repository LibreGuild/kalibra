import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDemoServers, type DemoServers } from '../src/servers.js';

describe('demo streaming STT socket', () => {
  let servers: DemoServers;
  beforeAll(async () => {
    servers = await startDemoServers({ port: 0 });
  }, 120_000);
  afterAll(() => servers?.close());

  it('survives a client protocol error instead of crashing the demo process', async () => {
    const ws = new WebSocket(`${servers.wsUrl}/ws/stt`);
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    // A text frame that isn't valid UTF-8 makes the server-side socket emit 'error'.
    ws.send(Buffer.from([0xff, 0xfe]), { binary: false });
    expect(await closed).toBeGreaterThanOrEqual(1000);
    const health = await fetch(`${servers.url}/api/health`);
    expect(health.status).toBe(200);
  });
});
