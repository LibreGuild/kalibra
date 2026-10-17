import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { newId, nowIso, parseJson } from '../util.js';

/*
 * Human labels on results: the ground truth used to check whether a judge (or any check)
 * agrees with people. One label per (result, check); check '' labels the whole row.
 */

export type Label = 'pass' | 'fail';

export interface LabelRecord {
  id: string;
  runId: string;
  resultId: string;
  checkId: string;
  label: Label;
  note: string;
  actor: Actor;
  createdAt: string;
  updatedAt: string;
}

const toLabel = (r: any): LabelRecord => ({
  id: r.id,
  runId: r.run_id,
  resultId: r.result_id,
  checkId: r.check_id,
  label: r.label,
  note: r.note,
  actor: parseJson(r.actor, { kind: 'user', id: 'local' }),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class LabelRepo {
  constructor(private db: Db) {}

  async set(input: { runId: string; resultId: string; checkId: string; label: Label; note?: string }, actor: Actor): Promise<LabelRecord> {
    return this.db.tx(async () => {
      const now = nowIso();
      await this.db.run(
        `INSERT INTO labels (id, run_id, result_id, check_id, label, note, actor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(result_id, check_id) DO UPDATE SET label = excluded.label, note = excluded.note, actor = excluded.actor, updated_at = excluded.updated_at`,
        newId('lbl'), input.runId, input.resultId, input.checkId, input.label, input.note ?? '', JSON.stringify(actor), now, now,
      );
      return (await this.get(input.resultId, input.checkId))!;
    });
  }

  async clear(resultId: string, checkId: string) {
    return this.db.tx(async () => {
      return Number((await this.db.run('DELETE FROM labels WHERE result_id = ? AND check_id = ?', resultId, checkId)).changes);
    });
  }

  async get(resultId: string, checkId: string): Promise<LabelRecord | undefined> {
    const r = await this.db.get('SELECT * FROM labels WHERE result_id = ? AND check_id = ?', resultId, checkId);
    return r ? toLabel(r) : undefined;
  }

  /** Labels for one or more runs, optionally for one check. */
  async list(runIds: string[], checkId?: string): Promise<LabelRecord[]> {
    if (!runIds.length) return [];
    const marks = runIds.map(() => '?').join(',');
    const rows =
      checkId === undefined
        ? await this.db.all(`SELECT * FROM labels WHERE run_id IN (${marks}) ORDER BY updated_at`, ...runIds)
        : await this.db.all(`SELECT * FROM labels WHERE run_id IN (${marks}) AND check_id = ? ORDER BY updated_at`, ...runIds, checkId);
    return rows.map(toLabel);
  }
}
