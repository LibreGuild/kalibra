import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { Db, TableInfo, TxOptions } from './db.js';

/*
 * Postgres behind the same Db interface as SQLite (see docs/design/storage-and-scaling.md).
 *
 * - One connection pool per process; the hub and every project are schemas of one database
 *   (`kalibra_hub`, `kalibra_p_<projectId>`), so the per-project SQL is unchanged. A pooled
 *   connection's search_path is set only when it switches schema.
 * - The SQL stays SQLite-flavoured: `toPostgres` turns `?` into `$n` and LIKE into ILIKE (SQLite's
 *   LIKE ignores ASCII case), and refuses SQLite-only constructs so they fail loudly in tests.
 * - Transactions are SERIALIZABLE and retried on serialization failures, which keeps the guarantee
 *   SQLite gives by running one writer at a time: read-check-write code needs no extra locking.
 *   A retried transaction runs its function again, so keep those functions to database work.
 * - Migrations are the SQLite ones translated by `toPostgresDdl`, applied under an advisory lock so
 *   several instances can start at once; the version lives in a table per schema.
 */

/** The hub's schema and each project's (`prefix` is KALIBRA_DATABASE_SCHEMA, default "kalibra"). */
export const hubSchema = (prefix = 'kalibra') => `${prefix}_hub`;
export const projectSchema = (projectId: string, prefix = 'kalibra') => {
  const name = `${prefix}_p_${projectId}`;
  if (!SAFE_SCHEMA.test(name)) throw new Error(`Project id "${projectId}" can't be used as a Postgres schema name`);
  return name;
};
const SAFE_SCHEMA = /^[a-z][a-z0-9_]{0,62}$/;
const VERSION_TABLE = 'kalibra_schema_version';

const quoteIdent = (name: string) => {
  if (!SAFE_SCHEMA.test(name)) throw new Error(`Not a safe Postgres identifier: ${name}`);
  return `"${name}"`;
};

// ── SQL translation ─────────────────────────────────────────────────────────

type Segment = { code: boolean; text: string };

/** Splits SQL into code and the parts that must not be touched (strings, quoted names, comments). */
function segments(sql: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let start = 0;
  const flush = (end: number, code: boolean) => {
    if (end > start) out.push({ code, text: sql.slice(start, end) });
    start = end;
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      flush(i, true);
      i++;
      while (i < sql.length) {
        if (sql[i] === c && sql[i + 1] === c) i += 2; // '' or "" inside
        else if (sql[i] === c) {
          i++;
          break;
        } else i++;
      }
      flush(i, false);
    } else if (c === '-' && next === '-') {
      flush(i, true);
      while (i < sql.length && sql[i] !== '\n') i++;
      flush(i, false);
    } else if (c === '/' && next === '*') {
      flush(i, true);
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      flush(i, false);
    } else i++;
  }
  flush(sql.length, true);
  return out;
}

/** SQLite-only constructs the Postgres driver does not translate: write them portably instead. */
const NOT_PORTABLE: [RegExp, string][] = [
  [/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, 'INSERT OR …: use INSERT … ON CONFLICT'],
  [/\bjson_(extract|each|patch|set|object|array|group_array|tree)\s*\(/i, 'json_*(): branch on db.dialect'],
  [/\browid\b/i, 'rowid'],
  [/\bPRAGMA\b/i, 'PRAGMA'],
  [/\bGROUP_CONCAT\s*\(/i, 'GROUP_CONCAT(): branch on db.dialect'],
  [/\bIFNULL\s*\(/i, 'IFNULL(): use COALESCE'],
  [/\bCOLLATE\s+NOCASE\b/i, 'COLLATE NOCASE: compare lower(x) = lower(?)'],
  [/\bIS\s+\?/i, 'IS ?: use IS NOT DISTINCT FROM ?'],
  [/\bstrftime\s*\(|\bdatetime\s*\(|\bjulianday\s*\(/i, 'SQLite date functions'],
];

const translated = new Map<string, string>();
const MAX_TRANSLATED = 1000;

/** Translates one statement written for SQLite (placeholders `?`) to Postgres (`$1`…). */
export function toPostgres(sql: string): string {
  const hit = translated.get(sql);
  if (hit !== undefined) return hit;
  let n = 0;
  let out = '';
  for (const s of segments(sql)) {
    if (!s.code) {
      out += s.text;
      continue;
    }
    for (const [re, what] of NOT_PORTABLE) if (re.test(s.text)) throw new Error(`SQL not portable to Postgres (${what}): ${sql.slice(0, 200)}`);
    out += s.text.replace(/\?/g, () => `$${++n}`).replace(/\bLIKE\b/gi, 'ILIKE');
  }
  // lower() of a parameter compares like lower() of a "C"-collated column: ASCII only, as in SQLite.
  out = out.replace(/\blower\(\$(\d+)\)/gi, (_m, d) => `lower(CAST($${d} AS TEXT) COLLATE "C")`);
  if (translated.size >= MAX_TRANSLATED) translated.delete(translated.keys().next().value!);
  translated.set(sql, out);
  return out;
}

/**
 * Translates a SQLite migration to Postgres DDL. Text columns use the "C" collation, so ordering and
 * comparisons are byte-wise like SQLite's default; COLLATE NOCASE is dropped (case-insensitive
 * lookups use lower(x) indexes, which mean the same in both databases).
 */
export function toPostgresDdl(sql: string): string {
  return segments(sql)
    .map((s) =>
      !s.code
        ? s.text
        : s.text
            .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
            .replace(/\s+COLLATE\s+NOCASE\b/gi, '')
            .replace(/\bINTEGER\b/g, 'BIGINT')
            .replace(/\bREAL\b/g, 'DOUBLE PRECISION')
            .replace(/\bBLOB\b/g, 'BYTEA')
            .replace(/\bTEXT\b/g, 'TEXT COLLATE "C"'),
    )
    .join('');
}

// ── Values ──────────────────────────────────────────────────────────────────

/** Whole numbers come back as JS numbers, like SQLite; one too big to be exact is an error, not a silent rounding. */
function toNumber(text: string): number {
  const n = Number(text);
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw new Error(`Number ${text} is too large to read exactly`);
  return n;
}

/** The values SQLite accepts, and nothing else: pg would turn an object into JSON and an array into a Postgres array. */
const params = (values: unknown[]) =>
  values.map((p, i) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return p.toString();
    if (typeof p === 'number' || typeof p === 'string' || Buffer.isBuffer(p)) return p;
    if (p instanceof Uint8Array) return Buffer.from(p);
    throw new TypeError(`Cannot bind a ${p === null ? 'null' : typeof p} value to parameter ${i + 1}`);
  });

/** Serialization failures and deadlocks: the transaction can be retried as a whole. */
const retryable = (e: any) => e?.code === '40001' || e?.code === '40P01';
const MAX_ATTEMPTS = 20;
/** Randomised, growing waits (up to 1 s), so transactions that keep colliding under load drift apart. */
const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(1000, 10 * 2 ** attempt)));

// ── Connection pool shared by the hub and every project ─────────────────────

export interface PostgresOptions {
  /** postgres://user:password@host:5432/db (Unix sockets: ?host=/cloudsql/PROJECT:REGION:INSTANCE). */
  url: string;
  /** Most connections this process opens. */
  max?: number;
}

export class PostgresPool {
  /** The schema each pooled connection's search_path points at. */
  private schemaOf = new WeakMap<PoolClient, string>();

  private constructor(readonly pool: Pool) {}

  static async connect(opts: PostgresOptions): Promise<PostgresPool> {
    const { default: pg } = await import('pg');
    const types = {
      getTypeParser(oid: number, format?: any) {
        if (format === 'text' || format === undefined) {
          if (oid === 20 || oid === 1700) return toNumber; // int8, numeric
          if (oid === 16) return (v: string) => (v === 't' ? 1 : 0); // bool, as SQLite returns it
        }
        return pg.types.getTypeParser(oid, format);
      },
    };
    const pool = new pg.Pool({ connectionString: opts.url, max: opts.max ?? 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000, types: types as any });
    // An idle connection dropped by the server must not crash the process; the pool replaces it.
    pool.on('error', (e) => console.error(`[kalibra] Postgres connection error: ${e.message}`));
    const self = new PostgresPool(pool);
    const client = await pool.connect().catch((e) => {
      throw new Error(`Can't connect to Postgres: ${e.message}`);
    });
    client.release();
    return self;
  }

  /** A connection whose search_path is `schema`; release it with `done`. */
  async checkout(schema: string): Promise<PoolClient> {
    const client = await this.pool.connect();
    if (this.schemaOf.get(client) !== schema) {
      try {
        await client.query(`SET search_path TO ${quoteIdent(schema)}`);
        this.schemaOf.set(client, schema);
      } catch (e) {
        client.release(e as Error);
        throw e;
      }
    }
    return client;
  }

  /** Creates the schema if needed and applies missing migrations, once even with several instances starting. */
  async migrate(schema: string, migrations: string[]) {
    const client = await this.pool.connect();
    let failed: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kalibra-migrate:${schema}`]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
      await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (version BIGINT NOT NULL)`);
      const row = (await client.query(`SELECT version FROM ${VERSION_TABLE}`)).rows[0];
      if (!row) await client.query(`INSERT INTO ${VERSION_TABLE} (version) VALUES (0)`);
      const current = row ? Number(row.version) : 0;
      if (current > migrations.length) {
        throw new Error(`This data was written by a newer version of Kalibra (schema ${current}, this version knows ${migrations.length}). Update Kalibra to open it.`);
      }
      for (let v = current; v < migrations.length; v++) {
        await client.query(toPostgresDdl(migrations[v]));
        await client.query(`UPDATE ${VERSION_TABLE} SET version = $1`, [v + 1]);
      }
      await client.query('COMMIT');
    } catch (e) {
      failed = e as Error;
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      // SET LOCAL ended with the transaction; the connection's search_path is what it was before.
      client.release(failed && isConnectionError(failed) ? failed : undefined);
    }
  }

  /** Opens (and migrates) one schema as a Db. */
  async open(schema: string, migrations: string[]): Promise<Db> {
    await this.migrate(schema, migrations);
    return new PostgresDb(this, schema);
  }

  async dropSchema(schema: string) {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  }

  async schemaExists(schema: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema])).rowCount! > 0;
  }

  async schemas(prefix: string): Promise<string[]> {
    const r = await this.pool.query('SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1) ORDER BY 1', [prefix]);
    return r.rows.map((x) => x.schema_name);
  }

  close() {
    return this.pool.end();
  }
}

/** The connection itself failed (it is dropped from the pool), as opposed to a statement or our own code. */
const isConnectionError = (e: any) =>
  /^(08|57P)/.test(String(e?.code ?? '')) || /^E[A-Z]+$/.test(String(e?.code ?? '')) || /Connection terminated|not queryable|Client was closed/i.test(String(e?.message ?? ''));

// ── One schema as a Db ──────────────────────────────────────────────────────

class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  /** The open transaction of this async flow: its connection, until commit or rollback. */
  private current = new AsyncLocalStorage<{ client: PoolClient; open: boolean }>();
  /** Statements and transactions under way; close() waits for them, then refuses new ones like a closed SQLite file. */
  private active = 0;
  private closed = false;
  private idle?: () => void;

  constructor(
    private pg: PostgresPool,
    readonly schema: string,
  ) {}

  private async query(sql: string, values: unknown[]): Promise<QueryResult> {
    const text = toPostgres(sql);
    const tx = this.current.getStore();
    if (tx?.open) return tx.client.query(text, params(values));
    return this.track(async () => {
      const client = await this.pg.checkout(this.schema);
      try {
        const r = await client.query(text, params(values));
        client.release();
        return r;
      } catch (e) {
        client.release(isConnectionError(e) ? (e as Error) : undefined);
        throw e;
      }
    });
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('The database is not open (the project was closed)');
    this.active++;
    try {
      return await fn();
    } finally {
      if (--this.active === 0) this.idle?.();
    }
  }

  async run(sql: string, ...values: unknown[]) {
    return { changes: (await this.query(sql, values)).rowCount ?? 0 };
  }

  async get<T = any>(sql: string, ...values: unknown[]): Promise<T | undefined> {
    return (await this.query(sql, values)).rows[0] as T | undefined;
  }

  async all<T = any>(sql: string, ...values: unknown[]): Promise<T[]> {
    return (await this.query(sql, values)).rows as T[];
  }

  async exec(sql: string) {
    await this.query(sql, []);
  }

  /**
   * Runs `fn` in a SERIALIZABLE transaction (nested calls join the outer one). When Postgres reports
   * a conflict with another transaction, the whole function runs again on fresh data.
   */
  async tx<T>(fn: () => Promise<T>, opts: TxOptions = {}): Promise<T> {
    if (this.current.getStore()?.open) return fn();
    return this.track(() => this.attempt(fn, opts.isolation === 'read committed' ? 'READ COMMITTED' : 'SERIALIZABLE'));
  }

  private async attempt<T>(fn: () => Promise<T>, isolation: 'SERIALIZABLE' | 'READ COMMITTED'): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pg.checkout(this.schema);
      const state = { client, open: true };
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const out = await this.current.run(state, fn);
        state.open = false;
        await client.query('COMMIT');
        client.release();
        return out;
      } catch (e) {
        state.open = false;
        let broken = isConnectionError(e) ? (e as Error) : undefined;
        await client.query('ROLLBACK').catch((r) => (broken ??= r));
        client.release(broken);
        if (retryable(e) && attempt < MAX_ATTEMPTS) {
          await backoff(attempt);
          continue;
        }
        throw e;
      }
    }
  }

  async tables(): Promise<TableInfo[]> {
    const cols = await this.all<{ table_name: string; column_name: string; is_identity: string }>(
      `SELECT table_name, column_name, is_identity FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name <> '${VERSION_TABLE}' ORDER BY table_name, ordinal_position`,
    );
    const keys = await this.all<{ table_name: string; column_name: string; constraint_type: string; foreign_table: string | null }>(
      `SELECT tc.table_name, kcu.column_name, tc.constraint_type, ccu.table_name AS foreign_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema() AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
        ORDER BY tc.table_name, kcu.ordinal_position`,
    );
    const byName = new Map<string, TableInfo>();
    for (const c of cols) {
      const t = byName.get(c.table_name) ?? { name: c.table_name, columns: [], primaryKey: [], references: [], identity: [] };
      t.columns.push(c.column_name);
      if (c.is_identity === 'YES') t.identity.push(c.column_name);
      byName.set(c.table_name, t);
    }
    for (const k of keys) {
      const t = byName.get(k.table_name);
      if (!t) continue;
      if (k.constraint_type === 'PRIMARY KEY') t.primaryKey.push(k.column_name);
      else if (k.foreign_table && !t.references.includes(k.foreign_table)) t.references.push(k.foreign_table);
    }
    return [...byName.values()];
  }

  /** After rows were copied in with their ids, identity columns continue after the highest one. */
  async resetIdentity(table: string, column: string) {
    await this.query(`SELECT setval(pg_get_serial_sequence('${quoteIdent(table).replace(/"/g, '')}', '${column}'), COALESCE((SELECT MAX(${column}) FROM ${table}), 0) + 1, false)`, []);
  }

  async sizeBytes(): Promise<number> {
    const r = await this.get('SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN (\'r\', \'m\')');
    return Number(r?.bytes ?? 0);
  }

  /** Waits for statements under way, then refuses new ones. The pool is shared; closing the hub closes it. */
  async close() {
    this.closed = true;
    if (this.active) await new Promise<void>((resolve) => (this.idle = resolve));
  }
}
