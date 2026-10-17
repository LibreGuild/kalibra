/*
 * With KALIBRA_TEST_DATABASE_URL set (postgres://…), every Hub and Engine the tests open without
 * explicit databases uses Postgres instead of SQLite files: each test data folder gets its own
 * schemas (see test-support/database.ts), dropped when the test file ends. CI runs the suite both ways.
 */
import { afterAll } from 'vitest';
import { schemaPrefix, testDatabaseUrl } from './test-support/database.js';

if (testDatabaseUrl) {
  const { PostgresPool, projectSchema } = await import('./packages/core/src/db-postgres.js');
  const { postgresSchemas, setDefaultDatabases } = await import('./packages/core/src/deploy/databases.js');
  const { PROJECT_MIGRATIONS } = await import('./packages/core/src/db.js');
  const pool = await PostgresPool.connect({ url: testDatabaseUrl, max: Number(process.env.KALIBRA_TEST_DATABASE_POOL ?? 4) });
  const prefixes = new Set<string>();
  setDefaultDatabases((dir) => {
    const prefix = schemaPrefix(dir);
    prefixes.add(prefix);
    const dbs = postgresSchemas(pool, prefix);
    // An engine opened on its folder directly is that folder's default project.
    return {
      ...dbs,
      project: (id, projectDir) => (id ? dbs.project(id, projectDir) : pool.open(projectSchema('default', prefix), PROJECT_MIGRATIONS)),
      exists: async (kind, id, d) => (kind === 'project' && !id ? pool.schemaExists(projectSchema('default', prefix)) : dbs.exists(kind, id, d)),
    };
  });
  afterAll(async () => {
    for (const prefix of prefixes) for (const s of await pool.schemas(`${prefix}_`)) await pool.dropSchema(s).catch(() => {});
    await pool.close();
  });
}
