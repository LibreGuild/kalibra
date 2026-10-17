/*
 * Deployment settings: where the database, files and shared state live. See
 * docs/design/storage-and-scaling.md and docs/self-hosting.md. Everything is optional: with no
 * settings Kalibra keeps SQLite and files in its data folder (mode A).
 */

export type StorageKind = 'disk' | 'gcs' | 's3' | 'azure';
export type DeployMode = 'single' | 'single+bucket' | 'postgres' | 'scaled';

export interface DeployConfig {
  /** postgres://user:pass@host:5432/db (KALIBRA_DATABASE_URL). Unset: SQLite in the data folder. */
  databaseUrl?: string;
  /** Most Postgres connections this instance opens (KALIBRA_DATABASE_POOL, default 10). */
  databasePool: number;
  /** gs://bucket/prefix, s3://bucket/prefix or az://account/container/prefix (KALIBRA_STORAGE_URL). Unset: the data folder. */
  storageUrl?: string;
  /** With a bucket and SQLite: seconds between syncs of each changed database (KALIBRA_SQLITE_SYNC_SECONDS, default 10). */
  sqliteSyncSeconds: number;
  /** redis:// or rediss:// (KALIBRA_REDIS_URL). Needed only for several instances. */
  redisUrl?: string;
  /** Key that encrypts provider secrets stored in the database (KALIBRA_SECRET_KEY, 32+ random bytes, base64 or hex). */
  secretKey?: string;
  /** S3-compatible endpoint, e.g. MinIO or Cloudflare R2 (KALIBRA_S3_ENDPOINT); region (KALIBRA_S3_REGION or AWS_REGION). */
  s3Endpoint?: string;
  s3Region?: string;
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

function positiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be a whole number from 1 to ${max} (got "${raw}")`);
  return n;
}

/** Reads the settings; command-line flags win over environment variables. */
export function deployConfigFrom(env: Env = process.env, flags: Partial<Record<'database-url' | 'storage' | 'redis-url', string>> = {}): DeployConfig {
  return {
    databaseUrl: nonEmpty(flags['database-url'] ?? env.KALIBRA_DATABASE_URL),
    databasePool: positiveInt('KALIBRA_DATABASE_POOL', env.KALIBRA_DATABASE_POOL, 10, 500),
    storageUrl: nonEmpty(flags.storage ?? env.KALIBRA_STORAGE_URL),
    sqliteSyncSeconds: positiveInt('KALIBRA_SQLITE_SYNC_SECONDS', env.KALIBRA_SQLITE_SYNC_SECONDS, 10, 3600),
    redisUrl: nonEmpty(flags['redis-url'] ?? env.KALIBRA_REDIS_URL),
    secretKey: nonEmpty(env.KALIBRA_SECRET_KEY),
    s3Endpoint: nonEmpty(env.KALIBRA_S3_ENDPOINT),
    s3Region: nonEmpty(env.KALIBRA_S3_REGION ?? env.AWS_REGION),
  };
}

export function storageKind(url: string | undefined): StorageKind {
  if (!url) return 'disk';
  const scheme = /^([a-z0-9]+):\/\//i.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'gs') return 'gcs';
  if (scheme === 's3') return 's3';
  if (scheme === 'az' || scheme === 'azure') return 'azure';
  throw new Error(`KALIBRA_STORAGE_URL must start with gs://, s3:// or az:// (got "${url.slice(0, 80)}")`);
}

export function deployMode(cfg: DeployConfig): DeployMode {
  if (cfg.databaseUrl) return cfg.redisUrl ? 'scaled' : 'postgres';
  return cfg.storageUrl ? 'single+bucket' : 'single';
}

/** Checks the combination before anything starts; every problem says what to change. */
export function validateDeployConfig(cfg: DeployConfig): void {
  const problems: string[] = [];
  if (cfg.databaseUrl && !/^postgres(ql)?:\/\//i.test(cfg.databaseUrl)) {
    problems.push('KALIBRA_DATABASE_URL must be a Postgres URL (postgres://user:password@host:5432/database).');
  }
  try {
    storageKind(cfg.storageUrl);
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (cfg.redisUrl && !/^rediss?:\/\//i.test(cfg.redisUrl)) problems.push('KALIBRA_REDIS_URL must start with redis:// or rediss://.');
  if (cfg.redisUrl && !cfg.databaseUrl) {
    problems.push('KALIBRA_REDIS_URL is for several instances, which need Postgres: set KALIBRA_DATABASE_URL too (with SQLite, run one instance and leave Redis out).');
  }
  if (cfg.redisUrl && !cfg.storageUrl) {
    problems.push('Several instances (KALIBRA_REDIS_URL) need shared files: set KALIBRA_STORAGE_URL to a bucket.');
  }
  if ((cfg.databaseUrl || cfg.storageUrl) && !cfg.secretKey) {
    problems.push(
      'Set KALIBRA_SECRET_KEY (for example `openssl rand -base64 32`): with Postgres or a bucket, provider keys are stored encrypted in the database so they survive the machine. Keep it safe; without it they cannot be read.',
    );
  }
  if (cfg.secretKey && Buffer.from(cfg.secretKey, /^[0-9a-f]+$/i.test(cfg.secretKey) ? 'hex' : 'base64').length < 32) {
    problems.push('KALIBRA_SECRET_KEY must hold at least 32 random bytes (e.g. `openssl rand -base64 32`).');
  }
  if (problems.length) throw new Error(`Deployment settings:\n- ${problems.join('\n- ')}`);
}

/** One line for the startup log, without credentials. */
export function describeDeploy(cfg: DeployConfig): string {
  const db = cfg.databaseUrl ? `Postgres (${redactUrl(cfg.databaseUrl)})` : 'SQLite in the data folder';
  const files = cfg.storageUrl ? `${cfg.storageUrl}${cfg.databaseUrl ? '' : `, SQLite synced every ${cfg.sqliteSyncSeconds} s`}` : 'the data folder';
  const shared = cfg.redisUrl ? `, Redis (${redactUrl(cfg.redisUrl)})` : '';
  return `database: ${db}; files: ${files}${shared}`;
}

/** Drops user name, password and query (which may carry credentials) from a URL for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}
