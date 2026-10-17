import { describe, expect, it } from 'vitest';
import { deployConfigFrom, deployMode, describeDeploy, redactUrl, storageKind, validateDeployConfig } from '../src/deploy/config.js';

const KEY = 'a'.repeat(64); // 32 bytes, hex

describe('deployment settings', () => {
  it('defaults to SQLite and the data folder', () => {
    const cfg = deployConfigFrom({});
    expect(cfg).toMatchObject({ databasePool: 10, sqliteSyncSeconds: 10 });
    expect(deployMode(cfg)).toBe('single');
    expect(() => validateDeployConfig(cfg)).not.toThrow();
  });

  it('flags win over the environment', () => {
    const cfg = deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://a' }, { storage: 's3://b/p' });
    expect(cfg.storageUrl).toBe('s3://b/p');
    expect(storageKind(cfg.storageUrl)).toBe('s3');
  });

  it('names each mode', () => {
    expect(deployMode(deployConfigFrom({ KALIBRA_STORAGE_URL: 'gs://b' }))).toBe('single+bucket');
    expect(deployMode(deployConfigFrom({ KALIBRA_DATABASE_URL: 'postgres://h/d' }))).toBe('postgres');
    expect(deployMode(deployConfigFrom({ KALIBRA_DATABASE_URL: 'postgres://h/d', KALIBRA_REDIS_URL: 'redis://r' }))).toBe('scaled');
  });

  it('rejects combinations that would lose data or not work', () => {
    const bad = (env: Record<string, string>) => () => validateDeployConfig(deployConfigFrom(env));
    expect(bad({ KALIBRA_STORAGE_URL: 'gs://b' })).toThrow(/KALIBRA_SECRET_KEY/);
    expect(bad({ KALIBRA_STORAGE_URL: 'ftp://b', KALIBRA_SECRET_KEY: KEY })).toThrow(/gs:\/\/, s3:\/\/ or az:\/\//);
    expect(bad({ KALIBRA_REDIS_URL: 'redis://r', KALIBRA_SECRET_KEY: KEY })).toThrow(/need Postgres/);
    expect(bad({ KALIBRA_DATABASE_URL: 'postgres://h/d', KALIBRA_REDIS_URL: 'redis://r', KALIBRA_SECRET_KEY: KEY })).toThrow(/shared files/);
    expect(bad({ KALIBRA_DATABASE_URL: 'mysql://h/d', KALIBRA_SECRET_KEY: KEY })).toThrow(/Postgres URL/);
    expect(bad({ KALIBRA_STORAGE_URL: 'gs://b', KALIBRA_SECRET_KEY: 'short' })).toThrow(/32 random bytes/);
    expect(bad({ KALIBRA_SQLITE_SYNC_SECONDS: '0' })).toThrow(/1 to 3600/);
    expect(() =>
      validateDeployConfig(deployConfigFrom({ KALIBRA_DATABASE_URL: 'postgres://h/d', KALIBRA_REDIS_URL: 'redis://r', KALIBRA_STORAGE_URL: 'gs://b', KALIBRA_SECRET_KEY: KEY })),
    ).not.toThrow();
  });

  it('never logs credentials', () => {
    const line = describeDeploy(deployConfigFrom({ KALIBRA_DATABASE_URL: 'postgres://kal:s3cret@db.internal:5432/kalibra?sslmode=require', KALIBRA_REDIS_URL: 'rediss://:pw@r:6380' }));
    expect(line).not.toMatch(/s3cret|pw@|sslmode/);
    expect(line).toContain('db.internal:5432/kalibra');
    expect(redactUrl('not a url')).toBe('(invalid URL)');
  });
});
