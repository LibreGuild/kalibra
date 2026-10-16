import { z } from 'zod';
import type { Engine } from '../engine.js';
import type { JobHandle } from '../jobs.js';
import { defineOp, type OpDef } from '../registry.js';
import { latestInsight, saveInsight } from '../insights/store.js';
import {
  agglomerate,
  ASSIGN_SCHEMA,
  asSeverity,
  clampTitle,
  example,
  freeGroups,
  isFailure,
  PROPOSE_SCHEMA,
  summarize,
  THEME_SCHEMA,
  type FailureLite,
  type Theme,
} from '../insights/themes.js';
import { invalid } from '../util.js';

/*
 * Failure themes for a run: instant free grouping plus optional AI themes (embeddings clustering
 * named by an LLM, or LLM assignment when no embeddings are available). AI themes are saved as
 * insights so reopening the run shows them without paying again.
 */

const SYSTEM =
  'You analyse failures from an automated evaluation of an AI application. Be concrete and brief. Name what actually goes wrong in the examples; do not invent details that are not in them.';

const SIMILARITY = 0.75;
const ASSIGN_BATCH = 40;

interface ThemeOptions {
  connectionId: string;
  model?: string;
  maxThemes: number;
  useEmbeddings: boolean;
}

function buildTheme(id: string, named: any, members: FailureLite[]): Theme {
  return {
    id,
    title: clampTitle(String(named?.title ?? '')),
    explanation: String(named?.explanation ?? ''),
    cause: String(named?.cause ?? ''),
    fix: String(named?.fix ?? ''),
    severity: asSeverity(named?.severity),
    count: members.length,
    resultIds: members.map((m) => m.id),
    examples: members.slice(0, 3).map(example),
  };
}

async function nameCluster(engine: Engine, o: ThemeOptions, members: FailureLite[], total: number, signal: AbortSignal) {
  const sample = members.slice(0, 8).map((m, i) => `Example ${i + 1}:\n${summarize(m)}`).join('\n\n');
  const res = await engine.llm.json<any>({
    connectionId: o.connectionId,
    model: o.model || undefined,
    system: SYSTEM,
    prompt: `These ${members.length} failures (of ${total} in the run) were grouped because they look alike.\n\n${sample}\n\nName the shared failure theme.`,
    schema: THEME_SCHEMA,
    schemaName: 'failure_theme',
    temperature: 0.2,
    signal,
  });
  return { named: res.value, model: res.model };
}

/** Embeddings path: cluster summaries, then name each cluster. */
async function viaEmbeddings(engine: Engine, o: ThemeOptions, failures: FailureLite[], summaries: string[], total: number, job: JobHandle) {
  const { vectors } = await engine.embeddings.embed(summaries, { signal: job.signal });
  if (vectors.length !== failures.length) throw new Error('Embedding count does not match the failures');
  const clusters = failures.length === 1 ? [[0]] : agglomerate(vectors, SIMILARITY, o.maxThemes);
  const themes: Theme[] = [];
  let model = '';
  job.progress(0, clusters.length, 'Naming themes');
  for (const [n, idx] of clusters.entries()) {
    if (job.signal.aborted) break;
    const members = idx.map((i) => failures[i]);
    const r = await nameCluster(engine, o, members, total, job.signal);
    model = r.model;
    themes.push(buildTheme(`t${n + 1}`, r.named, members));
    job.progress(n + 1, clusters.length, `Named ${n + 1} of ${clusters.length} themes`);
  }
  return { themes, model, method: 'embeddings' as const };
}

/** LLM-only path: propose themes from a sample, then assign every failure in batches. */
async function viaLlm(engine: Engine, o: ThemeOptions, failures: FailureLite[], summaries: string[], total: number, job: JobHandle) {
  const batches = Math.ceil(failures.length / ASSIGN_BATCH);
  job.progress(0, batches + 1, 'Proposing themes');
  const sample = summaries.slice(0, 60).map((s, i) => `Failure ${i + 1}:\n${s}`).join('\n\n');
  const proposed = await engine.llm.json<any>({
    connectionId: o.connectionId,
    model: o.model || undefined,
    system: SYSTEM,
    prompt: `Here are ${Math.min(60, failures.length)} of ${total} failures from one run.\n\n${sample}\n\nGroup them into at most ${o.maxThemes} distinct failure themes. Give each theme a short unique id (t1, t2, …).`,
    schema: PROPOSE_SCHEMA,
    schemaName: 'failure_themes',
    temperature: 0.2,
    signal: job.signal,
  });
  const raw = Array.isArray(proposed.value?.themes) ? proposed.value.themes : [];
  const seen = new Set<string>();
  const defs = raw
    .filter((t: any) => t && typeof t.id === 'string' && t.id && !seen.has(t.id) && seen.add(t.id))
    .slice(0, o.maxThemes);
  if (!defs.length) throw new Error('The model returned no themes');
  job.progress(1, batches + 1, 'Assigning failures to themes');

  const themeIds = new Set(defs.map((t: any) => t.id));
  const assigned = new Map<string, string>();
  const catalog = defs.map((t: any) => `${t.id}: ${clampTitle(t.title)} — ${t.explanation}`).join('\n');
  for (let b = 0; b < batches; b++) {
    if (job.signal.aborted) break;
    const slice = failures.slice(b * ASSIGN_BATCH, (b + 1) * ASSIGN_BATCH);
    const ids = new Set(slice.map((f) => f.id));
    const list = slice.map((f) => `[${f.id}]\n${summarize(f)}`).join('\n\n');
    const res = await engine.llm.json<any>({
      connectionId: o.connectionId,
      model: o.model || undefined,
      system: SYSTEM,
      prompt: `Themes:\n${catalog}\n\nAssign each failure below to exactly one theme id. Use the result id in brackets.\n\n${list}`,
      schema: ASSIGN_SCHEMA,
      schemaName: 'theme_assignments',
      temperature: 0,
      signal: job.signal,
    });
    // Only accept ids we actually sent and themes we actually have; anything else becomes "Other".
    for (const a of Array.isArray(res.value?.assignments) ? res.value.assignments : []) {
      if (a && ids.has(a.resultId) && themeIds.has(a.themeId) && !assigned.has(a.resultId)) assigned.set(a.resultId, a.themeId);
    }
    job.progress(b + 2, batches + 1, `Assigned ${Math.min((b + 1) * ASSIGN_BATCH, failures.length)} of ${failures.length}`);
  }

  const themes: Theme[] = [];
  for (const t of defs) {
    const members = failures.filter((f) => assigned.get(f.id) === t.id);
    if (members.length) themes.push(buildTheme(t.id, t, members));
  }
  const leftovers = failures.filter((f) => !assigned.has(f.id));
  if (leftovers.length) {
    themes.push(
      buildTheme('other', { title: 'Other failures', explanation: 'Failures the model did not place in a theme.', cause: 'Varied or unclear.', fix: 'Review these rows individually.', severity: 'low' }, leftovers),
    );
  }
  return { themes, model: proposed.model, method: 'llm' as const };
}

async function findThemes(engine: Engine, runId: string, o: ThemeOptions, failures: FailureLite[], total: number, truncated: boolean, actor: any, job: JobHandle) {
  const summaries = failures.map(summarize);
  let result: { themes: Theme[]; model: string; method: 'embeddings' | 'llm' } | undefined;
  let embeddingError: string | undefined;
  try {
    if (o.useEmbeddings) {
      try {
        result = await viaEmbeddings(engine, o, failures, summaries, total, job);
      } catch (e: any) {
        if (job.signal.aborted) throw e;
        embeddingError = e?.message ?? String(e);
      }
    }
    result ??= await viaLlm(engine, o, failures, summaries, total, job);
  } catch (e: any) {
    if (job.signal.aborted) throw e;
    // Keep the free grouping usable and say why the AI step did not work.
    return { fallback: true, error: e?.message ?? String(e), groups: freeGroups(failures).groups.length };
  }
  if (job.signal.aborted) return { cancelled: true };
  const themes = result.themes.sort((a, b) => b.count - a.count);
  const data = {
    method: result.method,
    model: result.model,
    connectionId: o.connectionId,
    totalFailures: total,
    analyzed: failures.length,
    truncated,
    embeddingNote: result.method === 'llm' && embeddingError ? `Embeddings unavailable (${embeddingError}); themes were assigned by the model.` : undefined,
    themes,
  };
  const saved = saveInsight(engine.db, 'failure_themes', runId, data, actor);
  return { insightId: saved.id, method: result.method, themes: themes.length, analyzed: failures.length };
}

export const themesOps: OpDef<any, any>[] = [
  defineOp({
    name: 'get_failure_themes',
    title: 'Get failure themes',
    description:
      'Failures of a run grouped two ways: instant groups by first failing check and reason pattern (always available, free), and the latest AI themes (title, what goes wrong, likely cause, suggested fix, severity, result ids) if cluster_failures was run.',
    category: 'runs',
    readOnly: true,
    input: z.object({ runId: z.string() }),
    handler: ({ engine }, i) => {
      const run = engine.repos.runs.get(i.runId);
      const free = freeGroups(engine.repos.runs.allLite(run.id) as FailureLite[]);
      const latest = latestInsight(engine.db, 'failure_themes', run.id);
      return { runId: run.id, totalFailures: free.total, groups: free.groups, ai: latest ? { id: latest.id, createdAt: latest.createdAt, ...latest.data } : null };
    },
  }),

  defineOp({
    name: 'cluster_failures',
    title: 'Find failure themes with AI',
    description:
      'Groups the failures of a run into named themes with a likely cause and a suggested fix, using a model connection (and local embeddings when available). Runs as a background job and saves the result; read it with get_failure_themes. Returns { jobId }.',
    category: 'runs',
    input: z.object({
      runId: z.string(),
      connectionId: z.string().min(1).describe('Model connection that names the themes'),
      model: z.string().default(''),
      maxThemes: z.number().int().min(2).max(15).default(10),
      maxFailures: z.number().int().min(1).max(1000).default(300).describe('Analyse at most this many failures (the first ones in row order)'),
      useEmbeddings: z.boolean().default(true).describe('Cluster with text embeddings when available; otherwise the model assigns failures to themes'),
    }),
    handler: ({ engine, actor }, i) => {
      const run = engine.repos.runs.get(i.runId);
      engine.repos.defs.get('connection', i.connectionId);
      const all = (engine.repos.runs.allLite(run.id) as FailureLite[]).filter(isFailure);
      if (!all.length) throw invalid('This run has no failures to group');
      const failures = all.slice(0, i.maxFailures);
      const job = engine.jobs.start(
        'cluster_failures',
        `Failure themes for ${run.name}`,
        (job) => findThemes(engine, run.id, { connectionId: i.connectionId, model: i.model, maxThemes: i.maxThemes, useEmbeddings: i.useEmbeddings }, failures, all.length, all.length > failures.length, actor, job),
        actor,
        { runId: run.id },
      );
      return { jobId: job.id };
    },
  }),
];
