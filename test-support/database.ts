/*
 * Running the test suite against Postgres: with KALIBRA_TEST_DATABASE_URL set, vitest.setup.ts makes
 * every Hub/Engine opened without explicit databases use Postgres, with schemas named after the
 * test's data folder. Tests that start the CLI in another process pass `databaseEnv(dir)` so it
 * opens the same schemas.
 */
import { createHash } from 'node:crypto';

export const testDatabaseUrl = process.env.KALIBRA_TEST_DATABASE_URL || undefined;

/** True when the suite runs against Postgres (skip checks of SQLite files and query plans). */
export const onPostgres = !!testDatabaseUrl;

/** The schema prefix of a test data folder: t<hash>, so tests running at once never share data. */
export const schemaPrefix = (dir: string) => `t${createHash('sha256').update(dir).digest('hex').slice(0, 14)}`;

/** Environment for a CLI started by a test on `dir`: the same Postgres schemas the test process uses. */
export function databaseEnv(dir: string): Record<string, string> {
  if (!testDatabaseUrl) return {};
  return { KALIBRA_DATABASE_URL: testDatabaseUrl, KALIBRA_DATABASE_SCHEMA: schemaPrefix(dir), KALIBRA_SECRET_KEY: 'a'.repeat(64) };
}
