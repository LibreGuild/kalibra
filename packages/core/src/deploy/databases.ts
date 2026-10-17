import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite, PROJECT_MIGRATIONS, type Db, type SqliteOptions } from '../db.js';
import { hubSchema, PostgresPool, projectSchema } from '../db-postgres.js';
import { HUB_MIGRATIONS } from '../hub/schema.js';

/**
 * Where the hub and each project keep their data: SQLite files in their folders (default), or
 * schemas of one Postgres database (KALIBRA_DATABASE_URL). The hub opens its own database and each
 * project's through this, so nothing else needs to know which one is in use.
 */
export interface Databases {
  readonly dialect: 'sqlite' | 'postgres';
  /** The hub's database (accounts, projects, members, settings). */
  hub(hubDir: string): Promise<Db>;
  /** A project's database. `projectId` is unknown when an engine is opened on a folder directly. */
  project(projectId: string | undefined, projectDir: string): Promise<Db>;
  /** Whether the hub's or a project's database exists yet, without creating it. */
  exists(kind: 'hub' | 'project', projectId: string | undefined, dir: string): Promise<boolean>;
  /** Frees shared resources (the Postgres pool) after every database was closed. */
  close(): Promise<void>;
}

/** SQLite files: hub.db in the hub folder, kalibra.db in each project folder. */
export function sqliteDatabases(opts: SqliteOptions = {}): Databases {
  return {
    dialect: 'sqlite',
    hub: (dir) => openSqlite(join(dir, 'hub.db'), HUB_MIGRATIONS, opts),
    project: (_id, dir) => {
      mkdirSync(dir, { recursive: true }); // a new project's folder may not exist yet
      return openSqlite(join(dir, 'kalibra.db'), PROJECT_MIGRATIONS, opts);
    },
    exists: async (kind, _id, dir) => existsSync(join(dir, kind === 'hub' ? 'hub.db' : 'kalibra.db')),
    close: async () => {},
  };
}

/** One Postgres database: schema <prefix>_hub, and <prefix>_p_<projectId> per project (prefix "kalibra" by default). */
export async function postgresDatabases(opts: { url: string; max?: number; schema?: string }): Promise<Databases & { pool: PostgresPool }> {
  const pool = await PostgresPool.connect(opts);
  return postgresSchemas(pool, opts.schema ?? 'kalibra', { close: () => pool.close() });
}

/** The hub and projects of one deployment (schema prefix) in an open pool. */
export function postgresSchemas(pool: PostgresPool, prefix: string, opts: { close?: () => Promise<void> } = {}): Databases & { pool: PostgresPool } {
  // An engine opened on a bare folder (tools, tests) has no project id; its schema is named after the folder.
  const schemaOf = (id: string | undefined, dir: string) => (id ? projectSchema(id, prefix) : `${prefix}_d_${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`);
  return {
    dialect: 'postgres',
    pool,
    hub: () => pool.open(hubSchema(prefix), HUB_MIGRATIONS),
    project: (id, dir) => pool.open(schemaOf(id, dir), PROJECT_MIGRATIONS),
    exists: async (kind, id, dir) => (await pool.schemaExists(kind === 'hub' ? hubSchema(prefix) : schemaOf(id, dir))),
    close: opts.close ?? (async () => {}),
  };
}

let defaults: (dir: string) => Databases = () => sqliteDatabases();

/** What a Hub or Engine opened without explicit databases uses (SQLite files unless a host or test setup says otherwise). */
export const defaultDatabases = (dir: string) => defaults(dir);

/** Lets a host or a test setup choose the default (e.g. every test against Postgres). */
export function setDefaultDatabases(fn: (dir: string) => Databases) {
  defaults = fn;
}
