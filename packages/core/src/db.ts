import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, statSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

type Param = null | number | bigint | string | Uint8Array;
const norm = (params: unknown[]): Param[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as Param)));

/** Schema of a project database (kalibra.db). The hub database has its own list (hub/schema.ts). */
export const PROJECT_MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE datasets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    schema TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    next_seq INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX datasets_name ON datasets(name) WHERE deleted_at IS NULL;

  CREATE TABLE rows (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    seq INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'approved',
    split TEXT,
    provenance TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX rows_dataset ON rows(dataset_id, deleted_at, seq);

  CREATE TABLE row_revs (
    row_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    data TEXT NOT NULL,
    tags TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    PRIMARY KEY (row_id, rev)
  );

  CREATE TABLE dataset_versions (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES datasets(id),
    number INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    row_count INTEGER NOT NULL,
    schema TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    UNIQUE (dataset_id, number)
  );
  CREATE TABLE dataset_version_rows (
    version_id TEXT NOT NULL,
    row_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    PRIMARY KEY (version_id, row_id)
  );

  CREATE TABLE defs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    spec TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX defs_name ON defs(kind, name) WHERE deleted_at IS NULL;
  CREATE TABLE def_versions (
    def_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    PRIMARY KEY (def_id, version)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    dataset_id TEXT,
    dataset_version_id TEXT,
    target_id TEXT,
    target_version INTEGER,
    suite_id TEXT,
    suite_version INTEGER,
    settings TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    created_by TEXT NOT NULL,
    error TEXT,
    deleted_at TEXT
  );

  CREATE TABLE results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    row_id TEXT NOT NULL,
    row_rev INTEGER,
    rep INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    passed INTEGER,
    score REAL,
    input TEXT,
    request TEXT,
    response TEXT,
    outputs TEXT,
    checks TEXT,
    metrics TEXT,
    error TEXT,
    logs TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX results_run ON results(run_id, seq);
  CREATE INDEX results_run_status ON results(run_id, status, passed);

  CREATE TABLE blobs (
    hash TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    op TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT ''
  );
  `,
  // 2: human labels on results (ground truth for calibrating judges and other checks)
  `
  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    result_id TEXT NOT NULL REFERENCES results(id),
    check_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL CHECK (label IN ('pass', 'fail')),
    note TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (result_id, check_id)
  );
  CREATE INDEX labels_run ON labels(run_id, check_id);
  `,
  // 3: run groups (compare several targets/models in one go) and saved insights (failure themes, quality reports)
  `
  ALTER TABLE runs ADD COLUMN group_id TEXT;
  ALTER TABLE runs ADD COLUMN variant_label TEXT;
  CREATE INDEX runs_group ON runs(group_id);

  CREATE TABLE run_groups (
    id TEXT PRIMARY KEY,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    dataset_id TEXT NOT NULL,
    suite_id TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE insights (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX insights_subject ON insights(kind, subject_id, created_at);
  `,
  // 4: a fingerprint per row, so the duplicate check when adding rows is an index lookup instead of
  // reading and hashing the whole dataset on every add (rows written before this get theirs lazily)
  `
  ALTER TABLE rows ADD COLUMN fp TEXT;
  CREATE INDEX rows_fp ON rows(dataset_id, fp);
  `,
  // 5: traces your app sends (SDK, OpenTelemetry, proxy), tool recordings for replay, the steps of
  // each eval row, and git details of runs started from code or CI (docs/design/sdk-and-traces.md)
  `
  CREATE TABLE traces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    duration_ms REAL,
    input TEXT,
    output TEXT,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    run_id TEXT,
    result_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX traces_started ON traces(started_at);
  CREATE INDEX traces_result ON traces(result_id) WHERE result_id IS NOT NULL;
  CREATE INDEX traces_name ON traces(name, started_at);

  CREATE TABLE spans (
    id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    started_at TEXT NOT NULL,
    duration_ms REAL,
    input TEXT,
    output TEXT,
    error TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (trace_id, id)
  );

  CREATE TABLE tool_recordings (
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args TEXT NOT NULL,
    output TEXT,
    error TEXT,
    recorded_at TEXT NOT NULL,
    run_id TEXT,
    PRIMARY KEY (tool, args_hash)
  );

  ALTER TABLE results ADD COLUMN steps TEXT;
  ALTER TABLE runs ADD COLUMN git TEXT;
  `,
  // 6: the Traces page's run filter (and deleting a run's traces) without scanning every trace
  `
  CREATE INDEX traces_run ON traces(run_id, started_at) WHERE run_id IS NOT NULL;
  `,
  // 7: which instance is executing a run (a lease it renews), so several instances can share runs:
  // when one stops, another resumes its runs from the last saved row; a cancel can come from any of them
  `
  ALTER TABLE runs ADD COLUMN lease_owner TEXT;
  ALTER TABLE runs ADD COLUMN lease_until TEXT;
  ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
  `,
  // 8: provider secrets kept in the database (encrypted with KALIBRA_SECRET_KEY) when the data folder
  // may disappear: a bucket or Postgres deployment (see deploy/secrets.ts)
  `
  CREATE TABLE secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
];

/**
 * The data layer every store uses: SQL with `?` placeholders, asynchronous so a networked database
 * (Postgres) can sit behind the same interface. `tx` runs a function in a transaction; calls made
 * inside it (in the same async flow) join it, including nested `tx` calls.
 */
export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>, opts?: TxOptions): Promise<T>;
  /** The tables with their columns, primary key and the tables they reference (for copying data between databases). */
  tables(): Promise<TableInfo[]>;
  /** Bytes the data takes on disk (database file, or the schema's tables in Postgres). */
  sizeBytes(): Promise<number>;
  close(): Promise<void>;
}

export interface TxOptions {
  /**
   * Postgres only (SQLite always runs one writer at a time). `serializable` (default) keeps SQLite's
   * guarantees for read-check-write code and retries on conflicts. `read committed` is for hot paths
   * that only need row locks and atomic updates (e.g. `done = done + 1` from every worker of a run):
   * no conflicts to retry; lock what you read-then-write with `FOR UPDATE` (see `forUpdate`).
   */
  isolation?: 'serializable' | 'read committed';
}

/** ` FOR UPDATE` on Postgres (locks the rows read until the transaction ends), nothing on SQLite. */
export const forUpdate = (db: Db) => (db.dialect === 'postgres' ? ' FOR UPDATE' : '');

export interface TableInfo {
  name: string;
  columns: string[];
  primaryKey: string[];
  /** Tables this one has foreign keys to (copy those first). */
  references: string[];
  /** Columns filled by the database (Postgres identity); reset after copying rows in with their values. */
  identity: string[];
}

export interface SqliteOptions {
  /**
   * Leaves checkpointing to the caller (`wal_autocheckpoint=0`): the bucket sync ships every WAL
   * page before it checkpoints, so no change can move into the main file unseen.
   */
  manualCheckpoints?: boolean;
}

/** Opens (and migrates) a SQLite database file. */
export async function openSqlite(file: string, migrations: string[] = PROJECT_MIGRATIONS, opts: SqliteOptions = {}): Promise<Db> {
  return new SqliteDb(file, migrations, opts);
}

/** Low-level access to a SQLite database for the bucket sync (see deploy/sqlite-sync.ts). */
export interface SqliteControl {
  readonly file: string;
  /** Runs `fn` on the write connection with no transaction open and other writes waiting. */
  exclusive<T>(fn: (raw: DatabaseSync) => T | Promise<T>): Promise<T>;
}

/** The SQLite internals of a database opened with openSqlite, or undefined for other drivers. */
export function sqliteControl(db: Db): SqliteControl | undefined {
  return db instanceof SqliteDb ? db : undefined;
}

/** Runs one task at a time, in arrival order. */
class Mutex {
  private waiting: (() => void)[] = [];
  private locked = false;

  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.locked) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.locked = true;
    try {
      return await fn();
    } finally {
      // Hand the lock straight to the next waiter, or free it.
      const next = this.waiting.shift();
      if (next) next();
      else this.locked = false;
    }
  }
}

class Conn {
  private cache = new Map<string, StatementSync>();
  /** Queries with variable-length IN (...) lists produce many distinct statements; keep the cache bounded. */
  private static readonly MAX_CACHED = 500;

  constructor(readonly raw: DatabaseSync) {}

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size >= Conn.MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(sql, s);
    }
    return s;
  }
}

/**
 * SQLite through node:sqlite. One write connection, used by one transaction (or single write) at a
 * time; reads from outside a transaction use a separate read-only connection, so they never wait
 * for a transaction and never see its uncommitted changes (WAL lets both work at once).
 */
class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private writer: Conn;
  private reader: Conn;
  private lock = new Mutex();
  /**
   * The open transaction of this async flow, if any: calls there use the write connection and join
   * it. Closed at commit/rollback, so work that outlives the transaction waits its turn again.
   */
  private current = new AsyncLocalStorage<{ open: boolean }>();

  constructor(
    readonly file: string,
    private migrations: string[],
    opts: SqliteOptions = {},
  ) {
    // Loaded lazily so hosts can silence node:sqlite's ExperimentalWarning before it is first used.
    const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const manual = opts.manualCheckpoints ? ' PRAGMA wal_autocheckpoint=0;' : '';
    this.writer = new Conn(new Sqlite(file));
    this.writer.raw.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;${manual}`);
    this.migrate();
    // An in-memory database is private to its connection, so reads share the writer there.
    const memory = file === ':memory:' || file === '';
    this.reader = memory ? this.writer : new Conn(new Sqlite(file));
    if (!memory) this.reader.raw.exec(`PRAGMA query_only=1; PRAGMA busy_timeout=5000;${manual}`);
  }

  exclusive<T>(fn: (raw: DatabaseSync) => T | Promise<T>): Promise<T> {
    return this.lock.run(() => fn(this.writer.raw));
  }

  private migrate() {
    const raw = this.writer.raw;
    const current = Number((raw.prepare('PRAGMA user_version').get() as any).user_version);
    if (current > this.migrations.length) {
      throw new Error(`This data was written by a newer version of Kalibra (schema ${current}, this version knows ${this.migrations.length}). Update Kalibra to open it.`);
    }
    for (let v = current; v < this.migrations.length; v++) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        raw.exec(this.migrations[v]);
        raw.exec(`PRAGMA user_version = ${v + 1}`);
        raw.exec('COMMIT');
      } catch (e) {
        rollback(raw);
        throw e;
      }
    }
  }

  private inTx() {
    return this.current.getStore()?.open === true;
  }

  /** Runs a write: inside the current transaction, or on its own once the write connection is free. */
  private write<T>(fn: (c: Conn) => T): Promise<T> {
    if (this.inTx()) return settle(() => fn(this.writer));
    return this.lock.run(() => fn(this.writer));
  }

  /** Reads see the transaction they are part of, or else the last committed state. */
  private read<T>(fn: (c: Conn) => T): Promise<T> {
    if (this.inTx()) return settle(() => fn(this.writer));
    if (this.reader === this.writer) return this.lock.run(() => fn(this.writer));
    return settle(() => fn(this.reader));
  }

  run(sql: string, ...params: unknown[]) {
    return this.write((c) => ({ changes: Number(c.stmt(sql).run(...norm(params)).changes) }));
  }

  get<T = any>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const fn = (c: Conn) => c.stmt(sql).get(...norm(params)) as T | undefined;
    return readOnly(sql) ? this.read(fn) : this.write(fn);
  }

  all<T = any>(sql: string, ...params: unknown[]): Promise<T[]> {
    const fn = (c: Conn) => c.stmt(sql).all(...norm(params)) as T[];
    return readOnly(sql) ? this.read(fn) : this.write(fn);
  }

  exec(sql: string) {
    return this.write((c) => void c.raw.exec(sql));
  }

  /** Runs `fn` in a transaction (nested calls join the outer one). Other writes wait until it ends. */
  tx<T>(fn: () => Promise<T>, _opts?: TxOptions): Promise<T> {
    if (this.inTx()) return fn();
    return this.lock.run(async () => {
      const raw = this.writer.raw;
      const state = { open: true };
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = await this.current.run(state, fn);
        state.open = false;
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        state.open = false;
        rollback(raw);
        throw e;
      }
    });
  }

  async tables(): Promise<TableInfo[]> {
    const names = await this.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const out: TableInfo[] = [];
    for (const { name } of names) {
      const cols = await this.all<{ name: string; pk: number }>(`PRAGMA table_info("${name}")`);
      const fks = await this.all<{ table: string }>(`PRAGMA foreign_key_list("${name}")`);
      out.push({
        name,
        columns: cols.map((c) => c.name),
        primaryKey: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
        references: [...new Set(fks.map((f) => f.table))],
        identity: [],
      });
    }
    return out;
  }

  async sizeBytes(): Promise<number> {
    const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
    return size(this.file) + size(`${this.file}-wal`);
  }

  async close() {
    await this.lock.run(() => {
      if (this.reader !== this.writer) this.reader.raw.close();
      this.writer.raw.close();
    });
  }
}

/** SELECTs (without a write in a WITH clause) may use the read connection; anything else writes (UPDATE … RETURNING). */
function readOnly(sql: string) {
  return /^\s*SELECT\b/i.test(sql) || (/^\s*WITH\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
}

/** A synchronous statement as a promise, without waiting an extra tick. */
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e);
  }
}

/** Ends a failed transaction (SQLite may already have rolled it back itself). */
function rollback(raw: DatabaseSync) {
  try {
    raw.exec('ROLLBACK');
  } catch {
    /* no transaction was active */
  }
}
