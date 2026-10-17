import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { newId, nowIso, parseJson } from '../util.js';

/** Saved analyses (failure themes, …) in the `insights` table; the latest per subject wins. */

export async function saveInsight(db: Db, kind: string, subjectId: string, data: unknown, actor: Actor) {
  const id = newId('ins');
  const at = nowIso();
  await db.run('INSERT INTO insights (id, kind, subject_id, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', id, kind, subjectId, JSON.stringify(data), at, JSON.stringify(actor));
  return { id, createdAt: at };
}

export async function latestInsight<T = any>(db: Db, kind: string, subjectId: string): Promise<{ id: string; createdAt: string; createdBy: Actor; data: T } | null> {
  const r = await db.get('SELECT * FROM insights WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', kind, subjectId);
  if (!r) return null;
  return { id: r.id, createdAt: r.created_at, createdBy: parseJson(r.created_by, { kind: 'user', id: 'local' } as Actor), data: parseJson<T>(r.data, {} as T) };
}
