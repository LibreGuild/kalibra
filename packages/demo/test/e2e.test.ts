import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '@kalibra/core';
import { startDemoServers, type DemoServers } from '../src/servers.js';
import { seedWorkspace } from '../src/seed.js';

/** Full path: seed through operations → run each demo target → summaries make sense. */
describe('engine end to end against the demo apps', () => {
  let engine: Engine;
  let servers: DemoServers;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-e2e-'));
    engine = await Engine.open({ dir });
    servers = await startDemoServers({ port: 0 });
    await seedWorkspace((n, i) => engine.call(n, i), { baseUrl: servers.url, wsUrl: servers.wsUrl, fixtures: servers.fixtures });
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    await servers?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (dataset: string, target: string, suite: string) => {
    const started = await engine.call('start_run', { dataset, target, suite, settings: { concurrency: 4, retries: 0 } });
    return engine.runner.wait(started.id);
  };

  it('scores the JSON chat API with gates and conditional checks', async () => {
    const r = await run('Support questions', 'Demo chat API', 'Chat API checks');
    expect(r.status).toBe('completed');
    expect(r.summary.completed).toBe(r.total);
    expect(r.summary.passRate).toBeGreaterThan(0);
    expect(r.summary.passRate).toBeLessThan(1); // the demo bot has deliberate failures
    const ids = r.summary.checks.map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['status', 'schema', 'mentions']));
    expect(r.summary.metrics.latency_ms.count).toBe(r.total);
  }, 120_000);

  it('computes corpus WER for batch speech-to-text', async () => {
    const r = await run('Voice commands', 'Demo STT (batch upload)', 'STT checks (batch)');
    expect(r.status).toBe('completed');
    const wer = r.summary.checks.find((c: any) => c.id === 'wer');
    expect(wer.corpus.refUnits).toBeGreaterThan(0);
    expect(wer.corpus.value).toBeGreaterThanOrEqual(0);
    expect(wer.corpus.value).toBeLessThan(0.5);
  }, 120_000);

  it('streams audio over WebSocket and records streaming latency', async () => {
    const targets = await engine.call<any[]>('list_targets', {});
    const ws = targets.find((t) => t.spec.config.kind === 'websocket');
    // speed up pacing for the test
    await engine.call('update_target', { id: ws.id, spec: { ...ws.spec, config: { ...ws.spec.config, audio: { ...ws.spec.config.audio, speed: 4 } } } });
    const r = await run('Voice commands', ws.name, 'STT checks (streaming)');
    expect(r.status).toBe('completed');
    expect(r.summary.targetErrors).toBe(0);
    expect(r.summary.metrics.first_partial_ms?.count).toBeGreaterThan(0);
    expect(r.summary.metrics.final_latency_ms?.count).toBe(r.total);
    const wer = r.summary.checks.find((c: any) => c.id === 'wer');
    expect(wer.corpus.value).toBeLessThan(0.5);
  }, 180_000);

  it('runs scripted multi-turn conversations against the session bot', async () => {
    const started = await engine.call('start_run', {
      dataset: 'Support conversations',
      target: 'Demo chat (session)',
      suite: 'Conversation checks',
      settings: { concurrency: 3, retries: 0, conversation: { mode: 'scripted' } },
    });
    const r = await engine.runner.wait(started.id);
    expect(r.status).toBe('completed');
    expect(r.summary.targetErrors).toBe(0);
    expect(r.summary.passRate).toBe(1);
    expect(r.summary.metrics.turns.count).toBe(r.total);
    expect(r.summary.metrics.turn_latency_ms.mean).toBeGreaterThan(0);
  }, 120_000);

  it('compares two targets on the same dataset', async () => {
    const c = await engine.call<any>('start_comparison', {
      dataset: 'Support questions',
      suite: 'Chat API checks',
      variants: [{ target: 'Demo chat API' }, { target: 'Demo chat API (streaming)' }],
      settings: { concurrency: 4, retries: 0 },
    });
    let cmp: any;
    for (let i = 0; i < 600; i++) {
      cmp = await engine.call('get_comparison', { id: c.id });
      if (cmp.status !== 'running') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(cmp.status).toBe('completed');
    expect(cmp.variants).toHaveLength(2);
    expect(cmp.variants.filter((v: any) => v.isBest)).toHaveLength(1);
    const rows = await engine.call<any>('compare_rows', { id: c.id, filter: 'all' });
    expect(rows.total).toBe(16);
  }, 180_000);

  it('scores outputs imported from a file and compares runs', async () => {
    const rows = await engine.call<any>('list_rows', { dataset: 'Support questions', limit: 100 });
    const csv = ['row_id,output', ...rows.rows.map((r: any) => `${r.id},"Please call 1800-123-456 or block it in the app"`)].join('\n');
    const file = await engine.call<any>('upload_file', { name: 'outputs.csv', base64: Buffer.from(csv).toString('base64') });
    const res = await engine.call<any>('import_outputs', { dataset: 'Support questions', suite: 'Chat API checks', blob: file.hash });
    expect(res.matched).toBe(rows.rows.length);
    const done = await engine.runner.wait(res.run.id);
    expect(done.status).toBe('completed');
    const live = (await engine.call<any>('list_runs', { dataset: 'Support questions' })).runs.find((r: any) => r.kind === 'live');
    const cmp = await engine.call<any>('compare_runs', { baseRunId: live.id, runId: done.id });
    expect(cmp.rows.length).toBe(rows.rows.length);
  }, 120_000);

  it('validates agent-added rows and marks them for review', async () => {
    const res = await engine.call<any>(
      'add_dataset_rows',
      { dataset: 'Support questions', rows: [{ data: { question: 'Can I close my account online?', expected_behavior: 'answer' } }, { data: { expected_behavior: 'maybe' } }] },
      { kind: 'agent', id: 'claude-code', client: 'claude-code' },
    );
    expect(res.added).toHaveLength(1);
    expect(res.rejected[0].errors.join(' ')).toMatch(/question: required|must be one of/);
    const row = await engine.call<any>('list_rows', { dataset: 'Support questions', status: ['needs_review'] });
    expect(row.rows[0].provenance.client).toBe('claude-code');
  });
});
