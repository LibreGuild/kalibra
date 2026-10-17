import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { TargetSpec } from '../src/specs.js';

describe('playground', () => {
  let engine: Engine;
  let dir: string;
  let conA = '';
  let conB = '';
  const seen: any[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-playground-'));
    engine = await Engine.open({ dir });
    conA = (await engine.call<any>('create_connection', { name: 'A', spec: { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'a-model' } })).id;
    conB = (await engine.call<any>('create_connection', { name: 'B', spec: { provider: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'b-model' } })).id;
    await engine.call('create_dataset', { name: 'Docs', columns: [{ key: 'text', type: 'text' }, { key: 'expected', type: 'text' }, { key: 'image', type: 'image' }] });
    const png = await engine.blobs.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), { name: 'pic.png', mime: 'image/png' });
    await engine.call('add_dataset_rows', {
      dataset: 'Docs',
      rows: [
        { data: { text: 'alpha', expected: 'ALPHA', image: { blob: png.hash, name: 'pic.png', mime: 'image/png' } } },
        { data: { text: 'beta', expected: 'BETA' } },
        { data: { text: 'gamma', expected: 'GAMMA' } },
      ],
    });
    await engine.call('create_suite', { name: 'Upper', spec: { checks: [{ id: 'eq', type: 'equals', config: { actual: '{{output}}', expected: '{{expected}}' } }] } });

    (engine as any).llm = {
      text: async (req: any) => {
        seen.push(req);
        if (req.connectionId === conB && req.prompt.includes('beta')) throw new Error('rate limited');
        const word = /Upper: (\w+)/.exec(req.prompt)?.[1] ?? '';
        return { text: req.connectionId === conA ? word.toUpperCase() : word, latencyMs: 5, model: req.model ?? 'm', inputTokens: 3, outputTokens: 1 };
      },
    };
  });

  afterAll(async () => {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a single typed-in row synchronously', async () => {
    const r = await engine.call<any>('playground_run', { system: 'Be terse', prompt: 'Upper: {{word}}', variants: [{ connectionId: conA }], values: [{ word: 'hi' }] });
    expect(r.jobId).toBeUndefined();
    expect(r.result.rows[0].cells[0].output).toBe('HI');
    expect(seen.at(-1).system).toBe('Be terse');
  });

  it('runs dataset rows × variants as a job, scores with a suite, and isolates per-cell errors', async () => {
    const { jobId } = await engine.call<any>('playground_run', { prompt: 'Upper: {{text}}', variants: [{ connectionId: conA }, { connectionId: conB, temperature: 0 }], dataset: 'Docs', limit: 3, suite: 'Upper' });
    const job = await engine.jobs.wait(jobId, 10);
    expect(job.status).toBe('completed');
    const res = job.result as any;
    expect(res.rows).toHaveLength(3);
    expect(res.rows.every((r: any) => r.cells.length === 2 && r.cells[0].variant === 0)).toBe(true);
    const [va, vb] = res.variants;
    expect(va.passRate).toBe(1);
    expect(vb.passRate).toBe(0);
    expect(vb.errors).toBe(1);
    expect(res.rows[1].cells[1].error).toMatch(/rate limited/);
    expect(res.rows[0].cells[0].checks[0].status).toBe('pass');
    expect(va.label).toBe('A');
  });

  it('attaches image columns used by the prompt instead of inlining them', async () => {
    seen.length = 0;
    const row = (await engine.repos.datasets.listRows((await engine.repos.datasets.get('Docs')).id, { limit: 1 })).rows[0];
    await engine.call<any>('playground_run', { prompt: 'Upper: {{text}} — describe {{image}}', variants: [{ connectionId: conA }], dataset: 'Docs', rowIds: [row.id] });
    const req = seen.at(-1);
    expect(req.files).toHaveLength(1);
    expect(req.files[0].mime).toBe('image/png');
    expect(req.prompt).toContain('[attached file: pic.png]');
    expect(req.prompt).not.toContain('"blob"');
  });

  it('validates sources and limits', async () => {
    await expect(engine.call('playground_run', { prompt: 'x', variants: [{ connectionId: conA }] })).rejects.toThrow(/dataset or type in/);
    await expect(engine.call('playground_run', { prompt: 'x', variants: [{ connectionId: conA }], dataset: 'Docs', values: [{ a: 1 }] })).rejects.toThrow(/not both/);
    await expect(engine.call('playground_run', { prompt: 'x', variants: [{ connectionId: conA }], values: Array.from({ length: 26 }, () => ({})) })).rejects.toThrow();
    await expect(engine.call('playground_run', { prompt: 'x', variants: Array.from({ length: 5 }, () => ({ connectionId: conA })), values: [{}] })).rejects.toThrow();
    await expect(engine.call('playground_run', { prompt: 'x', variants: [{ connectionId: 'nope' }], values: [{}] })).rejects.toThrow(/not found/);
    await expect(engine.call('playground_run', { prompt: '', variants: [{ connectionId: conA }], values: [{}] })).rejects.toThrow();
  });

  it('saves a playground prompt as a valid model target', async () => {
    const t = await engine.call<any>('save_playground_target', { name: 'Upper v1', system: 'Be terse', prompt: 'Upper: {{text}}', connectionId: conA, model: 'a-model', temperature: 0.2 });
    const spec = TargetSpec.parse(t.spec);
    expect(spec.config.kind).toBe('model');
    expect((spec.config as any).task).toBe('text');
    expect((spec.config as any).temperature).toBe(0.2);
    await expect(engine.call('save_playground_target', { name: 'Upper v1', prompt: 'x', connectionId: conA })).rejects.toThrow(/already exists/);
  });
});
