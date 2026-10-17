import { z } from 'zod';
import { toText } from '../template.js';
import { stepsOf } from './agents.js';
import { defineCheck, fail, pass, round, skip, text, toList, value, verdict } from './common.js';

/*
 * Checks for retrieval-augmented answers (docs/design/sdk-and-traces.md §7): were the right
 * documents found, is the answer backed by them, and do its citations point at real ones.
 *
 * Retrieved documents come from, first match wins:
 *   - `sources` in the check scope (retrieval spans from traces, normalized to [{id, text, score?}]);
 *   - `outputs.sources` (an API-only app returns them and the target maps the field);
 *   - the outputs of retrieval spans in `steps` / `outputs.steps`.
 * Documents may be objects ({id|doc_id|document_id|source|url, text|content|page_content|chunk}) or
 * plain strings (the text; its position becomes the id).
 */

export interface Source {
  id: string;
  text: string;
  score?: number;
}

const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s.startsWith('[') && !s.startsWith('{')) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
};

/** One retrieval result as a list of documents (handles `{documents: [...]}` style wrappers too). */
function docsIn(v: unknown): unknown[] | undefined {
  const p = parsed(v);
  if (Array.isArray(p)) return p;
  if (p && typeof p === 'object') {
    for (const key of ['documents', 'docs', 'sources', 'results', 'chunks', 'matches']) {
      const inner = (p as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return undefined;
}

function normalize(docs: unknown[]): Source[] {
  return docs.map((d, i) => {
    if (d && typeof d === 'object') {
      const o = d as Record<string, any>;
      const meta = o.metadata && typeof o.metadata === 'object' ? o.metadata : {};
      const id = o.id ?? o.doc_id ?? o.document_id ?? o.source ?? o.url ?? meta.id ?? meta.source ?? String(i + 1);
      const text = o.text ?? o.content ?? o.page_content ?? o.pageContent ?? o.chunk ?? o.snippet ?? '';
      const score = typeof o.score === 'number' ? o.score : undefined;
      return { id: toText(id), text: toText(text), ...(score !== undefined ? { score } : {}) };
    }
    return { id: String(i + 1), text: toText(d) };
  });
}

/** Retrieved documents of this result, in retrieval order; undefined when nothing was reported. */
export function sourcesOf(scope: Record<string, unknown>): Source[] | undefined {
  const direct = docsIn(scope.sources) ?? docsIn((scope.outputs as any)?.sources);
  if (direct) return normalize(direct);
  const steps = stepsOf(scope);
  if (!steps) return undefined;
  const retrieval = steps.filter((s) => s.kind === 'retrieval');
  if (!retrieval.length) return undefined;
  return normalize(retrieval.flatMap((s) => docsIn(s.output) ?? []));
}

const NO_SOURCES = 'No retrieved documents recorded for this result. Send traces with the Kalibra SDK (a "retrieval" step), or return a sources field from your app and map it in the target.';

export const retrievalRecallCheck = defineCheck({
  type: 'retrieval_recall',
  label: 'Found the right documents',
  category: 'agents',
  layer: 4,
  description: 'Passes when the documents your app retrieved include the ones this row needs (recall against a column of expected document ids).',
  config: z.object({
    expected: z.string().default('{{expected_sources}}'),
    k: z.number().int().min(0).default(0),
    min: z.number().min(0).max(1).default(1),
  }),
  fields: [
    {
      key: 'expected',
      label: 'Expected document ids',
      kind: 'template',
      default: '{{expected_sources}}',
      help: 'A column with the ids that should be found: a list, or ids separated by commas.',
    },
    { key: 'k', label: 'Only the first', kind: 'number', default: 0, help: 'Count only the top k retrieved documents (0 = all of them).' },
    { key: 'min', label: 'Minimum recall', kind: 'number', default: 1, help: 'Share of expected ids that must be found, from 0 to 1. 1 means all of them.' },
  ],
  async run(cfg, ctx) {
    const expected = [...new Set(toList(await value(cfg.expected, ctx)))];
    if (!expected.length) return skip('No expected document ids for this row');
    const sources = sourcesOf(ctx.scope);
    if (!sources) return skip(NO_SOURCES);
    const top = cfg.k > 0 ? sources.slice(0, cfg.k) : sources;
    const got = new Set(top.map((s) => s.id));
    const found = expected.filter((id) => got.has(id));
    const missing = expected.filter((id) => !got.has(id));
    const recall = found.length / expected.length;
    const precision = top.length ? top.filter((s) => expected.includes(s.id)).length / top.length : 0;
    return verdict(recall >= cfg.min, {
      score: round(recall),
      value: round(recall),
      threshold: cfg.min,
      reason: missing.length ? `Found ${found.length}/${expected.length}; missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : `Found all ${expected.length} expected document${expected.length === 1 ? '' : 's'}`,
      details: { recall: round(recall), precision: round(precision), found, missing, retrieved: top.map((s) => s.id) },
    });
  },
});

export const citationsCheck = defineCheck({
  type: 'citations',
  label: 'Citations are real',
  category: 'agents',
  layer: 3,
  description: 'Fails when the answer cites a document that was not retrieved (made-up or wrong references).',
  config: z.object({
    actual: z.string().default('{{output}}'),
    pattern: z.string().default('\\[([\\w.:/#-]+)\\]'),
    field: z.string().default(''),
    required: z.boolean().default(false),
  }),
  fields: [
    { key: 'actual', label: 'Answer', kind: 'template', default: '{{output}}', help: 'The text whose citations are checked.' },
    {
      key: 'pattern',
      label: 'How citations look',
      kind: 'text',
      default: '\\[([\\w.:/#-]+)\\]',
      help: 'A regular expression; its first group is the cited document id. The default finds [doc-17] style references.',
    },
    { key: 'field', label: 'Or a field with cited ids', kind: 'template', placeholder: '{{outputs.citations}}', help: 'Use this instead of the pattern when your app returns the cited ids separately.' },
    { key: 'required', label: 'Answer must cite something', kind: 'boolean', default: false, help: 'Fail answers without any citation.' },
  ],
  async run(cfg, ctx) {
    const sources = sourcesOf(ctx.scope);
    if (!sources) return skip(NO_SOURCES);
    let cited: string[];
    if (cfg.field.trim()) cited = toList(await value(cfg.field, ctx));
    else {
      let re: RegExp;
      try {
        re = new RegExp(cfg.pattern, 'g');
      } catch (e: any) {
        return fail({ reason: `The citation pattern is not a valid regular expression: ${e?.message ?? e}` });
      }
      const answer = await text(cfg.actual, ctx);
      cited = [...answer.matchAll(re)].map((m) => (m[1] ?? m[0]).trim()).filter(Boolean);
    }
    cited = [...new Set(cited)];
    if (!cited.length) return cfg.required ? fail({ reason: 'The answer cites no documents' }) : skip('The answer cites no documents');
    const known = new Set(sources.map((s) => s.id));
    const bad = cited.filter((id) => !known.has(id));
    return verdict(!bad.length, {
      score: round((cited.length - bad.length) / cited.length),
      reason: bad.length ? `Cites ${bad.join(', ')}, which ${bad.length === 1 ? 'was' : 'were'} not retrieved` : `All ${cited.length} citation${cited.length === 1 ? '' : 's'} point at retrieved documents`,
      details: { cited, unknown: bad, retrieved: [...known] },
    });
  },
});

/** Keeps the judge prompt bounded: long documents are cut, and only so much text is sent overall. */
const MAX_SOURCE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 16_000;

export const groundedCheck = defineCheck({
  type: 'grounded',
  label: 'Answer is grounded',
  category: 'agents',
  layer: 5,
  description: 'An LLM judge splits the answer into claims and checks each against the retrieved documents. Catches made-up facts that look plausible.',
  config: z.object({
    actual: z.string().default('{{output}}'),
    connectionId: z.string().default(''),
    model: z.string().default(''),
    min: z.number().min(0).max(1).default(1),
  }),
  fields: [
    { key: 'actual', label: 'Answer', kind: 'template', default: '{{output}}' },
    { key: 'connectionId', label: 'Judge connection', kind: 'connection', help: 'The model that checks the claims.' },
    { key: 'model', label: 'Judge model', kind: 'model', help: 'Leave empty to use the connection default.' },
    { key: 'min', label: 'Minimum supported share', kind: 'number', default: 1, help: 'Share of claims that must be supported, from 0 to 1. 1 means every claim.' },
  ],
  async run(cfg, ctx) {
    const answer = (await text(cfg.actual, ctx)).trim();
    if (!answer) return skip('The answer is empty');
    const sources = sourcesOf(ctx.scope);
    if (!sources) return skip(NO_SOURCES);
    if (!sources.length) return fail({ reason: 'Nothing was retrieved, so the answer cannot be grounded' });
    if (!cfg.connectionId) return fail({ reason: 'Pick a judge connection' });
    let budget = MAX_TOTAL_CHARS;
    const docs: string[] = [];
    for (const s of sources) {
      if (budget <= 0) break;
      const t = s.text.slice(0, Math.min(MAX_SOURCE_CHARS, budget));
      budget -= t.length;
      docs.push(`[${s.id}] ${t}`);
    }
    const res = await ctx.llm.json<{ claims: { claim: string; supported: boolean; source?: string; reason?: string }[] }>({
      connectionId: cfg.connectionId,
      model: cfg.model || undefined,
      system:
        'You check whether an answer is supported by the given documents. Split the answer into its factual claims (skip greetings, questions and opinions). For each claim decide if the documents support it. A claim is supported only if the documents state it or it follows directly from them.',
      prompt: `Documents:\n${docs.join('\n\n')}\n\nAnswer:\n"""\n${answer.slice(0, 6000)}\n"""\n\nList every factual claim of the answer and whether the documents support it (give the id of the supporting document).`,
      schema: {
        type: 'object',
        properties: {
          claims: {
            type: 'array',
            items: {
              type: 'object',
              properties: { claim: { type: 'string' }, supported: { type: 'boolean' }, source: { type: 'string' }, reason: { type: 'string' } },
              required: ['claim', 'supported'],
            },
          },
        },
        required: ['claims'],
      },
      schemaName: 'grounding',
      signal: ctx.signal,
    });
    const claims = Array.isArray(res.value?.claims) ? res.value.claims : [];
    if (!claims.length) return pass({ reason: 'The answer makes no factual claims to check', details: { claims: [], model: res.model } });
    const supported = claims.filter((c) => c.supported === true).length;
    const share = supported / claims.length;
    const unsupported = claims.filter((c) => c.supported !== true);
    return verdict(share >= cfg.min, {
      score: round(share),
      value: round(share),
      threshold: cfg.min,
      reason: unsupported.length ? `${unsupported.length} of ${claims.length} claims unsupported, e.g. "${toText(unsupported[0].claim).slice(0, 120)}"` : `All ${claims.length} claims supported`,
      details: { claims, model: res.model },
    });
  },
});

export const ragChecks = [retrievalRecallCheck, citationsCheck, groundedCheck];
