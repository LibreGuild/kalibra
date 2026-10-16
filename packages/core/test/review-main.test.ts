import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { RunSettings } from '../src/specs.js';
import { evalExpression } from '../src/script.js';

const user = { kind: 'user' as const, id: 'local' };

describe('run status', () => {
  let engine: Engine;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kalibra-main-'));
    engine = new Engine({ dir });
    await engine.call('create_dataset', { name: 'Q', columns: [{ key: 'question', type: 'text' }] });
    await engine.call('add_dataset_rows', { dataset: 'Q', rows: [{ data: { question: 'hi' } }] });
  });
  afterAll(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('clears the old error when a failed run is resumed', () => {
    const ds = engine.repos.datasets.get('Q');
    const v = engine.repos.datasets.createVersion(ds.id, '', user);
    const run = engine.repos.runs.create({ kind: 'imported', datasetId: ds.id, datasetVersionId: v.id, suiteId: 'ste_x', suiteVersion: 1, settings: RunSettings.parse({}) }, user);
    engine.repos.runs.setStatus(run.id, 'failed', { error: 'disk full' });
    expect(engine.repos.runs.get(run.id).error).toBe('disk full');
    engine.repos.runs.setStatus(run.id, 'running');
    expect(engine.repos.runs.get(run.id).error).toBeNull();
    engine.repos.runs.setStatus(run.id, 'completed');
    expect(engine.repos.runs.get(run.id).error).toBeNull();
  });
});

describe('expression cache', () => {
  it('keeps evaluating correctly past the cache limit', () => {
    for (let i = 0; i < 1200; i++) expect(evalExpression(`n + ${i}`, { n: 1 })).toBe(1 + i);
  });
});
