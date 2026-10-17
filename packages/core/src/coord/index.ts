import type { DeployConfig } from '../deploy/config.js';
import { LocalCoordinator, type Coordinator } from './coordinator.js';

export { LocalCoordinator, newInstanceId, type Coordinator, type Lock } from './coordinator.js';
export { HubCache } from './cache.js';

/** Redis when KALIBRA_REDIS_URL is set (several instances), otherwise in memory. */
export async function createCoordinator(cfg: Pick<DeployConfig, 'redisUrl'>): Promise<Coordinator> {
  if (!cfg.redisUrl) return new LocalCoordinator();
  const { RedisCoordinator } = await import('./redis.js');
  return RedisCoordinator.connect(cfg.redisUrl);
}
