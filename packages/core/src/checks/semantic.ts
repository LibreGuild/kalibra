import { z } from 'zod';
import { cosine } from '../providers/embeddings.js';
import { normalizeText } from '../metrics/normalize.js';
import { ACTUAL_FIELD, actualSchema, defineCheck, errorOutcome, round, skip, text, verdict } from './common.js';
import type { CheckType } from './types.js';

/*
 * Meaning-based checks. `semantic_similarity` compares embeddings (a free local model or a
 * connection's embedding model). `semantic_wer` asks an LLM which transcription errors actually
 * change the meaning (names, numbers, negations, invented or dropped content), because plain WER
 * counts "fifteen hundred" vs "1500" the same as "fifteen" vs "fifty".
 */

export const semanticSimilarityCheck = defineCheck({
  type: 'semantic_similarity',
  label: 'Meaning matches (embeddings)',
  category: 'reference',
  layer: 4,
  description: 'Compares the meaning of the value and a reference using text embeddings. 1 = same meaning, 0 = unrelated.',
  config: z.object({
    actual: actualSchema,
    reference: z.string().default('{{expected}}'),
    threshold: z.number().min(-1).max(1).default(0.8),
    source: z.enum(['local', 'connection']).default('local'),
    connectionId: z.string().default(''),
    model: z.string().default(''),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'reference', label: 'Reference', kind: 'template', default: '{{expected}}', help: 'What a good answer means, usually a dataset column such as {{expected}}.' },
    { key: 'threshold', label: 'Minimum similarity', kind: 'number', default: 0.8, help: 'From 0 to 1. Paraphrases usually score 0.7–0.9 with the local model; unrelated text scores below 0.3.' },
    {
      key: 'source',
      label: 'Embedding model',
      kind: 'select',
      default: 'local',
      options: [
        { value: 'local', label: 'Local model (free, offline)' },
        { value: 'connection', label: 'A connection’s embedding model' },
      ],
      help: 'The local model runs on your machine after a one-time download. Connections use their provider’s embedding model (e.g. text-embedding-3-small, or nomic-embed-text in Ollama).',
    },
    { key: 'connectionId', label: 'Connection', kind: 'connection', help: 'Only when using a connection’s embedding model.' },
    { key: 'model', label: 'Model', kind: 'model', help: 'Leave empty to use the connection’s embedding model.' },
  ],
  async run(cfg, ctx) {
    const a = (await text(cfg.actual, ctx)).trim();
    const b = (await text(cfg.reference, ctx)).trim();
    if (!b) return skip('No reference for this row');
    if (!ctx.embed) return errorOutcome('Embeddings are not available here');
    if (!a) return verdict(false, { score: 0, value: 0, threshold: cfg.threshold, reason: 'Empty output' });
    if (cfg.source === 'connection' && !cfg.connectionId) return errorOutcome('Pick a connection, or switch to the local model');
    const res = await ctx.embed.embed([a, b], cfg.source === 'connection' ? { connectionId: cfg.connectionId, model: cfg.model || undefined, signal: ctx.signal } : { signal: ctx.signal });
    const sim = round(cosine(res.vectors[0], res.vectors[1]));
    return verdict(sim >= cfg.threshold, {
      score: Math.max(0, Math.min(1, sim)),
      value: sim,
      threshold: cfg.threshold,
      reason: `Similarity ${sim.toFixed(3)} (min ${cfg.threshold})`,
      details: { similarity: sim, source: res.source, model: res.model },
    });
  },
});

const WER_SYSTEM =
  'You compare a speech transcript (hypothesis) with what was actually said (reference). List only errors that change the meaning: wrong or missing names, numbers, amounts, dates, negations, wrong words that change intent, invented content, or dropped content that matters. Ignore punctuation, casing, spelling variants, number formatting ("1500" vs "fifteen hundred"), filler words and harmless contractions.';

export const semanticWerCheck = defineCheck({
  type: 'semantic_wer',
  label: 'Meaning errors in a transcript (LLM)',
  category: 'reference',
  layer: 4,
  description: 'An LLM counts only the transcription errors that change the meaning. Score = meaning errors ÷ reference words.',
  config: z.object({
    actual: actualSchema,
    reference: z.string().default('{{reference}}'),
    max: z.number().min(0).max(1).default(0.05),
    connectionId: z.string().default(''),
    model: z.string().default(''),
  }),
  fields: [
    { ...ACTUAL_FIELD, help: 'The transcript your app produced, usually {{output}}.' },
    { key: 'reference', label: 'Reference transcript', kind: 'template', default: '{{reference}}', help: 'What was really said, usually a dataset column like {{reference}}.' },
    { key: 'max', label: 'Maximum meaning-error rate', kind: 'number', default: 0.05, help: 'Meaning errors per reference word. 0.05 means at most one meaning error per 20 words.' },
    { key: 'connectionId', label: 'Connection', kind: 'connection', help: 'Which model reviews the transcript.' },
    { key: 'model', label: 'Model', kind: 'model', help: 'Leave empty to use the connection default.' },
  ],
  async run(cfg, ctx) {
    const hyp = await text(cfg.actual, ctx);
    const ref = await text(cfg.reference, ctx);
    if (!ref.trim()) return skip('No reference transcript for this row');
    if (!cfg.connectionId) return errorOutcome('Pick a connection for the reviewing model');
    const refWords = normalizeText(ref, 'basic').split(/\s+/).filter(Boolean).length || 1;
    const res = await ctx.llm.json<{ errors: { kind: string; reference: string; hypothesis: string; why: string }[] }>({
      connectionId: cfg.connectionId,
      model: cfg.model || undefined,
      system: WER_SYSTEM,
      prompt: `Reference:\n"""\n${ref}\n"""\n\nHypothesis:\n"""\n${hyp}\n"""\n\nList the meaning-changing errors. Return an empty list if the meaning is preserved.`,
      schema: {
        type: 'object',
        properties: {
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['name', 'number', 'negation', 'wrong_word', 'invented', 'dropped', 'other'] },
                reference: { type: 'string' },
                hypothesis: { type: 'string' },
                why: { type: 'string' },
              },
              required: ['kind', 'reference', 'hypothesis', 'why'],
            },
          },
        },
        required: ['errors'],
      },
      signal: ctx.signal,
    });
    const errors = Array.isArray(res.value?.errors) ? res.value.errors : [];
    const rate = round(errors.length / refWords);
    return verdict(rate <= cfg.max, {
      score: Math.max(0, 1 - rate),
      value: rate,
      threshold: cfg.max,
      reason: errors.length ? `${errors.length} meaning error${errors.length > 1 ? 's' : ''}: ${errors.map((e) => `${e.reference || '∅'} → ${e.hypothesis || '∅'}`).slice(0, 3).join('; ')}` : 'Meaning preserved',
      details: { metric: 'semantic_wer', errors: errors.length, refUnits: refWords, list: errors, model: res.model },
    });
  },
});

export const semanticChecks: CheckType[] = [semanticSimilarityCheck, semanticWerCheck];
