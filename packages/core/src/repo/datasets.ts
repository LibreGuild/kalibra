import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { DatasetSchema, FileValue, type ColumnSpec, type RowStatus } from '../specs.js';
import { conflict, invalid, newId, notFound, nowIso, parseJson } from '../util.js';

export interface DatasetRecord {
  id: string;
  name: string;
  description: string;
  schema: DatasetSchema;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
}

export interface RowRecord {
  id: string;
  datasetId: string;
  seq: number;
  rev: number;
  data: Record<string, unknown>;
  tags: string[];
  status: RowStatus;
  split: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const toDataset = (r: any): DatasetRecord => ({
  id: r.id,
  name: r.name,
  description: r.description,
  schema: DatasetSchema.parse(parseJson(r.schema, {})),
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  createdBy: parseJson(r.created_by, { kind: 'user', id: 'local' }),
});

const toRow = (r: any): RowRecord => ({
  id: r.id,
  datasetId: r.dataset_id,
  seq: r.seq,
  rev: r.rev,
  data: parseJson(r.data, {}),
  tags: parseJson(r.tags, []),
  status: r.status,
  split: r.split,
  provenance: parseJson(r.provenance, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class DatasetRepo {
  constructor(private db: Db) {}

  async list() {
    const rows = await this.db.all(
      `SELECT d.*,
        (SELECT COUNT(*) FROM rows r WHERE r.dataset_id = d.id AND r.deleted_at IS NULL) AS row_count,
        (SELECT COUNT(*) FROM rows r WHERE r.dataset_id = d.id AND r.deleted_at IS NULL AND r.status = 'needs_review') AS review_count,
        (SELECT MAX(number) FROM dataset_versions v WHERE v.dataset_id = d.id) AS latest_version
       FROM datasets d WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
    );
    return rows.map((r) => ({ ...toDataset(r), rowCount: r.row_count, reviewCount: r.review_count, latestVersion: r.latest_version ?? null }));
  }

  async get(idOrName: string): Promise<DatasetRecord> {
    const r = await this.db.get('SELECT * FROM datasets WHERE (id = ? OR name = ?) AND deleted_at IS NULL', idOrName, idOrName);
    if (!r) throw notFound('Dataset', idOrName);
    return toDataset(r);
  }

  async stats(id: string) {
    const counts = await this.db.all('SELECT status, COUNT(*) AS n FROM rows WHERE dataset_id = ? AND deleted_at IS NULL GROUP BY status', id);
    const tagRows = await this.db.all(
      `SELECT j.value AS tag, COUNT(*) AS n FROM rows r, ${this.db.dialect === 'postgres' ? 'jsonb_array_elements_text(r.tags::jsonb) AS j(value)' : 'json_each(r.tags) j'}
       WHERE r.dataset_id = ? AND r.deleted_at IS NULL GROUP BY j.value ORDER BY n DESC, j.value LIMIT 50`,
      id,
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    const total = counts.reduce((s, c) => s + c.n, 0);
    return { total, byStatus, tags: tagRows.map((t) => ({ tag: t.tag, count: t.n })) };
  }

  async create(input: { name: string; description?: string; schema?: unknown }, actor: Actor): Promise<DatasetRecord> {
    return this.db.tx(async () => {
      const schema = DatasetSchema.parse(input.schema ?? {});
      assertUniqueColumns(schema.columns);
      if (await this.db.get('SELECT 1 FROM datasets WHERE name = ? AND deleted_at IS NULL', input.name)) {
        throw conflict(`A dataset named "${input.name}" already exists`);
      }
      const id = newId('ds');
      const now = nowIso();
      await this.db.run(
        'INSERT INTO datasets (id, name, description, schema, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, input.name, input.description ?? '', JSON.stringify(schema), now, now, JSON.stringify(actor),
      );
      return await this.get(id);
    });
  }

  async update(id: string, patch: { name?: string; description?: string; schema?: unknown }, baseRevision?: number): Promise<DatasetRecord> {
    return this.db.tx(async () => {
      const cur = await this.get(id);
      if (baseRevision !== undefined && baseRevision !== cur.revision) {
        throw conflict(`Dataset changed since revision ${baseRevision} (now ${cur.revision}). Reload and re-apply.`, { current: cur.revision });
      }
      if (patch.name !== undefined && patch.name !== cur.name && await this.db.get('SELECT 1 FROM datasets WHERE name = ? AND id != ? AND deleted_at IS NULL', patch.name, cur.id)) {
        throw conflict(`A dataset named "${patch.name}" already exists`);
      }
      const schema = patch.schema !== undefined ? DatasetSchema.parse(patch.schema) : cur.schema;
      assertUniqueColumns(schema.columns);
      await this.db.run(
        'UPDATE datasets SET name = ?, description = ?, schema = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        patch.name ?? cur.name, patch.description ?? cur.description, JSON.stringify(schema), nowIso(), cur.id,
      );
      return await this.get(cur.id);
    });
  }

  async delete(id: string) {
    return this.db.tx(async () => {
      const cur = await this.get(id);
      await this.db.run('UPDATE datasets SET deleted_at = ? WHERE id = ?', nowIso(), cur.id);
    });
  }

  async touch(id: string) {
    await this.db.run('UPDATE datasets SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  async listRows(datasetId: string, q: { status?: RowStatus[]; tag?: string; search?: string; offset?: number; limit?: number; ids?: string[] } = {}) {
    const where = ['dataset_id = ?', 'deleted_at IS NULL'];
    const params: unknown[] = [datasetId];
    if (q.status?.length) {
      where.push(`status IN (${q.status.map(() => '?').join(',')})`);
      params.push(...q.status);
    }
    if (q.tag) {
      where.push(
        this.db.dialect === 'postgres'
          ? 'EXISTS (SELECT 1 FROM jsonb_array_elements_text(rows.tags::jsonb) AS j(value) WHERE j.value = ?)'
          : 'EXISTS (SELECT 1 FROM json_each(rows.tags) j WHERE j.value = ?)',
      );
      params.push(q.tag);
    }
    if (q.search) {
      where.push('(data LIKE ? OR id = ?)');
      params.push(`%${q.search}%`, q.search);
    }
    if (q.ids?.length) {
      where.push(`id IN (${q.ids.map(() => '?').join(',')})`);
      params.push(...q.ids);
    }
    const clause = where.join(' AND ');
    const total = (await this.db.get(`SELECT COUNT(*) AS n FROM rows WHERE ${clause}`, ...params)).n as number;
    const rows = (await this.db.all(`SELECT * FROM rows WHERE ${clause} ORDER BY seq LIMIT ? OFFSET ?`, ...params, q.limit ?? 100, q.offset ?? 0))
      .map(toRow);
    return { total, rows };
  }

  async getRow(id: string): Promise<RowRecord> {
    const r = await this.db.get('SELECT * FROM rows WHERE id = ? AND deleted_at IS NULL', id);
    if (!r) throw notFound('Row', id);
    return toRow(r);
  }

  /**
   * Validates and inserts rows. Invalid rows are rejected individually (the rest still go in),
   * so a coding agent gets precise feedback and can resubmit just the failures.
   */
  async addRows(
    datasetId: string,
    input: { data: Record<string, unknown>; tags?: string[]; status?: RowStatus; split?: string | null }[],
    actor: Actor,
    opts: { defaultStatus?: RowStatus; provenance?: Record<string, unknown>; dedupe?: boolean } = {},
  ) {
    return this.db.tx(async () => {
      const ds = await this.get(datasetId);
      const added: string[] = [];
      const rejected: { index: number; errors: string[]; duplicateOf?: string }[] = [];
      const warnings: { index: number; message: string }[] = [];
      const now = nowIso();
      const dedupe = opts.dedupe !== false;
      // Copies within this batch are always caught; copies of stored rows only when deduping.
      const batch = new Map<string, string>();

      await this.db.tx(async () => {
        // Postgres may run a transaction again after a conflict: start the lists afresh each time.
        added.length = rejected.length = warnings.length = 0;
        batch.clear();
        if (dedupe) await this.backfillFingerprints(ds.id);
        let seq = (await this.db.get('SELECT next_seq FROM datasets WHERE id = ?', ds.id)).next_seq as number;
        for (const [index, item] of input.entries()) {
          const { value, errors, unknownKeys } = validateRow(ds.schema.columns, item.data ?? {});
          if (errors.length) {
            rejected.push({ index, errors });
            continue;
          }
          if (unknownKeys.length) warnings.push({ index, message: `Unknown columns kept as-is: ${unknownKeys.join(', ')}` });
          const fp = fingerprint(value);
          const dup = batch.get(fp) ?? (dedupe ? ((await this.db.get('SELECT id FROM rows WHERE dataset_id = ? AND fp = ? AND deleted_at IS NULL LIMIT 1', ds.id, fp))?.id as string | undefined) : undefined);
          if (dup) {
            rejected.push({ index, errors: ['Duplicate of an existing row'], duplicateOf: dup });
            continue;
          }
          const id = newId('row');
          const tags = JSON.stringify(item.tags ?? []);
          const data = JSON.stringify(value);
          await this.db.run(
            `INSERT INTO rows (id, dataset_id, seq, rev, data, tags, status, split, provenance, created_at, updated_at, fp)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, ds.id, seq++, data, tags, item.status ?? opts.defaultStatus ?? 'approved', item.split ?? null,
            JSON.stringify({ ...opts.provenance, actor }), now, now, fp,
          );
          await this.db.run('INSERT INTO row_revs (row_id, rev, data, tags, created_at, actor) VALUES (?, 1, ?, ?, ?, ?)', id, data, tags, now, JSON.stringify(actor));
          batch.set(fp, id);
          added.push(id);
        }
        await this.db.run('UPDATE datasets SET next_seq = ?, updated_at = ? WHERE id = ?', seq, now, ds.id);
      });
      return { added, rejected, warnings, total: (await this.stats(ds.id)).total };
    });
  }

  async updateRow(
    id: string,
    patch: { data?: Record<string, unknown>; tags?: string[]; status?: RowStatus; split?: string | null },
    actor: Actor,
    baseRev?: number,
  ): Promise<RowRecord> {
    return this.db.tx(async () => {
      const cur = await this.getRow(id);
      if (baseRev !== undefined && baseRev !== cur.rev) {
        throw conflict(`Row changed since revision ${baseRev} (now ${cur.rev}). Reload and re-apply.`, { current: cur.rev });
      }
      const ds = await this.get(cur.datasetId);
      let data = cur.data;
      if (patch.data) {
        const v = validateRow(ds.schema.columns, { ...cur.data, ...patch.data });
        if (v.errors.length) throw invalid(`Row is invalid: ${v.errors.join('; ')}`, v.errors);
        data = v.value;
      }
      const tags = patch.tags ?? cur.tags;
      const contentChanged = JSON.stringify(data) !== JSON.stringify(cur.data) || JSON.stringify(tags) !== JSON.stringify(cur.tags);
      const now = nowIso();
      await this.db.tx(async () => {
        const rev = contentChanged ? cur.rev + 1 : cur.rev;
        await this.db.run(
          'UPDATE rows SET data = ?, tags = ?, status = ?, split = ?, rev = ?, updated_at = ?, fp = ? WHERE id = ?',
          JSON.stringify(data), JSON.stringify(tags), patch.status ?? cur.status,
          patch.split === undefined ? cur.split : patch.split, rev, now, fingerprint(data), id,
        );
        if (contentChanged) {
          await this.db.run('INSERT INTO row_revs (row_id, rev, data, tags, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)', id, rev, JSON.stringify(data), JSON.stringify(tags), now, JSON.stringify(actor));
        }
        await this.touch(cur.datasetId);
      });
      return await this.getRow(id);
    });
  }

  async setStatus(datasetId: string, ids: string[], status: RowStatus) {
    return this.db.tx(async () => {
      const now = nowIso();
      let n = 0;
      await this.db.tx(async () => {
        for (const id of ids) n += Number((await this.db.run('UPDATE rows SET status = ?, updated_at = ? WHERE id = ? AND dataset_id = ? AND deleted_at IS NULL', status, now, id, datasetId)).changes);
        await this.touch(datasetId);
      });
      return n;
    });
  }

  async deleteRows(datasetId: string, ids: string[]) {
    return this.db.tx(async () => {
      const now = nowIso();
      let n = 0;
      await this.db.tx(async () => {
        for (const id of ids) n += Number((await this.db.run('UPDATE rows SET deleted_at = ? WHERE id = ? AND dataset_id = ? AND deleted_at IS NULL', now, id, datasetId)).changes);
        await this.touch(datasetId);
      });
      return n;
    });
  }

  /** Immutable snapshot of the current rows at their current revisions. Reuses the latest one if nothing changed. */
  async createVersion(datasetId: string, note: string, actor: Actor) {
    return this.db.tx(async () => {
      const ds = await this.get(datasetId);
      const rows = await this.db.all('SELECT id, rev FROM rows WHERE dataset_id = ? AND deleted_at IS NULL ORDER BY seq', ds.id);
      const fp = createHash('sha256')
        .update(JSON.stringify(ds.schema))
        .update(rows.map((r) => `${r.id}:${r.rev}`).join(','))
        .digest('hex');
      const latest = await this.db.get('SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY number DESC LIMIT 1', ds.id);
      if (latest && latest.fingerprint === fp) return { id: latest.id as string, number: latest.number as number, rowCount: latest.row_count as number, reused: true };
      const id = newId('dsv');
      const number = (latest?.number ?? 0) + 1;
      await this.db.tx(async () => {
        await this.db.run(
          'INSERT INTO dataset_versions (id, dataset_id, number, note, row_count, schema, fingerprint, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, ds.id, number, note, rows.length, JSON.stringify(ds.schema), fp, nowIso(), JSON.stringify(actor),
        );
        for (const r of rows) await this.db.run('INSERT INTO dataset_version_rows (version_id, row_id, rev) VALUES (?, ?, ?)', id, r.id, r.rev);
      });
      return { id, number, rowCount: rows.length, reused: false };
    });
  }

  async listVersions(datasetId: string) {
    const ds = await this.get(datasetId);
    return (await this.db.all('SELECT id, number, note, row_count, created_at, created_by FROM dataset_versions WHERE dataset_id = ? ORDER BY number DESC', ds.id))
      .map((v) => ({ id: v.id, number: v.number, note: v.note, rowCount: v.row_count, createdAt: v.created_at, createdBy: parseJson(v.created_by, {}) }));
  }

  /** Rows exactly as they were in a version (data at the recorded revision). */
  async versionRows(versionId: string) {
    return (await this.db.all(
        `SELECT r.id, r.seq, r.tags AS cur_tags, r.status, vr.rev, rr.data, rr.tags
         FROM dataset_version_rows vr
         JOIN rows r ON r.id = vr.row_id
         JOIN row_revs rr ON rr.row_id = vr.row_id AND rr.rev = vr.rev
         WHERE vr.version_id = ? ORDER BY r.seq`,
        versionId,
      ))
      .map((r) => ({ id: r.id as string, seq: r.seq as number, rev: r.rev as number, status: r.status as RowStatus, data: parseJson<Record<string, unknown>>(r.data, {}), tags: parseJson<string[]>(r.tags, []) }));
  }

  /** Tags (as of the version) and current review status of a version's rows, without their data. */
  async versionRowMeta(versionId: string) {
    return (await this.db.all(
        `SELECT r.id, r.status, rr.tags FROM dataset_version_rows vr
         JOIN rows r ON r.id = vr.row_id
         JOIN row_revs rr ON rr.row_id = vr.row_id AND rr.rev = vr.rev
         WHERE vr.version_id = ?`,
        versionId,
      ))
      .map((r) => ({ id: r.id as string, status: r.status as RowStatus, tags: parseJson<string[]>(r.tags, []) }));
  }

  /** Fills in fingerprints of rows written before they were stored (or by code that skipped them). */
  private async backfillFingerprints(datasetId: string) {
    return this.db.tx(async () => {
      for (const r of await this.db.all('SELECT id, data FROM rows WHERE dataset_id = ? AND fp IS NULL', datasetId)) {
        await this.db.run('UPDATE rows SET fp = ? WHERE id = ?', fingerprint(parseJson(r.data, {})), r.id);
      }
    });
  }
}

/** Identity of a row's values, independent of key order: equal fingerprints mean duplicate rows. */
export function fingerprint(data: Record<string, unknown>) {
  const sorted = Object.keys(data).sort().map((k) => [k, data[k]]);
  return createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
}

function assertUniqueColumns(columns: ColumnSpec[]) {
  const seen = new Set<string>();
  for (const c of columns) {
    if (seen.has(c.key)) throw invalid(`Duplicate column "${c.key}"`);
    seen.add(c.key);
  }
}

/** Coerces obvious cases (numeric strings, "true"), and reports errors per column. */
export function validateRow(columns: ColumnSpec[], data: Record<string, unknown>) {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  const known = new Set(columns.map((c) => c.key));
  for (const col of columns) {
    let v = data[col.key];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (col.required) errors.push(`${col.key}: required`);
      if (v !== undefined) value[col.key] = v;
      continue;
    }
    switch (col.type) {
      case 'text':
        if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
        if (typeof v !== 'string') errors.push(`${col.key}: expected text`);
        break;
      case 'number':
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
        if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${col.key}: expected a number`);
        break;
      case 'boolean':
        if (v === 'true' || v === 'false') v = v === 'true';
        if (typeof v !== 'boolean') errors.push(`${col.key}: expected true or false`);
        break;
      case 'list':
        if (typeof v === 'string') v = tryJson(v) ?? v.split(',').map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(v)) errors.push(`${col.key}: expected a list`);
        break;
      case 'messages':
        if (typeof v === 'string') v = tryJson(v) ?? v;
        if (!Array.isArray(v) || !v.every((m: any) => m && typeof m.role === 'string' && 'content' in m)) {
          errors.push(`${col.key}: expected [{role, content}, ...]`);
        }
        break;
      case 'json':
        if (typeof v === 'string') v = tryJson(v) ?? v;
        break;
      case 'audio':
      case 'image':
      case 'file': {
        if (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)) v = { blob: v };
        const parsed = FileValue.safeParse(v);
        if (!parsed.success) errors.push(`${col.key}: expected an uploaded file ({ blob: <sha256> })`);
        else v = parsed.data;
        break;
      }
    }
    if (col.enum?.length && typeof v === 'string' && !col.enum.includes(v)) {
      errors.push(`${col.key}: must be one of ${col.enum.join(', ')}`);
    }
    value[col.key] = v;
  }
  const unknownKeys = Object.keys(data).filter((k) => !known.has(k));
  for (const k of unknownKeys) value[k] = data[k];
  return { value, errors, unknownKeys };
}

function tryJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
