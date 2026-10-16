import { z } from 'zod';
import type { CheckType } from './types.js';
import { defineCheck, fail, pass, renderText, skip, toList, value, verdict } from './common.js';

/*
 * Checks for multi-turn conversation results (Run settings → Conversation). They read
 * `outputs.transcript` ([{role, content, turn}]) and, for simulated users, `outputs.goal_met`.
 */

interface Entry {
  role: string;
  content: string;
  turn?: number;
}

const transcriptOf = (scope: Record<string, unknown>): Entry[] | undefined => {
  const t = (scope.outputs as any)?.transcript;
  return Array.isArray(t) ? (t as Entry[]) : undefined;
};

const asText = (t: Entry[]) => t.map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.content}`).join('\n');

export const goalMetCheck = defineCheck({
  type: 'goal_met',
  label: 'Goal achieved',
  category: 'judgment',
  layer: 5,
  description: "Did the conversation get the user what they came for? Uses the simulated user's own verdict, or asks an LLM judge to read the transcript.",
  config: z.object({
    source: z.enum(['auto', 'simulator', 'judge']).default('auto'),
    goal: z.string().default('{{goal}}'),
    connectionId: z.string().default(''),
    model: z.string().default(''),
    criteria: z.string().default(''),
  }),
  fields: [
    {
      key: 'source',
      label: 'Who decides',
      kind: 'select',
      default: 'auto',
      options: [
        { value: 'auto', label: 'Simulated user if available, otherwise a judge' },
        { value: 'simulator', label: 'The simulated user' },
        { value: 'judge', label: 'An LLM judge' },
      ],
      help: 'A simulated user already says whether its goal was met. For scripted conversations (or a second opinion) an LLM judge reads the whole transcript.',
    },
    { key: 'goal', label: 'Goal', kind: 'template', default: '{{goal}}', help: 'What the user wanted. Usually a dataset column such as {{goal}}.' },
    { key: 'connectionId', label: 'Judge connection', kind: 'connection', help: 'Needed when a judge decides.' },
    { key: 'model', label: 'Judge model', kind: 'model', help: 'Leave empty to use the connection default.' },
    { key: 'criteria', label: 'Extra criteria', kind: 'textarea', help: 'Optional rules for the judge, e.g. "The card must be blocked, not just explained".' },
  ],
  async run(cfg, ctx) {
    const transcript = transcriptOf(ctx.scope);
    if (!transcript) return skip('Not a conversation result (no transcript)');
    const simVerdict = (ctx.scope.outputs as any)?.goal_met;
    if (cfg.source !== 'judge' && typeof simVerdict === 'boolean') {
      const reason = (ctx.scope.outputs as any)?.simulator_reason;
      return verdict(simVerdict, { reason: `Simulated user: ${simVerdict ? 'goal met' : 'goal not met'}${reason ? ` (${reason})` : ''}`, details: { source: 'simulator', reasoning: reason } });
    }
    if (cfg.source === 'simulator') return skip('No simulated-user verdict for this result');
    if (!cfg.connectionId) return fail({ reason: 'Choose a judge connection (scripted conversations have no simulator verdict)' });
    if (!transcript.length) return fail({ reason: 'The conversation is empty' });
    const goal = await renderText(cfg.goal, ctx);
    const res = await ctx.llm.json<{ reasoning: string; goal_met: boolean }>({
      connectionId: cfg.connectionId,
      model: cfg.model || undefined,
      system: 'You judge whether a conversation between a user and an assistant achieved the user\'s goal. Explain briefly first, then decide.',
      prompt: `Goal: ${goal || '(infer it from the first user message)'}\n${cfg.criteria ? `Criteria: ${cfg.criteria}\n` : ''}\nTranscript:\n${asText(transcript)}\n\nWas the goal achieved?`,
      schema: { type: 'object', properties: { reasoning: { type: 'string' }, goal_met: { type: 'boolean' } }, required: ['reasoning', 'goal_met'] },
      signal: ctx.signal,
    });
    return verdict(!!res.value?.goal_met, { reason: res.value?.reasoning?.slice(0, 300), details: { source: 'judge', reasoning: res.value?.reasoning, model: res.model } });
  },
});

export const transcriptContainsCheck = defineCheck({
  type: 'transcript_contains',
  label: 'Conversation mentions',
  category: 'content',
  layer: 3,
  description: 'Looks for phrases anywhere in the assistant\'s replies across the whole conversation (not just the last reply).',
  config: z.object({
    values: z.array(z.string()).default([]),
    mode: z.enum(['any', 'all', 'none']).default('all'),
    speaker: z.enum(['assistant', 'user', 'both']).default('assistant'),
  }),
  fields: [
    { key: 'values', label: 'Phrases', kind: 'list', default: [], help: 'Case-insensitive. An item like {{must_mention}} expands to a list from a column.' },
    {
      key: 'mode',
      label: 'Match',
      kind: 'select',
      default: 'all',
      options: [
        { value: 'all', label: 'All phrases must appear' },
        { value: 'any', label: 'At least one must appear' },
        { value: 'none', label: 'None may appear' },
      ],
      help: 'Use "none" for things the app must never say, like an internal phone number.',
    },
    {
      key: 'speaker',
      label: 'Whose messages',
      kind: 'select',
      default: 'assistant',
      options: [
        { value: 'assistant', label: 'The app' },
        { value: 'user', label: 'The user' },
        { value: 'both', label: 'Both' },
      ],
    },
  ],
  async run(cfg, ctx) {
    const transcript = transcriptOf(ctx.scope);
    if (!transcript) return skip('Not a conversation result (no transcript)');
    const phrases: string[] = [];
    for (const v of cfg.values) {
      const resolved = await value(v, ctx);
      phrases.push(...toList(resolved));
    }
    const wanted = phrases.map((p) => p.trim()).filter(Boolean);
    if (!wanted.length) return skip('No phrases to look for');
    const text = transcript
      .filter((e) => cfg.speaker === 'both' || e.role === cfg.speaker)
      .map((e) => e.content)
      .join('\n')
      .toLowerCase();
    const found = wanted.filter((p) => text.includes(p.toLowerCase()));
    const missing = wanted.filter((p) => !found.includes(p));
    const ok = cfg.mode === 'all' ? missing.length === 0 : cfg.mode === 'any' ? found.length > 0 : found.length === 0;
    const score = cfg.mode === 'none' ? (ok ? 1 : 0) : wanted.length ? found.length / wanted.length : 0;
    const reason =
      cfg.mode === 'none'
        ? ok ? 'None of the phrases appear' : `Found: ${found.join(', ')}`
        : ok ? `Found ${found.length} of ${wanted.length}` : `Missing: ${missing.join(', ')}`;
    return ok ? pass({ score, reason, details: { found, missing } }) : fail({ score, reason, details: { found, missing } });
  },
});

export const turnCountCheck = defineCheck({
  type: 'turn_count',
  label: 'Number of turns',
  category: 'content',
  layer: 3,
  description: 'Passes when the conversation took between a minimum and maximum number of user turns, e.g. "solved within 4 turns".',
  config: z.object({ min: z.number().int().min(0).default(1), max: z.number().int().min(1).default(6) }),
  fields: [
    { key: 'min', label: 'At least', kind: 'number', default: 1, help: 'Fewest user turns allowed.' },
    { key: 'max', label: 'At most', kind: 'number', default: 6, help: 'Most user turns allowed. Fewer turns usually means the app was more efficient.' },
  ],
  async run(cfg, ctx) {
    const transcript = transcriptOf(ctx.scope);
    if (!transcript) return skip('Not a conversation result (no transcript)');
    const turns = transcript.filter((e) => e.role === 'user').length;
    return verdict(turns >= cfg.min && turns <= cfg.max, { value: turns, reason: `${turns} turn${turns === 1 ? '' : 's'} (allowed ${cfg.min}–${cfg.max})` });
  },
});

export const conversationChecks: CheckType[] = [transcriptContainsCheck, turnCountCheck, goalMetCheck];
