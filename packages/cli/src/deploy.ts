import { cacheSigningKey, createCoordinator, deployConfigFrom, describeDeploy, openStorage, postgresDatabases, validateDeployConfig, type Databases, type DeployConfig, type HubOptions, type StorageRuntime } from '@kalibra/core';

/*
 * Turns the deployment settings (database, files, Redis; see docs/self-hosting.md) into what the hub
 * needs. With nothing set this is plain SQLite and files in the data folder, as always.
 */

export interface Deployment {
  cfg: DeployConfig;
  storage: StorageRuntime;
  /** Options for Hub.open. */
  hub: Pick<HubOptions, 'databases' | 'storage' | 'coordinator' | 'cacheKey'>;
  /** One line for the startup log (no credentials). */
  describe: string;
  /** After the hub closed: releases the bucket lease. */
  close(): Promise<void>;
}

export async function openDeployment(dir: string, flags: Record<string, unknown> = {}): Promise<Deployment> {
  const cfg = deployConfigFrom(process.env, {
    ...(typeof flags['database-url'] === 'string' ? { 'database-url': flags['database-url'] } : {}),
    ...(typeof flags.storage === 'string' ? { storage: flags.storage } : {}),
    ...(typeof flags['redis-url'] === 'string' ? { 'redis-url': flags['redis-url'] } : {}),
  });
  validateDeployConfig(cfg);
  const storage = await openStorage(cfg, {
    dir,
    takeover: !!flags.takeover || process.env.KALIBRA_TAKEOVER === '1',
    onLeaseLost: (why) => {
      // Another instance owns the bucket now; writing on would overwrite its data.
      console.error(`Kalibra is stopping: ${why}.`);
      process.exit(1);
    },
    onHandoverAbandoned: () => {
      // The instance that asked for the bucket never took it: exit so the platform starts this one again.
      console.error('Kalibra is stopping: it handed the bucket over, but no new instance took it. Restart Kalibra to serve again.');
      process.exit(1);
    },
  });
  let databases: Databases | undefined = storage.databases;
  if (!databases && cfg.databaseUrl) databases = await postgresDatabases({ url: cfg.databaseUrl, max: cfg.databasePool, schema: cfg.databaseSchema });
  // Redis: live events, cancels, sign-in limits, the lookup cache and run hand-over reach every instance.
  const coordinator = await createCoordinator(cfg);
  if (cfg.databaseUrl && !cfg.redisUrl) {
    console.warn('Postgres without Redis: run only one Kalibra instance (set KALIBRA_REDIS_URL to run several behind a load balancer).');
  }
  return {
    cfg,
    storage,
    // Cache entries in Redis are signed, so access to Redis alone can't forge a sign-in.
    hub: { ...(databases ? { databases } : {}), storage: storage.hooks, coordinator, ...(cfg.secretKey ? { cacheKey: cacheSigningKey(cfg.secretKey) } : {}) },
    describe: describeDeploy(cfg),
    close: async () => {
      await storage.close();
      await coordinator.close();
    },
  };
}
