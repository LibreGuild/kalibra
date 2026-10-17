import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argsHash, Hub } from '@kalibra/core';
import { startServer, type RunningServer } from '../src/index.js';
import { onPostgres } from '../../../test-support/database.js';

/*
 * Where apps send traces, over real HTTP on a team server: ingest keys and their scope, size
 * limits, OpenTelemetry JSON, tool recordings, and the OpenAI proxy against a fake upstream.
 */

const PW = 'correct horse battery';
let dir: string;
let hub: Hub;
let srv: RunningServer;
let project: { id: string };
let other: { id: string };
let key: string;
let keyId: string;
let admin: ReturnType<typeof browser>;

/** A tiny browser: keeps the session cookie and sends our Origin like a real page would. */
function browser() {
  let jar = '';
  const call = async (path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(`${srv.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: srv.url, 'content-type': 'application/json', ...(jar ? { cookie: jar } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) jar = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { call, cookie: () => jar };
}

/** An app sending something with a key (no cookies, no Origin: not a browser). */
const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });

const traces = async (query: Record<string, unknown> = {}) => (await admin.call(`/kalibra/api/projects/${project.id}/ops/list_traces`, query)).body.data;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kalibra-ingest-'));
  hub = await Hub.open({ dir, mode: 'server' });
  await hub.completeSetup((await hub.setupCode())!, { username: 'admin', password: PW });
  srv = await startServer({ hub });
  admin = browser();
  await admin.call('/kalibra/api/auth/login', { username: 'admin', password: PW });
  project = (await admin.call('/kalibra/api/hub/create_project', { name: 'Support bot' })).body.data;
  other = (await admin.call('/kalibra/api/hub/create_project', { name: 'Other team' })).body.data;
  const created = (await admin.call('/kalibra/api/hub/create_ingest_key', { project: project.id, name: 'support-bot dev' })).body.data;
  key = created.key;
  keyId = created.id;
});

afterAll(async () => {
  await srv?.close();
  await hub?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingest keys', () => {
  it('are created once, listed without the secret, and kept out of MCP', async () => {
    expect(key).toMatch(/^kik_[A-Za-z0-9_-]{20,}$/);
    const list = (await admin.call('/kalibra/api/hub/list_ingest_keys', { project: project.id })).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: keyId, name: 'support-bot dev', prefix: key.slice(0, 10) });
    expect(JSON.stringify(list)).not.toContain(key);
    for (const op of ['list_ingest_keys', 'create_ingest_key', 'revoke_ingest_key']) expect(hub.registry.get(op)?.mcp).toBe(false);
  });

  it('send traces to their own project only, and read nothing', async () => {
    const ok = await send(`/kalibra/api/projects/${project.id}/ingest/traces`, { traces: [{ id: 'k-1', name: 'answer', input: 'hi', output: 'hello', spans: [{ name: 'llm', kind: 'llm' }] }] });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ accepted: 1, rejected: [] });
    expect((await traces({ name: 'answer' })).traces.map((t: any) => t.id)).toEqual(['k-1']);

    // Another project looks like it doesn't exist; so does the default-project shortcut.
    expect((await send(`/kalibra/api/projects/${other.id}/ingest/traces`, { traces: [{ name: 'x' }] })).status).toBe(404);
    expect((await send('/kalibra/api/ingest/traces', { traces: [{ name: 'x' }] })).status).toBe(404);
    // Not an access token: operations refuse it.
    expect((await send(`/kalibra/api/projects/${project.id}/ops/list_traces`, {})).status).toBe(401);
    expect((await send('/kalibra/api/hub/list_projects', {})).status).toBe(401);
    expect((await send(`/kalibra/api/projects/${project.id}/ingest/traces`, { traces: [{ name: 'x' }] }, { authorization: 'Bearer kik_not-a-real-key' })).status).toBe(401);
  });

  it('stop working when revoked', async () => {
    const tmp = (await admin.call('/kalibra/api/hub/create_ingest_key', { project: project.id, name: 'temporary' })).body.data;
    const use = () => send(`/kalibra/api/projects/${project.id}/ingest/traces`, { traces: [{ name: 'x' }] }, { authorization: `Bearer ${tmp.key}` });
    expect((await use()).status).toBe(202);
    expect((await admin.call('/kalibra/api/hub/revoke_ingest_key', { project: project.id, id: tmp.id })).status).toBe(200);
    expect((await use()).status).toBe(401);
    expect((await admin.call('/kalibra/api/hub/list_ingest_keys', { project: project.id })).body.data.map((k: any) => k.id)).toEqual([keyId]);
  });
});

describe('signed-in senders', () => {
  it('need the editor role (and an Origin when using a cookie)', async () => {
    await admin.call('/kalibra/api/hub/create_user', { username: 'ed', password: PW, mustChangePassword: false });
    await admin.call('/kalibra/api/hub/create_user', { username: 'vi', password: PW, mustChangePassword: false });
    await admin.call('/kalibra/api/hub/set_member', { project: project.id, user: 'ed', role: 'editor' });
    await admin.call('/kalibra/api/hub/set_member', { project: project.id, user: 'vi', role: 'viewer' });
    const ed = browser();
    await ed.call('/kalibra/api/auth/login', { username: 'ed', password: PW });
    const vi = browser();
    await vi.call('/kalibra/api/auth/login', { username: 'vi', password: PW });
    const path = `/kalibra/api/projects/${project.id}/ingest/traces`;
    expect((await ed.call(path, { traces: [{ name: 'from-editor' }] })).status).toBe(202);
    expect((await vi.call(path, { traces: [{ name: 'from-viewer' }] })).status).toBe(403);
    expect((await vi.call(`/kalibra/api/hub/list_ingest_keys`, { project: project.id })).status).toBe(403);
    expect((await ed.call(`/kalibra/api/projects/${other.id}/ingest/traces`, { traces: [{ name: 'x' }] })).status).toBe(404);
    const noOrigin = await fetch(`${srv.url}${path}`, { method: 'POST', headers: { cookie: ed.cookie(), 'content-type': 'application/json' }, body: '{"traces":[{"name":"csrf"}]}' });
    expect(noOrigin.status).toBe(403);
    expect((await fetch(`${srv.url}${path}`, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('limits and validation', () => {
  it('answers clearly for bad bodies, too many traces and oversize requests', async () => {
    const path = `/kalibra/api/projects/${project.id}/ingest/traces`;
    expect((await send(path, '{not json')).status).toBe(400);
    const none = await send(path, { traces: [{ name: '' }, { spans: 3 }] });
    expect(none.status).toBe(400);
    expect(((await none.json()) as any).error.details).toHaveLength(2);
    const some = await (await send(path, { traces: [{ name: 'good' }, { name: '' }] })).json();
    expect(some).toMatchObject({ accepted: 1, rejected: [{ index: 1 }] });
    expect((await send(path, { traces: Array.from({ length: 1001 }, () => ({ name: 'x' })) })).status).toBe(400);
    const big = await send(path, JSON.stringify({ traces: [{ name: 'big', input: 'x'.repeat(2.5 * 1024 * 1024) }] }));
    expect(big.status).toBe(413);
    expect((await fetch(`${srv.url}${path}`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(405);
  });
});

describe('OpenTelemetry', () => {
  const span = (name: string) => ({
    resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'support-bot' } }] }, scopeSpans: [{ spans: [{ traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), name, startTimeUnixNano: '1792224000000000000', endTimeUnixNano: '1792224000500000000', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }] }] }] }],
  });

  it('accepts OTLP/HTTP JSON (also gzipped) and explains that protobuf is not supported', async () => {
    const path = `/kalibra/api/projects/${project.id}/otlp/v1/traces`;
    const ok = await send(path, span('chat gpt'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({});
    const t = (await traces({ source: 'otel' })).traces[0];
    expect(t).toMatchObject({ id: 'b'.repeat(32), name: 'chat gpt', metadata: { service: 'support-bot' } });
    expect((await send(path, gzipSync(JSON.stringify(span('zipped'))), { 'content-encoding': 'gzip' })).status).toBe(200);
    const proto = await send(path, Buffer.from([1, 2, 3]), { 'content-type': 'application/x-protobuf' });
    expect(proto.status).toBe(415);
    expect(((await proto.json()) as any).error.message).toMatch(/http\/json/);
    expect((await send(path, { nope: 1 })).status).toBe(400);
  });
});

describe('tool recordings', () => {
  it('records a response and finds it again by the hash of its arguments', async () => {
    const path = `/kalibra/api/projects/${project.id}/ingest/tools`;
    const args = { user: 'u1', filters: { status: 'open', since: '2026-01-01' } };
    const stored = await (await send(path, { tool: 'search_orders', args, output: [{ id: 'A12' }], argsHash: 'deadbeef' })).json();
    expect(stored).toMatchObject({ stored: true, argsHash: argsHash(args), warning: expect.stringMatching(/differs/) });
    const get = (q: string) => fetch(`${srv.url}${path}?${q}`, { headers: { 'x-kalibra-key': key } }).then((r) => r.json());
    // Same arguments in another key order hash the same.
    const reordered = { filters: { since: '2026-01-01', status: 'open' }, user: 'u1' };
    expect(await get(`tool=search_orders&argsHash=${argsHash(reordered)}`)).toEqual({ found: true, output: [{ id: 'A12' }] });
    expect(await get(`tool=search_orders&args=${encodeURIComponent(JSON.stringify(reordered))}`)).toEqual({ found: true, output: [{ id: 'A12' }] });
    expect(await get(`tool=search_orders&argsHash=${argsHash({ user: 'u2' })}`)).toEqual({ found: false });
    await send(path, { tool: 'send_email', args: {}, error: 'smtp down' });
    expect(await get(`tool=send_email&argsHash=${argsHash({})}`)).toEqual({ found: true, output: null, error: 'smtp down' });
    expect((await fetch(`${srv.url}${path}?tool=x&argsHash=nothex`, { headers: { 'x-kalibra-key': key } })).status).toBe(400);
    expect((await send(path, null)).status).toBe(400);
    expect((await admin.call(`/kalibra/api/projects/${project.id}/ops/list_tool_recordings`, {})).body.data.total).toBe(2);
  });
});

describe('the OpenAI proxy', () => {
  let upstream: Server;
  let seen: { path: string; headers: Record<string, unknown>; body: string }[] = [];
  let releaseStream: () => void = () => {};

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers, body });
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ model: 'gpt-test', choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
          // The rest only comes once the client has seen the first part: a buffering proxy would hang here.
          new Promise<void>((r) => (releaseStream = r)).then(() => {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
            res.end('data: [DONE]\n\n');
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_1', 'set-cookie': 'upstream=1' });
        res.end(JSON.stringify({ model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'Hi there' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const set = await admin.call(`/kalibra/api/projects/${project.id}/ops/set_trace_settings`, { proxyOpenaiUpstream: `http://127.0.0.1:${(upstream.address() as any).port}` });
    expect(set.status).toBe(200);
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  const proxied = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${srv.url}/kalibra/api/projects/${project.id}/proxy/openai${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-live-SECRET-123', 'x-kalibra-key': key, 'content-type': 'application/json', cookie: 'kalibra_session=nope', ...headers },
      body: JSON.stringify(body),
    });

  it('forwards a call unchanged, returns the answer, and records it without the OpenAI key', async () => {
    seen = [];
    const res = await proxied('/v1/chat/completions?api-version=1', { model: 'gpt-test', messages: [{ role: 'user', content: 'Hello?' }] }, { 'x-kalibra-result': 'res_42' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('req_1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(((await res.json()) as any).choices[0].message.content).toBe('Hi there');
    expect(seen[0].path).toBe('/v1/chat/completions?api-version=1');
    expect(seen[0].headers.authorization).toBe('Bearer sk-live-SECRET-123');
    for (const h of ['x-kalibra-key', 'x-kalibra-result', 'cookie', 'origin']) expect(seen[0].headers[h]).toBeUndefined();

    const list = await traces({ source: 'proxy' });
    expect(list.total).toBe(1);
    const t = (await admin.call(`/kalibra/api/projects/${project.id}/ops/get_trace`, { id: list.traces[0].id })).body.data;
    expect(t).toMatchObject({ name: 'openai.chat.completions', output: 'Hi there', resultId: 'res_42' });
    expect(t.spans[0].attributes).toMatchObject({ model: 'gpt-test', tokens_in: 7, tokens_out: 3, streamed: false });
    expect(JSON.stringify(t)).not.toContain('SECRET');
    // Nor anywhere in the project's database: no table holds it, nor (with SQLite) any database file.
    const engine = await hub.engine(project.id);
    for (const table of await engine.db.tables()) expect(JSON.stringify(await engine.db.all(`SELECT * FROM ${table.name}`))).not.toContain('sk-live-SECRET');
    if (!onPostgres) {
      const files = readdirSync(engine.dir).filter((n) => /\.db(-wal)?$/.test(n));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(readFileSync(join(engine.dir, f)).includes('sk-live-SECRET')).toBe(false);
    }
  });

  it('passes a streamed answer through as it arrives, then records the whole text', async () => {
    const res = await proxied('/v1/chat/completions', { model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'Stream?' }] });
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('Hel');
    releaseStream();
    let rest = '';
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toContain('[DONE]');
    // Recorded after the stream ends.
    let t: any;
    for (let i = 0; i < 50 && !t; i++) {
      t = (await traces({ source: 'proxy', search: 'Stream?' })).traces[0];
      if (!t) await new Promise((r) => setTimeout(r, 20));
    }
    expect(t.outputPreview).toBe('Hello');
  });

  it('needs the key in x-kalibra-key, and says when the upstream is down', async () => {
    const res = await fetch(`${srv.url}/kalibra/api/projects/${project.id}/proxy/openai/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: '{}' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.message).toMatch(/x-kalibra-key/);
    await admin.call(`/kalibra/api/projects/${project.id}/ops/set_trace_settings`, { proxyOpenaiUpstream: 'http://127.0.0.1:9' });
    const down = await proxied('/v1/chat/completions', { model: 'x' });
    expect(down.status).toBe(502);
    expect(((await down.json()) as any).error.type).toBe('kalibra_proxy_error');
  });
});
