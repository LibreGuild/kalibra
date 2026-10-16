import Papa from 'papaparse';
import { parse as parseYaml } from 'yaml';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';
import { DEFAULT_JUDGE_PROMPT, getCheckType } from '../checks/index.js';
import { ColumnSpec, type ColumnType, type CheckSpec } from '../specs.js';
import { invalid } from '../util.js';
import { freeName, insertRows, type IncomingRow } from './common.js';

/*
 * Importers for other eval tools' files. Each one turns what it can into a Kalibra dataset (and,
 * where the source has them, a suite and targets) and reports exactly what it could not map, so
 * nothing is dropped silently.
 */

export type ExternalFormat = 'promptfoo' | 'openai_evals' | 'langsmith' | 'langfuse' | 'kalibra_bundle' | 'plain';

export interface ImportReport {
  format: ExternalFormat;
  dataset?: { id: string; name: string; rows: number; rejected: number; columns: string[] };
  suite?: { id: string; name: string; checks: number };
  targets: { id: string; name: string; kind: string; note?: string }[];
  mappedChecks: { from: string; to: string; note?: string }[];
  unsupported: { what: string; reason: string }[];
  skipped: { what: string; reason: string }[];
  warnings: string[];
}

// ── Detection ───────────────────────────────────────────────────────────────

function tryJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonlRecords(text: string): any[] | undefined {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return undefined;
  const out: any[] = [];
  for (const l of lines) {
    const v = tryJson(l);
    if (v === undefined || typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    out.push(v);
  }
  return out;
}

export function detectFormat(bytes: Uint8Array, name = ''): ExternalFormat {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'kalibra_bundle';
  const text = Buffer.from(bytes).toString('utf8');
  const lower = name.toLowerCase();
  const json = tryJson(text);
  const records = Array.isArray(json) ? json : jsonlRecords(text);
  if (records?.length && records.every((r) => r && typeof r === 'object')) {
    if (records.some((r) => 'item' in r && typeof r.item === 'object')) return 'openai_evals';
    if (records.some((r) => 'expectedOutput' in r || ('input' in r && ('datasetId' in r || 'sourceTraceId' in r)))) return 'langfuse';
    if (records.some((r) => 'inputs' in r && ('outputs' in r || 'reference_outputs' in r))) return 'langsmith';
  }
  if (json && !Array.isArray(json) && typeof json === 'object') {
    if ('tests' in json || 'prompts' in json || 'providers' in json || 'defaultTest' in json) return 'promptfoo';
    if (Array.isArray(json.items) && json.items.some((i: any) => 'expectedOutput' in i || 'input' in i)) return 'langfuse';
  }
  if (/\.ya?ml$/.test(lower) || (!json && /^\s*(description|prompts|providers|tests|defaultTest)\s*:/m.test(text))) {
    try {
      const y = parseYaml(text);
      if (y && typeof y === 'object' && ('tests' in y || 'prompts' in y || 'providers' in y)) return 'promptfoo';
    } catch {
      /* not YAML */
    }
  }
  if (/\.csv$/.test(lower) || (!json && !records)) {
    const head = Papa.parse<Record<string, string>>(text, { header: true, preview: 5, skipEmptyLines: true });
    const cols = head.meta.fields ?? [];
    if (cols.some((c) => c === 'inputs' || c.startsWith('inputs.')) && cols.some((c) => c === 'outputs' || c.startsWith('outputs.') || c.startsWith('reference_outputs'))) return 'langsmith';
  }
  return 'plain';
}

// ── Shared helpers ──────────────────────────────────────────────────────────

// `__proto__` as a plain key would replace the row object's prototype instead of adding a column.
const safeKey = (k: string) => k.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').replace(/^__proto__$/, 'proto') || 'column';

function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => v !== undefined && v !== null && v !== '');
  if (!present.length) return 'text';
  if (present.every((v) => typeof v === 'number')) return 'number';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => Array.isArray(v) && v.every((m) => m && typeof m === 'object' && 'role' in m && 'content' in m))) return 'messages';
  if (present.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number'))) return 'list';
  if (present.every((v) => typeof v === 'string')) return 'text';
  return 'json';
}

function columnsFor(rows: Record<string, unknown>[], descriptions: Record<string, string> = {}): ColumnSpec[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return keys.map((key) => ColumnSpec.parse({ key, type: inferType(rows.map((r) => r[key])), description: descriptions[key] ?? '' }));
}

function datasetName(engine: Engine, wanted: string) {
  return freeName((n) => {
    try {
      engine.repos.datasets.get(n);
      return true;
    } catch {
      return false;
    }
  }, wanted.trim() || 'Imported dataset', 'imported');
}

function defName(engine: Engine, kind: 'suite' | 'target', wanted: string) {
  return freeName((n) => {
    try {
      engine.repos.defs.get(kind, n);
      return true;
    } catch {
      return false;
    }
  }, wanted.trim() || `Imported ${kind}`, 'imported');
}

function createDataset(engine: Engine, actor: Actor, name: string, description: string, rows: IncomingRow[], report: ImportReport, descriptions: Record<string, string> = {}) {
  if (!rows.length) report.warnings.push('The file has no rows');
  const columns = columnsFor(rows.map((r) => r.data), descriptions);
  const ds = engine.repos.datasets.create({ name: datasetName(engine, name), description, schema: { columns, instructions: '' } }, actor);
  const res = insertRows(engine, ds.id, ds.schema.columns, rows, actor, { importedFrom: report.format });
  report.dataset = { id: ds.id, name: ds.name, rows: res.added.length, rejected: res.rejected.length, columns: columns.map((c) => c.key) };
  if (res.rejected.length) report.warnings.push(`${res.rejected.length} rows could not be imported: ${res.rejected[0].errors.join('; ')}`);
  engine.events.emit({ type: 'dataset.changed', datasetId: ds.id, actor });
  return ds;
}

/** Maps generic field intents (expected, threshold…) onto a check type's real config keys. */
function fitConfig(type: string, intent: Record<string, unknown>): Record<string, unknown> {
  const t = getCheckType(type);
  let keys: string[] = [];
  try {
    keys = Object.keys((t?.config.parse({}) as object) ?? {});
  } catch {
    keys = [];
  }
  const out: Record<string, unknown> = {};
  const aliases: Record<string, string[]> = {
    expected: ['expected', 'reference'],
    threshold: ['threshold', 'min', 'minScore', 'minSimilarity'],
  };
  for (const [k, v] of Object.entries(intent)) {
    if (v === undefined) continue;
    const candidates = aliases[k] ?? [k];
    const key = candidates.find((c) => keys.includes(c)) ?? (keys.length ? undefined : k);
    if (key) out[key] = v;
  }
  return out;
}

// ── promptfoo ───────────────────────────────────────────────────────────────

/** Converts promptfoo's Nunjucks-ish {{ var }} into Kalibra templates (same syntax, minus odd spacing). */
const pfTemplate = (s: string) => String(s).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, e) => `{{${e.trim()}}}`);

function renderSimple(template: string, vars: Record<string, unknown>) {
  return template.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, k) => {
    const v = k.split('.').reduce((o: any, p: string) => (o == null ? undefined : o[p]), vars);
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

interface PfAssert {
  type: string;
  value?: unknown;
  threshold?: number;
  weight?: number;
  metric?: string;
}

function importPromptfoo(engine: Engine, text: string, name: string | undefined, actor: Actor, report: ImportReport) {
  let cfg: any;
  try {
    cfg = tryJson(text) ?? parseYaml(text);
  } catch (e: any) {
    throw invalid(`Could not read the promptfoo config: ${e?.message ?? e}`);
  }
  if (!cfg || typeof cfg !== 'object') throw invalid('The promptfoo config is empty');

  const defaultVars: Record<string, unknown> = cfg.defaultTest?.vars ?? {};
  let tests: any[] = [];
  if (typeof cfg.tests === 'string') report.skipped.push({ what: `tests: ${cfg.tests}`, reason: 'Tests in separate files are not readable from here; import that CSV/YAML file separately' });
  else if (Array.isArray(cfg.tests)) {
    for (const t of cfg.tests) {
      if (typeof t === 'string') report.skipped.push({ what: `tests: ${t}`, reason: 'File references are not readable from here' });
      else if (t && typeof t === 'object') tests.push(t);
    }
  }
  if (cfg.scenarios) report.unsupported.push({ what: 'scenarios', reason: 'Scenario matrices are not supported yet; their tests were not imported' });

  // Prompts: inline strings become a rendered `prompt` column so targets can send {{prompt}}.
  const prompts: string[] = [];
  for (const p of Array.isArray(cfg.prompts) ? cfg.prompts : cfg.prompts ? [cfg.prompts] : []) {
    if (typeof p === 'string' && !p.startsWith('file://')) prompts.push(p);
    else if (p && typeof p === 'object' && typeof p.raw === 'string') prompts.push(p.raw);
    else report.skipped.push({ what: `prompt ${typeof p === 'string' ? p : p?.id ?? ''}`.trim(), reason: 'Prompt files are not readable from here' });
  }
  if (prompts.length > 1) report.warnings.push(`${prompts.length} prompts found; the first is used for the "prompt" column. Use a comparison run to test the others.`);

  // Assertions: values that are the same in every test stay in the check; varying values become row columns.
  const allAsserts: PfAssert[][] = tests.map((t) => [...(cfg.defaultTest?.assert ?? []), ...(t.assert ?? [])].filter((a: any) => a && typeof a.type === 'string'));
  const byType = new Map<string, { values: unknown[]; present: boolean[]; asserts: PfAssert[] }>();
  allAsserts.forEach((list, i) => {
    for (const a of list) {
      if (!byType.has(a.type)) byType.set(a.type, { values: Array(tests.length).fill(undefined), present: Array(tests.length).fill(false), asserts: [] });
      const e = byType.get(a.type)!;
      e.asserts.push(a);
      e.present[i] = true;
      const prev = e.values[i];
      e.values[i] = prev === undefined ? a.value : [...(Array.isArray(prev) ? prev : [prev]), a.value];
    }
  });

  const rowsData: Record<string, unknown>[] = tests.map((t) => {
    const vars: Record<string, unknown> = { ...defaultVars, ...(t.vars ?? {}) };
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'string' && v.startsWith('file://')) {
        report.skipped.push({ what: `var ${k}: ${v}`, reason: 'File-backed variables are not readable from here' });
        continue;
      }
      data[safeKey(k)] = v;
    }
    if (prompts[0]) data.prompt = renderSimple(prompts[0], vars);
    if (typeof t.description === 'string' && t.description) data.test_description = t.description;
    return data;
  });

  const checks: CheckSpec[] = [];
  let n = 0;
  const add = (from: string, type: string, config: Record<string, unknown>, a?: PfAssert, extra: Partial<CheckSpec> = {}, note?: string) => {
    if (!getCheckType(type)) {
      report.unsupported.push({ what: `assert ${from}`, reason: `Kalibra has no "${type}" check in this version` });
      return;
    }
    checks.push({ id: `pf_${++n}`, type, name: a?.metric || `${from}`, enabled: true, gate: false, weight: a?.weight ?? 1, applyWhen: '', config, ...extra });
    report.mappedChecks.push({ from, to: type, note });
  };

  for (const [rawType, { values, present, asserts }] of byType) {
    const negated = rawType.startsWith('not-');
    const type = negated ? rawType.slice(4) : rawType;
    const first = asserts[0];
    const constant = present.every(Boolean) && values.every((v) => stableEq(v, values[0]));
    const col = `assert_${safeKey(rawType).replace(/-/g, '_')}`;
    // Assertions that differ between tests (or appear only in some) become a row column; checks
    // read it and are skipped on rows without it.
    const perRow = !constant;
    if (perRow) present.forEach((p, i) => p && (rowsData[i][col] = values[i] ?? true));
    const distinct = new Set(values.filter((v) => v !== undefined).map((v) => JSON.stringify(v))).size;
    const ref = (fallback: unknown) => (perRow ? `{{${col}}}` : typeof fallback === 'string' ? pfTemplate(fallback) : JSON.stringify(fallback ?? ''));
    const when = perRow ? `typeof ${col} !== 'undefined' && ${col} !== null && ${col} !== ''` : '';
    const value = values.find((v) => v !== undefined);

    switch (type) {
      case 'equals':
        if (negated) add(rawType, 'expression', { expression: perRow ? `String(output).trim() !== String(${col}).trim()` : `String(output).trim() !== ${JSON.stringify(String(value ?? ''))}` }, first, { applyWhen: when });
        else add(rawType, 'equals', { actual: '{{output}}', expected: ref(value) }, first, { applyWhen: when });
        break;
      case 'contains':
      case 'icontains':
      case 'contains-any':
      case 'icontains-any':
      case 'contains-all':
      case 'icontains-all': {
        const mode = negated ? 'none' : type.includes('any') ? 'any' : 'all';
        const values_ = perRow ? [`{{${col}}}`] : (Array.isArray(value) ? value : [value]).map((v) => pfTemplate(String(v)));
        add(rawType, 'contains', { actual: '{{output}}', values: values_, mode, caseInsensitive: type.startsWith('i') }, first, { applyWhen: when });
        break;
      }
      case 'starts-with':
        add(rawType, 'regex', { actual: '{{output}}', pattern: perRow ? `^{{${col}}}` : `^${escapeRe(String(value))}`, flags: '', mustMatch: !negated }, first, { applyWhen: when }, perRow ? 'Prefix is used as a regex; escape special characters if needed' : undefined);
        break;
      case 'regex':
        add(rawType, 'regex', { actual: '{{output}}', pattern: perRow ? `{{${col}}}` : String(value), flags: '', mustMatch: !negated }, first, { applyWhen: when });
        break;
      case 'is-json':
      case 'contains-json':
        if (negated) report.unsupported.push({ what: `assert ${rawType}`, reason: 'Negated JSON checks are not supported; use a script check' });
        else add(rawType, 'is_json', { actual: '{{output}}' }, first, { applyWhen: when }, type === 'contains-json' ? 'Checks the whole output is JSON (promptfoo also accepts JSON inside text)' : undefined);
        if (value && typeof value === 'object') add(`${rawType} schema`, 'json_schema', { actual: '{{output}}', schema: JSON.stringify(value, null, 2) }, first, { applyWhen: when });
        break;
      case 'javascript': {
        const code = (v: unknown) => {
          const s = String(v ?? '');
          return /\breturn\b/.test(s) ? s : `return (${s});`;
        };
        if (distinct > 1) report.warnings.push('Different javascript assertions per test were merged; only the first one is used');
        add(rawType, 'script', { code: `// Imported from promptfoo\nconst context = { vars: row };\n${negated ? `const __r = (() => { ${code(value)} })();\nreturn !__r;` : code(value)}` }, first, { applyWhen: when }, 'Runs the JavaScript from the config on your computer; review it before running');
        break;
      }
      case 'similar':
        if (getCheckType('semantic_similarity')) add(rawType, 'semantic_similarity', fitConfig('semantic_similarity', { actual: '{{output}}', expected: ref(value), threshold: first?.threshold ?? 0.75 }), first, { applyWhen: when });
        else add(rawType, 'similarity', { actual: '{{output}}', expected: ref(value), threshold: first?.threshold ?? 0.75 }, first, { applyWhen: when }, 'Uses text similarity; semantic similarity is not available here');
        break;
      case 'levenshtein':
        add(rawType, 'similarity', { actual: '{{output}}', expected: ref(value), threshold: 0.8 }, first, { applyWhen: when }, 'promptfoo uses a maximum edit distance; converted to similarity ≥ 0.8 — review the threshold');
        break;
      case 'rouge-n':
      case 'rouge-l':
        add(rawType, 'rouge_l', { actual: '{{output}}', reference: ref(value), min: first?.threshold ?? 0.5 }, first, { applyWhen: when }, type === 'rouge-n' ? 'ROUGE-N mapped to ROUGE-L' : undefined);
        break;
      case 'bleu':
        add(rawType, 'bleu', { actual: '{{output}}', reference: ref(value), min: first?.threshold ?? 0.5 }, first, { applyWhen: when });
        break;
      case 'llm-rubric':
      case 'model-graded-closedqa':
      case 'factuality':
      case 'g-eval': {
        const criteria = perRow ? undefined : String(value ?? '');
        const config: Record<string, unknown> = { connectionId: '', criteria: criteria || 'The output meets the rubric.' };
        if (perRow) config.prompt = DEFAULT_JUDGE_PROMPT.replace('{{criteria}}', `{{${col}}}`);
        if (type === 'factuality') config.reference = ref(value);
        add(rawType, 'llm_judge', config, first, { applyWhen: when, enabled: false }, 'Pick a connection for the judge, then enable it');
        break;
      }
      case 'latency':
        add(rawType, 'latency', { metric: 'latency_ms', max: first?.threshold ?? 5000 }, first, { applyWhen: when });
        break;
      case 'is-refusal':
        add(rawType, 'refusal', { actual: '{{output}}', expected: negated ? 'answer' : 'refuse' }, first, { applyWhen: when });
        break;
      default:
        report.unsupported.push({ what: `assert ${rawType}`, reason: 'No matching Kalibra check; use a script check for custom logic' });
    }
  }

  const title = name || cfg.description || 'promptfoo import';
  const rows: IncomingRow[] = rowsData.map((data) => ({ data, tags: ['promptfoo'] }));
  const ds = createDataset(engine, actor, String(title), typeof cfg.description === 'string' ? cfg.description : 'Imported from a promptfoo config', rows, report, { prompt: 'The prompt rendered with this test’s vars', test_description: 'promptfoo test description' });

  if (checks.length) {
    const suite = engine.repos.defs.create('suite', { name: defName(engine, 'suite', `${title} checks`), description: 'Imported from promptfoo assertions', spec: { checks } }, actor);
    report.suite = { id: suite.id, name: suite.name, checks: checks.length };
    engine.events.emit({ type: 'def.changed', kind: 'suite', id: suite.id, actor });
  }

  // Providers → targets.
  const providers = Array.isArray(cfg.providers) ? cfg.providers : cfg.providers ? [cfg.providers] : [];
  for (const p of providers) {
    const id: string = typeof p === 'string' ? p : String(p?.id ?? '');
    const pc = typeof p === 'object' ? p.config ?? {} : {};
    const label = (typeof p === 'object' && p.label) || id;
    let spec: Record<string, unknown> | undefined;
    let note: string | undefined;
    if (id === 'http' || id === 'https' || /^https?:\/\//.test(id)) {
      const url = pfTemplate(String(pc.url ?? (id.startsWith('http') ? id : '')));
      const body = pc.body;
      const headers = Object.entries(pc.headers ?? {}).map(([key, value]) => ({ key, value: pfTemplate(String(value)), enabled: true }));
      let outputs = [{ name: 'output', from: 'text', path: '' }];
      if (typeof pc.transformResponse === 'string') {
        const expr = pc.transformResponse.replace(/\bjson\b/g, 'body');
        outputs = [{ name: 'output', from: 'expression', path: expr }];
        note = 'transformResponse converted to an expression on `body`; check it with Try it';
      }
      spec = {
        config: {
          kind: 'http',
          method: String(pc.method ?? 'POST').toUpperCase(),
          url,
          headers,
          body: body === undefined ? { type: 'none' } : typeof body === 'string' ? { type: 'text', content: pfTemplate(body) } : { type: 'json', content: pfTemplate(JSON.stringify(body, null, 2)).replace(/"\{\{(\w+)\}\}"/g, '"{{$1}}"') },
          outputs,
        },
      };
    } else {
      const m = /^(openai|anthropic|vertex|google|bedrock|azure|azureopenai|ollama|openrouter|mistral|groq|xai)(?::(?:chat|messages|completion))?:(.+)$/.exec(id);
      if (m) {
        spec = { config: { kind: 'model', connectionId: '', model: m[2], prompt: prompts[0] ? '{{prompt}}' : '{{input}}', temperature: typeof pc.temperature === 'number' ? pc.temperature : undefined } };
        note = 'Pick a connection for this model target';
      }
    }
    if (!spec) {
      report.unsupported.push({ what: `provider ${id}`, reason: 'Only http providers and model providers are imported; wrap others in a script target' });
      continue;
    }
    try {
      const t = engine.repos.defs.create('target', { name: defName(engine, 'target', String(label)), description: `Imported from promptfoo provider ${id}`, spec }, actor);
      report.targets.push({ id: t.id, name: t.name, kind: String((spec.config as any).kind), note });
      engine.events.emit({ type: 'def.changed', kind: 'target', id: t.id, actor });
    } catch (e: any) {
      report.unsupported.push({ what: `provider ${id}`, reason: e?.message ?? String(e) });
    }
  }
  return ds;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function stableEq(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── OpenAI Evals ────────────────────────────────────────────────────────────

const oaTemplate = (s: string) =>
  String(s)
    .replace(/\{\{\s*item\.([\w.]+)\s*\}\}/g, '{{$1}}')
    .replace(/\{\{\s*sample\.output_text\s*\}\}/g, '{{output}}')
    .replace(/\{\{\s*sample\.output_json\s*\}\}/g, '{{output | json}}');

function importOpenAiEvals(engine: Engine, text: string, name: string | undefined, actor: Actor, report: ImportReport, graders?: unknown) {
  const json = tryJson(text);
  const records = Array.isArray(json) ? json : jsonlRecords(text);
  if (!records) throw invalid('The file is not JSONL');
  const rows: IncomingRow[] = records.map((r: any) => {
    const item = r && typeof r.item === 'object' && r.item ? r.item : r;
    return { data: Object.fromEntries(Object.entries(item).map(([k, v]) => [safeKey(k), v])) };
  });
  createDataset(engine, actor, name || 'OpenAI Evals import', 'Imported from an OpenAI Evals data file', rows, report);

  const list = Array.isArray(graders) ? graders : (graders as any)?.testing_criteria ?? [];
  const checks: CheckSpec[] = [];
  let n = 0;
  const push = (from: string, type: string, config: Record<string, unknown>, g: any, note?: string, enabled = true) => {
    checks.push({ id: `oa_${++n}`, type, name: g.name || from, enabled, gate: false, weight: 1, applyWhen: '', config });
    report.mappedChecks.push({ from, to: type, note });
  };
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    const input = oaTemplate(g.input ?? '{{output}}');
    switch (g.type) {
      case 'string_check': {
        const ref = oaTemplate(g.reference ?? '');
        if (g.operation === 'eq') push('string_check eq', 'equals', { actual: input, expected: ref }, g);
        else if (g.operation === 'ne') push('string_check ne', 'expression', { expression: `String(output).trim() !== String(${JSON.stringify(ref)}).trim()` }, g, 'The expected value is compared literally; edit if it uses a column');
        else if (g.operation === 'like' || g.operation === 'ilike') push(`string_check ${g.operation}`, 'contains', { actual: input, values: [ref], mode: 'all', caseInsensitive: g.operation === 'ilike' }, g);
        else report.unsupported.push({ what: `string_check ${g.operation}`, reason: 'Unknown operation' });
        break;
      }
      case 'text_similarity': {
        const metric = String(g.evaluation_metric ?? 'fuzzy_match');
        const ref = oaTemplate(g.reference ?? '');
        const t = typeof g.pass_threshold === 'number' ? g.pass_threshold : 0.8;
        if (metric === 'fuzzy_match') push('text_similarity fuzzy_match', 'similarity', { actual: input, expected: ref, threshold: t }, g);
        else if (metric === 'bleu' || metric === 'gleu') push(`text_similarity ${metric}`, 'bleu', { actual: input, reference: ref, min: t }, g, metric === 'gleu' ? 'GLEU mapped to BLEU' : undefined);
        else if (/^rouge/.test(metric)) push(`text_similarity ${metric}`, 'rouge_l', { actual: input, reference: ref, min: t }, g, metric !== 'rouge_l' ? `${metric} mapped to ROUGE-L` : undefined);
        else if (metric === 'cosine' && getCheckType('semantic_similarity')) push('text_similarity cosine', 'semantic_similarity', fitConfig('semantic_similarity', { actual: input, expected: ref, threshold: t }), g);
        else report.unsupported.push({ what: `text_similarity ${metric}`, reason: 'No equivalent metric yet' });
        break;
      }
      case 'score_model':
      case 'label_model': {
        const msgs = Array.isArray(g.input) ? g.input : [];
        const criteria = msgs.map((m: any) => (typeof m?.content === 'string' ? m.content : '')).filter(Boolean).join('\n\n') || 'Grade the output.';
        push(g.type, 'llm_judge', { connectionId: '', model: g.model ?? '', criteria: oaTemplate(criteria) }, g, 'Pick a connection for the judge, then enable it', false);
        break;
      }
      default:
        report.unsupported.push({ what: `grader ${g.type ?? '?'}`, reason: g.type === 'python' ? 'Python graders are not supported; port it to a script check' : 'Unknown grader' });
    }
  }
  if (checks.length) {
    const suite = engine.repos.defs.create('suite', { name: defName(engine, 'suite', `${name || 'OpenAI Evals'} graders`), description: 'Imported from OpenAI Evals graders', spec: { checks } }, actor);
    report.suite = { id: suite.id, name: suite.name, checks: checks.length };
    engine.events.emit({ type: 'def.changed', kind: 'suite', id: suite.id, actor });
  }
}

// ── LangSmith ───────────────────────────────────────────────────────────────

function parseJsonCell(v: unknown) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  return tryJson(t) ?? v;
}

function importLangSmith(engine: Engine, text: string, name: string | undefined, actor: Actor, report: ImportReport) {
  const json = tryJson(text);
  let records: Record<string, unknown>[] = Array.isArray(json) ? json : jsonlRecords(text) ?? [];
  if (!records.length) records = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true }).data;
  const rows: IncomingRow[] = records.map((r) => {
    const data: Record<string, unknown> = {};
    let tags: string[] = [];
    let split: string | null = null;
    const put = (prefix: string, obj: unknown, key: string) => {
      const v = parseJsonCell(obj);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) data[safeKey(prefix + k)] = x;
      else if (v !== undefined && v !== '') data[safeKey(prefix ? prefix.replace(/_$/, '') : key)] = v;
    };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'inputs') put('', v, 'input');
      else if (k === 'outputs' || k === 'reference_outputs') put('expected_', v, 'expected');
      else if (k.startsWith('inputs.')) data[safeKey(k.slice(7))] = parseJsonCell(v);
      else if (k.startsWith('outputs.')) data[safeKey(`expected_${k.slice(8)}`)] = parseJsonCell(v);
      else if (k === 'metadata') {
        const m = parseJsonCell(v) as any;
        if (m && typeof m === 'object') {
          if (typeof m.split === 'string') split = m.split;
          if (Array.isArray(m.tags)) tags = m.tags.filter((t: unknown) => typeof t === 'string');
        }
      } else if (k === 'split' && typeof v === 'string') split = v;
      else if (!['id', 'example_id', 'created_at', 'modified_at', 'dataset_id'].includes(k)) data[safeKey(k)] = parseJsonCell(v);
    }
    // Single `expected_output`/`expected_answer` reads more naturally as `expected`.
    const exp = Object.keys(data).filter((k) => k.startsWith('expected_'));
    if (exp.length === 1 && !('expected' in data)) {
      data.expected = data[exp[0]];
      delete data[exp[0]];
    }
    return { data, tags, split };
  });
  createDataset(engine, actor, name || 'LangSmith import', 'Imported from a LangSmith dataset export', rows, report);
}

// ── Langfuse ────────────────────────────────────────────────────────────────

function importLangfuse(engine: Engine, text: string, name: string | undefined, actor: Actor, report: ImportReport) {
  const json = tryJson(text);
  const records: any[] = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : Array.isArray(json?.data) ? json.data : jsonlRecords(text) ?? [];
  const rows: IncomingRow[] = records.map((r) => {
    const data: Record<string, unknown> = {};
    const input = parseJsonCell(r.input);
    if (input && typeof input === 'object' && !Array.isArray(input)) for (const [k, v] of Object.entries(input)) data[safeKey(k)] = v;
    else if (Array.isArray(input) && input.every((m: any) => m && typeof m === 'object' && 'role' in m)) data.messages = input;
    else if (input !== undefined) data.input = input;
    const exp = parseJsonCell(r.expectedOutput ?? r.expected_output);
    if (exp && typeof exp === 'object' && !Array.isArray(exp)) for (const [k, v] of Object.entries(exp)) data[safeKey(`expected_${k}`)] = v;
    else if (exp !== undefined && exp !== null) data.expected = exp;
    const meta = parseJsonCell(r.metadata);
    if (meta && typeof meta === 'object' && Object.keys(meta).length) data.metadata = meta;
    const archived = r.status === 'ARCHIVED';
    return { data, status: archived ? 'rejected' : 'approved', tags: archived ? ['archived'] : [] };
  });
  createDataset(engine, actor, name || 'Langfuse import', 'Imported from a Langfuse dataset export', rows, report);
}

// ── Entry ───────────────────────────────────────────────────────────────────

export function inspectExternal(bytes: Uint8Array, fileName = '') {
  const format = detectFormat(bytes, fileName);
  const text = format === 'kalibra_bundle' ? '' : Buffer.from(bytes).toString('utf8');
  const out: { format: ExternalFormat; rows?: number; columns?: string[]; asserts?: number; providers?: number } = { format };
  if (format === 'promptfoo') {
    const cfg: any = tryJson(text) ?? parseYaml(text);
    out.rows = Array.isArray(cfg?.tests) ? cfg.tests.length : 0;
    out.asserts = (Array.isArray(cfg?.tests) ? cfg.tests : []).reduce((n: number, t: any) => n + (Array.isArray(t?.assert) ? t.assert.length : 0), 0);
    out.providers = Array.isArray(cfg?.providers) ? cfg.providers.length : cfg?.providers ? 1 : 0;
  } else if (format !== 'kalibra_bundle' && format !== 'plain') {
    const json = tryJson(text);
    const recs = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : jsonlRecords(text);
    out.rows = recs?.length ?? Papa.parse(text, { header: true, skipEmptyLines: true }).data.length;
  }
  return out;
}

export function importExternal(engine: Engine, bytes: Uint8Array, opts: { format: ExternalFormat | 'auto'; name?: string; fileName?: string; graders?: unknown }, actor: Actor): ImportReport {
  const format = opts.format === 'auto' ? detectFormat(bytes, opts.fileName) : opts.format;
  const report: ImportReport = { format, targets: [], mappedChecks: [], unsupported: [], skipped: [], warnings: [] };
  const text = Buffer.from(bytes).toString('utf8');
  switch (format) {
    case 'promptfoo':
      importPromptfoo(engine, text, opts.name, actor, report);
      break;
    case 'openai_evals':
      importOpenAiEvals(engine, text, opts.name, actor, report, opts.graders);
      break;
    case 'langsmith':
      importLangSmith(engine, text, opts.name, actor, report);
      break;
    case 'langfuse':
      importLangfuse(engine, text, opts.name, actor, report);
      break;
    case 'kalibra_bundle':
      throw invalid('This is a Kalibra bundle; import it with import_bundle');
    default:
      throw invalid('Format not recognised. For a plain CSV/JSONL, create a dataset and use import_rows.');
  }
  return report;
}
