import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../src/engine.js';
import { getCheckType } from '../src/checks/index.js';
import { scriptedTurns } from '../src/runner/conversation.js';
import type { LlmClient, LlmRequest } from '../src/providers/types.js';
import { startDemoServers, type DemoServers } from '../../demo/src/index.js';

/*
 * Multi-turn conversations: scripted turns against the demo session bot (real HTTP, session id
 * carried between turns), simulated users with a stubbed model, edge cases, and model targets
 * replaying history as chat messages.
 */

let engine: Engine;
let servers: DemoServers;
let dir: string;

const sessionSpec = (baseUrl: string) => ({
  variables: [{ key: 'base_url', value: baseUrl, enabled: true }],
  config: {
    kind: 'http',
    method: 'POST',
    url: '{{vars.base_url}}/api/chat/session',
    body: { type: 'json', content: '{"message": "{{message}}", "session_id": "{{session_id}}"}' },
    outputs: [
      { name: 'output', from: 'json', path: '$.answer' },
      { name: 'session_id', from: 'json', path: '$.session_id' },
    ],
  },
});

const scriptSpec = (code: string) => ({ config: { kind: 'script', code } });

async function runAndWait(input: Record<string, unknown>) {
  const run = await engine.call<any>('start_run', input);
  await engine.runner.wait(run.id, 20);
  const done = await engine.call<any>('get_run', { runId: run.id });
  const { results } = await engine.call<any>('query_results', { runId: run.id, limit: 100 });
  const full = await Promise.all(results.map((r: any) => engine.call<any>('get_result', { resultId: r.id })));
  return { run: done, results: full };
}

/** A stub model: `sim` answers simulated-user turns, `text` answers model-target prompts. */
function stubLlm(opts: { sim?: (req: any, n: number) => any; final?: any; text?: (req: LlmRequest) => string; calls?: LlmRequest[] }): LlmClient {
  let simCalls = 0;
  return {
    text: async (req) => {
      opts.calls?.push(req);
      return { text: opts.text ? opts.text(req) : 'ok', latencyMs: 1, model: 'stub' };
    },
    json: async (req: any) => {
      opts.calls?.push(req);
      if (req.schemaName === 'simulated_user_turn') return { value: opts.sim?.(req, simCalls++) ?? { message: '', done: true, goal_met: false, reason: '' }, latencyMs: 1, model: 'stub-sim' };
      return { value: opts.final ?? { goal_met: false, reason: 'not done' }, latencyMs: 1, model: 'stub-final' };
    },
    image: async () => ({ images: [], latencyMs: 1, model: 'stub' }),
    speech: async () => ({ audio: { data: new Uint8Array(), mime: 'audio/wav' }, latencyMs: 1, model: 'stub' }),
    transcribe: async () => ({ text: '', latencyMs: 1, model: 'stub' }),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kalibra-conv-'));
  engine = new Engine({ dir });
  servers = await startDemoServers({ port: 0 });
  await engine.call('create_dataset', {
    name: 'Convos',
    columns: [
      { key: 'turns', type: 'list' },
      { key: 'goal', type: 'text' },
      { key: 'persona', type: 'text' },
      { key: 'must_mention', type: 'list' },
    ],
  });
  await engine.call('add_dataset_rows', {
    dataset: 'Convos',
    rows: [
      { data: { turns: ['Hi, my name is Anita', 'I lost my debit card', 'debit', 'yes'], goal: 'Block the card', persona: 'calm', must_mention: ['blocked', 'Anita'] } },
      { data: { turns: ['My name is Rahul', 'Who am I?'], goal: 'Be remembered', persona: 'regular', must_mention: ['Rahul'] } },
      { data: { turns: [], goal: 'Nothing', persona: 'silent', must_mention: [] } },
    ],
  });
  await engine.call('create_target', { name: 'Session bot', spec: sessionSpec(servers.url) });
  await engine.call('create_suite', {
    name: 'Convo checks',
    spec: {
      checks: [
        { id: 'ok', type: 'no_error', gate: true, config: {} },
        { id: 'mentions', type: 'transcript_contains', config: { values: ['{{must_mention}}'], mode: 'all' } },
        { id: 'turns', type: 'turn_count', config: { min: 1, max: 5 } },
        { id: 'goal', type: 'goal_met', config: { source: 'simulator' } },
      ],
    },
  });
}, 60_000);

afterAll(async () => {
  engine?.close();
  await servers?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scriptedTurns', () => {
  it('accepts lists, messages arrays, JSON strings and plain lines', () => {
    expect(scriptedTurns(['a', ' ', 'b'])).toEqual(['a', 'b']);
    expect(scriptedTurns([{ role: 'system', content: 'x' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'bye' }])).toEqual(['hi', 'bye']);
    expect(scriptedTurns('["one","two"]')).toEqual(['one', 'two']);
    expect(scriptedTurns('first\nsecond')).toEqual(['first', 'second']);
    expect(scriptedTurns(undefined)).toEqual([]);
    expect(scriptedTurns('')).toEqual([]);
  });
});

describe('scripted conversations against the demo session bot', () => {
  it('carries the session id, keeps memory, records per-turn latency and scores the final state', async () => {
    const { run, results } = await runAndWait({ dataset: 'Convos', target: 'Session bot', suite: 'Convo checks', settings: { conversation: { mode: 'scripted' }, retries: 0 } });
    expect(run.status).toBe('completed');
    const anita = results.find((r: any) => r.input.persona === 'calm');
    const t = anita.outputs.transcript;
    expect(t.map((e: any) => e.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(anita.outputs.session_id).toMatch(/^sess_/);
    expect(anita.outputs.output).toMatch(/Done, Anita\. Your debit card is blocked/);
    expect(anita.outputs.stop_reason).toBe('script_done');
    expect(anita.metrics.turns).toBe(4);
    expect(anita.metrics.turn_latency_ms).toBeGreaterThan(0);
    expect(anita.metrics.turn_latency_max_ms).toBeGreaterThanOrEqual(anita.metrics.turn_latency_ms);
    expect(t.filter((e: any) => e.role === 'assistant').every((e: any) => typeof e.latency_ms === 'number')).toBe(true);
    expect(anita.checks.find((c: any) => c.id === 'mentions').status).toBe('pass');
    expect(anita.checks.find((c: any) => c.id === 'goal').status).toBe('skip'); // scripted: no simulator verdict
    expect(anita.passed).toBe(true);

    const rahul = results.find((r: any) => r.input.persona === 'regular');
    expect(rahul.outputs.output).toBe('You told me your name is Rahul.');
  }, 60_000);

  it('turns an empty turns column into a clear error result instead of crashing the run', async () => {
    const { run, results } = await runAndWait({ dataset: 'Convos', target: 'Session bot', suite: 'Convo checks', settings: { conversation: { mode: 'scripted' }, retries: 0 } });
    expect(run.status).toBe('completed');
    const empty = results.find((r: any) => r.input.persona === 'silent');
    expect(empty.status).toBe('error');
    expect(empty.error).toMatch(/No user turns found/);
    expect(empty.passed).toBe(false);
  }, 60_000);

  it('uses a custom turns column and passes history to the target', async () => {
    await engine.call('create_target', { name: 'History echo', spec: scriptSpec('return { output: `turn ${row.turn}: saw ${row.history.length} earlier messages, conv ${row.conversation_id ? "yes" : "no"}` };') });
    const res = await engine.call<any>('test_conversation', { target: 'History echo', values: { lines: ['a', 'b', 'c'] }, conversation: { mode: 'scripted', turnsColumn: 'lines' } });
    expect(res.ok).toBe(true);
    expect(res.outputs.transcript.filter((e: any) => e.role === 'assistant').map((e: any) => e.content)).toEqual([
      'turn 1: saw 0 earlier messages, conv yes',
      'turn 2: saw 2 earlier messages, conv yes',
      'turn 3: saw 4 earlier messages, conv yes',
    ]);
  });

  it('rejects mode "off" in test_conversation', async () => {
    await expect(engine.call('test_conversation', { target: 'History echo', values: { turns: ['x'] }, conversation: { mode: 'off' } })).rejects.toThrow(/scripted|simulated/);
  });
});

describe('simulated users (stubbed model)', () => {
  const original = () => (engine as any).llm;
  let saved: LlmClient;
  beforeAll(() => {
    saved = original();
  });
  afterAll(() => {
    (engine as any).llm = saved;
  });

  const conv = (extra: Record<string, unknown> = {}) => ({ mode: 'simulated', connectionId: 'stub', personaTemplate: '{{persona}}', goalTemplate: '{{goal}}', maxTurns: 3, ...extra });

  it('stops immediately when the simulated user is done on its first turn', async () => {
    (engine as any).llm = stubLlm({ sim: () => ({ message: '', done: true, goal_met: true, reason: 'nothing to do' }) });
    const res = await engine.call<any>('test_conversation', { target: 'Session bot', values: { persona: 'p', goal: 'g' }, conversation: conv() });
    expect(res.ok).toBe(true);
    expect(res.outputs.transcript).toEqual([]);
    expect(res.outputs.stop_reason).toBe('goal_met');
    expect(res.outputs.goal_met).toBe(true);
  });

  it('runs up to maxTurns, then asks once whether the goal was met', async () => {
    const calls: any[] = [];
    (engine as any).llm = stubLlm({ calls, sim: (_r, n) => ({ message: `message ${n + 1}`, done: false, goal_met: false, reason: '' }), final: { goal_met: false, reason: 'never got there' } });
    const res = await engine.call<any>('test_conversation', { target: 'Session bot', values: { persona: 'p', goal: 'g' }, conversation: conv({ maxTurns: 3 }) });
    expect(res.outputs.turns).toBe(3);
    expect(res.outputs.stop_reason).toBe('max_turns');
    expect(res.outputs.goal_met).toBe(false);
    expect(res.outputs.simulator_reason).toBe('never got there');
    // the simulator sees the persona and goal, and later turns see the transcript so far
    expect(calls[0].prompt).toMatch(/Persona: p[\s\S]*Goal: g/);
    expect(calls[1].prompt).toMatch(/Conversation so far:[\s\S]*User: message 1/);
  });

  it('ends on the stop phrase', async () => {
    await engine.call('create_target', { name: 'Says goodbye', spec: scriptSpec('return { output: row.turn >= 2 ? "Goodbye and thanks!" : "How can I help?" };') });
    (engine as any).llm = stubLlm({ sim: (_r, n) => ({ message: `hi ${n}`, done: false, goal_met: false, reason: '' }) });
    const res = await engine.call<any>('test_conversation', { target: 'Says goodbye', values: {}, conversation: conv({ maxTurns: 6, stopPhrase: 'GOODBYE' }) });
    expect(res.outputs.stop_reason).toBe('stop_phrase');
    expect(res.outputs.turns).toBe(2);
  });

  it('keeps the partial transcript when the target fails mid-way', async () => {
    await engine.call('create_target', { name: 'Breaks on turn 2', spec: scriptSpec('if (row.turn === 2) throw new Error("backend down"); return { output: "fine" };') });
    (engine as any).llm = stubLlm({ sim: (_r, n) => ({ message: `q${n}`, done: false, goal_met: false, reason: '' }) });
    const res = await engine.call<any>('test_conversation', { target: 'Breaks on turn 2', values: {}, conversation: conv({ maxTurns: 5 }) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Turn 2: .*backend down/);
    expect(res.outputs.stop_reason).toBe('error');
    expect(res.outputs.transcript.map((e: any) => e.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('explains a missing simulator connection', async () => {
    const res = await engine.call<any>('test_conversation', { target: 'Session bot', values: {}, conversation: { mode: 'simulated', connectionId: '' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connection to play the simulated user/);
  });

  it('feeds the simulator verdict to the goal_met check in a run', async () => {
    (engine as any).llm = stubLlm({ sim: (_r, n) => (n < 1 ? { message: 'block my debit card', done: false, goal_met: false, reason: '' } : { message: '', done: true, goal_met: true, reason: 'card blocked' }) });
    const { results } = await runAndWait({ dataset: 'Convos', target: 'Session bot', suite: 'Convo checks', settings: { rowIds: undefined, limit: 1, conversation: conv({ maxTurns: 4 }), retries: 0 } });
    const r = results[0];
    expect(r.outputs.goal_met).toBe(true);
    const goal = r.checks.find((c: any) => c.id === 'goal');
    expect(goal.status).toBe('pass');
    expect(goal.reason).toMatch(/card blocked/);
  }, 60_000);
});

describe('model targets replay history as chat messages', () => {
  it('sends earlier turns as messages and the new user message as the prompt', async () => {
    const saved = (engine as any).llm;
    const calls: LlmRequest[] = [];
    (engine as any).llm = stubLlm({ calls, text: (req) => `echo: ${req.prompt}` });
    try {
      await engine.call('create_target', { name: 'Model chat', spec: { config: { kind: 'model', connectionId: 'stub', model: 'm', system: 'Be brief', prompt: '{{input}}' } } });
      const res = await engine.call<any>('test_conversation', { target: 'Model chat', values: { turns: ['hello', 'and again'] }, conversation: { mode: 'scripted' } });
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].prompt).toBe('hello');
      expect(calls[0].messages).toEqual([]);
      expect(calls[1].prompt).toBe('and again');
      expect(calls[1].messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'echo: hello' },
      ]);
      expect(calls[1].system).toBe('Be brief');
    } finally {
      (engine as any).llm = saved;
    }
  });

  it('still renders the prompt template when it refers to {{message}}', async () => {
    const saved = (engine as any).llm;
    const calls: LlmRequest[] = [];
    (engine as any).llm = stubLlm({ calls });
    try {
      await engine.call('create_target', { name: 'Model chat tpl', spec: { config: { kind: 'model', connectionId: 'stub', model: 'm', prompt: 'Customer says: {{message}}' } } });
      await engine.call('test_conversation', { target: 'Model chat tpl', values: { turns: ['hi'] }, conversation: { mode: 'scripted' } });
      expect(calls[0].prompt).toBe('Customer says: hi');
    } finally {
      (engine as any).llm = saved;
    }
  });
});

describe('conversation checks on their own', () => {
  const ctx = (outputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    scope: { outputs, output: outputs.output, ...extra },
    env: {},
    llm: stubLlm({}),
    log: () => {},
    workspaceDir: '.',
    signal: new AbortController().signal,
  });
  const transcript = [
    { role: 'user', content: 'block my card', turn: 1 },
    { role: 'assistant', content: 'Which card?', turn: 1 },
    { role: 'user', content: 'debit', turn: 2 },
    { role: 'assistant', content: 'Your debit card is BLOCKED.', turn: 2 },
  ];

  it('transcript_contains handles all / any / none, speakers and empty phrase lists', async () => {
    const t = getCheckType('transcript_contains')!;
    expect((await t.run({ values: ['blocked', 'which card'] }, ctx({ transcript }))).status).toBe('pass');
    expect((await t.run({ values: ['blocked', 'replacement'], mode: 'all' }, ctx({ transcript }))).status).toBe('fail');
    expect((await t.run({ values: ['nope', 'blocked'], mode: 'any' }, ctx({ transcript }))).status).toBe('pass');
    expect((await t.run({ values: ['1800'], mode: 'none' }, ctx({ transcript }))).status).toBe('pass');
    expect((await t.run({ values: ['debit'], speaker: 'user' }, ctx({ transcript }))).status).toBe('pass');
    expect((await t.run({ values: [] }, ctx({ transcript }))).status).toBe('skip');
    expect((await t.run({ values: ['x'] }, ctx({ output: 'single reply' }))).status).toBe('skip');
  });

  it('turn_count and goal_met skip non-conversation results; goal_met can use a judge', async () => {
    const turns = getCheckType('turn_count')!;
    expect((await turns.run({ min: 1, max: 2 }, ctx({ transcript }))).status).toBe('pass');
    expect((await turns.run({ min: 1, max: 1 }, ctx({ transcript }))).status).toBe('fail');
    expect((await turns.run({}, ctx({ output: 'x' }))).status).toBe('skip');

    const goal = getCheckType('goal_met')!;
    expect((await goal.run({}, ctx({ output: 'x' }))).status).toBe('skip');
    expect((await goal.run({ source: 'judge' }, ctx({ transcript }))).status).toBe('fail'); // no connection
    const judged = await goal.run(
      { source: 'judge', connectionId: 'c' },
      { ...ctx({ transcript }, { goal: 'Block the card' }), llm: { ...stubLlm({}), json: async () => ({ value: { reasoning: 'It was blocked', goal_met: true }, latencyMs: 1, model: 'j' }) } as any },
    );
    expect(judged.status).toBe('pass');
    expect((judged.details as any).source).toBe('judge');
  });
});
