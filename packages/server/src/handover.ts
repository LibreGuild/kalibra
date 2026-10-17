import type { Hub, StorageRuntime } from '@kalibra/core';
import type { RunningServer } from './index.js';

/**
 * Setup B (SQLite + bucket): when a new instance started with --takeover asks for the bucket
 * (rolling deploys), stop serving data, let requests in progress finish and close the hub (each
 * database syncs one last time); storage then releases the lease and the new instance restores.
 * This process keeps answering 503 until the platform stops it.
 *
 * Returns the hub's close for the normal shutdown path; safe to call after a handover too.
 */
export function handOverOnRequest(storage: Pick<StorageRuntime, 'handOverWith'>, srv: Pick<RunningServer, 'setUnavailable' | 'drain'>, hub: Pick<Hub, 'close'>, log: (msg: string) => void = console.log) {
  let closing: Promise<void> | undefined;
  const closeHub = (opts?: { handOff?: boolean }) => (closing ??= hub.close(opts));
  storage.handOverWith(async () => {
    log('  A new instance asked for the bucket: handing over (requests get 503 meanwhile)');
    srv.setUnavailable('Kalibra is moving to a new instance. Try again in a few seconds.');
    await srv.drain(10_000);
    await closeHub({ handOff: true });
  });
  return () => closeHub();
}
