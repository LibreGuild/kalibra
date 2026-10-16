import type { Db } from '../db.js';
import type { Actor } from '../registry.js';
import { RunSettings } from '../specs.js';
import { newId, notFound, nowIso, parseJson } from '../util.js';

export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type ResultStatus = 'pending' | 'running' | 'done' | 'error';

export interface RunRecord {
  id: string;
  number: number;
  name: string;
  kind: 'live' | 'imported';
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
});

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
  attempts: r.attempts,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export class RunRepo {
  constructor(private db: Db) {}

  create(input: {
    name?: string;
    kind: 'live' | 'imported';
    datasetId: string;
    datasetVersionId: string;
    targetId?: string | null;
    targetVersion?: number | null;
    suiteId: string;
    suiteVersion: number;
    settings: RunSettings;
  }, actor: Actor): RunRecord {
    const id = newId('run');
    const number = ((this.db.get('SELECT MAX(number) AS n FROM runs')?.n as number) ?? 0) + 1;
    this.db.run(
      `INSERT INTO runs (id, number, name, kind, status, dataset_id, dataset_version_id, target_id, target_version, suite_id, suite_version, settings, created_at, created_by)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, number, input.name || `Run #${number}`, input.kind, input.datasetId, input.datasetVersionId,
      input.targetId ?? null, input.targetVersion ?? null, input.suiteId, input.suiteVersion,
      JSON.stringify(input.settings), nowIso(), JSON.stringify(actor),
    );
    return this.get(id);
  }

  get(id: string): RunRecord {
    const r = this.db.get('SELECT * FROM runs WHERE (id = ? OR CAST(number AS TEXT) = ?) AND deleted_at IS NULL', id, id);
    if (!r) throw notFound('Run', id);
    return toRun(r);
  }

  list(q: { datasetId?: string; targetId?: string; suiteId?: string; limit?: number; offset?: number } = {}) {
    const where = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (q.datasetId) (where.push('dataset_id = ?'), params.push(q.datasetId));
    if (q.targetId) (where.push('target_id = ?'), params.push(q.targetId));
    if (q.suiteId) (where.push('suite_id = ?'), params.push(q.suiteId));
    const clause = where.join(' AND ');
    const total = this.db.get(`SELECT COUNT(*) AS n FROM runs WHERE ${clause}`, ...params).n as number;
    const runs = this.db.all(`SELECT * FROM runs WHERE ${clause} ORDER BY number DESC LIMIT ? OFFSET ?`, ...params, q.limit ?? 50, q.offset ?? 0).map(toRun);
    return { total, runs };
  }

  setStatus(id: string, status: RunStatus, extra: { error?: string | null; summary?: unknown } = {}) {
    const now = nowIso();
    this.db.run(
      `UPDATE runs SET status = ?,
        started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? IN ('completed','cancelled','failed','interrupted') THEN ? ELSE NULL END,
        error = COALESCE(?, error),
        summary = COALESCE(?, summary)
       WHERE id = ?`,
      status, status, now, status, now, extra.error ?? null, extra.summary !== undefined ? JSON.stringify(extra.summary) : null, id,
    );
  }

  setSummary(id: string, summary: unknown) {
    this.db.run('UPDATE runs SET summary = ? WHERE id = ?', JSON.stringify(summary), id);
  }

  delete(id: string) {
    const run = this.get(id);
    this.db.run('UPDATE runs SET deleted_at = ? WHERE id = ?', nowIso(), run.id);
  }

  addPending(runId: string, items: { rowId: string; rowRev: number | null; rep: number; input: unknown; outputs?: unknown; metrics?: unknown; error?: string | null }[]) {
    this.db.tx(() => {
      let seq = 0;
      for (const it of items) {
        this.db.run(
          `INSERT INTO results (id, run_id, row_id, row_rev, rep, seq, status, input, outputs, metrics, error) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          newId('res'), runId, it.rowId, it.rowRev, it.rep, seq++, JSON.stringify(it.input),
          it.outputs ? JSON.stringify(it.outputs) : null, it.metrics ? JSON.stringify(it.metrics) : null, it.error ?? null,
        );
      }
      this.db.run('UPDATE runs SET total = ? WHERE id = ?', items.length, runId);
    });
  }

  pending(runId: string) {
    return this.db
      .all("SELECT * FROM results WHERE run_id = ? AND status IN ('pending','running') ORDER BY seq", runId)
      .map(toResult);
  }

  markRunning(resultId: string) {
    this.db.run("UPDATE results SET status = 'running', started_at = ? WHERE id = ?", nowIso(), resultId);
  }

  saveResult(runId: string, resultId: string, r: {
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
  }) {
    this.db.tx(() => {
      this.db.run(
        `UPDATE results SET status = ?, passed = ?, score = ?, request = ?, response = ?, outputs = ?, checks = ?, metrics = ?, error = ?, logs = ?, attempts = ?, finished_at = ? WHERE id = ?`,
        r.status, r.passed === null ? null : r.passed ? 1 : 0, r.score, JSON.stringify(r.request ?? null), JSON.stringify(r.response ?? null),
        JSON.stringify(r.outputs ?? {}), JSON.stringify(r.checks ?? []), JSON.stringify(r.metrics ?? {}), r.error ?? null,
        JSON.stringify(r.logs ?? []), r.attempts, nowIso(), resultId,
      );
      this.db.run("UPDATE runs SET done = (SELECT COUNT(*) FROM results WHERE run_id = ? AND status IN ('done','error')) WHERE id = ?", runId, runId);
    });
  }

  progress(runId: string) {
    return this.db.get('SELECT status, done, total FROM runs WHERE id = ?', runId) as { status: RunStatus; done: number; total: number };
  }

  resetRunning(runId: string) {
    this.db.run("UPDATE results SET status = 'pending' WHERE run_id = ? AND status = 'running'", runId);
  }

  /** Paged results for grids. Filters: passed/failed/error, a failing check id, free-text search. */
  query(runId: string, q: { filter?: 'all' | 'passed' | 'failed' | 'errors'; checkId?: string; search?: string; offset?: number; limit?: number; sort?: 'seq' | 'score' | 'latency' } = {}) {
    const where = ['run_id = ?'];
    const params: unknown[] = [runId];
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
    const total = this.db.get(`SELECT COUNT(*) AS n FROM results WHERE ${clause}`, ...params).n as number;
    const results = this.db.all(`SELECT * FROM results WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit ?? 100, q.offset ?? 0).map(toResultLite);
    return { total, results };
  }

  getResult(id: string): ResultRecord {
    const r = this.db.get('SELECT * FROM results WHERE id = ?', id);
    if (!r) throw notFound('Result', id);
    return toResult(r);
  }

  /** All finished results of a run, light shape, for summaries and comparisons. */
  allLite(runId: string) {
    return this.db.all("SELECT * FROM results WHERE run_id = ? ORDER BY seq", runId).map((r) => ({
      ...toResultLite(r),
      checks: parseJson<any[]>(r.checks, []),
    }));
  }
}
