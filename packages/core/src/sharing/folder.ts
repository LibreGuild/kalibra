import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';
import { DEF_KINDS, DatasetSchema, type DefKind } from '../specs.js';
import { invalid, mapSeq, nowIso, parseJson } from '../util.js';
import { checkSyncDir, codeWarning, contentHash, findCode, insertRows, isSafeEntryName, jsonl, settingsSet, stableStringify, uniqueSlugs, type CodeItem, type IncomingRow } from './common.js';

/*
 * Folder sync: definitions and datasets as small, stable text files that a team keeps in Git.
 * Output is byte-stable (sorted keys, rows in dataset order, no timestamps), so a diff only shows real
 * changes. Import compares content hashes and applies differences as new versions or row edits.
 * Nothing is deleted unless `prune` is set.
 */

export const FOLDER_FORMAT = 'kalibra-folder';
const DIRS: Record<DefKind, string> = { target: 'targets', suite: 'suites', connection: 'connections' };

/**
 * A shared folder comes from other people (a Git pull). A symbolic link in it could point a read or
 * a write anywhere on this computer, so Kalibra only follows real files and folders inside it.
 */
async function assertNoLinks(root: string, rel: string) {
  let cur = root;
  for (const part of rel.split('/')) {
    cur = join(cur, part);
    const st = await lstat(cur).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) throw invalid(`${rel} goes through a symbolic link. Kalibra only reads and writes real files inside the folder; replace the link with the file itself.`);
  }
}

/**
 * Files an earlier export wrote, from its kalibra.json. Only these are removed when their item is
 * gone, so other files that happen to live in the folder (your own datasets/, notes…) are never touched.
 */
async function previousExport(dir: string): Promise<string[]> {
  if (!existsSync(join(dir, 'kalibra.json'))) return [];
  await assertNoLinks(dir, 'kalibra.json');
  let m: any;
  try {
    m = JSON.parse(await readFile(join(dir, 'kalibra.json'), 'utf8'));
  } catch {
    return [];
  }
  if (m?.format !== FOLDER_FORMAT || !m.index || typeof m.index !== 'object') return [];
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && isSafeEntryName(p)) : []);
  const out: string[] = [];
  for (const sub of Object.values(DIRS)) out.push(...list(m.index[sub]).filter((p) => new RegExp(`^${sub}/[^/]+\\.json$`).test(p)));
  for (const base of list(m.index.datasets).filter((p) => /^datasets\/[^/]+$/.test(p))) out.push(`${base}/schema.json`, `${base}/rows.jsonl`);
  return out;
}

const fileOf = (v: unknown) => !!v && typeof v === 'object' && typeof (v as any).blob === 'string';
const rowContent = (r: { data: unknown; tags?: unknown; status?: unknown; split?: unknown }) => ({ data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null });

export async function exportToFolder(engine: Engine, dirIn: string, o: { includeRows?: boolean; includeMedia?: boolean } = {}) {
  const dir = checkSyncDir(dirIn, engine.dir);
  const includeRows = o.includeRows !== false;
  const files = new Map<string, string | Uint8Array>();
  const manifest: Record<string, unknown> = { format: FOLDER_FORMAT, formatVersion: 1, note: 'Managed by Kalibra. Edit freely; import to apply changes.' };
  const index: Record<string, string[]> = {};

  for (const kind of ['target', 'suite', 'connection'] as DefKind[]) {
    const list = (await engine.repos.defs.list(kind)).sort((a, b) => a.name.localeCompare(b.name));
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
  const datasets = (await engine.repos.datasets.list()).sort((a, b) => a.name.localeCompare(b.name));
  const dsSlugs = uniqueSlugs(datasets.map((d) => d.name));
  index.datasets = [];
  for (const d of datasets) {
    const base = `datasets/${dsSlugs.get(d.name)}`;
    files.set(`${base}/schema.json`, stableStringify({ name: d.name, description: d.description, schema: d.schema }, 2) + '\n');
    if (includeRows) {
      const rows = (await engine.repos.datasets.listRows(d.id, { limit: 10_000_000 })).rows; // dataset order (seq): stable, and new rows append at the end of the file
      files.set(`${base}/rows.jsonl`, rows.map((r) => stableStringify({ id: r.id, ...rowContent(r) })).join('\n') + (rows.length ? '\n' : ''));
      for (const r of rows) for (const v of Object.values(r.data)) if (fileOf(v)) media.add((v as any).blob);
    }
    index.datasets.push(base);
  }
  manifest.index = index;
  files.set('kalibra.json', stableStringify(manifest, 2) + '\n');

  if (o.includeMedia) {
    for (const hash of [...media].sort()) {
      if (await engine.blobs.has(hash)) files.set(`media/${hash}`, await engine.blobs.get(hash));
    }
  }

  // Remove files the last export wrote whose item was renamed or deleted since.
  let removed = 0;
  for (const path of await previousExport(dir)) {
    if (files.has(path) || !existsSync(join(dir, path))) continue;
    await assertNoLinks(dir, path);
    await rm(join(dir, path), { force: true });
    removed++;
  }

  let written = 0;
  let unchanged = 0;
  for (const [path, content] of files) {
    await assertNoLinks(dir, path);
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
  await settingsSet(engine, { folder: dir, lastExportAt: nowIso(), includeRows, includeMedia: !!o.includeMedia });
  return { dir, written, unchanged, removed, files: files.size };
}

/** Real files under `root/sub` (relative to that folder). Symbolic links are skipped. */
async function listFiles(root: string, sub: string, prefix = ''): Promise<string[]> {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  if (!prefix) await assertNoLinks(root, sub);
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...(await listFiles(root, sub, `${prefix}${e.name}/`)));
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out;
}

/** Reads `rel` inside the folder, refusing symbolic links. */
async function readIn(root: string, rel: string): Promise<Buffer> {
  await assertNoLinks(root, rel);
  return readFile(join(root, rel));
}

async function readJson<T>(root: string, rel: string): Promise<T> {
  const text = (await readIn(root, rel)).toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalid(`${rel} is not valid JSON`);
  }
}

type DefChange = { kind: DefKind; name: string; change: 'added' | 'changed' | 'unchanged' | 'removed' };
type DatasetChange = { name: string; change: 'added' | 'changed' | 'unchanged' | 'removed'; schemaChanged: boolean; rows: { added: number; changed: number; unchanged: number; removed: number; invalid: number } };

export async function importFromFolder(engine: Engine, dirIn: string, o: { dryRun?: boolean; prune?: boolean }, actor: Actor) {
  const dir = checkSyncDir(dirIn, engine.dir);
  if (!existsSync(join(dir, 'kalibra.json'))) throw invalid('This folder has no kalibra.json. Export to it first, or pick the folder your team shares.');
  const manifest = await readJson<any>(dir, 'kalibra.json');
  if (manifest.format !== FOLDER_FORMAT) throw invalid('kalibra.json is not a Kalibra folder manifest');
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > 1) throw invalid('This folder was written by a newer Kalibra. Update Kalibra to import it.');

  const dry = !!o.dryRun;
  const { defs, datasets } = engine.repos;
  const defChanges: DefChange[] = [];
  const dsChanges: DatasetChange[] = [];
  const warnings: string[] = [];
  const incoming: { kind: string; name: string; spec: unknown }[] = []; // added or changed definitions

  // Media in the folder (optional) goes in first so rows can point at it.
  if (!dry && existsSync(join(dir, 'media'))) {
    for (const name of await listFiles(dir, 'media')) {
      if (!/^[a-f0-9]{64}$/.test(name) || await engine.blobs.has(name)) continue;
      const bytes = await readIn(dir, `media/${name}`);
      if (createHash('sha256').update(bytes).digest('hex') !== name) {
        warnings.push(`media/${name} does not match its name and was skipped`);
        continue;
      }
      await engine.blobs.put(bytes, {});
    }
  }

  for (const kind of ['target', 'suite', 'connection'] as DefKind[]) {
    const seen = new Set<string>();
    for (const rel of (await listFiles(dir, DIRS[kind])).filter((f) => f.endsWith('.json')).sort()) {
      const d = await readJson<any>(dir, `${DIRS[kind]}/${rel}`);
      if (typeof d?.name !== 'string' || !d.name.trim()) throw invalid(`${DIRS[kind]}/${rel} has no name`);
      const parsed = DEF_KINDS[kind].safeParse(d.spec ?? {});
      if (!parsed.success) throw invalid(`${DIRS[kind]}/${rel}: invalid ${kind} (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message})`);
      seen.add(d.name);
      let existing;
      try {
        existing = await defs.get(kind, d.name);
      } catch {
        existing = undefined;
      }
      if (!existing) {
        defChanges.push({ kind, name: d.name, change: 'added' });
        incoming.push({ kind, name: d.name, spec: parsed.data });
        if (!dry) engine.events.emit({ type: 'def.changed', kind, id: (await defs.create(kind, { name: d.name, description: d.description ?? '', spec: parsed.data }, actor)).id, actor });
      } else if (contentHash({ spec: normalizeSpec(kind, existing.spec), description: existing.description }) !== contentHash({ spec: parsed.data, description: d.description ?? '' })) {
        defChanges.push({ kind, name: d.name, change: 'changed' });
        incoming.push({ kind, name: d.name, spec: parsed.data });
        if (!dry) {
          await defs.update(kind, existing.id, { spec: parsed.data, description: d.description ?? '' }, actor);
          engine.events.emit({ type: 'def.changed', kind, id: existing.id, actor });
        }
      } else defChanges.push({ kind, name: d.name, change: 'unchanged' });
    }
    if (o.prune) {
      for (const d of await defs.list(kind)) {
        if (seen.has(d.name)) continue;
        defChanges.push({ kind, name: d.name, change: 'removed' });
        if (!dry) await defs.delete(kind, d.id);
      }
    }
  }

  const seenDs = new Set<string>();
  const dsDirs = [...new Set((await listFiles(dir, 'datasets')).filter((f) => f.endsWith('/schema.json')).map((f) => f.replace(/\/schema\.json$/, '')))].sort();
  for (const sub of dsDirs) {
    const s = await readJson<any>(dir, `datasets/${sub}/schema.json`);
    const schema = DatasetSchema.safeParse(s.schema ?? {});
    if (!schema.success || typeof s.name !== 'string') throw invalid(`datasets/${sub}/schema.json is not a valid dataset schema`);
    seenDs.add(s.name);
    const rowsPath = join(dir, 'datasets', sub, 'rows.jsonl');
    const hasRows = existsSync(rowsPath);
    const rows = hasRows ? jsonl<IncomingRow>((await readIn(dir, `datasets/${sub}/rows.jsonl`)).toString('utf8'), `datasets/${sub}/rows.jsonl`) : [];
    const ch: DatasetChange = { name: s.name, change: 'unchanged', schemaChanged: false, rows: { added: 0, changed: 0, unchanged: 0, removed: 0, invalid: 0 } };

    let ds;
    try {
      ds = await datasets.get(s.name);
    } catch {
      ds = undefined;
    }
    if (!ds) {
      ch.change = 'added';
      ch.rows.added = rows.length;
      if (!dry) {
        const created = await datasets.create({ name: s.name, description: s.description ?? '', schema: schema.data }, actor);
        const res = await insertRows(engine, created.id, created.schema.columns, rows, actor, { importedFrom: 'folder' });
        ch.rows.added = res.added.length;
        ch.rows.invalid = res.rejected.length;
        engine.events.emit({ type: 'dataset.changed', datasetId: created.id, actor });
      }
      dsChanges.push(ch);
      continue;
    }

    if (contentHash({ schema: ds.schema, description: ds.description }) !== contentHash({ schema: schema.data, description: s.description ?? '' })) {
      ch.schemaChanged = true;
      if (!dry) ds = await datasets.update(ds.id, { schema: schema.data, description: s.description ?? '' });
    }
    if (hasRows) {
      const current = new Map((await datasets.listRows(ds.id, { limit: 10_000_000 })).rows.map((r) => [r.id, r]));
      const toInsert: IncomingRow[] = [];
      const seenRows = new Set<string>();
      for (const r of rows) {
        if (r.id) seenRows.add(r.id);
        const cur = r.id ? current.get(r.id) : undefined;
        if (!cur) {
          // A soft-deleted row with this id comes back as an edit of that row.
          const deleted = r.id ? await engine.db.get('SELECT id FROM rows WHERE id = ? AND dataset_id = ? AND deleted_at IS NOT NULL', r.id, ds.id) : undefined;
          if (deleted && !dry) {
            await engine.db.run('UPDATE rows SET deleted_at = NULL WHERE id = ?', r.id);
            try {
              await datasets.updateRow(r.id!, { data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null }, actor);
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
            await datasets.updateRow(cur.id, { data: r.data, tags: r.tags ?? [], status: r.status ?? 'approved', split: r.split ?? null }, actor);
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
          const res = await insertRows(engine, ds.id, ds.schema.columns, toInsert, actor, { importedFrom: 'folder' });
          ch.rows.added += res.added.length;
          ch.rows.invalid += res.rejected.length;
        }
      }
      if (o.prune) {
        const gone = [...current.keys()].filter((id) => !seenRows.has(id));
        ch.rows.removed = gone.length;
        if (!dry && gone.length) await datasets.deleteRows(ds.id, gone);
      }
      const missingMedia = (await mapSeq(rows.flatMap((r) => Object.values(r.data ?? {})), async (v) => !!fileOf(v) && !(await engine.blobs.has((v as any).blob)))).filter(Boolean).length;
      if (missingMedia) warnings.push(`"${s.name}": ${missingMedia} files are not in this workspace or the folder's media/ (export with media to share them)`);
    }
    if (ch.schemaChanged || ch.rows.added || ch.rows.changed || ch.rows.removed) ch.change = 'changed';
    if (!dry && ch.change === 'changed') engine.events.emit({ type: 'rows.changed', datasetId: ds.id, count: ch.rows.added + ch.rows.changed, actor });
    dsChanges.push(ch);
  }
  if (o.prune) {
    for (const d of await datasets.list()) {
      if (seenDs.has(d.name)) continue;
      dsChanges.push({ name: d.name, change: 'removed', schemaChanged: false, rows: { added: 0, changed: 0, unchanged: 0, removed: d.rowCount, invalid: 0 } });
      if (!dry) await datasets.delete(d.id);
    }
  }

  const code: CodeItem[] = findCode(incoming);
  const codeNote = codeWarning('This folder', code);
  if (codeNote) warnings.unshift(codeNote);
  if (!dry) await settingsSet(engine, { folder: dir, lastImportAt: nowIso() });
  const count = (c: string) => defChanges.filter((d) => d.change === c).length + dsChanges.filter((d) => d.change === c).length;
  return {
    dir,
    dryRun: dry,
    summary: { added: count('added'), changed: count('changed'), unchanged: count('unchanged'), removed: count('removed') },
    definitions: defChanges,
    datasets: dsChanges,
    warnings,
    code,
    lastExport: parseJson<any>((await engine.db.get("SELECT value FROM meta WHERE key = 'sharing'"))?.value, {}).lastExportAt ?? null,
  };
}

/** A stored spec as the current schema sees it (adds defaults for fields added since it was saved). */
function normalizeSpec(kind: DefKind, spec: unknown) {
  const parsed = DEF_KINDS[kind].safeParse(spec);
  return parsed.success ? parsed.data : spec;
}
