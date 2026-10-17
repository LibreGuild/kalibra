import type { Db } from '../db.js';
import { mapSeq, notFound, nowIso, parseJson } from '../util.js';
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

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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
   *
   * Whole traces are written a few hundred rows per statement (a busy app sends thousands at once,
   * and every statement is a round trip to a networked database); partial traces merge one by one.
   */
  async write(batch: TraceWithSpans[]) {
    const now = nowIso();
    await this.db.tx(async () => {
      let group: TraceWithSpans[] = [];
      const ids = new Set<string>();
      for (const t of batch) {
        // Keep the order of updates to one trace: a partial trace, or a second copy, waits for what came before it.
        if (t.partial || ids.has(t.id)) {
          await this.writeWhole(group, now);
          group = [];
          ids.clear();
        }
        if (t.partial) await this.writePartial(t, now);
        else (group.push(t), ids.add(t.id));
      }
      await this.writeWhole(group, now);
    });
  }

  /** Traces that replace any earlier copy, with all their spans (ids are unique within `group`). */
  private async writeWhole(group: TraceWithSpans[], now: string) {
    if (!group.length) return;
    const created = new Map<string, string>();
    for (const part of chunks(group, 500)) {
      const rows = await this.db.all<{ id: string; created_at: string }>(`SELECT id, created_at FROM traces WHERE id IN (${part.map(() => '?').join(',')})`, ...part.map((t) => t.id));
      for (const r of rows) created.set(r.id, r.created_at);
      await this.db.run(`DELETE FROM spans WHERE trace_id IN (${part.map(() => '?').join(',')})`, ...part.map((t) => t.id));
    }
    for (const part of chunks(group, 200)) {
      await this.db.run(
        `INSERT INTO traces (id, name, source, status, started_at, duration_ms, input, output, error, metadata, tags, run_id, result_id, created_at)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source, status = excluded.status, started_at = excluded.started_at,
           duration_ms = excluded.duration_ms, input = excluded.input, output = excluded.output, error = excluded.error, metadata = excluded.metadata,
           tags = excluded.tags, run_id = excluded.run_id, result_id = excluded.result_id, created_at = excluded.created_at`,
        ...part.flatMap((t) => [
          t.id, t.name, t.source, t.status, t.startedAt, t.durationMs ?? null, json(t.input), json(t.output), t.error ?? null,
          JSON.stringify(t.metadata), JSON.stringify(t.tags), t.runId ?? null, t.resultId ?? null, created.get(t.id) ?? now,
        ]),
      );
    }
    await this.writeSpans(group.flatMap((t) => t.spans.map((sp) => ({ traceId: t.id, span: sp }))));
  }

  /** Merges spans of a trace that is still running into what is stored. */
  private async writePartial(t: TraceWithSpans, now: string) {
    const cur = await this.db.get('SELECT * FROM traces WHERE id = ?', t.id);
    if (!cur) return this.writeWhole([{ ...t, partial: false }], now);
    const start = cur.started_at < t.startedAt ? cur.started_at : t.startedAt;
    const end = Math.max(endMs(cur.started_at, cur.duration_ms), endMs(t.startedAt, t.durationMs));
    const hasRoot = t.spans.some((sp) => !sp.parentId);
    await this.db.run(
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
    await this.writeSpans(t.spans.map((sp) => ({ traceId: t.id, span: sp })));
  }

  private async writeSpans(all: { traceId: string; span: Span }[]) {
    // The last copy of a span wins, as when they were written one after another.
    const spans = [...new Map(all.map((x) => [`${x.traceId}\u0000${x.span.id}`, x])).values()];
    for (const part of chunks(spans, 300)) {
      await this.db.run(
        `INSERT INTO spans (id, trace_id, parent_id, name, kind, started_at, duration_ms, input, output, error, attributes)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (trace_id, id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, kind = excluded.kind, started_at = excluded.started_at,
           duration_ms = excluded.duration_ms, input = excluded.input, output = excluded.output, error = excluded.error, attributes = excluded.attributes`,
        ...part.flatMap(({ traceId, span: sp }) => [
          sp.id, traceId, sp.parentId ?? null, sp.name, sp.kind, sp.startedAt, sp.durationMs ?? null, json(sp.input), json(sp.output), sp.error ?? null, JSON.stringify(sp.attributes),
        ]),
      );
    }
  }

  async list(q: TraceQuery = {}) {
    const { clause, params } = this.filter(q);
    const total = (await this.db.get(`SELECT COUNT(*) AS n FROM traces ${clause}`, ...params)).n as number;
    const rows = await this.db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM spans s WHERE s.trace_id = t.id) AS span_count FROM traces t ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      ...params,
      Math.min(q.limit ?? 50, 500),
      q.offset ?? 0,
    );
    return { total, traces: rows.map(toTrace) };
  }

  /** The WHERE clause for a trace filter. */
  private filter(q: Omit<TraceQuery, 'limit' | 'offset'>) {
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
      // Compares the JSON value itself (a number matches a number, a string a string), in either database.
      if (this.db.dialect === 'postgres') (where.push(`(metadata::jsonb -> '${k}') = CAST(? AS jsonb)`), params.push(JSON.stringify(v)));
      else (where.push(`json_extract(metadata, '$."${k}"') = ?`), params.push(v));
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  async get(id: string): Promise<Trace & { spans: Span[] }> {
    const r = await this.db.get('SELECT * FROM traces WHERE id = ?', id);
    if (!r) throw notFound('Trace', id);
    return { ...toTrace(r), spans: (await this.db.all('SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, id', id)).map(toSpan) };
  }

  /** Every trace of one eval row (a conversation can send one per turn), oldest first. */
  async byResult(resultId: string): Promise<(Trace & { spans: Span[] })[]> {
    return mapSeq(await this.db.all('SELECT id FROM traces WHERE result_id = ? ORDER BY started_at', resultId), async (r) => await this.get(r.id));
  }

  async delete(ids: string[]) {
    return this.db.tx(async () => {
      let n = 0;
      await this.db.tx(async () => {
        for (const id of ids) {
          await this.db.run('DELETE FROM spans WHERE trace_id = ?', id);
          n += Number((await this.db.run('DELETE FROM traces WHERE id = ?', id)).changes);
        }
      });
      return n;
    });
  }

  /** Deletes traces matching a filter (or all), in chunks so a huge delete doesn't hold the database. */
  async deleteWhere(q: Omit<TraceQuery, 'limit' | 'offset'>) {
    let deleted = 0;
    const { clause, params } = this.filter(q);
    for (;;) {
      // Ids only: no count or span totals per chunk, so deleting many traces stays linear.
      const ids = (await this.db.all(`SELECT id FROM traces ${clause} LIMIT 500`, ...params)).map((r) => r.id as string);
      if (!ids.length) return deleted;
      deleted += await this.delete(ids);
    }
  }

  /** Removes traces started before `before` that belong to no run (run traces live as long as their run). */
  async prune(before: string) {
    return this.db.tx(async () => {
      let n = 0;
      await this.db.tx(async () => {
        await this.db.run('DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE started_at < ? AND run_id IS NULL)', before);
        n = Number((await this.db.run('DELETE FROM traces WHERE started_at < ? AND run_id IS NULL', before)).changes);
      });
      return n;
    });
  }

  async counts() {
    return {
      traces: (await this.db.get('SELECT COUNT(*) AS n FROM traces')).n as number,
      spans: (await this.db.get('SELECT COUNT(*) AS n FROM spans')).n as number,
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

  async upsert(r: { tool: string; argsHash: string; args: unknown; output?: unknown; error?: string; runId?: string }) {
    await this.db.run(
      `INSERT INTO tool_recordings (tool, args_hash, args, output, error, recorded_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool, args_hash) DO UPDATE SET args = excluded.args, output = excluded.output, error = excluded.error,
         recorded_at = excluded.recorded_at, run_id = excluded.run_id`,
      r.tool, r.argsHash, JSON.stringify(r.args ?? null), json(r.output), r.error ?? null, nowIso(), r.runId ?? null,
    );
  }

  async get(tool: string, argsHash: string): Promise<ToolRecording | undefined> {
    const r = await this.db.get('SELECT * FROM tool_recordings WHERE tool = ? AND args_hash = ?', tool, argsHash);
    return r ? toRecording(r) : undefined;
  }

  async list(q: { tool?: string; limit?: number; offset?: number } = {}) {
    const clause = q.tool ? 'WHERE tool = ?' : '';
    const params = q.tool ? [q.tool] : [];
    const total = (await this.db.get(`SELECT COUNT(*) AS n FROM tool_recordings ${clause}`, ...params)).n as number;
    const tools = (await this.db.all('SELECT tool, COUNT(*) AS n FROM tool_recordings GROUP BY tool ORDER BY tool')).map((r) => ({ tool: r.tool as string, count: r.n as number }));
    const recordings = (await this.db.all(`SELECT * FROM tool_recordings ${clause} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(q.limit ?? 50, 500), q.offset ?? 0))
      .map(toRecording);
    return { total, tools, recordings };
  }

  async delete(q: { tool?: string; argsHashes?: string[] }) {
    return this.db.tx(async () => {
      if (q.argsHashes?.length) {
        let n = 0;
        await this.db.tx(async () => {
          for (const h of q.argsHashes!) n += Number((await this.db.run(`DELETE FROM tool_recordings WHERE args_hash = ?${q.tool ? ' AND tool = ?' : ''}`, h, ...(q.tool ? [q.tool] : []))).changes);
        });
        return n;
      }
      if (q.tool) return Number((await this.db.run('DELETE FROM tool_recordings WHERE tool = ?', q.tool)).changes);
      return Number((await this.db.run('DELETE FROM tool_recordings')).changes);
    });
  }
}
