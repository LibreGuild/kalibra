/*
 * A tiny stand-in for the Kalibra server in tests: records every request and answers the ingest,
 * tool-recording and code-run endpoints the SDK uses (docs/design/sdk-and-traces.md §2–§3).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
// The server's own hash, as packages/server/src/ingest.ts uses it: recordings are stored under the
// hash of the `args` the SDK posts, not the `argsHash` it claims.
import { argsHash as serverHash } from '../../core/src/traces/hash.js';

export interface Received {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface FakeKalibra {
  url: string;
  requests: Received[];
  traces: () => any[];
  recordings: Map<string, { output?: unknown; error?: string; args: unknown }>;
  /** Answer the next N ingest requests with this status (default 202). */
  failIngest: (status: number, times?: number) => void;
  /** Handlers for ops: POST /kalibra/api/projects/:p/ops/:name. */
  ops: Record<string, (input: any) => unknown>;
  close: () => Promise<void>;
}

export async function fakeKalibra(): Promise<FakeKalibra> {
  const requests: Received[] = [];
  const recordings = new Map<string, { output?: unknown; error?: string; args: unknown }>();
  const ops: FakeKalibra['ops'] = {};
  let failures: { status: number; times: number } | undefined;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://x');
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    // Like the server: everything lives under /kalibra.
    if (!url.pathname.startsWith('/kalibra/api/')) return json(404, { error: { code: 'not_found', message: `Outside /kalibra: ${url.pathname}` } });
    if (url.pathname.endsWith('/ingest/traces')) {
      if (failures && failures.times > 0) {
        failures.times--;
        return json(failures.status, { error: { code: 'internal', message: 'nope' } });
      }
      return json(202, { data: { accepted: body?.traces?.length ?? 0 } });
    }
    if (url.pathname.endsWith('/ingest/tools')) {
      if (req.method === 'POST') {
        const hash = serverHash(body.args ?? null);
        recordings.set(`${body.tool}:${hash}`, { output: body.output, error: body.error, args: body.args });
        return json(200, { data: { stored: true, argsHash: hash } });
      }
      const hit = recordings.get(`${url.searchParams.get('tool')}:${url.searchParams.get('argsHash')}`);
      return json(200, { data: hit ? { found: true, output: hit.output, error: hit.error } : { found: false } });
    }
    const op = /\/ops\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (op && ops[op]) {
      try {
        return json(200, { data: await ops[op](body) });
      } catch (e: any) {
        return json(400, { error: { code: 'invalid', message: e.message } });
      }
    }
    json(404, { error: { code: 'not_found', message: `No route ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    url,
    requests,
    traces: () => requests.filter((r) => r.path.endsWith('/ingest/traces')).flatMap((r) => r.body?.traces ?? []),
    recordings,
    failIngest: (status, times = 1) => {
      failures = { status, times };
    },
    ops,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
