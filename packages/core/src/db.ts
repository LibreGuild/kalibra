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
];

/** Thin synchronous wrapper over node:sqlite with cached statements and transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  /** Queries with variable-length IN (...) lists produce many distinct statements; keep the cache bounded. */
  private static readonly MAX_CACHED = 500;
  private depth = 0;

  constructor(
    file: string,
    private migrations: string[] = PROJECT_MIGRATIONS,
  ) {
    // Loaded lazily so hosts can silence node:sqlite's ExperimentalWarning before it is first used.
    const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    this.raw = new Sqlite(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  private migrate() {
    const current = Number((this.raw.prepare('PRAGMA user_version').get() as any).user_version);
    if (current > this.migrations.length) {
      throw new Error(`This data was written by a newer version of Kalibra (schema ${current}, this version knows ${this.migrations.length}). Update Kalibra to open it.`);
    }
    for (let v = current; v < this.migrations.length; v++) {
      this.tx(() => {
        this.raw.exec(this.migrations[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size >= Db.MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: unknown[]) {
    return this.stmt(sql).run(...norm(params));
  }

  get<T = any>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...norm(params)) as T | undefined;
  }

  all<T = any>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...norm(params)) as T[];
  }

  /** Runs `fn` in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  close() {
    this.raw.close();
  }
}
