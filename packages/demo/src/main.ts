import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASE_PATH } from '@kalibra/core';
import { startDemoServers } from './servers.js';
import { seedWorkspace, type Call } from './seed.js';

/*
 * `npm run demo` – starts the mock apps under test and prints their URLs.
 * `npm run demo -- --seed [--dir .kalibra-dev]` – also fills the workspace with demo
 * datasets, targets and suites (through the running engine when there is one).
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('--port') ?? process.env.KALIBRA_DEMO_PORT ?? 4400);
const dir = resolve(arg('--dir') ?? process.env.KALIBRA_DIR ?? '.kalibra-dev');

const servers = await startDemoServers({ port });
const voices = [...new Set(servers.fixtures.map((f) => f.voice))].join(', ');
console.log(`Kalibra demo apps running (${servers.fixtures.length} audio fixtures, voices: ${voices})

  POST ${servers.url}/api/chat          JSON support bot      body: {"message": "..."}
  POST ${servers.url}/api/chat/stream   same bot over SSE
  POST ${servers.url}/api/chat/session  multi-turn bot        body: {"message": "...", "session_id": "..."}
  POST ${servers.url}/api/stt           batch STT             multipart: file, language
  WS   ${servers.wsUrl}/ws/stt            streaming STT         {"type":"start"} → audio frames → {"type":"stop"}
`);

if (process.argv.includes('--seed')) {
  const call = await engineCall(dir);
  const created = await seedWorkspace(call.call, { baseUrl: servers.url, wsUrl: servers.wsUrl, fixtures: servers.fixtures });
  console.log(`Seeded ${dir} (${call.mode}): ${JSON.stringify(created)}`);
  await call.close();
}
console.log('Press Ctrl+C to stop.');

const stop = async () => {
  await servers.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** Talk to the running engine if there is one (so the open UI updates live); otherwise open the workspace directly. */
async function engineCall(workspace: string): Promise<{ call: Call; mode: string; close: () => Promise<void> }> {
  const info = join(workspace, '.engine.json');
  if (existsSync(info)) {
    const { url, token } = JSON.parse(readFileSync(info, 'utf8'));
    // Kalibra's API lives under BASE_PATH (/kalibra).
    const ok = await fetch(`${url}${BASE_PATH}/api/health`).then((r) => r.ok, () => false);
    if (ok) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-kalibra-actor': JSON.stringify({ kind: 'cli', id: 'demo-seed' }) };
      if (token) headers.authorization = `Bearer ${token}`;
      const call: Call = async (name, input) => {
        const res = await fetch(`${url}${BASE_PATH}/api/ops/${name}`, { method: 'POST', headers, body: JSON.stringify(input) });
        const body: any = await res.json();
        if (!res.ok) throw new Error(`${name}: ${body?.error?.message}`);
        return body.data;
      };
      return { call, mode: 'via running engine', close: async () => {} };
    }
  }
  const { Engine } = await import('@kalibra/core');
  const engine = await Engine.open({ dir: workspace });
  return { call: (name, input) => engine.call(name, input, { kind: 'cli', id: 'demo-seed' }), mode: 'direct', close: async () => await engine.close() };
}
