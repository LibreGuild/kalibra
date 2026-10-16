import { z } from 'zod';
import { normalizeText, type NormalizerProfile } from '../metrics/normalize.js';
import { charErrors, topConfusions, wordErrors } from '../metrics/wer.js';
import { chrF, rougeL, sentenceBleu, tokenF1 } from '../metrics/text.js';
import { toText } from '../template.js';
import { ACTUAL_FIELD, actualSchema, defineCheck, round, skip, text, toList, value, verdict } from './common.js';
import type { CheckField } from './types.js';

/* Layer 4: reference metrics — WER/CER for speech, BLEU/ROUGE/chrF/F1 for text. */

const referenceField = (help?: string): CheckField => ({
  key: 'reference',
  label: 'Reference',
  kind: 'template',
  default: '{{reference}}',
  help: help ?? 'The correct text to compare with, usually a dataset column such as {{reference}} or {{expected}}.',
});

const normalizerField: CheckField = {
  key: 'normalizer',
  label: 'Normalizer',
  kind: 'select',
  default: 'basic',
  options: [
    { value: 'none', label: 'None (compare as is)' },
    { value: 'basic', label: 'Basic (lowercase, no punctuation)' },
    { value: 'english', label: 'English (basic + numbers, contractions, fillers)' },
    { value: 'custom', label: 'Custom rules' },
  ],
  help: 'Cleans both texts before comparing, so "Hello, World!" and "hello world" count as equal. The choice changes scores a lot, so keep it fixed when comparing runs.',
};

const rulesSchema = z
  .array(z.object({ pattern: z.string(), flags: z.string().default('g'), replace: z.string().default('') }))
  .default([]);
const substitutionsSchema = z.array(z.object({ from: z.string(), to: z.string() })).default([]);

const customFields: CheckField[] = [
  {
    key: 'customBase',
    label: 'Custom: start from',
    kind: 'select',
    default: 'basic',
    options: [
      { value: 'none', label: 'None' },
      { value: 'basic', label: 'Basic' },
      { value: 'english', label: 'English' },
    ],
    help: 'Only for the Custom normalizer: which profile runs before your own rules.',
  },
  {
    key: 'customRules',
    label: 'Custom: regex rules',
    kind: 'json',
    default: [],
    help: 'Only for Custom. A list like [{"pattern": "\\\\bmr\\\\b", "replace": "mister"}], applied in order.',
  },
  {
    key: 'substitutions',
    label: 'Custom: word substitutions',
    kind: 'json',
    default: [],
    help: 'Only for Custom. Whole-word replacements like [{"from": "ok", "to": "okay"}] for spellings you treat as equal.',
  },
];

const normalizeOpts = (cfg: { customBase: string; customRules: z.infer<typeof rulesSchema>; substitutions: z.infer<typeof substitutionsSchema> }) => ({
  base: cfg.customBase as Exclude<NormalizerProfile, 'custom'>,
  rules: cfg.customRules,
  substitutions: Object.fromEntries(cfg.substitutions.map((s) => [s.from, s.to])),
});

const MAX_OPS = 2000;

export const werCheck = defineCheck({
  type: 'wer',
  label: 'Word error rate (WER/CER)',
  category: 'reference',
  layer: 4,
  description: 'Speech-to-text accuracy: word (WER) or character (CER) error rate against a reference transcript. Lower is better.',
  config: z.object({
    actual: actualSchema,
    reference: z.string().default('{{reference}}'),
    metric: z.enum(['wer', 'cer', 'mer', 'wil']).default('wer'),
    normalizer: z.enum(['none', 'basic', 'english', 'custom']).default('basic'),
    customBase: z.enum(['none', 'basic', 'english']).default('basic'),
    customRules: rulesSchema,
    substitutions: substitutionsSchema,
    ignoreSpaces: z.boolean().default(false),
    max: z.number().nonnegative().default(0.15),
  }),
  fields: [
    { ...ACTUAL_FIELD, label: 'Transcript (hypothesis)', help: 'The text your app produced, usually {{output}}.' },
    referenceField('The correct transcript, usually a dataset column such as {{reference}}.'),
    {
      key: 'metric',
      label: 'Metric',
      kind: 'select',
      default: 'wer',
      options: [
        { value: 'wer', label: 'WER – word error rate' },
        { value: 'cer', label: 'CER – character error rate' },
        { value: 'mer', label: 'MER – match error rate' },
        { value: 'wil', label: 'WIL – word information lost' },
      ],
      help: 'WER counts wrong, missing and extra words divided by reference words. Use CER for languages written without spaces (Chinese, Japanese, Thai).',
    },
    normalizerField,
    ...customFields,
    { key: 'ignoreSpaces', label: 'CER: ignore spaces', kind: 'boolean', default: false, help: 'For CER only: remove all spaces before comparing (useful for Chinese/Japanese).' },
    { key: 'max', label: 'Maximum error rate', kind: 'number', default: 0.15, help: 'The check fails above this rate. 0.15 means up to 15 errors per 100 reference words.' },
  ],
  async run(cfg, ctx) {
    const hyp = await text(cfg.actual, ctx);
    const ref = await text(cfg.reference, ctx);
    const opts = { profile: cfg.normalizer as NormalizerProfile, normalize: normalizeOpts(cfg) };
    let rate: number;
    let refUnits: number;
    let hypUnits: number;
    let counts: { hits: number; subs: number; dels: number; ins: number; ops: any[]; normalizedRef: string; normalizedHyp: string };
    if (cfg.metric === 'cer') {
      const r = charErrors(ref, hyp, { ...opts, ignoreSpaces: cfg.ignoreSpaces });
      rate = r.cer;
      refUnits = r.refChars;
      hypUnits = r.hypChars;
      counts = r;
    } else {
      const r = wordErrors(ref, hyp, opts);
      rate = cfg.metric === 'wer' ? r.wer : cfg.metric === 'mer' ? r.mer : r.wil;
      refUnits = r.refWords;
      hypUnits = r.hypWords;
      counts = r;
    }
    const errors = counts.subs + counts.dels + counts.ins;
    const label = cfg.metric.toUpperCase();
    return verdict(rate <= cfg.max, {
      score: Math.max(0, 1 - rate),
      value: round(rate),
      threshold: cfg.max,
      reason: `${label} ${(rate * 100).toFixed(1)}% (${counts.subs} sub, ${counts.dels} del, ${counts.ins} ins of ${refUnits})`,
      details: {
        metric: cfg.metric,
        normalizer: cfg.normalizer,
        errors,
        refUnits,
        hypUnits,
        hits: counts.hits,
        subs: counts.subs,
        dels: counts.dels,
        ins: counts.ins,
        ops: counts.ops.slice(0, MAX_OPS),
        opsTruncated: counts.ops.length > MAX_OPS,
        confusions: topConfusions(counts.ops, 5),
        normalizedRef: counts.normalizedRef,
        normalizedHyp: counts.normalizedHyp,
      },
    });
  },
});

export const keywordRecallCheck = defineCheck({
  type: 'keyword_recall',
  label: 'Keyword recall',
  category: 'reference',
  layer: 4,
  description: 'Share of important words or phrases (names, numbers, product terms) that appear in the output.',
  config: z.object({
    actual: actualSchema,
    keywords: z.string().default('{{keywords}}'),
    normalizer: z.enum(['none', 'basic', 'english']).default('basic'),
    minRecall: z.number().min(0).max(1).default(1),
  }),
  fields: [
    ACTUAL_FIELD,
    { key: 'keywords', label: 'Keywords', kind: 'template', default: '{{keywords}}', help: 'A list column, or text separated by commas or new lines. Multi-word phrases must appear as whole words, in order.' },
    { ...normalizerField, options: normalizerField.options!.filter((o) => o.value !== 'custom') },
    { key: 'minRecall', label: 'Minimum recall', kind: 'number', default: 1, help: 'Share of keywords that must be found, from 0 to 1. 1 = all of them.' },
  ],
  async run(cfg, ctx) {
    const keywords = toList(await value(cfg.keywords, ctx));
    if (keywords.length === 0) return skip('No keywords for this row');
    const profile = cfg.normalizer as NormalizerProfile;
    const hay = ` ${normalizeText(await text(cfg.actual, ctx), profile)} `;
    const found: string[] = [];
    const missing: string[] = [];
    for (const k of keywords) {
      const nk = normalizeText(k, profile);
      (nk && hay.includes(` ${nk} `) ? found : missing).push(k);
    }
    const recall = found.length / keywords.length;
    return verdict(recall >= cfg.minRecall, {
      score: recall,
      value: round(recall),
      threshold: cfg.minRecall,
      reason: missing.length ? `Missing: ${missing.join(', ')}` : `All ${keywords.length} found`,
      details: { found, missing },
    });
  },
});

/** A list value (array or JSON array text) gives several acceptable references; anything else is one reference. */
function referenceList(v: unknown): string[] {
  if (Array.isArray(v)) return v.length ? v.map((x) => toText(x)) : [''];
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr) && arr.length) return arr.map((x) => toText(x));
    } catch {
      /* plain text */
    }
  }
  return [toText(v)];
}

function textMetricCheck(def: {
  type: string;
  label: string;
  description: string;
  min: number;
  minHelp: string;
  score: (refs: string[], hyp: string) => { score: number; details?: Record<string, unknown> };
}) {
  return defineCheck({
    type: def.type,
    label: def.label,
    category: 'reference',
    layer: 4,
    description: def.description,
    config: z.object({ actual: actualSchema, reference: z.string().default('{{expected}}'), min: z.number().min(0).max(1).default(def.min) }),
    fields: [
      ACTUAL_FIELD,
      { ...referenceField('The correct text. A list column gives several acceptable references.'), default: '{{expected}}' },
      { key: 'min', label: 'Minimum score', kind: 'number', default: def.min, help: def.minHelp },
    ],
    async run(cfg, ctx) {
      const refs = referenceList(await value(cfg.reference, ctx));
      const hyp = await text(cfg.actual, ctx);
      const r = def.score(refs, hyp);
      return verdict(r.score >= cfg.min, { score: r.score, value: round(r.score), threshold: cfg.min, reason: `${def.label} ${round(r.score, 3)}`, details: r.details });
    },
  });
}

export const bleuCheck = textMetricCheck({
  type: 'bleu',
  label: 'BLEU',
  description: 'Word n-gram overlap with the reference (common for translation). 0 to 1, higher is better.',
  min: 0.3,
  minHelp: 'From 0 to 1. Sentence BLEU is strict; 0.3–0.5 is often already a good match.',
  score: (refs, hyp) => {
    const r = sentenceBleu(refs, hyp);
    return { score: r.score, details: { precisions: r.precisions, brevityPenalty: r.brevityPenalty, hypLength: r.hypLength, refLength: r.refLength } };
  },
});

export const rougeLCheck = textMetricCheck({
  type: 'rouge_l',
  label: 'ROUGE-L',
  description: 'Longest common word sequence with the reference (common for summaries). F1 from 0 to 1.',
  min: 0.5,
  minHelp: 'From 0 to 1. Higher means more of the reference wording appears in the same order.',
  score: (refs, hyp) => {
    const best = refs.map((r) => rougeL(r, hyp)).sort((a, b) => b.f1 - a.f1)[0];
    return { score: best.f1, details: { precision: best.precision, recall: best.recall } };
  },
});

export const chrfCheck = textMetricCheck({
  type: 'chrf',
  label: 'chrF',
  description: 'Character n-gram F-score with the reference. Robust to word forms; good for many languages.',
  min: 0.5,
  minHelp: 'From 0 to 1. Higher is closer to the reference.',
  score: (refs, hyp) => ({ score: Math.max(...refs.map((r) => chrF(r, hyp))) }),
});

export const tokenF1Check = textMetricCheck({
  type: 'token_f1',
  label: 'Token F1',
  description: 'Word overlap F1 after removing case, punctuation and articles (SQuAD-style). Good for short answers.',
  min: 0.5,
  minHelp: 'From 0 to 1. 1 means the same words (order ignored).',
  score: (refs, hyp) => {
    const best = refs.map((r) => tokenF1(r, hyp)).sort((a, b) => b.f1 - a.f1)[0];
    return { score: best.f1, details: { precision: best.precision, recall: best.recall, exactMatch: best.exactMatch } };
  },
});
