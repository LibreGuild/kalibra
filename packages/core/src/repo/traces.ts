import type { Db } from '../db.js';
import { notFound, nowIso, parseJson } from '../util.js';
import type { Span, Trace, TraceWithSpans } from '../traces/types.js';

/*
 * Storage of traces, their spans and tool recordings (tables from project migration 5).
 * Writes come in batches from TraceStore's queue; reads serve the Traces page, eval rows (by
 * result id) and the check scope.
 */

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const opt = <T>(s: string | null): T | undefined => (s === null || s === undefined ? undefined : (parseJson<T>(s, undefined as T) as T));

const toTrace = (r: any): Trace & { spanCount?: number } => ({
  id: r.id,
  name: r.name,
  source: r.source,
  status: r.status,
  startedAt: r.started_at,
  ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
  ...(r.input !== null ? { input: opt(r.input) } : {}),
  ...(r.output !== null ? { output: opt(r.output) } : {}),
  ...(r.error ? { error: r.error } : {}),
  metadata: parseJson(r.metadata, {}),
  tags: parseJson(r.tags, []),
  ...(r.run_id ? { runId: r.run_id } : {}),
  ...(r.result_id ? { resultId: r.result_id } : {}),
  createdAt: r.created_at,
  ...(r.span_count !== undefined ? { spanCount: r.span_count } : {}),
});

const toSpan = (r: any): Span => ({
  id: r.id,
  traceId: r.trace_id,
  ...(r.parent_id ? { parentId: r.parent_id } : {}),
  name: r.name,
  kind: r.kind,
  startedAt: r.started_at,
  ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
  ...(r.input !== null ? { input: opt(r.input) } : {}),
  ...(r.output !== null ? { output: opt(r.output) } : {}),
  ...(r.error ? { error: r.error } : {}),
  attributes: parseJson(r.attributes, {}),
});

const endMs = (startedAt: string, durationMs?: number | null) => Date.parse(startedAt) + (durationMs ?? 0);

export interface TraceQuery {
  name?: string;
  status?: 'ok' | 'error';
  source?: 'sdk' | 'otel' | 'proxy';
  since?: string;
  until?: string;
  /** Text in the name, input, output or error. */
  search?: string;
  runId?: string;
  resultId?: string;
  /** Exact metadata values, e.g. { environment: 'dev' }. */
  metadata?: Record<string, string>;
  limit?: number;
  offset?: number;
}

export class TraceRepo {
  constructor(private db: Db) {}

  /**
   * Stores a batch in one transaction. A trace sent again (an SDK retry) replaces itself; a partial
   * trace (OpenTelemetry sends spans as they end) is merged: spans are added, the time range grows,
   * and the root span's name, input and output win once it arrives.
   */
  write(batch: TraceWithSpans[]) {
    const now = nowIso();
    this.db.tx(() => {
      for (const t of batch) {
        const cur = this.db.get('SELECT * FROM traces WHERE id = ?', t.id);
        if (cur && t.partial) {
          const start = cur.started_at < t.startedAt ? cur.started_at : t.startedAt;
          const end = Math.max(endMs(cur.started_at, cur.duration_ms), endMs(t.startedAt, t.durationMs));
          const hasRoot = t.spans.some((s) => !s.parentId);
          this.db.run(
            `UPDATE traces SET name = ?, status = ?, started_at = ?, duration_ms = ?, input = COALESCE(?, input), output = COALESCE(?, output),
               error = COALESCE(?, error), metadata = ?, run_id = COALESCE(run_id, ?), result_id = COALESCE(result_id, ?) WHERE id = ?`,
            hasRoot ? t.name : cur.name,
            cur.status === 'error' || t.status === 'error' ? 'error' : 'ok',
            start,
            end - Date.parse(start),
            hasRoot ? json(t.input) : null,
            hasRoot ? json(t.output) : null,
            t.error ?? null,
            JSON.stringify({ ...parseJson(cur.metadata, {}), ...t.metadata }),
            t.runId ?? null,
            t.resultId ?? null,
            t.id,
          );
        } else {
          this.db.run(
            `INSERT OR REPLACE INTO traces (id, name, source, status, started_at, duration_ms, input, output, error, metadata, tags, run_id, result_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            t.id, t.name, t.source, t.status, t.startedAt, t.durationMs ?? null, json(t.input), json(t.output), t.error ?? null,
            JSON.stringify(t.metadata), JSON.stringify(t.tags), t.runId ?? null, t.resultId ?? null, cur?.created_at ?? now,
          );
          if (!t.partial) this.db.run('DELETE FROM spans WHERE trace_id = ?', t.id);
        }
        for (const s of t.spans) {
          this.db.run(
            `INSERT OR REPLACE INTO spans (id, trace_id, parent_id, name, kind, started_at, duration_ms, input, output, error, attributes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            s.id, t.id, s.parentId ?? null, s.name, s.kind, s.startedAt, s.durationMs ?? null, json(s.input), json(s.output), s.error ?? null, JSON.stringify(s.attributes),
          );
        }
      }
    });
  }

  list(q: TraceQuery = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.name) (where.push('name = ?'), params.push(q.name));
    if (q.status) (where.push('status = ?'), params.push(q.status));
    if (q.source) (where.push('source = ?'), params.push(q.source));
    if (q.since) (where.push('started_at >= ?'), params.push(q.since));
    if (q.until) (where.push('started_at <= ?'), params.push(q.until));
    if (q.runId) (where.push('run_id = ?'), params.push(q.runId));
    if (q.resultId) (where.push('result_id = ?'), params.push(q.resultId));
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(name LIKE ? ESCAPE '\\' OR input LIKE ? ESCAPE '\\' OR output LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    for (const [k, v] of Object.entries(q.metadata ?? {})) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
      where.push(`json_extract(metadata, '$."${k}"') = ?`);
      params.push(v);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM traces ${clause}`, ...params).n as number;
    const rows = this.db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM spans s WHERE s.trace_id = t.id) AS span_count FROM traces t ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      ...params,
      Math.min(q.limit ?? 50, 500),
      q.offset ?? 0,
    );
    return { total, traces: rows.map(toTrace) };
  }

  get(id: string): Trace & { spans: Span[] } {
    const r = this.db.get('SELECT * FROM traces WHERE id = ?', id);
    if (!r) throw notFound('Trace', id);
    return { ...toTrace(r), spans: this.db.all('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, id', id).map(toSpan) };
  }

  /** Every trace of one eval row (a conversation can send one per turn), oldest first. */
  byResult(resultId: string): (Trace & { spans: Span[] })[] {
    return this.db.all('SELECT id FROM traces WHERE result_id = ? ORDER BY started_at', resultId).map((r) => this.get(r.id));
  }

  delete(ids: string[]) {
    let n = 0;
    this.db.tx(() => {
      for (const id of ids) {
        this.db.run('DELETE FROM spans WHERE trace_id = ?', id);
        n += Number(this.db.run('DELETE FROM traces WHERE id = ?', id).changes);
      }
    });
    return n;
  }

  /** Deletes traces matching a filter (or all), in chunks so a huge delete doesn't hold the database. */
  deleteWhere(q: Omit<TraceQuery, 'limit' | 'offset'>) {
    let deleted = 0;
    for (;;) {
      const ids = this.list({ ...q, limit: 500 }).traces.map((t) => t.id);
      if (!ids.length) return deleted;
      deleted += this.delete(ids);
    }
  }

  /** Removes traces started before `before` that belong to no run (run traces live as long as their run). */
  prune(before: string) {
    let n = 0;
    this.db.tx(() => {
      this.db.run('DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ? AND run_id IS NULL)', before);
      n = Number(this.db.run('DELETE FROM traces WHERE started_at < ? AND run_id IS NULL', before).changes);
    });
    return n;
  }

  counts() {
    return {
      traces: this.db.get('SELECT COUNT(*) AS n FROM traces').n as number,
      spans: this.db.get('SELECT COUNT(*) AS n FROM spans').n as number,
    };
  }
}

export interface ToolRecording {
  tool: string;
  argsHash: string;
  args: unknown;
  output?: unknown;
  error?: string;
  recordedAt: string;
  runId?: string;
}

const toRecording = (r: any): ToolRecording => ({
  tool: r.tool,
  argsHash: r.args_hash,
  args: parseJson(r.args, null),
  ...(r.output !== null ? { output: parseJson(r.output, null) } : {}),
  ...(r.error ? { error: r.error } : {}),
  recordedAt: r.recorded_at,
  ...(r.run_id ? { runId: r.run_id } : {}),
});

/** Recorded tool responses, replayed by the SDKs during evals (docs/design/sdk-and-traces.md §6). */
export class ToolRecordingRepo {
  constructor(private db: Db) {}

  upsert(r: { tool: string; argsHash: string; args: unknown; output?: unknown; error?: string; runId?: string }) {
    this.db.run(
      `INSERT INTO tool_recordings (tool, args_hash, args, output, error, recorded_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool, args_hash) DO UPDATE SET args = excluded.args, output = excluded.output, error = excluded.error,
         recorded_at = excluded.recorded_at, run_id = excluded.run_id`,
      r.tool, r.argsHash, JSON.stringify(r.args ?? null), json(r.output), r.error ?? null, nowIso(), r.runId ?? null,
    );
  }

  get(tool: string, argsHash: string): ToolRecording | undefined {
    const r = this.db.get('SELECT * FROM tool_recordings WHERE tool = ? AND args_hash = ?', tool, argsHash);
    return r ? toRecording(r) : undefined;
  }

  list(q: { tool?: string; limit?: number; offset?: number } = {}) {
    const clause = q.tool ? 'WHERE tool = ?' : '';
    const params = q.tool ? [q.tool] : [];
    const total = this.db.get(`SELECT COUNT(*) AS n FROM tool_recordings ${clause}`, ...params).n as number;
    const tools = this.db.all('SELECT tool, COUNT(*) AS n FROM tool_recordings GROUP BY tool ORDER BY tool').map((r) => ({ tool: r.tool as string, count: r.n as number }));
    const recordings = this.db
      .all(`SELECT * FROM tool_recordings ${clause} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(q.limit ?? 50, 500), q.offset ?? 0)
      .map(toRecording);
    return { total, tools, recordings };
  }

  delete(q: { tool?: string; argsHashes?: string[] }) {
    if (q.argsHashes?.length) {
      let n = 0;
      this.db.tx(() => {
        for (const h of q.argsHashes!) n += Number(this.db.run(`DELETE FROM tool_recordings WHERE args_hash = ?${q.tool ? ' AND tool = ?' : ''}`, h, ...(q.tool ? [q.tool] : [])).changes);
      });
      return n;
    }
    if (q.tool) return Number(this.db.run('DELETE FROM tool_recordings WHERE tool = ?', q.tool).changes);
    return Number(this.db.run('DELETE FROM tool_recordings').changes);
  }
}
