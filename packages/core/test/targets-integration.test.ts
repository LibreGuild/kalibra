import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTarget, type TargetCallContext } from '../src/targets/index.js';
import { TargetSpec } from '../src/specs.js';
import type { BlobInfo, BlobStore } from '../src/storage.js';
import { startDemoServers, demoData, materializeRows, type DemoServers } from '../../demo/src/index.js';

/** In-memory blob store for executor tests. */
class MemoryBlobs implements BlobStore {
  files = new Map<string, { data: Buffer; info: BlobInfo }>();
  async put(data: Uint8Array, meta: { mime?: string; name?: string }) {
    const hash = createHash('sha256').update(data).digest('hex');
    const info = { hash, size: data.byteLength, mime: meta.mime ?? 'application/octet-stream', name: meta.name };
    this.files.set(hash, { data: Buffer.from(data), info });
    return info;
  }
  async get(hash: string) {
    return this.files.get(hash)!.data;
  }
  info(hash: string) {
    return this.files.get(hash)?.info;
  }
  has(hash: string) {
    return this.files.has(hash);
  }
  stream(hash: string) {
    return Readable.from(this.files.get(hash)!.data);
  }
}

const blobs = new MemoryBlobs();
const secrets: Record<string, string> = { demo_token: 'tok-12345' };

function ctxFor(row: Record<string, unknown>, vars: Record<string, string>): TargetCallContext {
  return {
    row,
    rowId: 'row_test',
    vars,
    env: { secret: async (n) => secrets[n], loadFile: async (v) => blobs.get(v.blob) },
    blobs,
    llm: {
      text: async () => ({ text: 'stub', latencyMs: 1, model: 'stub' }),
      json: async () => ({ value: {} as any, latencyMs: 1, model: 'stub' }),
    },
    signal: new AbortController().signal,
    log: () => undefined,
    workspaceDir: process.cwd(),
  };
}

const varsOf = (spec: TargetSpec) => Object.fromEntries(spec.variables.map((v) => [v.key, v.value]));

let servers: DemoServers;
let data: ReturnType<typeof demoData>;
let audioRows: { data: Record<string, unknown> }[];

beforeAll(async () => {
  servers = await startDemoServers({ port: 0 });
  data = demoData({ baseUrl: servers.url, wsUrl: servers.wsUrl, fixtures: servers.fixtures });
  audioRows = await materializeRows(data.datasets[1].rows, async (path) => {
    const info = await blobs.put(readFileSync(path), { mime: 'audio/wav', name: path.split('/').pop() });
    return { blob: info.hash, mime: info.mime, name: info.name, size: info.size };
  });
}, 60000);

afterAll(async () => {
  await servers?.close();
});

const target = (name: string) => TargetSpec.parse(data.targets.find((t) => t.name === name)!.spec);

describe('http executor against the demo chat API', () => {
  it('sends JSON with escaped placeholders and extracts outputs', async () => {
    const spec = target('Demo chat API');
    const row = { question: 'I lost my "debit" card, how do I block it?' };
    // Find a phrasing without a deterministic server quirk (500 / broken JSON / missing sources).
    let res = await executeTarget(spec, ctxFor(row, varsOf(spec)));
    expect(res.ok).toBe(true);
    expect(res.metrics.latency_ms).toBeGreaterThan(0);
    expect(res.metrics.ttfb_ms).toBeLessThanOrEqual(res.metrics.latency_ms);
    expect((res.request as any).body).toEqual({ message: row.question });
    if (res.response?.status === 200 && typeof res.response.body === 'object') {
      expect(String(res.outputs.output)).toMatch(/block/i);
    }
    res = await executeTarget(spec, ctxFor({ question: 'How do I check my balance?' }, varsOf(spec)));
    expect(res.ok).toBe(true);
  });

  it('runs beforeRequest/afterResponse hooks and masks secrets', async () => {
    const base = target('Demo chat API');
    const spec = TargetSpec.parse({
      ...base,
      config: {
        ...base.config,
        auth: { type: 'bearer', token: '{{secret.demo_token}}' },
        headers: [{ key: 'X-Trace', value: 'id-{{secret.demo_token}}', enabled: true }],
        scripts: {
          beforeRequest: "request.headers['X-Signed'] = 'yes'; return request;",
          afterResponse: 'return { status_copy: response.status, words: String(outputs.output ?? "").split(" ").length };',
        },
      },
    });
    const res = await executeTarget(spec, ctxFor({ question: 'What are your branch opening hours?' }, varsOf(spec)));
    expect(res.ok).toBe(true);
    const req = res.request as any;
    expect(req.headers['X-Signed']).toBe('yes');
    expect(req.headers.Authorization).toBe('Bearer ••••');
    expect(req.headers['X-Trace']).toBe('id-••••');
    expect(JSON.stringify(req)).not.toContain('tok-12345');
    expect(res.outputs.status_copy).toBe(res.response?.status);
  });

  it('reads SSE streams, concatenates deltas and measures TTFT', async () => {
    const spec = target('Demo chat API (streaming)');
    const res = await executeTarget(spec, ctxFor({ question: 'What is the daily transfer limit?' }, varsOf(spec)));
    expect(res.ok).toBe(true);
    expect(String(res.outputs.output)).toContain('daily transfer limit');
    expect(res.metrics.ttft_ms).toBeGreaterThan(0);
    expect(res.metrics.event_count).toBeGreaterThan(5);
  });

  it('reports connection failures as retryable errors', async () => {
    const spec = TargetSpec.parse({ config: { kind: 'http', url: 'http://127.0.0.1:1/nothing', timeoutMs: 2000 } });
    const res = await executeTarget(spec, ctxFor({}, {}));
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
    expect(res.error).toMatch(/ECONNREFUSED|fetch failed/);
  });
});

describe('speech-to-text executors against the demo services', () => {
  it('uploads audio as multipart and gets a transcript', async () => {
    const spec = target('Demo STT (batch upload)');
    const row = audioRows[0].data;
    const res = await executeTarget(spec, ctxFor(row, varsOf(spec)));
    expect(res.ok).toBe(true);
    expect(res.response?.status).toBe(200);
    expect(typeof res.outputs.output).toBe('string');
    expect(String(res.outputs.output).split(' ').length).toBeGreaterThan(3);
    expect((res.request as any).body.multipart[0]).toMatchObject({ name: 'file', type: 'audio/wav' });
  });

  it('streams binary PCM over WebSocket and collects partials and a final', async () => {
    const spec = target('Demo STT (streaming, binary frames)');
    // Faster than real time keeps the test quick while exercising pacing.
    (spec.config as any).audio.speed = 4;
    const row = audioRows[1].data;
    const res = await executeTarget(spec, ctxFor(row, varsOf(spec)));
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.metrics.final_count).toBe(1);
    expect(res.metrics.partial_count).toBeGreaterThan(0);
    expect(res.metrics.final_latency_ms).toBeGreaterThanOrEqual(100);
    expect(res.metrics.first_partial_ms).toBeGreaterThan(0);
    expect(res.metrics.audio_ms).toBeGreaterThan(500);
    const fixture = servers.fixtures[1];
    if (!fixture.synthetic) {
      // The mock recognizes the clip by its PCM, so the transcript is close to the reference.
      const ref = fixture.text.split(' ');
      const hyp = String(res.outputs.output).split(' ');
      expect(Math.abs(ref.length - hyp.length)).toBeLessThanOrEqual(1);
    }
    const kinds = new Set(res.response!.messages!.map((m) => m.kind));
    expect(kinds.has('audio_start')).toBe(true);
    expect(kinds.has('audio_end')).toBe(true);
  }, 30000);

  it('streams base64 JSON frames as fast as possible', async () => {
    const spec = target('Demo STT (streaming, base64 JSON frames)');
    (spec.config as any).audio.pacing = 'fast';
    const res = await executeTarget(spec, ctxFor(audioRows[2].data, varsOf(spec)));
    expect(res.error).toBeUndefined();
    expect(res.metrics.final_count).toBe(1);
    expect(String(res.outputs.output).length).toBeGreaterThan(0);
  }, 30000);

  it('supports full-control session scripts', async () => {
    const base = target('Demo STT (streaming, binary frames)');
    const spec = TargetSpec.parse({
      ...base,
      config: {
        ...base.config,
        audio: { ...(base.config as any).audio, pacing: 'fast' },
        scripts: {
          onMessage: '',
          session: `
            send({ type: 'start', sample_rate: 16000, encoding: 'pcm_s16le' });
            await nextMessage(2000);
            mark('audio_started');
            await sendAudio();
            send({ type: 'stop' });
            let msg;
            while ((msg = await nextMessage(5000))) { if (msg.is_final) break; }
            return { output: msg ? msg.text : '', metrics: { custom_metric: 42 } };
          `,
        },
      },
    });
    const res = await executeTarget(spec, ctxFor(audioRows[3].data, varsOf(spec)));
    expect(res.error).toBeUndefined();
    expect(String(res.outputs.output).length).toBeGreaterThan(0);
    expect(res.metrics.custom_metric).toBe(42);
    expect(res.metrics.audio_started).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('fails clearly when the WebSocket handshake is rejected', async () => {
    const base = target('Demo STT (streaming, binary frames)');
    const spec = TargetSpec.parse({ ...base, config: { ...base.config, url: '{{vars.ws_url}}/ws/missing' } });
    const res = await executeTarget(spec, ctxFor(audioRows[0].data, varsOf(spec)));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/404/);
  });
});

describe('script target', () => {
  it('runs user code with fetch and returns outputs and metrics', async () => {
    const spec = TargetSpec.parse({
      variables: [{ key: 'base_url', value: servers.url }],
      config: {
        kind: 'script',
        code: `
          const res = await fetch(vars.base_url + '/api/health');
          const body = await res.json();
          console.log('fixtures', body.fixtures);
          return { output: 'ok:' + row.name, fixtures: body.fixtures, metrics: { extra: 1 } };
        `,
      },
    });
    const res = await executeTarget(spec, ctxFor({ name: 'abc' }, varsOf(spec)));
    expect(res.ok).toBe(true);
    expect(res.outputs.output).toBe('ok:abc');
    expect(res.outputs.fixtures).toBe(12);
    expect(res.metrics.extra).toBe(1);
  });
});
