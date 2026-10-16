import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { DEF_KINDS, type DefKind } from '../specs.js';
import { conflict, invalid, newId, notFound, nowIso, parseJson } from '../util.js';

/*
 * Targets, suites and connections share one versioned store. Every save creates an immutable
 * version; runs pin the exact version they used. Saves carry the version they started from
 * (optimistic concurrency), because the UI and an MCP agent can edit the same item at once.
 */

export interface DefRecord<S = any> {
  id: string;
  kind: DefKind;
  name: string;
  description: string;
  version: number;
  spec: S;
  createdAt: string;
  updatedAt: string;
  updatedBy: Actor;
}

const PREFIX: Record<DefKind, string> = { target: 'tgt', suite: 'ste', connection: 'con' };

const toDef = (r: any): DefRecord => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  description: r.description,
  version: r.version,
  spec: parseJson(r.spec, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: parseJson(r.updated_by, { kind: 'user', id: 'local' }),
});

export class DefRepo {
  constructor(private db: Db) {}

  list(kind: DefKind) {
    return this.db.all('SELECT * FROM defs WHERE kind = ? AND deleted_at IS NULL ORDER BY updated_at DESC', kind).map(toDef);
  }

  get(kind: DefKind, idOrName: string): DefRecord {
    const r = this.db.get('SELECT * FROM defs WHERE kind = ? AND (id = ? OR name = ?) AND deleted_at IS NULL', kind, idOrName, idOrName);
    if (!r) throw notFound(kind[0].toUpperCase() + kind.slice(1), idOrName);
    return toDef(r);
  }

  getVersion(kind: DefKind, id: string, version: number): DefRecord {
    // Runs pin versions by id; they keep working (view, resume) after the item is moved to the trash.
    const pinned = this.db.get('SELECT * FROM defs WHERE kind = ? AND id = ?', kind, id);
    const cur = pinned ? toDef(pinned) : this.get(kind, id);
    const v = this.db.get('SELECT * FROM def_versions WHERE def_id = ? AND version = ?', cur.id, version);
    if (!v) throw notFound(`${kind} version`, `${id}@${version}`);
    return { ...cur, name: v.name, version: v.version, spec: parseJson(v.spec, {}) };
  }

  versions(kind: DefKind, id: string) {
    const cur = this.get(kind, id);
    return this.db
      .all('SELECT version, name, created_at, actor FROM def_versions WHERE def_id = ? ORDER BY version DESC', cur.id)
      .map((v) => ({ version: v.version, name: v.name, createdAt: v.created_at, actor: parseJson(v.actor, {}) }));
  }

  create(kind: DefKind, input: { name: string; description?: string; spec: unknown }, actor: Actor): DefRecord {
    const spec = this.validate(kind, input.spec);
    if (!input.name.trim()) throw invalid('Name is required');
    if (this.db.get('SELECT 1 FROM defs WHERE kind = ? AND name = ? AND deleted_at IS NULL', kind, input.name)) {
      throw conflict(`A ${kind} named "${input.name}" already exists`);
    }
    const id = newId(PREFIX[kind]);
    const now = nowIso();
    const a = JSON.stringify(actor);
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO defs (id, kind, name, description, version, spec, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
        id, kind, input.name, input.description ?? '', JSON.stringify(spec), now, now, a, a,
      );
      this.db.run('INSERT INTO def_versions (def_id, version, name, spec, created_at, actor) VALUES (?, 1, ?, ?, ?, ?)', id, input.name, JSON.stringify(spec), now, a);
    });
    return this.get(kind, id);
  }

  update(kind: DefKind, id: string, patch: { name?: string; description?: string; spec?: unknown }, actor: Actor, baseVersion?: number): DefRecord {
    const cur = this.get(kind, id);
    if (baseVersion !== undefined && baseVersion !== cur.version) {
      throw conflict(`This ${kind} was changed (now version ${cur.version}, you edited version ${baseVersion}). Reload and re-apply your change.`, { current: cur.version });
    }
    const name = patch.name ?? cur.name;
    if (name !== cur.name && this.db.get('SELECT 1 FROM defs WHERE kind = ? AND name = ? AND id != ? AND deleted_at IS NULL', kind, name, cur.id)) {
      throw conflict(`A ${kind} named "${name}" already exists`);
    }
    const spec = patch.spec !== undefined ? this.validate(kind, patch.spec) : cur.spec;
    const specChanged = JSON.stringify(spec) !== JSON.stringify(cur.spec) || name !== cur.name;
    const now = nowIso();
    const a = JSON.stringify(actor);
    this.db.tx(() => {
      const version = specChanged ? cur.version + 1 : cur.version;
      this.db.run(
        'UPDATE defs SET name = ?, description = ?, spec = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        name, patch.description ?? cur.description, JSON.stringify(spec), version, now, a, cur.id,
      );
      if (specChanged) {
        this.db.run('INSERT INTO def_versions (def_id, version, name, spec, created_at, actor) VALUES (?, ?, ?, ?, ?, ?)', cur.id, version, name, JSON.stringify(spec), now, a);
      }
    });
    return this.get(kind, cur.id);
  }

  delete(kind: DefKind, id: string) {
    const cur = this.get(kind, id);
    this.db.run('UPDATE defs SET deleted_at = ? WHERE id = ?', nowIso(), cur.id);
  }

  validate(kind: DefKind, spec: unknown) {
    const parsed = DEF_KINDS[kind].safeParse(spec ?? {});
    if (!parsed.success) {
      throw invalid(`Invalid ${kind}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, parsed.error.issues);
    }
    return parsed.data;
  }
}
