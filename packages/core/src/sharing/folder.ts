import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';
import { DEF_KINDS, DatasetSchema, type DefKind } from '../specs.js';
import { invalid, nowIso, parseJson } from '../util.js';
import { checkSyncDir, contentHash, insertRows, jsonl, settingsSet, stableStringify, uniqueSlugs, type IncomingRow } from './common.js';

/*
 * Folder sync: definitions and datasets as small, stable text files that a team keeps in Git.
 * Output is byte-stable (sorted keys, rows in dataset order, no timestamps), so a diff only shows real
 * changes. Import compares content hashes and applies differences as new versions or row edits.
 * Nothing is deleted unless `prune` is set.
 */

export const FOLDER_FORMAT = 'kalibra-folder';
const DIRS: Record<DefKind, string> = { target: 'targets', suite: 'suites', connection: 'connections' };
const MANAGED = ['targets', 'suites', 'connections', 'datasets'];

const fileOf = (v: unknown) => !!v && typeof v === 'object' && typeof (v as any).blob === 'string';
const rowContent = (r: { data: unknown; tags?: unknown; status?: unknown; split?: unknown }) => ({ data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null });

export async function exportToFolder(engine: Engine, dirIn: string, o: { includeRows?: boolean; includeMedia?: boolean } = {}) {
  const dir = checkSyncDir(dirIn, engine.dir);
  const includeRows = o.includeRows !== false;
  const files = new Map<string, string | Uint8Array>();
  const manifest: Record<string, unknown> = { format: FOLDER_FORMAT, formatVersion: 1, note: 'Managed by Kalibra. Edit freely; import to apply changes.' };
  const index: Record<string, string[]> = {};

  for (const kind of ['target', 'suite', 'connection'] as DefKind[]) {
    const list = engine.repos.defs.list(kind).sort((a, b) => a.name.localeCompare(b.name));
    const slugs = uniqueSlugs(list.map((d) => d.name));
    index[DIRS[kind]] = [];
    for (const d of list) {
      const path = `${DIRS[kind]}/${slugs.get(d.name)}.json`;
      // Normalized through the current schema, so specs saved before a field existed export the same as new ones.
      files.set(path, stableStringify({ name: d.name, description: d.description, spec: normalizeSpec(kind, d.spec) }, 2) + '\n');
      index[DIRS[kind]].push(path);
    }
  }

  const media = new Set<string>();
  const datasets = engine.repos.datasets.list().sort((a, b) => a.name.localeCompare(b.name));
  const dsSlugs = uniqueSlugs(datasets.map((d) => d.name));
  index.datasets = [];
  for (const d of datasets) {
    const base = `datasets/${dsSlugs.get(d.name)}`;
    files.set(`${base}/schema.json`, stableStringify({ name: d.name, description: d.description, schema: d.schema }, 2) + '\n');
    if (includeRows) {
      const rows = engine.repos.datasets.listRows(d.id, { limit: 10_000_000 }).rows; // dataset order (seq): stable, and new rows append at the end of the file
      files.set(`${base}/rows.jsonl`, rows.map((r) => stableStringify({ id: r.id, ...rowContent(r) })).join('\n') + (rows.length ? '\n' : ''));
      for (const r of rows) for (const v of Object.values(r.data)) if (fileOf(v)) media.add((v as any).blob);
    }
    index.datasets.push(base);
  }
  manifest.index = index;
  files.set('kalibra.json', stableStringify(manifest, 2) + '\n');

  if (o.includeMedia) {
    for (const hash of [...media].sort()) {
      if (engine.blobs.has(hash)) files.set(`media/${hash}`, await engine.blobs.get(hash));
    }
  }

  // Remove files we manage that no longer correspond to anything (renamed or deleted items).
  let removed = 0;
  for (const sub of MANAGED) {
    for (const rel of await listFiles(join(dir, sub))) {
      const path = `${sub}/${rel}`;
      if (!files.has(path) && /(\.json|\.jsonl)$/.test(path)) {
        await rm(join(dir, path), { force: true });
        removed++;
      }
    }
  }

  let written = 0;
  let unchanged = 0;
  for (const [path, content] of files) {
    const full = join(dir, path);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    if (existsSync(full) && (await readFile(full)).equals(bytes)) {
      unchanged++;
      continue;
    }
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
    written++;
  }
  settingsSet(engine, { folder: dir, lastExportAt: nowIso(), includeRows, includeMedia: !!o.includeMedia });
  return { dir, written, unchanged, removed, files: files.size };
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    throw invalid(`${what} is not valid JSON`);
  }
}

type DefChange = { kind: DefKind; name: string; change: 'added' | 'changed' | 'unchanged' | 'removed' };
type DatasetChange = { name: string; change: 'added' | 'changed' | 'unchanged' | 'removed'; schemaChanged: boolean; rows: { added: number; changed: number; unchanged: number; removed: number; invalid: number } };

export async function importFromFolder(engine: Engine, dirIn: string, o: { dryRun?: boolean; prune?: boolean }, actor: Actor) {
  const dir = checkSyncDir(dirIn, engine.dir);
  if (!existsSync(join(dir, 'kalibra.json'))) throw invalid('This folder has no kalibra.json. Export to it first, or pick the folder your team shares.');
  const manifest = await readJson<any>(join(dir, 'kalibra.json'), 'kalibra.json');
  if (manifest.format !== FOLDER_FORMAT) throw invalid('kalibra.json is not a Kalibra folder manifest');
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > 1) throw invalid('This folder was written by a newer Kalibra. Update Kalibra to import it.');

  const dry = !!o.dryRun;
  const { defs, datasets } = engine.repos;
  const defChanges: DefChange[] = [];
  const dsChanges: DatasetChange[] = [];
  const warnings: string[] = [];

  // Media in the folder (optional) goes in first so rows can point at it.
  if (!dry && existsSync(join(dir, 'media'))) {
    for (const name of await listFiles(join(dir, 'media'))) {
      if (!/^[a-f0-9]{64}$/.test(name) || engine.blobs.has(name)) continue;
      const bytes = await readFile(join(dir, 'media', name));
      if (createHash('sha256').update(bytes).digest('hex') !== name) {
        warnings.push(`media/${name} does not match its name and was skipped`);
        continue;
      }
      await engine.blobs.put(bytes, {});
    }
  }

  for (const kind of ['target', 'suite', 'connection'] as DefKind[]) {
    const seen = new Set<string>();
    for (const rel of (await listFiles(join(dir, DIRS[kind]))).filter((f) => f.endsWith('.json')).sort()) {
      const d = await readJson<any>(join(dir, DIRS[kind], rel), `${DIRS[kind]}/${rel}`);
      if (typeof d?.name !== 'string' || !d.name.trim()) throw invalid(`${DIRS[kind]}/${rel} has no name`);
      const parsed = DEF_KINDS[kind].safeParse(d.spec ?? {});
      if (!parsed.success) throw invalid(`${DIRS[kind]}/${rel}: invalid ${kind} (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message})`);
      seen.add(d.name);
      let existing;
      try {
        existing = defs.get(kind, d.name);
      } catch {
        existing = undefined;
      }
      if (!existing) {
        defChanges.push({ kind, name: d.name, change: 'added' });
        if (!dry) engine.events.emit({ type: 'def.changed', kind, id: defs.create(kind, { name: d.name, description: d.description ?? '', spec: parsed.data }, actor).id, actor });
      } else if (contentHash({ spec: normalizeSpec(kind, existing.spec), description: existing.description }) !== contentHash({ spec: parsed.data, description: d.description ?? '' })) {
        defChanges.push({ kind, name: d.name, change: 'changed' });
        if (!dry) {
          defs.update(kind, existing.id, { spec: parsed.data, description: d.description ?? '' }, actor);
          engine.events.emit({ type: 'def.changed', kind, id: existing.id, actor });
        }
      } else defChanges.push({ kind, name: d.name, change: 'unchanged' });
    }
    if (o.prune) {
      for (const d of defs.list(kind)) {
        if (seen.has(d.name)) continue;
        defChanges.push({ kind, name: d.name, change: 'removed' });
        if (!dry) defs.delete(kind, d.id);
      }
    }
  }

  const seenDs = new Set<string>();
  const dsDirs = [...new Set((await listFiles(join(dir, 'datasets'))).filter((f) => f.endsWith('/schema.json')).map((f) => f.replace(/\/schema\.json$/, '')))].sort();
  for (const sub of dsDirs) {
    const s = await readJson<any>(join(dir, 'datasets', sub, 'schema.json'), `datasets/${sub}/schema.json`);
    const schema = DatasetSchema.safeParse(s.schema ?? {});
    if (!schema.success || typeof s.name !== 'string') throw invalid(`datasets/${sub}/schema.json is not a valid dataset schema`);
    seenDs.add(s.name);
    const rowsPath = join(dir, 'datasets', sub, 'rows.jsonl');
    const hasRows = existsSync(rowsPath);
    const rows = hasRows ? jsonl<IncomingRow>(await readFile(rowsPath, 'utf8'), `datasets/${sub}/rows.jsonl`) : [];
    const ch: DatasetChange = { name: s.name, change: 'unchanged', schemaChanged: false, rows: { added: 0, changed: 0, unchanged: 0, removed: 0, invalid: 0 } };

    let ds;
    try {
      ds = datasets.get(s.name);
    } catch {
      ds = undefined;
    }
    if (!ds) {
      ch.change = 'added';
      ch.rows.added = rows.length;
      if (!dry) {
        const created = datasets.create({ name: s.name, description: s.description ?? '', schema: schema.data }, actor);
        const res = insertRows(engine, created.id, created.schema.columns, rows, actor, { importedFrom: 'folder' });
        ch.rows.added = res.added.length;
        ch.rows.invalid = res.rejected.length;
        engine.events.emit({ type: 'dataset.changed', datasetId: created.id, actor });
      }
      dsChanges.push(ch);
      continue;
    }

    if (contentHash({ schema: ds.schema, description: ds.description }) !== contentHash({ schema: schema.data, description: s.description ?? '' })) {
      ch.schemaChanged = true;
      if (!dry) ds = datasets.update(ds.id, { schema: schema.data, description: s.description ?? '' });
    }
    if (hasRows) {
      const current = new Map(datasets.listRows(ds.id, { limit: 10_000_000 }).rows.map((r) => [r.id, r]));
      const toInsert: IncomingRow[] = [];
      const seenRows = new Set<string>();
      for (const r of rows) {
        if (r.id) seenRows.add(r.id);
        const cur = r.id ? current.get(r.id) : undefined;
        if (!cur) {
          // A soft-deleted row with this id comes back as an edit of that row.
          const deleted = r.id ? engine.db.get('SELECT id FROM rows WHERE id = ? AND dataset_id = ? AND deleted_at IS NOT NULL', r.id, ds.id) : undefined;
          if (deleted && !dry) {
            engine.db.run('UPDATE rows SET deleted_at = NULL WHERE id = ?', r.id);
            try {
              datasets.updateRow(r.id!, { data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null }, actor);
            } catch {
              ch.rows.invalid++;
            }
            ch.rows.changed++;
          } else if (deleted) ch.rows.changed++;
          else toInsert.push(r);
          continue;
        }
        if (contentHash(rowContent(cur)) === contentHash(rowContent(r))) {
          ch.rows.unchanged++;
          continue;
        }
        ch.rows.changed++;
        if (!dry) {
          try {
            datasets.updateRow(cur.id, { data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null }, actor);
          } catch (e: any) {
            ch.rows.invalid++;
            ch.rows.changed--;
            warnings.push(`"${s.name}" row ${cur.id}: ${e?.message ?? e}`);
          }
        }
      }
      if (toInsert.length) {
        if (dry) ch.rows.added += toInsert.length;
        else {
          const res = insertRows(engine, ds.id, ds.schema.columns, toInsert, actor, { importedFrom: 'folder' });
          ch.rows.added += res.added.length;
          ch.rows.invalid += res.rejected.length;
        }
      }
      if (o.prune) {
        const gone = [...current.keys()].filter((id) => !seenRows.has(id));
        ch.rows.removed = gone.length;
        if (!dry && gone.length) datasets.deleteRows(ds.id, gone);
      }
      const missingMedia = rows.flatMap((r) => Object.values(r.data ?? {})).filter((v) => fileOf(v) && !engine.blobs.has((v as any).blob)).length;
      if (missingMedia) warnings.push(`"${s.name}": ${missingMedia} files are not in this workspace or the folder's media/ (export with media to share them)`);
    }
    if (ch.schemaChanged || ch.rows.added || ch.rows.changed || ch.rows.removed) ch.change = 'changed';
    if (!dry && ch.change === 'changed') engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: ch.rows.added + ch.rows.changed, actor });
    dsChanges.push(ch);
  }
  if (o.prune) {
    for (const d of datasets.list()) {
      if (seenDs.has(d.name)) continue;
      dsChanges.push({ name: d.name, change: 'removed', schemaChanged: false, rows: { added: 0, changed: 0, unchanged: 0, removed: d.rowCount, invalid: 0 } });
      if (!dry) datasets.delete(d.id);
    }
  }

  if (!dry) settingsSet(engine, { folder: dir, lastImportAt: nowIso() });
  const count = (c: string) => defChanges.filter((d) => d.change === c).length + dsChanges.filter((d) => d.change === c).length;
  return {
    dir,
    dryRun: dry,
    summary: { added: count('added'), changed: count('changed'), unchanged: count('unchanged'), removed: count('removed') },
    definitions: defChanges,
    datasets: dsChanges,
    warnings,
    lastExport: parseJson<any>(engine.db.get("SELECT value FROM meta WHERE key = 'sharing'")?.value, {}).lastExportAt ?? null,
  };
}

/** A stored spec as the current schema sees it (adds defaults for fields added since it was saved). */
function normalizeSpec(kind: DefKind, spec: unknown) {
  const parsed = DEF_KINDS[kind].safeParse(spec);
  return parsed.success ? parsed.data : spec;
}
