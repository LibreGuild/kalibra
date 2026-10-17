import { z } from 'zod';
import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { RunSettings } from '../specs.js';
import { newId, notFound, nowIso, parseJson } from '../util.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
/**
 * live: Kalibra calls a target. imported: outputs came from a file. code: outputs came from the
 * developer's own code (SDK evaluate() / CI), submitted in batches (ops/coderuns.ts).
 */
export type RunKind = 'live' | 'imported' | 'code';

/** Where a run came from in version control, so CI runs can be compared with their base branch. */
export const GitInfoInput = z.object({
  branch: z.string().max(200).optional(),
  commit: z.string().max(100).optional(),
  pr: z.number().int().positive().optional(),
  baseBranch: z.string().max(200).optional().describe('Branch to compare with (default main)'),
});
export type GitInfo = z.infer<typeof GitInfoInput>;
export type ResultStatus = 'pending' | 'running' | 'done' | 'error';

export interface RunRecord {
  id: string;
  number: number;
  name: string;
  kind: RunKind;
  status: RunStatus;
  datasetId: string | null;
  datasetVersionId: string | null;
  targetId: string | null;
  targetVersion: number | null;
  suiteId: string | null;
  suiteVersion: number | null;
  settings: RunSettings;
  summary: any;
  total: number;
  done: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: Actor;
  error: string | null;
  /** Set when the run is one variant of a comparison. */
  groupId: string | null;
  variantLabel: string | null;
  git: GitInfo | null;
}

export interface RunGroupRecord {
  id: string;
  number: number;
  name: string;
  datasetId: string;
  suiteId: string;
  settings: Record<string, unknown>;
  createdAt: string;
  createdBy: Actor;
}

export interface ResultRecord {
  id: string;
  runId: string;
  rowId: string;
  rowRev: number | null;
  rep: number;
  seq: number;
  status: ResultStatus;
  passed: boolean | null;
  score: number | null;
  input: Record<string, unknown>;
  request: unknown;
  response: any;
  outputs: Record<string, unknown>;
  checks: any[];
  metrics: Record<string, number>;
  error: string | null;
  logs: any[];
  attempts: number;
  /** What the app did inside for this row (spans of its trace, or steps it returned), in start order. */
  steps: unknown[] | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const toRun = (r: any): RunRecord => ({
  id: r.id,
  number: r.number,
  name: r.name,
  kind: r.kind,
  status: r.status,
  datasetId: r.dataset_id,
  datasetVersionId: r.dataset_version_id,
  targetId: r.target_id,
  targetVersion: r.target_version,
  suiteId: r.suite_id,
  suiteVersion: r.suite_version,
  settings: RunSettings.parse(parseJson(r.settings, {})),
  summary: parseJson(r.summary, {}),
  total: r.total,
  done: r.done,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdBy: parseJson(r.created_by, { kind: 'user', id: 'local' }),
  error: r.error,
  groupId: r.group_id ?? null,
  variantLabel: r.variant_label ?? null,
  git: parseJson<GitInfo | null>(r.git, null),
});

const toGroup = (r: any): RunGroupRecord => ({
  id: r.id,
  number: r.number,
  name: r.name,
  datasetId: r.dataset_id,
  suiteId: r.suite_id,
  settings: parseJson(r.settings, {}),
  createdAt: r.created_at,
  createdBy: parseJson(r.created_by, { kind: 'user', id: 'local' }),
});

/** Columns toResultLite reads: request, response and logs can be large and are left in the database. */
const LITE_COLUMNS = 'id, row_id, rep, seq, status, passed, score, input, outputs, checks, metrics, error';

/** Light result shape for grids (no request/response/logs). */
const toResultLite = (r: any) => ({
  id: r.id as string,
  rowId: r.row_id as string,
  rep: r.rep as number,
  seq: r.seq as number,
  status: r.status as ResultStatus,
  passed: r.passed === null ? null : !!r.passed,
  score: r.score as number | null,
  input: parseJson<Record<string, unknown>>(r.input, {}),
  outputs: parseJson<Record<string, unknown>>(r.outputs, {}),
  checks: parseJson<any[]>(r.checks, []).map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, score: c.score, value: c.value, reason: c.reason, layer: c.layer, gate: c.gate })),
  metrics: parseJson<Record<string, number>>(r.metrics, {}),
  error: r.error as string | null,
});

const toResult = (r: any): ResultRecord => ({
  ...toResultLite(r),
  runId: r.run_id,
  rowRev: r.row_rev,
  request: parseJson(r.request, null),
  response: parseJson(r.response, null),
  checks: parseJson(r.checks, []),
  logs: parseJson(r.logs, []),
  steps: parseJson<unknown[] | null>(r.steps, null),
  attempts: r.attempts,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export class RunRepo {
  constructor(private db: Db) {}

  async create(input: {
    name?: string;
    kind: RunKind;
    datasetId: string;
    datasetVersionId: string;
    targetId?: string | null;
    targetVersion?: number | null;
    suiteId: string;
    suiteVersion: number;
    settings: RunSettings;
    groupId?: string | null;
    variantLabel?: string | null;
  }, actor: Actor): Promise<RunRecord> {
    return this.db.tx(async () => {
      const id = newId('run');
      const number = (((await this.db.get('SELECT MAX(number) AS n FROM runs'))?.n as number) ?? 0) + 1;
      await this.db.run(
        `INSERT INTO runs (id, number, name, kind, status, dataset_id, dataset_version_id, target_id, target_version, suite_id, suite_version, settings, created_at, created_by, group_id, variant_label)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, number, input.name || `Run #${number}`, input.kind, input.datasetId, input.datasetVersionId,
        input.targetId ?? null, input.targetVersion ?? null, input.suiteId, input.suiteVersion,
        JSON.stringify(input.settings), nowIso(), JSON.stringify(actor), input.groupId ?? null, input.variantLabel ?? null,
      );
      return await this.get(id);
    });
  }

  async createGroup(input: { name?: string; datasetId: string; suiteId: string; settings: Record<string, unknown> }, actor: Actor): Promise<RunGroupRecord> {
    return this.db.tx(async () => {
      const id = newId('cmp');
      const number = (((await this.db.get('SELECT MAX(number) AS n FROM run_groups'))?.n as number) ?? 0) + 1;
      await this.db.run(
        'INSERT INTO run_groups (id, number, name, dataset_id, suite_id, settings, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, number, input.name || `Comparison #${number}`, input.datasetId, input.suiteId, JSON.stringify(input.settings), nowIso(), JSON.stringify(actor),
      );
      return await this.getGroup(id);
    });
  }

  async getGroup(id: string): Promise<RunGroupRecord> {
    const r = await this.db.get('SELECT * FROM run_groups WHERE (id = ? OR CAST(number AS TEXT) = ?) AND deleted_at IS NULL', id, id);
    if (!r) throw notFound('Comparison', id);
    return toGroup(r);
  }

  async listGroups(limit = 50, offset = 0) {
    const total = (await this.db.get('SELECT COUNT(*) AS n FROM run_groups WHERE deleted_at IS NULL')).n as number;
    const groups = (await this.db.all('SELECT * FROM run_groups WHERE deleted_at IS NULL ORDER BY number DESC LIMIT ? OFFSET ?', limit, offset)).map(toGroup);
    return { total, groups };
  }

  async groupRuns(groupId: string): Promise<RunRecord[]> {
    return (await this.db.all('SELECT * FROM runs WHERE group_id = ? AND deleted_at IS NULL ORDER BY number', groupId)).map(toRun);
  }

  async deleteGroup(id: string) {
    return this.db.tx(async () => {
      const g = await this.getGroup(id);
      const now = nowIso();
      await this.db.tx(async () => {
        await this.db.run('UPDATE run_groups SET deleted_at = ? WHERE id = ?', now, g.id);
        await this.db.run('UPDATE runs SET deleted_at = ? WHERE group_id = ? AND deleted_at IS NULL', now, g.id);
      });
      return g;
    });
  }

  async get(id: string): Promise<RunRecord> {
    const r = await this.db.get('SELECT * FROM runs WHERE (id = ? OR CAST(number AS TEXT) = ?) AND deleted_at IS NULL', id, id);
    if (!r) throw notFound('Run', id);
    return toRun(r);
  }

  async list(q: { datasetId?: string; targetId?: string; suiteId?: string; groupId?: string; excludeGrouped?: boolean; limit?: number; offset?: number } = {}) {
    const where = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (q.groupId) (where.push('group_id = ?'), params.push(q.groupId));
    if (q.excludeGrouped) where.push('group_id IS NULL');
    if (q.datasetId) (where.push('dataset_id = ?'), params.push(q.datasetId));
    if (q.targetId) (where.push('target_id = ?'), params.push(q.targetId));
    if (q.suiteId) (where.push('suite_id = ?'), params.push(q.suiteId));
    const clause = where.join(' AND ');
    const total = (await this.db.get(`SELECT COUNT(*) AS n FROM runs WHERE ${clause}`, ...params)).n as number;
    const runs = (await this.db.all(`SELECT * FROM runs WHERE ${clause} ORDER BY number DESC LIMIT ? OFFSET ?`, ...params, q.limit ?? 50, q.offset ?? 0)).map(toRun);
    return { total, runs };
  }

  async setStatus(id: string, status: RunStatus, extra: { error?: string | null; summary?: unknown } = {}) {
    return this.db.tx(async () => {
      const now = nowIso();
      await this.db.run(
        `UPDATE runs SET status = ?,
          started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
          finished_at = CASE WHEN ? IN ('completed','cancelled','failed','interrupted') THEN ? ELSE NULL END,
          error = CASE WHEN ? = 'running' THEN NULL ELSE COALESCE(?, error) END,
          summary = COALESCE(?, summary)
         WHERE id = ?`,
        status, status, now, status, now, status, extra.error ?? null, extra.summary !== undefined ? JSON.stringify(extra.summary) : null, id,
      );
    });
  }

  async setSummary(id: string, summary: unknown) {
    return this.db.tx(async () => {
      await this.db.run('UPDATE runs SET summary = ? WHERE id = ?', JSON.stringify(summary), id);
    });
  }

  async delete(id: string) {
    return this.db.tx(async () => {
      const run = await this.get(id);
      await this.db.run('UPDATE runs SET deleted_at = ? WHERE id = ?', nowIso(), run.id);
    });
  }

  async addPending(runId: string, items: { rowId: string; rowRev: number | null; rep: number; input: unknown; outputs?: unknown; metrics?: unknown; error?: string | null }[]) {
    return this.db.tx(async () => {
      await this.db.tx(async () => {
        let seq = 0;
        for (const it of items) {
          await this.db.run(
            `INSERT INTO results (id, run_id, row_id, row_rev, rep, seq, status, input, outputs, metrics, error) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            newId('res'), runId, it.rowId, it.rowRev, it.rep, seq++, JSON.stringify(it.input),
            it.outputs ? JSON.stringify(it.outputs) : null, it.metrics ? JSON.stringify(it.metrics) : null, it.error ?? null,
          );
        }
        await this.db.run('UPDATE runs SET total = ? WHERE id = ?', items.length, runId);
      });
    });
  }

  async pending(runId: string) {
    return (await this.db.all("SELECT * FROM results WHERE run_id = ? AND status IN ('pending','running') ORDER BY seq", runId))
      .map(toResult);
  }

  async markRunning(resultId: string) {
    return this.db.tx(async () => {
      await this.db.run("UPDATE results SET status = 'running', started_at = ? WHERE id = ?", nowIso(), resultId);
    });
  }

  async saveResult(runId: string, resultId: string, r: {
    status: ResultStatus;
    passed: boolean | null;
    score: number | null;
    request?: unknown;
    response?: unknown;
    outputs: unknown;
    checks: unknown;
    metrics: unknown;
    error?: string | null;
    logs?: unknown;
    attempts: number;
    steps?: unknown[] | null;
  }) {
    return this.db.tx(async () => {
      const final = (s: unknown) => s === 'done' || s === 'error';
      await this.db.tx(async () => {
        const before = (await this.db.get('SELECT status FROM results WHERE id = ?', resultId))?.status;
        await this.db.run(
          `UPDATE results SET status = ?, passed = ?, score = ?, request = ?, response = ?, outputs = ?, checks = ?, metrics = ?, error = ?, logs = ?, attempts = ?, steps = ?, finished_at = ? WHERE id = ?`,
          r.status, r.passed === null ? null : r.passed ? 1 : 0, r.score, JSON.stringify(r.request ?? null), JSON.stringify(r.response ?? null),
          JSON.stringify(r.outputs ?? {}), JSON.stringify(r.checks ?? []), JSON.stringify(r.metrics ?? {}), r.error ?? null,
          JSON.stringify(r.logs ?? []), r.attempts, r.steps?.length ? JSON.stringify(r.steps) : null, nowIso(), resultId,
        );
        // Keep the finished count by increments: recounting the run's results on every save made big runs
        // quadratic (seconds per thousand rows at 50k).
        const delta = Number(final(r.status)) - Number(final(before));
        if (delta) await this.db.run('UPDATE runs SET done = done + ? WHERE id = ?', delta, runId);
      });
    });
  }

  async progress(runId: string) {
    return await this.db.get('SELECT status, done, total FROM runs WHERE id = ?', runId) as { status: RunStatus; done: number; total: number };
  }

  async resetRunning(runId: string) {
    return this.db.tx(async () => {
      await this.db.run("UPDATE results SET status = 'pending' WHERE run_id = ? AND status = 'running'", runId);
    });
  }

  /** Paged results for grids. Filters: passed/failed/error, a failing check id, free-text search. */
  async query(runId: string, q: { filter?: 'all' | 'passed' | 'failed' | 'errors'; checkId?: string; search?: string; ids?: string[]; offset?: number; limit?: number; sort?: 'seq' | 'score' | 'latency' } = {}) {
    const where = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (q.ids) {
      if (!q.ids.length) return { total: 0, results: [] };
      where.push(`id IN (${q.ids.map(() => '?').join(',')})`);
      params.push(...q.ids);
    }
    if (q.filter === 'passed') where.push('passed = 1');
    if (q.filter === 'failed') where.push('passed = 0');
    if (q.filter === 'errors') where.push("(status = 'error' OR error IS NOT NULL)");
    if (q.checkId) {
      where.push("EXISTS (SELECT 1 FROM json_each(results.checks) j WHERE json_extract(j.value, '$.id') = ? AND json_extract(j.value, '$.status') IN ('fail','error'))");
      params.push(q.checkId);
    }
    if (q.search) {
      where.push('(input LIKE ? OR outputs LIKE ? OR row_id = ?)');
      params.push(`%${q.search}%`, `%${q.search}%`, q.search);
    }
    const order = q.sort === 'score' ? 'score ASC NULLS FIRST, seq' : q.sort === 'latency' ? "json_extract(metrics, '$.latency_ms') DESC, seq" : 'seq';
    const clause = where.join(' AND ');
    const total = (await this.db.get(`SELECT COUNT(*) AS n FROM results WHERE ${clause}`, ...params)).n as number;
    const results = (await this.db.all(`SELECT ${LITE_COLUMNS} FROM results WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit ?? 100, q.offset ?? 0)).map(toResultLite);
    return { total, results };
  }

  async getResult(id: string): Promise<ResultRecord> {
    const r = await this.db.get('SELECT * FROM results WHERE id = ?', id);
    if (!r) throw notFound('Result', id);
    return toResult(r);
  }

  /** Just what summarize() reads, for live and final run summaries (no inputs or outputs to parse). */
  async summaryRows(runId: string) {
    return (await this.db.all('SELECT status, passed, score, error, checks, metrics FROM results WHERE run_id = ? ORDER BY seq', runId))
      .map((r) => ({
        status: r.status as ResultStatus,
        passed: r.passed === null ? null : !!r.passed,
        score: r.score as number | null,
        error: r.error as string | null,
        checks: parseJson<any[]>(r.checks, []),
        metrics: parseJson<Record<string, number>>(r.metrics, {}),
      }));
  }

  // ── Code runs and git metadata (ops/coderuns.ts) ───────────────────────────

  async setGit(runId: string, git: GitInfo | null) {
    return this.db.tx(async () => {
      await this.db.run('UPDATE runs SET git = ? WHERE id = ?', git && Object.keys(git).length ? JSON.stringify(git) : null, runId);
    });
  }

  /**
   * Stores what the developer's code produced for a row of a code run, before scoring. Submitting
   * the same row again replaces the earlier submission. Returns false when the row is not part of
   * the run or was already scored.
   */
  async submitCodeOutput(runId: string, rowId: string, r: { outputs: unknown; metrics?: unknown; error?: string | null }): Promise<boolean> {
    return this.db.tx(async () => {
      const res = await this.db.run(
        "UPDATE results SET outputs = ?, metrics = ?, error = ? WHERE run_id = ? AND row_id = ? AND status = 'pending'",
        JSON.stringify(r.outputs ?? {}), JSON.stringify(r.metrics ?? {}), r.error ?? null, runId, rowId,
      );
      return Number(res.changes) > 0;
    });
  }

  /** Rows of a code run nothing was submitted for (outputs still NULL) get an error instead. */
  async markUnsubmitted(runId: string, message: string): Promise<number> {
    return this.db.tx(async () => {
      const res = await this.db.run("UPDATE results SET outputs = '{}', error = ? WHERE run_id = ? AND status = 'pending' AND outputs IS NULL", message, runId);
      return Number(res.changes);
    });
  }

  /** How many rows of a code run have outputs submitted. */
  async submittedCount(runId: string): Promise<number> {
    return (await this.db.get('SELECT COUNT(*) AS n FROM results WHERE run_id = ? AND outputs IS NOT NULL', runId)).n as number;
  }

  /**
   * The run to compare a CI run with: the latest completed run on `branch` with the same dataset
   * and suite (and target, when the run has one), started before `beforeNumber`.
   */
  async findBaseline(q: { datasetId: string | null; suiteId: string | null; targetId: string | null; branch: string; beforeNumber: number }): Promise<RunRecord | undefined> {
    const r = await this.db.get(
      `SELECT * FROM runs
        WHERE deleted_at IS NULL AND status = 'completed' AND number < ?
          AND dataset_id IS ? AND suite_id IS ? AND target_id IS ?
          AND json_extract(git, '$.branch') = ?
        ORDER BY number DESC LIMIT 1`,
      q.beforeNumber, q.datasetId, q.suiteId, q.targetId, q.branch,
    );
    return r ? toRun(r) : undefined;
  }

  /** All finished results of a run, light shape, for summaries and comparisons. */
  async allLite(runId: string) {
    return (await this.db.all(`SELECT ${LITE_COLUMNS} FROM results WHERE run_id = ? ORDER BY seq`, runId)).map((r) => ({
      ...toResultLite(r),
      checks: parseJson<any[]>(r.checks, []),
    }));
  }
}
