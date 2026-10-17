import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { PreconditionFailed, type ObjectStore } from './objects.js';

/*
 * Only one Kalibra may write SQLite databases into a bucket at a time; two would overwrite each
 * other's changes. The holder keeps `<prefix>/lease.json` fresh (every 30 s) with conditional
 * writes; another instance refuses to start while it is fresh, and may take it over once nobody has
 * renewed it for 90 s (the previous instance stopped or crashed). If the holder ever finds its lease
 * taken, it stops (`onLost`), so it can't keep writing behind the new holder's back.
 */

export const LEASE_KEY = 'lease.json';
const RENEW_MS = 30_000;
export const STALE_MS = 90_000;

interface LeaseBody {
  owner: string;
  host: string;
  pid: number;
  startedAt: string;
  renewedAt: string;
}

export class BucketLease {
  readonly owner = randomBytes(8).toString('hex');
  private version?: string;
  private timer?: NodeJS.Timeout;
  private startedAt = new Date().toISOString();
  private lastRenewed = 0;

  constructor(
    private objects: ObjectStore,
    private opts: { onLost: (why: string) => void; log?: (msg: string) => void; renewMs?: number; staleMs?: number; sleep?: (ms: number) => Promise<void> } ,
  ) {}

  private body(): Buffer {
    const b: LeaseBody = { owner: this.owner, host: hostname(), pid: process.pid, startedAt: this.startedAt, renewedAt: new Date().toISOString() };
    return Buffer.from(JSON.stringify(b));
  }

  private get stale() {
    return this.opts.staleMs ?? STALE_MS;
  }

  /**
   * Takes the lease. Fails with a clear message while another instance holds it, unless `takeover`
   * is set: then waits until that lease goes stale (the other instance must be stopped).
   */
  async acquire(takeover = false): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      const cur = await this.objects.get(LEASE_KEY);
      try {
        if (!cur) {
          this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifAbsent: true, contentType: 'application/json' })).version;
          break;
        }
        const held: LeaseBody = JSON.parse(cur.data.toString('utf8'));
        const age = Date.now() - Date.parse(held.renewedAt);
        if (held.owner === this.owner || !(age < this.stale)) {
          this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifVersion: cur.info.version, contentType: 'application/json' })).version;
          if (held.owner !== this.owner) this.opts.log?.(`took over the bucket from ${held.host} (pid ${held.pid}), silent for ${Math.round(age / 1000)} s`);
          break;
        }
        const wait = this.stale - age + 1000;
        const msg = `Another Kalibra (${held.host}, pid ${held.pid}) is using ${this.objects.url}; it last checked in ${Math.max(0, Math.round(age / 1000))} s ago.`;
        if (!takeover) {
          throw new Error(`${msg} Two instances on one bucket would overwrite each other's data. Stop it first; or, if it already stopped or crashed, start this one with --takeover to wait until its lease expires (${Math.round(this.stale / 1000)} s after it stopped).`);
        }
        this.opts.log?.(`${msg} Waiting ${Math.round(wait / 1000)} s for its lease to expire…`);
        await sleep(Math.min(wait, 15_000));
      } catch (e) {
        if (e instanceof PreconditionFailed) continue; // someone else wrote it at the same moment: look again
        throw e;
      }
    }
    this.lastRenewed = Date.now();
    this.timer = setInterval(() => void this.renew(), this.opts.renewMs ?? RENEW_MS).unref();
  }

  async renew(): Promise<void> {
    if (!this.version) return;
    try {
      this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifVersion: this.version, contentType: 'application/json' })).version;
      this.lastRenewed = Date.now();
    } catch (e: any) {
      if (e instanceof PreconditionFailed) {
        this.stop();
        this.opts.onLost(`another instance took over ${this.objects.url}`);
        return;
      }
      const silent = Date.now() - this.lastRenewed;
      this.opts.log?.(`renewing the bucket lease failed (${e?.message ?? e}); ${silent > this.stale / 2 ? 'other instances may take over soon' : 'will retry'}`);
    }
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Gives the lease back, so the next instance can start at once. */
  async release(): Promise<void> {
    this.stop();
    if (!this.version) return;
    try {
      const cur = await this.objects.get(LEASE_KEY);
      if (cur && cur.info.version === this.version) await this.objects.delete(LEASE_KEY);
    } catch (e: any) {
      this.opts.log?.(`releasing the bucket lease failed (${e?.message ?? e}); the next instance waits until it expires`);
    }
    this.version = undefined;
  }
}
