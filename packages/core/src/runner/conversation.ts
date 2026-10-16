import { randomUUID } from 'node:crypto';
import type { LlmClient } from '../providers/types.js';
import type { Logger } from '../script.js';
import type { ConversationSettings } from '../specs.js';
import { render, toText, type TemplateEnv } from '../template.js';
import type { TargetCallResult } from '../targets/types.js';

/*
 * Multi-turn conversations. Instead of one call per row, the target is called once per user turn:
 *   scripted  – user messages come from a list column (e.g. `turns`), in order;
 *   simulated – an LLM plays the user (persona + goal) and decides when the conversation is over.
 * Every turn sees the row plus `message`, `history`, `turn`, `conversation_id` and `session_id`
 * (taken from the previous reply's `session_id` output when the target extracts one).
 * Checks run once, on the final state; the transcript is in `outputs.transcript`.
 */

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  turn: number;
  latency_ms?: number;
}

export interface ConversationDeps {
  /** Calls the target once (with retries) for a row extended with the turn variables. */
  call: (row: Record<string, unknown>) => Promise<{ result: TargetCallResult; attempts: number }>;
  llm: LlmClient;
  env: TemplateEnv;
  signal: AbortSignal;
  log: Logger;
}

export type StopReason = 'script_done' | 'goal_met' | 'gave_up' | 'max_turns' | 'stop_phrase' | 'error' | 'cancelled';

const SIMULATOR_SYSTEM =
  'You are role-playing a USER talking to an app or AI assistant, to test it. Stay in character as the persona, write only what that user would type, ' +
  'keep messages short and natural, and pursue the goal step by step. Never reveal that you are a test or an AI. ' +
  'Set done=true when the goal has been achieved, when the assistant clearly cannot help, or when the conversation has naturally ended; ' +
  'when done is true the message may be empty. goal_met says whether the goal was achieved.';

const SIM_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    done: { type: 'boolean' },
    goal_met: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['message', 'done', 'goal_met', 'reason'],
};

/** User messages for a scripted conversation, from a list of strings or a messages array. */
export function scriptedTurns(value: unknown): string[] {
  let v = value;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try {
      v = JSON.parse(s);
    } catch {
      return s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(v)) return typeof v === 'string' && v ? [v] : [];
  return v
    .map((m: any) => (typeof m === 'string' ? m : m && typeof m === 'object' && (m.role ?? 'user') === 'user' ? toText(m.content) : ''))
    .map((s) => s.trim())
    .filter(Boolean);
}

const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

function transcriptText(t: TranscriptEntry[]) {
  return t.map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`).join('\n');
}

export async function runConversation(
  settings: ConversationSettings,
  row: Record<string, unknown>,
  deps: ConversationDeps,
): Promise<{ result: TargetCallResult; attempts: number }> {
  const conversationId = randomUUID();
  const started = Date.now();
  const transcript: TranscriptEntry[] = [];
  const messages: NonNullable<TargetCallResult['response']>['messages'] = [];
  const logs: TargetCallResult['logs'] = [];
  const turnLatencies: number[] = [];
  // Attempts mean what they mean for a single call: 1, plus one per retry of any turn.
  let calls = 0;
  let retries = 0;
  let sessionId: unknown;
  let lastResult: TargetCallResult | undefined;
  let error: string | undefined;
  let stopReason: StopReason = 'script_done';
  let goalMet: boolean | undefined;
  let simReason: string | undefined;
  let lastReply = '';
  let turn = 0;

  const scope = { ...row, row };
  const persona = settings.mode === 'simulated' ? await render(settings.personaTemplate, scope, deps.env) : '';
  const goal = settings.mode === 'simulated' ? await render(settings.goalTemplate, scope, deps.env) : '';

  const sendTurn = async (message: string) => {
    turn++;
    const history = transcript.map(({ role, content }) => ({ role, content }));
    transcript.push({ role: 'user', content: message, turn });
    messages.push({ t: Date.now() - started, dir: 'out', kind: 'user', data: message });
    const { result, attempts: a } = await deps.call({ ...row, message, history, turn, conversation_id: conversationId, session_id: sessionId ?? '' });
    calls++;
    retries += Math.max(0, a - 1);
    lastResult = result;
    logs.push(...result.logs.slice(0, 50));
    const latency = result.metrics.latency_ms;
    if (typeof latency === 'number') turnLatencies.push(latency);
    if (!result.ok) {
      error = `Turn ${turn}: ${result.error ?? 'the target failed'}`;
      stopReason = 'error';
      messages.push({ t: Date.now() - started, dir: 'in', kind: 'error', data: result.error ?? 'error' });
      return false;
    }
    if (result.outputs.session_id !== undefined && result.outputs.session_id !== null && result.outputs.session_id !== '') sessionId = result.outputs.session_id;
    lastReply = asText(result.outputs.output);
    transcript.push({ role: 'assistant', content: lastReply, turn, latency_ms: latency });
    messages.push({ t: Date.now() - started, dir: 'in', kind: 'assistant', data: lastReply });
    if (settings.stopPhrase && lastReply.toLowerCase().includes(settings.stopPhrase.toLowerCase())) {
      stopReason = 'stop_phrase';
      return false;
    }
    return true;
  };

  if (settings.mode === 'scripted') {
    const turns = scriptedTurns(row[settings.turnsColumn]);
    if (!turns.length) {
      return {
        result: {
          ok: false,
          outputs: { transcript: [], turns: 0, stop_reason: 'error' },
          metrics: { turns: 0 },
          error: `No user turns found: the "${settings.turnsColumn}" column is empty or missing for this row`,
          logs,
          retryable: false,
        },
        attempts: 0,
      };
    }
    // Scripted conversations always play the whole script; maxTurns only bounds simulated users.
    for (const message of turns) {
      if (deps.signal.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (!(await sendTurn(message))) break;
    }
  } else {
    if (!settings.connectionId) {
      return {
        result: { ok: false, outputs: { transcript: [], turns: 0, stop_reason: 'error' }, metrics: { turns: 0 }, error: 'Choose a model connection to play the simulated user', logs, retryable: false },
        attempts: 0,
      };
    }
    stopReason = 'max_turns';
    for (let i = 0; i < settings.maxTurns; i++) {
      if (deps.signal.aborted) {
        stopReason = 'cancelled';
        break;
      }
      let next;
      try {
        next = await deps.llm.json<{ message: string; done: boolean; goal_met: boolean; reason: string }>({
          connectionId: settings.connectionId,
          model: settings.model || undefined,
          system: SIMULATOR_SYSTEM,
          prompt:
            `Persona: ${persona || '(a typical user)'}\nGoal: ${goal || '(none given)'}\n\n` +
            (transcript.length ? `Conversation so far:\n${transcriptText(transcript)}\n\nWrite your next message as the user.` : 'Start the conversation: write your first message as the user.'),
          temperature: 0.7,
          schema: SIM_SCHEMA,
          schemaName: 'simulated_user_turn',
          signal: deps.signal,
        });
      } catch (e: any) {
        // The simulated user's model failing is this row's error, not the whole run's.
        error = `Simulated user (turn ${turn + 1}): ${e?.message ?? e}`;
        stopReason = deps.signal.aborted ? 'cancelled' : 'error';
        break;
      }
      const sim = next.value ?? ({} as any);
      goalMet = !!sim.goal_met;
      simReason = sim.reason;
      if (sim.done || !String(sim.message ?? '').trim()) {
        stopReason = goalMet ? 'goal_met' : 'gave_up';
        break;
      }
      if (!(await sendTurn(String(sim.message).trim()))) break;
    }
    // Ran out of turns: ask the simulated user once whether the goal was reached.
    if (stopReason === 'max_turns' && transcript.length) {
      try {
        const final = await deps.llm.json<{ goal_met: boolean; reason: string }>({
          connectionId: settings.connectionId,
          model: settings.model || undefined,
          system: SIMULATOR_SYSTEM,
          prompt: `Persona: ${persona}\nGoal: ${goal}\n\nThe conversation is over:\n${transcriptText(transcript)}\n\nWas your goal achieved?`,
          schema: { type: 'object', properties: { goal_met: { type: 'boolean' }, reason: { type: 'string' } }, required: ['goal_met', 'reason'] },
          signal: deps.signal,
        });
        goalMet = !!final.value?.goal_met;
        simReason = final.value?.reason;
      } catch (e: any) {
        deps.log('warn', `Could not get the final goal verdict: ${e?.message ?? e}`);
      }
    }
  }

  const userTurns = transcript.filter((t) => t.role === 'user').length;
  const totalLatency = turnLatencies.reduce((a, b) => a + b, 0);
  const metrics: Record<string, number> = {
    latency_ms: Math.round(totalLatency),
    conversation_ms: Date.now() - started,
    turns: userTurns,
  };
  if (turnLatencies.length) {
    metrics.turn_latency_ms = Math.round(totalLatency / turnLatencies.length);
    metrics.turn_latency_max_ms = Math.round(Math.max(...turnLatencies));
  }
  const outputs: Record<string, unknown> = {
    output: lastReply,
    transcript,
    turns: userTurns,
    stop_reason: stopReason,
    session_id: sessionId ?? null,
    conversation_id: conversationId,
  };
  if (settings.mode === 'simulated') Object.assign(outputs, { goal_met: goalMet ?? false, goal, persona, simulator_reason: simReason ?? '' });

  return {
    result: {
      ok: !error,
      request: { mode: settings.mode, turns: userTurns, last: lastResult?.request },
      response: { status: lastResult?.response?.status, messages: messages.slice(0, 400) },
      outputs,
      metrics,
      error,
      retryable: false,
      logs: logs.slice(0, 300),
    },
    attempts: calls ? 1 + retries : 0,
  };
}
