import { createHash } from 'node:crypto';
import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Engine } from '../engine.js';
import type { Actor } from '../registry.js';
import { fingerprint, validateRow } from '../repo/datasets.js';
import type { ColumnSpec, RowStatus } from '../specs.js';
import { invalid, newId, nowIso, parseJson } from '../util.js';

/*
 * Shared helpers for bundles, folder sync and importers: deterministic JSON (so Git diffs only show
 * real changes), safe unzip with size limits, secret-name discovery and row insertion that keeps ids.
 */

/** Written into bundle manifests (set by scripts/set-version.mjs). */
export const APP_VERSION = '0.1.1-beta.1';

/** JSON with object keys sorted at every level, so the same content always produces the same bytes. */
export function stableStringify(value: unknown, indent?: number): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as any)[k] !== undefined)
          .map((k) => [k, sortKeys((v as any)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(value), null, indent);
}

export const contentHash = (value: unknown) => createHash('sha1').update(stableStringify(value)).digest('hex');

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'item';
}

/** Gives each name a unique slug (name, name-2, name-3 …) in a stable order. */
export function uniqueSlugs(names: string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const n of names) {
    const base = slugify(n);
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    out.set(n, slug);
  }
  return out;
}

/** Secret names a definition needs: connection key fields and {{secret.x}} references anywhere in it. */
export function secretNames(spec: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
      if (key && /Secret$/.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) names.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(spec);
  return [...names].sort();
}

/** Spec fields holding JavaScript that Kalibra runs on this computer (`session`: WebSocket session scripts). */
const CODE_KEYS = new Set(['code', 'beforeRequest', 'afterResponse', 'onMessage', 'session', 'waitForOpenAck', 'ignoreWhen', 'isFinal', 'doneExpression', 'applyWhen', 'expression']);
const DONE_WHEN_MODES = new Set(['final_after_audio', 'close', 'expression', 'idle']);

/** Calls `found(place, code)` for every piece of JavaScript in a definition. */
function walkCode(spec: unknown, found: (place: string, code: string) => void) {
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      // `doneWhen` is JS on streaming HTTP targets and a mode name on WebSocket targets.
      if (v.trim() && key && (CODE_KEYS.has(key) || (key === 'doneWhen' && !DONE_WHEN_MODES.has(v)))) found(key, v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.from === 'expression' && typeof o.path === 'string' && o.path.trim()) found('output expression', o.path);
      for (const [k, x] of Object.entries(o)) walk(x, k);
    }
  };
  walk(spec);
}

/** Where a definition runs JavaScript (scripts, expressions), e.g. ["applyWhen", "code"]. */
export function codeIn(spec: unknown): string[] {
  const found = new Set<string>();
  walkCode(spec, (place) => found.add(place));
  return [...found].sort();
}

/** The JavaScript in a definition, as a stable list. Two specs run the same code when these are equal. */
export function codeSnippets(spec: unknown): string[] {
  const out: string[] = [];
  walkCode(spec, (place, code) => out.push(`${place}\u0000${code.trim()}`));
  return out.sort();
}

/**
 * Shared definitions can carry scripts that run with your permissions, like npm scripts in a cloned
 * repo. Nothing is blocked; the import just says where the code is so it can be reviewed first.
 */
export interface CodeItem {
  kind: string;
  name: string;
  /** Spec fields with code, e.g. ["beforeRequest", "code"]. */
  places: string[];
}

export function findCode(items: { kind: string; name: string; spec: unknown }[]): CodeItem[] {
  return items.map((i) => ({ kind: i.kind, name: i.name, places: codeIn(i.spec) })).filter((i) => i.places.length);
}

export function codeWarning(source: string, code: CodeItem[]): string | undefined {
  if (!code.length) return undefined;
  const list = code.map((i) => `${i.kind} "${i.name}" (${i.places.join(', ')})`).join('; ');
  return `${source} has code that runs on your computer when used: ${list}. Review it before running, as you would scripts in a repository you cloned.`;
}

// ── Zip ─────────────────────────────────────────────────────────────────────

export const ZIP_LIMITS = {
  maxEntries: 200_000,
  maxEntryBytes: 1024 ** 3,
  maxTotalBytes: 2 * 1024 ** 3,
};

/** Rejects names that could escape the extraction root (zip-slip) or are otherwise odd. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 512 || name.includes('\0') || name.includes('\\')) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

export function readZip(data: Uint8Array, limits = ZIP_LIMITS): Map<string, Uint8Array> {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(file) {
        if (file.name.endsWith('/')) return false;
        if (!isSafeEntryName(file.name)) throw invalid(`Unsafe path in bundle: "${file.name}"`);
        if (++count > limits.maxEntries) throw invalid('The bundle has too many files');
        if (file.originalSize > limits.maxEntryBytes) throw invalid(`"${file.name}" is too large (${file.originalSize} bytes)`);
        total += file.originalSize;
        if (total > limits.maxTotalBytes) throw invalid('The bundle is too large to import');
        return true;
      },
    });
  } catch (e: any) {
    if (e?.code === 'invalid') throw e;
    throw invalid(`Not a valid Kalibra bundle: the file is not a readable zip (${e?.message ?? e})`);
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    if (bytes.byteLength > limits.maxEntryBytes) throw invalid(`"${name}" is larger than it claimed`);
    out.set(name, bytes);
  }
  return out;
}

export function writeZip(entries: Map<string, Uint8Array | string>, storeOnly = new Set<string>()): Uint8Array {
  const z: Zippable = {};
  for (const [name, content] of entries) {
    if (!isSafeEntryName(name)) throw new Error(`Unsafe entry name: ${name}`);
    const bytes = typeof content === 'string' ? strToU8(content) : content;
    z[name] = [bytes, { level: storeOnly.has(name) ? 0 : 6, mtime: new Date('2026-01-01T00:00:00Z') }];
  }
  return zipSync(z);
}

export const textOf = (bytes: Uint8Array | undefined) => (bytes ? strFromU8(bytes) : '');

export function jsonOf<T>(bytes: Uint8Array | undefined, what: string): T {
  if (!bytes) throw invalid(`The bundle is missing ${what}`);
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch {
    throw invalid(`${what} is not valid JSON`);
  }
}

export function jsonl<T>(text: string, what: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        throw invalid(`${what}: line ${i + 1} is not valid JSON`);
      }
    });
}

// ── Folders ─────────────────────────────────────────────────────────────────

const SYSTEM_DIRS = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/System', '/Library', '/Applications', '/private/etc', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];

/** Folder sync only writes to an absolute, non-system folder outside the workspace's own storage. */
export function checkSyncDir(dir: string, workspaceDir: string): string {
  if (!dir || !isAbsolute(dir)) throw invalid('Use an absolute folder path, e.g. /Users/me/projects/evals');
  const abs = normalize(resolve(dir));
  const lower = abs.toLowerCase();
  if (abs === sep || /^[A-Za-z]:\\?$/.test(abs)) throw invalid('Pick a folder, not the root of a disk');
  for (const s of SYSTEM_DIRS) {
    const l = s.toLowerCase();
    if (lower === l || lower.startsWith(l + sep) || lower.startsWith(l + '/')) throw invalid(`Kalibra will not write to the system folder ${s}`);
  }
  const ws = normalize(resolve(workspaceDir));
  if (abs === ws || abs.startsWith(ws + sep)) throw invalid('Pick a folder outside the Kalibra workspace itself');
  return abs;
}

// ── Rows with stable ids ────────────────────────────────────────────────────

export interface IncomingRow {
  id?: string;
  data: Record<string, unknown>;
  tags?: string[];
  status?: RowStatus;
  split?: string | null;
  provenance?: Record<string, unknown>;
}

/**
 * Inserts rows keeping their ids when free (so a shared folder or bundle round-trips without id
 * churn). Rows are validated against the dataset columns like any other insert.
 */
export function insertRows(engine: Engine, datasetId: string, columns: ColumnSpec[], rows: IncomingRow[], actor: Actor, extraProvenance: Record<string, unknown> = {}) {
  const added: { index: number; id: string; sourceId?: string }[] = [];
  const rejected: { index: number; errors: string[] }[] = [];
  const db = engine.db;
  const now = nowIso();
  db.tx(() => {
    let seq = db.get('SELECT next_seq FROM datasets WHERE id = ?', datasetId).next_seq as number;
    rows.forEach((row, index) => {
      const { value, errors } = validateRow(columns, row.data ?? {});
      if (errors.length) {
        rejected.push({ index, errors });
        return;
      }
      const id = row.id && /^[A-Za-z0-9_-]{1,80}$/.test(row.id) && !db.get('SELECT 1 FROM rows WHERE id = ?', row.id) ? row.id : newId('row');
      const data = JSON.stringify(value);
      const tags = JSON.stringify(Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : []);
      db.run(
        `INSERT INTO rows (id, dataset_id, seq, rev, data, tags, status, split, provenance, created_at, updated_at, fp) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, datasetId, seq++, data, tags, row.status ?? 'approved', row.split ?? null,
        JSON.stringify({ ...(row.provenance ?? {}), ...extraProvenance }), now, now, fingerprint(value),
      );
      db.run('INSERT INTO row_revs (row_id, rev, data, tags, created_at, actor) VALUES (?, 1, ?, ?, ?, ?)', id, data, tags, now, JSON.stringify(actor));
      added.push({ index, id, sourceId: row.id });
    });
    db.run('UPDATE datasets SET next_seq = ?, updated_at = ? WHERE id = ?', seq, now, datasetId);
  });
  return { added, rejected };
}

/** Uniquely named copy: "Name (imported)", "Name (imported 2)", … */
export function freeName(taken: (name: string) => boolean, name: string, suffix = 'imported'): string {
  if (!taken(name)) return name;
  if (!taken(`${name} (${suffix})`)) return `${name} (${suffix})`;
  for (let i = 2; ; i++) if (!taken(`${name} (${suffix} ${i})`)) return `${name} (${suffix} ${i})`;
}

export function settingsGet(engine: Engine): { folder?: string; lastExportAt?: string; lastImportAt?: string; includeRows?: boolean; includeMedia?: boolean } {
  return parseJson(engine.db.get("SELECT value FROM meta WHERE key = 'sharing'")?.value, {});
}

export function settingsSet(engine: Engine, patch: Record<string, unknown>) {
  const next = { ...settingsGet(engine), ...patch };
  engine.db.run("INSERT INTO meta (key, value) VALUES ('sharing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
  return next;
}
