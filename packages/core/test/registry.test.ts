import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';

/*
 * Parity guard: the UI, CLI and MCP all come from the operation registry. Every operation must be
 * describable as a tool (JSON Schema object input, a real description) and secret handling must
 * never be exposed to agents.
 */
describe('operation registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kalibra-registry-'));
  const engine = new Engine({ dir });
  afterAll(() => {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ops = engine.registry.describe();

  it('describes every operation as a valid tool', () => {
    expect(ops.length).toBeGreaterThan(50);
    for (const op of ops) {
      expect(op.name, op.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(op.title.length, `${op.name} title`).toBeGreaterThan(3);
      expect(op.description.length, `${op.name} description`).toBeGreaterThan(20);
      expect((op.inputSchema as any).type, `${op.name} input schema`).toBe('object');
    }
  });

  it('has unique names', () => {
    const names = ops.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never exposes secret values to agents', () => {
    const exposed = ops.filter((o) => o.mcp).map((o) => o.name);
    expect(exposed).not.toContain('set_secret');
    expect(exposed).not.toContain('delete_secret');
    expect(exposed).toContain('list_secrets'); // names only
  });

  it('marks destructive operations so agents ask first', () => {
    const destructive = ops.filter((o) => o.name.startsWith('delete_')).filter((o) => o.mcp);
    for (const op of destructive) expect(op.destructive, op.name).toBe(true);
  });

  it('rejects bad input with a readable error instead of crashing', async () => {
    await expect(engine.call('add_dataset_rows', { dataset: 'nope', rows: [] })).rejects.toThrow(/Invalid input|not found/);
    await expect(engine.call('no_such_op', {})).rejects.toThrow(/Unknown operation/);
  });
});
