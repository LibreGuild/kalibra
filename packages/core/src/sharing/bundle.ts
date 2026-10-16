import { createHash } from 'node:crypto';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';
import { DEF_KINDS, DatasetSchema, type DefKind } from '../specs.js';
import { invalid, newId, nowIso, parseJson } from '../util.js';
import {
  APP_VERSION,
  codeWarning,
  findCode,
  freeName,
  insertRows,
  jsonOf,
  jsonl,
  readZip,
  secretNames,
  stableStringify,
  textOf,
  uniqueSlugs,
  writeZip,
  type IncomingRow,
} from './common.js';

/*
 * A bundle (.kalibra) is a zip a teammate can import: definitions, datasets with their media,
 * and optionally runs with results. Secret values are never included — only the names a
 * teammate has to set. Ids are remapped on import so nothing collides.
 */

export const BUNDLE_FORMAT = 'kalibra-bundle';
export const BUNDLE_VERSION = 1;

const DEF_DIRS: Record<DefKind, string> = { target: 'targets', suite: 'suites', connection: 'connections' };
const STORE_ONLY = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|ogg|mp4|webm|flac)|video\/)/;

export interface ExportOptions {
  datasets?: string[];
  targets?: string[];
  suites?: string[];
  connections?: string[];
  runs?: string[];
  everything?: boolean;
  includeRuns?: boolean;
  includeMedia?: boolean;
  name?: string;
}

export interface BundleManifest {
  format: string;
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  name: string;
  counts: Record<string, number>;
  secrets: string[];
  media: { included: boolean; files: number; bytes: number; missing: number };
  contents: {
    datasets: { name: string; path: string; rows: number }[];
    targets: { name: string; path: string }[];
    suites: { name: string; path: string }[];
    connections: { name: string; path: string }[];
    runs: { name: string; path: string; results: number }[];
  };
  autoIncluded: string[];
}

const fileValues = (data: Record<string, unknown>) =>
  Object.values(data).filter((v): v is { blob: string } => !!v && typeof v === 'object' && typeof (v as any).blob === 'string');

export async function exportBundle(engine: Engine, o: ExportOptions): Promise<{ bytes: Uint8Array; manifest: BundleManifest }> {
  const { datasets: dsRepo, defs, runs: runRepo } = engine.repos;
  const pick = <T,>(ids: string[] | undefined, all: () => T[], get: (id: string) => T) => (o.everything ? all() : (ids ?? []).map(get));

  const runRecords = o.everything && o.includeRuns ? runRepo.list({ limit: 10_000 }).runs : (o.runs ?? []).map((id) => runRepo.get(id));
  const datasets = new Map(pick(o.datasets, () => dsRepo.list().map((d) => dsRepo.get(d.id)), (id) => dsRepo.get(id)).map((d) => [d.id, d]));
  const defSets: Record<DefKind, Map<string, any>> = {
    target: new Map(pick(o.targets, () => defs.list('target'), (id) => defs.get('target', id)).map((d) => [d.id, d])),
    suite: new Map(pick(o.suites, () => defs.list('suite'), (id) => defs.get('suite', id)).map((d) => [d.id, d])),
    connection: new Map(pick(o.connections, () => defs.list('connection'), (id) => defs.get('connection', id)).map((d) => [d.id, d])),
  };

  // Runs need their dataset, target and suite to make sense on the other side.
  const autoIncluded: string[] = [];
  for (const r of runRecords) {
    if (r.datasetId && !datasets.has(r.datasetId)) {
      try {
        const d = dsRepo.get(r.datasetId);
        datasets.set(d.id, d);
        autoIncluded.push(`dataset "${d.name}"`);
      } catch {
        /* dataset was deleted; results still carry their inputs */
      }
    }
    for (const [kind, id] of [['target', r.targetId], ['suite', r.suiteId]] as const) {
      if (id && !defSets[kind].has(id)) {
        try {
          const d = defs.get(kind, id);
          defSets[kind].set(d.id, d);
          autoIncluded.push(`${kind} "${d.name}"`);
        } catch {
          /* deleted definition */
        }
      }
    }
  }
  if (!datasets.size && !runRecords.length && !Object.values(defSets).some((s) => s.size)) throw invalid('Pick something to export');

  const entries = new Map<string, Uint8Array | string>();
  const storeOnly = new Set<string>();
  const secrets = new Set<string>();
  const contents: BundleManifest['contents'] = { datasets: [], targets: [], suites: [], connections: [], runs: [] };

  for (const kind of ['target', 'suite', 'connection'] as DefKind[]) {
    const list = [...defSets[kind].values()];
    const slugs = uniqueSlugs(list.map((d) => d.name));
    for (const d of list) {
      const path = `definitions/${DEF_DIRS[kind]}/${slugs.get(d.name)}.json`;
      for (const s of secretNames(d.spec)) secrets.add(s);
      entries.set(path, stableStringify({ kind, sourceId: d.id, name: d.name, description: d.description, version: d.version, spec: d.spec }, 2));
      contents[`${kind}s` as 'targets'].push({ name: d.name, path });
    }
  }

  const media = new Set<string>();
  const dsList = [...datasets.values()];
  const dsSlugs = uniqueSlugs(dsList.map((d) => d.name));
  for (const d of dsList) {
    const base = `datasets/${dsSlugs.get(d.name)}`;
    const { rows } = dsRepo.listRows(d.id, { limit: 10_000_000 });
    entries.set(`${base}/schema.json`, stableStringify({ sourceId: d.id, name: d.name, description: d.description, schema: d.schema }, 2));
    entries.set(`${base}/rows.jsonl`, rows.map((r) => stableStringify({ id: r.id, data: r.data, tags: r.tags, status: r.status, split: r.split, provenance: r.provenance })).join('\n') + (rows.length ? '\n' : ''));
    for (const r of rows) for (const f of fileValues(r.data)) media.add(f.blob);
    contents.datasets.push({ name: d.name, path: base, rows: rows.length });
  }

  for (const r of runRecords) {
    const base = `runs/${r.id}`;
    const results = engine.db.all('SELECT * FROM results WHERE run_id = ? ORDER BY seq', r.id);
    entries.set(`${base}/run.json`, stableStringify({ ...r, datasetName: datasets.get(r.datasetId ?? '')?.name ?? null, targetName: defSets.target.get(r.targetId ?? '')?.name ?? null, suiteName: defSets.suite.get(r.suiteId ?? '')?.name ?? null }, 2));
    entries.set(`${base}/results.jsonl`, results.map((x) => stableStringify(x)).join('\n') + (results.length ? '\n' : ''));
    for (const x of results) for (const f of fileValues(parseJson(x.input, {}))) media.add(f.blob);
    contents.runs.push({ name: r.name, path: base, results: results.length });
  }

  let mediaBytes = 0;
  let missing = 0;
  if (o.includeMedia !== false) {
    for (const hash of [...media].sort()) {
      if (!engine.blobs.has(hash)) {
        missing++;
        continue;
      }
      const bytes = await engine.blobs.get(hash);
      const path = `media/${hash}`;
      entries.set(path, bytes);
      if (STORE_ONLY.test(engine.blobs.info(hash)?.mime ?? '')) storeOnly.add(path);
      mediaBytes += bytes.byteLength;
    }
  }

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_VERSION,
    appVersion: APP_VERSION,
    createdAt: nowIso(),
    name: o.name || 'Kalibra bundle',
    counts: {
      datasets: contents.datasets.length,
      rows: contents.datasets.reduce((n, d) => n + d.rows, 0),
      targets: contents.targets.length,
      suites: contents.suites.length,
      connections: contents.connections.length,
      runs: contents.runs.length,
      results: contents.runs.reduce((n, r) => n + r.results, 0),
    },
    secrets: [...secrets].sort(),
    media: { included: o.includeMedia !== false, files: o.includeMedia !== false ? media.size - missing : 0, bytes: mediaBytes, missing },
    contents,
    autoIncluded,
  };
  entries.set('manifest.json', stableStringify(manifest, 2));
  // Blob metadata (names, types) so imported files keep their names.
  const blobInfo = Object.fromEntries([...media].sort().map((h) => [h, engine.blobs.info(h) ?? null]).filter(([, v]) => v));
  entries.set('media.json', stableStringify(blobInfo, 2));
  return { bytes: writeZip(entries, storeOnly), manifest };
}

// ── Import ──────────────────────────────────────────────────────────────────

export type ConflictMode = 'rename' | 'skip' | 'new_version';

// Run files may be hand-edited or come from other tools: only text, numbers and null reach the
// database (SQLite rejects booleans and objects, which would abort the import halfway).
const str = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : null);

function openBundle(bytes: Uint8Array) {
  const files = readZip(bytes);
  const manifest = jsonOf<BundleManifest>(files.get('manifest.json'), 'manifest.json');
  if (manifest.format !== BUNDLE_FORMAT) throw invalid('This zip is not a Kalibra bundle (manifest.json has a different format)');
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > BUNDLE_VERSION) {
    throw invalid(`This bundle was made by a newer Kalibra (bundle format ${manifest.formatVersion}). Update Kalibra to import it.`);
  }
  return { files, manifest };
}

function readDefs(files: Map<string, Uint8Array>) {
  const out: { kind: DefKind; name: string; description: string; spec: unknown; sourceId: string; path: string }[] = [];
  for (const [path, bytes] of files) {
    const m = /^definitions\/(targets|suites|connections)\/[^/]+\.json$/.exec(path);
    if (!m) continue;
    const d = jsonOf<any>(bytes, path);
    const kind = ({ targets: 'target', suites: 'suite', connections: 'connection' } as const)[m[1] as 'targets'];
    if (typeof d?.name !== 'string' || !d.name.trim()) throw invalid(`${path} has no name`);
    out.push({ kind, name: d.name, description: d.description ?? '', spec: d.spec, sourceId: d.sourceId ?? path, path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readDatasets(files: Map<string, Uint8Array>) {
  const out: { name: string; description: string; schema: DatasetSchema; sourceId: string; rows: IncomingRow[]; path: string }[] = [];
  for (const [path, bytes] of files) {
    const m = /^(datasets\/[^/]+)\/schema\.json$/.exec(path);
    if (!m) continue;
    const s = jsonOf<any>(bytes, path);
    const parsed = DatasetSchema.safeParse(s.schema ?? {});
    if (!parsed.success) throw invalid(`${path}: invalid dataset schema`);
    out.push({
      name: String(s.name ?? m[1].split('/')[1]),
      description: s.description ?? '',
      schema: parsed.data,
      sourceId: s.sourceId ?? m[1],
      rows: jsonl<IncomingRow>(textOf(files.get(`${m[1]}/rows.jsonl`)), `${m[1]}/rows.jsonl`),
      path: m[1],
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function inspectBundle(engine: Engine, bytes: Uint8Array) {
  const { files, manifest } = openBundle(bytes);
  const { datasets, defs } = engine.repos;
  const exists = (kind: DefKind | 'dataset', name: string) => {
    try {
      kind === 'dataset' ? datasets.get(name) : defs.get(kind, name);
      return true;
    } catch {
      return false;
    }
  };
  const defsIn = readDefs(files);
  const items = [
    ...readDatasets(files).map((d) => ({ kind: 'dataset', name: d.name, rows: d.rows.length, exists: exists('dataset', d.name) })),
    ...defsIn.map((d) => ({ kind: d.kind, name: d.name, exists: exists(d.kind, d.name) })),
    ...[...files.keys()].filter((p) => /^runs\/[^/]+\/run\.json$/.test(p)).map((p) => ({ kind: 'run', name: jsonOf<any>(files.get(p), p).name, exists: false })),
  ];
  const code = findCode(defsIn);
  const warning = codeWarning('This bundle', code);
  return { manifest, items, conflicts: items.filter((i) => i.exists).length, secretsMissing: await missingSecretsAsync(engine, manifest.secrets ?? []), code, warnings: warning ? [warning] : [] };
}

async function missingSecretsAsync(engine: Engine, names: string[]) {
  const have = new Set(await engine.secrets.list());
  return names.filter((n) => !have.has(n));
}

export async function importBundle(engine: Engine, bytes: Uint8Array, onConflict: ConflictMode, actor: Actor) {
  const { files, manifest } = openBundle(bytes);
  const { datasets: dsRepo, defs } = engine.repos;
  const report = {
    created: [] as { kind: string; id: string; name: string; rows?: number }[],
    updated: [] as { kind: string; id: string; name: string; rows?: number }[],
    skipped: [] as { kind: string; name: string; reason: string }[],
    renamed: [] as { kind: string; from: string; to: string }[],
    warnings: [] as string[],
    secretsToSet: [] as string[],
    code: [] as ReturnType<typeof findCode>,
  };

  // Validate every definition before writing anything.
  const defsIn = readDefs(files).map((d) => {
    const parsed = DEF_KINDS[d.kind].safeParse(d.spec ?? {});
    if (!parsed.success) throw invalid(`${d.path}: invalid ${d.kind} (${parsed.error.issues[0]?.message})`);
    return { ...d, spec: parsed.data };
  });
  const dsIn = readDatasets(files);
  // Definitions written by this import (skipped ones keep the local copy).
  const written: typeof defsIn = [];

  // Media first, verifying every file against its name (content hash).
  const blobMeta = parseJson<Record<string, { mime?: string; name?: string }>>(textOf(files.get('media.json')), {});
  for (const [path, data] of files) {
    const m = /^media\/([a-f0-9]{64})$/.exec(path);
    if (!m) continue;
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== m[1]) {
      report.warnings.push(`Skipped ${path}: its content does not match its name`);
      continue;
    }
    await engine.blobs.put(data, { mime: blobMeta[m[1]]?.mime, name: blobMeta[m[1]]?.name });
  }

  const idMap = new Map<string, string>(); // source def/dataset id → local id
  const rowMap = new Map<string, string>(); // source row id → local row id
  const versionOf = new Map<string, number>();

  const defTaken = (kind: DefKind) => (name: string) => {
    try {
      defs.get(kind, name);
      return true;
    } catch {
      return false;
    }
  };

  for (const d of defsIn) {
    const taken = defTaken(d.kind);
    if (taken(d.name)) {
      const existing = defs.get(d.kind, d.name);
      if (onConflict === 'skip') {
        idMap.set(d.sourceId, existing.id);
        versionOf.set(existing.id, existing.version);
        report.skipped.push({ kind: d.kind, name: d.name, reason: 'already exists' });
        continue;
      }
      if (onConflict === 'new_version') {
        const u = defs.update(d.kind, existing.id, { spec: d.spec, description: d.description }, actor);
        written.push(d);
        idMap.set(d.sourceId, u.id);
        versionOf.set(u.id, u.version);
        report.updated.push({ kind: d.kind, id: u.id, name: u.name });
        engine.events.emit({ type: 'def.changed', kind: d.kind, id: u.id, actor });
        continue;
      }
      const name = freeName(taken, d.name);
      report.renamed.push({ kind: d.kind, from: d.name, to: name });
      d.name = name;
    }
    const c = defs.create(d.kind, { name: d.name, description: d.description, spec: d.spec }, actor);
    written.push(d);
    idMap.set(d.sourceId, c.id);
    versionOf.set(c.id, c.version);
    report.created.push({ kind: d.kind, id: c.id, name: c.name });
    engine.events.emit({ type: 'def.changed', kind: d.kind, id: c.id, actor });
  }

  const dsTaken = (name: string) => {
    try {
      dsRepo.get(name);
      return true;
    } catch {
      return false;
    }
  };
  const dsVersion = new Map<string, string>();
  for (const d of dsIn) {
    let target;
    const exists = dsTaken(d.name);
    if (exists && onConflict === 'skip') {
      target = dsRepo.get(d.name);
      idMap.set(d.sourceId, target.id);
      report.skipped.push({ kind: 'dataset', name: d.name, reason: 'already exists' });
      continue;
    }
    if (exists && onConflict === 'new_version') {
      target = dsRepo.get(d.name);
      const known = new Set(target.schema.columns.map((c) => c.key));
      const columns = [...target.schema.columns, ...d.schema.columns.filter((c) => !known.has(c.key))];
      if (columns.length !== target.schema.columns.length) target = dsRepo.update(target.id, { schema: { ...target.schema, columns } });
      // Rows that are already there (same id, or same content) are not duplicated.
      const existingIds = new Set(dsRepo.listRows(target.id, { limit: 10_000_000 }).rows.map((r) => r.id));
      const fresh = d.rows.filter((r) => !(r.id && existingIds.has(r.id)));
      for (const r of d.rows) if (r.id && existingIds.has(r.id)) rowMap.set(r.id, r.id);
      const res = insertRows(engine, target.id, target.schema.columns, fresh, actor, { importedFrom: 'bundle' });
      for (const a of res.added) if (a.sourceId) rowMap.set(a.sourceId, a.id);
      if (res.rejected.length) report.warnings.push(`${res.rejected.length} rows of "${d.name}" did not match its columns and were skipped`);
      report.updated.push({ kind: 'dataset', id: target.id, name: target.name, rows: res.added.length });
    } else {
      let name = d.name;
      if (exists) {
        name = freeName(dsTaken, d.name);
        report.renamed.push({ kind: 'dataset', from: d.name, to: name });
      }
      target = dsRepo.create({ name, description: d.description, schema: d.schema }, actor);
      const res = insertRows(engine, target.id, target.schema.columns, d.rows, actor, { importedFrom: 'bundle' });
      for (const a of res.added) if (a.sourceId) rowMap.set(a.sourceId, a.id);
      if (res.rejected.length) report.warnings.push(`${res.rejected.length} rows of "${d.name}" did not match its columns and were skipped`);
      report.created.push({ kind: 'dataset', id: target.id, name, rows: res.added.length });
    }
    idMap.set(d.sourceId, target.id);
    engine.events.emit({ type: 'rows.changed', datasetId: target.id, count: d.rows.length, actor });
    const missingMedia = d.rows.flatMap((r) => fileValues(r.data ?? {})).filter((f) => !engine.blobs.has(f.blob)).length;
    if (missingMedia) report.warnings.push(`"${d.name}": ${missingMedia} files were not included in the bundle`);
  }

  // Runs: remap dataset/target/suite/row ids; results keep their inputs, outputs and checks.
  for (const [path, bytes] of [...files].filter(([p]) => /^runs\/[^/]+\/run\.json$/.test(p)).sort(([a], [b]) => a.localeCompare(b))) {
    const r = jsonOf<any>(bytes, path);
    const results = jsonl<any>(textOf(files.get(path.replace(/run\.json$/, 'results.jsonl'))), path).filter((x) => x && typeof x === 'object');
    const datasetId = idMap.get(r.datasetId) ?? null;
    let datasetVersionId: string | null = null;
    if (datasetId) {
      if (!dsVersion.has(datasetId)) dsVersion.set(datasetId, dsRepo.createVersion(datasetId, 'Imported from a bundle', actor).id);
      datasetVersionId = dsVersion.get(datasetId)!;
    } else report.warnings.push(`Run "${r.name}": its dataset was not in the bundle`);
    const targetId = idMap.get(r.targetId) ?? null;
    const suiteId = idMap.get(r.suiteId) ?? null;
    if (!suiteId) report.warnings.push(`Run "${r.name}": its suite was not in the bundle, so it cannot be resumed`);
    const id = newId('run');
    const number = ((engine.db.get('SELECT MAX(number) AS n FROM runs')?.n as number) ?? 0) + 1;
    const status = ['completed', 'cancelled', 'failed', 'interrupted'].includes(r.status) ? r.status : 'interrupted';
    engine.db.tx(() => {
      engine.db.run(
        `INSERT INTO runs (id, number, name, kind, status, dataset_id, dataset_version_id, target_id, target_version, suite_id, suite_version, settings, summary, total, done, created_at, started_at, finished_at, created_by, error, variant_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, number, String(r.name ?? `Run #${number}`), r.kind === 'imported' ? 'imported' : 'live', status, datasetId, datasetVersionId,
        targetId, targetId ? versionOf.get(targetId) ?? null : null, suiteId, suiteId ? versionOf.get(suiteId) ?? null : null,
        JSON.stringify(r.settings ?? {}), JSON.stringify(r.summary ?? {}), results.length, results.filter((x) => ['done', 'error'].includes(x?.status)).length,
        str(r.createdAt) ?? nowIso(), str(r.startedAt), str(r.finishedAt), JSON.stringify(actor), str(r.error), str(r.variantLabel),
      );
      for (const x of results) {
        engine.db.run(
          `INSERT INTO results (id, run_id, row_id, row_rev, rep, seq, status, passed, score, input, request, response, outputs, checks, metrics, error, logs, attempts, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId('res'), id, rowMap.get(x.row_id) ?? str(x.row_id) ?? '', num(x.row_rev), num(x.rep) ?? 0, num(x.seq) ?? 0, ['done', 'error'].includes(x.status) ? x.status : 'pending',
          num(x.passed), num(x.score), str(x.input), str(x.request), str(x.response), str(x.outputs), str(x.checks), str(x.metrics),
          str(x.error), str(x.logs), num(x.attempts) ?? 0, str(x.started_at), str(x.finished_at),
        );
      }
    });
    report.created.push({ kind: 'run', id, name: r.name });
    engine.events.emit({ type: 'run.updated', runId: id, status, done: results.length, total: results.length });
  }

  report.code = findCode(written);
  const warning = codeWarning('This bundle', report.code);
  if (warning) report.warnings.unshift(warning);
  report.secretsToSet = await missingSecretsAsync(engine, manifest.secrets ?? []);
  return { manifest: { name: manifest.name, createdAt: manifest.createdAt, appVersion: manifest.appVersion }, ...report };
}
