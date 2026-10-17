import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  argsHash,
  DEFAULT_PROJECT,
  INGEST_KEY_PREFIX,
  INGEST_LIMITS,
  KalibraError,
  otlpToTraces,
  roleAtLeast,
  traceFromProxy,
  type Engine,
  type Hub,
} from '@kalibra/core';
import { authenticate, type AuthConfig } from './auth.js';
import { fail, readBody, send } from './http.js';

/*
 * Where apps send what happened inside them (docs/design/sdk-and-traces.md §2):
 *
 *   POST /api/projects/:p/ingest/traces     SDK batches            → 202 { accepted, rejected }
 *   POST /api/projects/:p/otlp/v1/traces    OpenTelemetry (JSON)   → 200 {}
 *   GET  /api/projects/:p/ingest/tools      a tool recording       → 200 { found, output, error }
 *   POST /api/projects/:p/ingest/tools      record one             → 200 { stored, argsHash }
 *   ANY  /api/projects/:p/proxy/openai/*    OpenAI-compatible proxy: forwarded unchanged, recorded
 *
 * Auth: an ingest key (`Authorization: Bearer kik_…`, or `x-kalibra-key` — the proxy needs the
 * Authorization header for the OpenAI key), or a normal sign-in with the editor role. A key only
 * works for its own project; any other project looks like it doesn't exist.
 * Shortcuts without /projects/:p (e.g. /api/ingest/traces) go to the default project.
 */

const ROUTE = /^\/api(?:\/projects\/([^/]+))?\/(ingest\/traces|ingest\/tools|otlp\/v1\/traces|proxy\/openai(?:\/.*)?)$/;
const PROXY_BODY = 20 * 1024 * 1024;
/** How much of a proxied response is kept for the trace (the client always gets all of it). */
const PROXY_CAPTURE = 2 * 1024 * 1024;
const TOOL_BODY = 2 * 1024 * 1024;
const OTLP_INFLATED = 16 * 1024 * 1024;
/** How much of an oversize upload is read and dropped after answering 413. */
const DRAIN_CAP = 64 * 1024 * 1024;

/** Request headers never forwarded upstream: hop-by-hop, ours, and browser ambient credentials. */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'cookie', 'origin', 'referer', 'accept-encoding', 'x-kalibra-key', 'x-kalibra-run', 'x-kalibra-result', 'x-kalibra-tools']);
/** Response headers not copied back: hop-by-hop, and encoding/length (fetch already decoded the body). */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie', 'upgrade', 'trailer']);

export function isIngestRoute(path: string) {
  return ROUTE.test(path);
}

export function ingestRoutes(hub: Hub, cfg: AuthConfig) {
  /** The project this request may write to, or a failure answer already sent. */
  async function resolve(req: IncomingMessage, res: ServerResponse, projectRef: string, keyOnly: boolean): Promise<Engine | undefined> {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    const header = req.headers['x-kalibra-key'];
    const key = (typeof header === 'string' && header.trim()) || (!keyOnly && bearer?.startsWith(INGEST_KEY_PREFIX) ? bearer : undefined);
    if (key) {
      const found = hub.ingestKeys.resolve(key);
      if (!found) return void fail(res, 401, 'unauthorized', 'Invalid or revoked ingest key');
      let projectId: string | undefined;
      try {
        projectId = hub.projects.get(projectRef).id;
      } catch {
        /* reported as not found below */
      }
      // A key for another project: answer as if this project did not exist.
      if (projectId !== found.projectId) return void fail(res, 404, 'not_found', `Project not found: ${projectRef}`);
      return hub.engine(projectId);
    }
    if (keyOnly) return void fail(res, 401, 'unauthorized', 'Send your Kalibra ingest key in the x-kalibra-key header (Authorization carries your OpenAI key)');
    const auth = await authenticate(req, cfg);
    if (!auth.ok) return void fail(res, auth.status, auth.code, auth.message);
    if ((auth.via === 'session' || auth.via === 'proxy') && req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.origin) {
      return void fail(res, 403, 'forbidden', 'Missing Origin header');
    }
    if (auth.principal.user.mustChangePassword && auth.via === 'session') return void fail(res, 403, 'password_change_required', 'Choose a new password to continue');
    const { project, role } = hub.projectFor(auth.principal, projectRef);
    if (!roleAtLeast(role, 'editor')) throw new KalibraError('forbidden', 'Sending traces needs the editor role in this project (or an ingest key)');
    return hub.engine(project.id);
  }

  /** The request body within `limit`, answering 413 when it is bigger. */
  async function body(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Buffer | undefined> {
    const tooLarge = () => void fail(res, 413, 'too_large', `Request body over ${Math.round(limit / 1024 / 1024)} MB; send smaller batches`);
    // Answer before reading when the size is declared, and drop what the client still sends so it
    // can read the 413 (closing mid-upload makes clients report a broken pipe instead). Past
    // DRAIN_CAP the connection is cut.
    if (Number(req.headers['content-length']) > limit) {
      let dropped = 0;
      req.on('data', (c: Buffer) => {
        dropped += c.length;
        if (dropped > DRAIN_CAP) req.destroy();
      });
      return tooLarge();
    }
    try {
      return await readBody(req, limit);
    } catch (e: any) {
      if (/too large/i.test(e?.message ?? '')) return tooLarge();
      throw e;
    }
  }

  function json(buf: Buffer) {
    try {
      return buf.length ? JSON.parse(buf.toString('utf8')) : {};
    } catch (e: any) {
      throw new KalibraError('invalid', `Invalid JSON: ${e?.message ?? e}`);
    }
  }

  async function traces(req: IncomingMessage, res: ServerResponse, engine: Engine) {
    const buf = await body(req, res, INGEST_LIMITS.bodyBytes);
    if (!buf) return;
    const { accepted, rejected } = engine.traces.ingestBody(json(buf), 'sdk');
    if (!accepted && rejected.length) return send(res, 400, { error: { code: 'invalid', message: `No trace was valid: ${rejected[0].error}`, details: rejected.slice(0, 50) } });
    send(res, 202, { accepted, rejected: rejected.slice(0, 50) });
  }

  async function otlp(req: IncomingMessage, res: ServerResponse, engine: Engine) {
    const type = String(req.headers['content-type'] ?? '');
    if (/protobuf/i.test(type)) {
      return fail(res, 415, 'unsupported', 'Kalibra accepts OTLP as JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (or OTEL_EXPORTER_OTLP_TRACES_PROTOCOL).');
    }
    let buf = await body(req, res, INGEST_LIMITS.bodyBytes);
    if (!buf) return;
    const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
    try {
      if (encoding === 'gzip') buf = gunzipSync(buf, { maxOutputLength: OTLP_INFLATED });
      else if (encoding === 'deflate') buf = inflateSync(buf, { maxOutputLength: OTLP_INFLATED });
    } catch {
      return fail(res, 400, 'invalid', `Could not decompress the ${encoding} body (or it is over ${OTLP_INFLATED / 1024 / 1024} MB unpacked)`);
    }
    engine.traces.enqueue(otlpToTraces(json(buf)));
    send(res, 200, {});
  }

  async function tools(req: IncomingMessage, res: ServerResponse, url: URL, engine: Engine) {
    if (req.method === 'GET') {
      const tool = url.searchParams.get('tool') ?? '';
      if (!tool) return fail(res, 400, 'invalid', 'Give ?tool= and ?argsHash= (or ?args= as JSON)');
      let hash = url.searchParams.get('argsHash') ?? '';
      const args = url.searchParams.get('args');
      if (!hash && args !== null) hash = argsHash(json(Buffer.from(args)));
      if (!/^[a-f0-9]{64}$/.test(hash)) return fail(res, 400, 'invalid', 'argsHash must be the SHA-256 (hex) of the canonical JSON arguments');
      const rec = engine.traces.tools.get(tool, hash);
      return send(res, 200, rec ? { found: true, output: rec.output ?? null, ...(rec.error ? { error: rec.error } : {}) } : { found: false });
    }
    if (req.method !== 'POST') return fail(res, 405, 'invalid', 'Use GET to look up or POST to record');
    const buf = await body(req, res, TOOL_BODY);
    if (!buf) return;
    const b = json(buf);
    const tool = typeof b.tool === 'string' ? b.tool.trim() : '';
    if (!tool || tool.length > 200) return fail(res, 400, 'invalid', 'tool (1–200 characters) is required');
    // The server's hash is the one stored; a client that canonicalizes differently is told so.
    const hash = argsHash(b.args ?? null);
    engine.traces.tools.upsert({
      tool,
      argsHash: hash,
      args: b.args ?? null,
      ...(b.output !== undefined ? { output: b.output } : {}),
      ...(typeof b.error === 'string' && b.error ? { error: b.error.slice(0, 4000) } : {}),
      ...(typeof b.runId === 'string' ? { runId: b.runId.slice(0, 64) } : {}),
    });
    send(res, 200, { stored: true, argsHash: hash, ...(b.argsHash && b.argsHash !== hash ? { warning: 'argsHash differs from the server hash of args; use the returned argsHash' } : {}) });
  }

  async function proxy(req: IncomingMessage, res: ServerResponse, url: URL, suffix: string, engine: Engine) {
    const buf = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await body(req, res, PROXY_BODY);
    if (!buf) return;
    const upstream = `${engine.traces.settings().proxyOpenaiUpstream}${suffix || '/'}${url.search}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQUEST.has(k) && typeof v === 'string') headers[k] = v;
    const runId = typeof req.headers['x-kalibra-run'] === 'string' ? req.headers['x-kalibra-run'].slice(0, 64) : undefined;
    const resultId = typeof req.headers['x-kalibra-result'] === 'string' ? req.headers['x-kalibra-result'].slice(0, 64) : undefined;

    const ac = new AbortController();
    res.on('close', () => !res.writableEnded && ac.abort());
    const started = Date.now();
    let up: Response;
    try {
      up = await fetch(upstream, { method: req.method, headers, body: buf.length ? buf : undefined, redirect: 'manual', signal: ac.signal });
    } catch (e: any) {
      return send(res, 502, { error: { message: `Kalibra could not reach ${new URL(upstream).origin}: ${e?.cause?.message ?? e?.message ?? e}`, type: 'kalibra_proxy_error' } });
    }
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!DROP_RESPONSE.has(k)) out[k] = v;
    });
    res.writeHead(up.status, out);

    // Pass every chunk on as it arrives (streaming answers stay streaming); keep a bounded copy.
    const kept: Buffer[] = [];
    let size = 0;
    try {
      if (up.body) {
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk);
          if (size < PROXY_CAPTURE) {
            const c = Buffer.from(chunk);
            kept.push(c.subarray(0, PROXY_CAPTURE - size));
            size += c.length;
          }
        }
      }
      res.end();
    } catch {
      if (!res.writableEnded) res.destroy();
      return;
    }

    // Recording never affects the call: the client already has its full answer.
    if (req.method !== 'POST') return;
    try {
      let requestBody: unknown;
      try {
        requestBody = JSON.parse(buf.toString('utf8'));
      } catch {
        return; // not a JSON API call (e.g. a file upload): nothing useful to record
      }
      engine.traces.enqueue([
        traceFromProxy({
          method: req.method ?? 'POST',
          path: suffix,
          requestBody,
          status: up.status,
          contentType: up.headers.get('content-type') ?? '',
          responseText: Buffer.concat(kept).toString('utf8'),
          startedAt: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          runId,
          resultId,
        }),
      ]);
    } catch {
      /* the queue is full or the project is closing: skip this recording */
    }
  }

  /** Handles an ingest route (see isIngestRoute). */
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = ROUTE.exec(url.pathname)!;
    let projectRef = DEFAULT_PROJECT;
    try {
      if (m[1]) projectRef = decodeURIComponent(m[1]);
    } catch {
      return fail(res, 400, 'invalid', 'Bad project in the address');
    }
    const route = m[2];
    const isProxy = route.startsWith('proxy/openai');
    if (!isProxy && route !== 'ingest/tools' && req.method !== 'POST') return fail(res, 405, 'invalid', `Use POST for /${route}`);
    const engine = await resolve(req, res, projectRef, isProxy);
    if (!engine) return;
    if (route === 'ingest/traces') return traces(req, res, engine);
    if (route === 'otlp/v1/traces') return otlp(req, res, engine);
    if (route === 'ingest/tools') return tools(req, res, url, engine);
    return proxy(req, res, url, route.slice('proxy/openai'.length), engine);
  };
}
