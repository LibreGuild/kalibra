import { describe, expect, it } from 'vitest';
import { getCheckType, describeCheckTypes } from '../src/checks/index.js';
import { matchesPartially, toolCallsOf } from '../src/checks/agents.js';
import { sourcesOf } from '../src/checks/rag.js';

const ctx = (scope: Record<string, unknown>, llmJson?: (req: any) => any) => ({
  scope,
  env: {},
  llm: { json: async (req: any) => ({ value: llmJson?.(req), latencyMs: 1, model: 'stub' }) } as any,
  log: () => {},
  workspaceDir: '.',
  signal: new AbortController().signal,
});
const run = (type: string, cfg: Record<string, unknown>, scope: Record<string, unknown>, llmJson?: (req: any) => any) => getCheckType(type)!.run(cfg, ctx(scope, llmJson));

const steps = [
  { name: 'plan', kind: 'llm', input: 'refund A12', output: 'call find_order' },
  { name: 'find_order', kind: 'tool', input: { order_id: 'A12' }, output: { total: 40 } },
  { name: 'search_kb', kind: 'retrieval', input: 'refund policy', output: [{ id: 'kb-1', text: 'Refunds within 30 days.' }, { id: 'kb-9', text: 'Shipping is free.' }] },
  { name: 'refund_order', kind: 'tool', input: { order_id: 'A12', amount: 40, notify: { email: true, sms: false } } },
  { name: 'answer', kind: 'llm', output: 'Refunded order A12 [kb-1].' },
];

describe('where agent facts come from', () => {
  it('reads tool calls from the scope, from outputs (also OpenAI shape and JSON text), or from tool steps', () => {
    expect(toolCallsOf({ tool_calls: [{ name: 'a', args: { x: 1 } }] })).toEqual([{ name: 'a', args: { x: 1 }, output: undefined, error: undefined }]);
    expect(toolCallsOf({ outputs: { tool_calls: JSON.stringify([{ function: { name: 'b', arguments: '{"y":2}' } }]) } })![0]).toMatchObject({ name: 'b', args: { y: 2 } });
    expect(toolCallsOf({ steps })!.map((c) => c.name)).toEqual(['find_order', 'refund_order']);
    expect(toolCallsOf({ outputs: { output: 'hi' } })).toBeUndefined();
  });

  it('reads retrieved documents from the scope, outputs (wrappers, strings) or retrieval steps', () => {
    expect(sourcesOf({ steps })!.map((s) => s.id)).toEqual(['kb-1', 'kb-9']);
    expect(sourcesOf({ outputs: { sources: { documents: [{ page_content: 'x', metadata: { source: 'a.md' } }] } } })).toEqual([{ id: 'a.md', text: 'x' }]);
    expect(sourcesOf({ sources: ['first text', 'second'] })).toEqual([{ id: '1', text: 'first text' }, { id: '2', text: 'second' }]);
    expect(sourcesOf({ outputs: {} })).toBeUndefined();
  });

  it('matches arguments partially', () => {
    expect(matchesPartially({ a: 1, b: { c: 'x', d: 2 } }, { b: { c: 'x' } })).toBe(true);
    expect(matchesPartially({ a: 12 }, { a: '12' })).toBe(true);
    expect(matchesPartially({ tags: ['x', 'y'] }, { tags: ['y'] })).toBe(true);
    expect(matchesPartially({ a: 1 }, { a: 2 })).toBe(false);
    expect(matchesPartially({ a: { b: 1 } }, { a: 'x' })).toBe(false);
    expect(matchesPartially('{"a":1}', { a: 1 })).toBe(true);
  });
});

describe('agent checks', () => {
  it('tool_called with templated partial args and min/max', async () => {
    const scope = { steps, order_id: 'A12' };
    expect((await run('tool_called', { name: 'refund_order', args: '{"order_id": "{{order_id}}", "notify": {"email": true}}' }, scope)).status).toBe('pass');
    const wrong = await run('tool_called', { name: 'refund_order', args: '{"order_id": "B7"}' }, scope);
    expect(wrong.status).toBe('fail');
    expect(wrong.reason).toMatch(/arguments differ/);
    const missing = await run('tool_called', { name: 'cancel_order' }, scope);
    expect(missing.reason).toMatch(/not called \(called: find_order, refund_order\)/);
    expect((await run('tool_called', { name: 'refund_order', min: 0, max: 0 }, scope)).status).toBe('fail');
    expect((await run('tool_called', { name: 'refund_order', args: '{bad' }, scope)).reason).toMatch(/not valid JSON/);
  });

  it('tool_not_called, tool_order and step_limits', async () => {
    expect((await run('tool_not_called', { names: ['delete_account'] }, { steps })).status).toBe('pass');
    expect((await run('tool_not_called', { names: ['refund_order'] }, { steps })).reason).toBe('Called refund_order');
    expect((await run('tool_order', { sequence: ['find_order', 'refund_order'] }, { steps })).status).toBe('pass');
    const order = await run('tool_order', { sequence: ['refund_order', 'find_order'] }, { steps });
    expect(order.status).toBe('fail');
    expect(order.reason).toMatch(/Missing "find_order" after refund_order/);
    expect((await run('step_limits', { maxSteps: 5, maxLlmCalls: 2 }, { steps })).status).toBe('pass');
    expect((await run('step_limits', { maxLlmCalls: 1, maxToolCalls: 1 }, { steps })).reason).toBe('2 model calls (max 1), 2 tool calls (max 1)');
  });

  it('skip with a hint when the app reported no tools or steps, and treat an empty list as no calls', async () => {
    for (const [type, cfg] of [['tool_called', { name: 'x' }], ['tool_not_called', { names: ['x'] }], ['tool_order', { sequence: ['a', 'b'] }], ['step_limits', { maxSteps: 3 }]] as const) {
      const r = await run(type, cfg, { outputs: { output: 'hi' } });
      expect(r.status, type).toBe('skip');
      expect(r.reason).toMatch(/Kalibra SDK/);
    }
    expect((await run('tool_called', { name: 'x' }, { tool_calls: [] })).status).toBe('fail');
  });
});

describe('RAG checks', () => {
  it('retrieval_recall from a list or comma-separated column, with k', async () => {
    expect((await run('retrieval_recall', {}, { steps, expected_sources: ['kb-1'] })).status).toBe('pass');
    const half = await run('retrieval_recall', { min: 1 }, { steps, expected_sources: 'kb-1, kb-4' });
    expect(half).toMatchObject({ status: 'fail', score: 0.5 });
    expect(half.reason).toMatch(/missing kb-4/);
    expect((await run('retrieval_recall', { min: 0.5 }, { steps, expected_sources: 'kb-1, kb-4' })).status).toBe('pass');
    expect((await run('retrieval_recall', { k: 1 }, { steps, expected_sources: 'kb-9' })).status).toBe('fail');
    expect((await run('retrieval_recall', {}, { steps, expected_sources: '' })).status).toBe('skip');
    expect((await run('retrieval_recall', {}, { expected_sources: 'kb-1' })).status).toBe('skip');
  });

  it('citations by pattern or field', async () => {
    expect((await run('citations', {}, { steps, output: 'See [kb-1].' })).status).toBe('pass');
    const made = await run('citations', {}, { steps, output: 'See [kb-1] and [kb-77].' });
    expect(made.status).toBe('fail');
    expect(made.reason).toMatch(/kb-77/);
    expect((await run('citations', { field: '{{outputs.cited}}' }, { steps, output: '', outputs: { cited: ['kb-9'] } })).status).toBe('pass');
    expect((await run('citations', {}, { steps, output: 'No refs.' })).status).toBe('skip');
    expect((await run('citations', { required: true }, { steps, output: 'No refs.' })).status).toBe('fail');
    expect((await run('citations', { pattern: '([' }, { steps, output: 'x' })).reason).toMatch(/not a valid regular expression/);
  });

  it('grounded asks the judge per claim and scores the supported share', async () => {
    let prompt = '';
    const judge = (req: any) => {
      prompt = req.prompt;
      return { claims: [{ claim: 'Refunds within 30 days', supported: true, source: 'kb-1' }, { claim: 'Refund arrives in 1 hour', supported: false }] };
    };
    const r = await run('grounded', { connectionId: 'c' }, { steps, output: 'Refunds within 30 days and arrive in 1 hour.' }, judge);
    expect(r).toMatchObject({ status: 'fail', score: 0.5 });
    expect(r.reason).toMatch(/1 of 2 claims unsupported/);
    expect(prompt).toContain('[kb-1] Refunds within 30 days.');
    expect((await run('grounded', { connectionId: 'c', min: 0.5 }, { steps, output: 'x' }, judge)).status).toBe('pass');
    expect((await run('grounded', { connectionId: 'c' }, { steps, output: 'Hello!' }, () => ({ claims: [] }))).status).toBe('pass');
    expect((await run('grounded', {}, { steps, output: 'x' })).reason).toMatch(/judge connection/);
    expect((await run('grounded', { connectionId: 'c' }, { output: 'x' })).status).toBe('skip');
    expect((await run('grounded', { connectionId: 'c' }, { sources: [], output: 'x' })).status).toBe('fail');
  });
});

describe('catalogue', () => {
  it('lists the new checks under Agents & RAG with defaults and form fields', () => {
    const cat = describeCheckTypes().filter((c) => c.category === 'agents');
    expect(cat.map((c) => c.type).sort()).toEqual(['citations', 'grounded', 'retrieval_recall', 'step_limits', 'tool_called', 'tool_not_called', 'tool_order']);
    for (const c of cat) expect(c.fields.length, c.type).toBeGreaterThan(0);
  });
});
