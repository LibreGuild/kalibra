import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { PreconditionFailed, type ObjectStore } from './objects.js';

/*
 * Only one Kalibra may write SQLite databases into a bucket at a time; two would overwrite each
 * other's changes. The holder keeps `<prefix>/lease.json` fresh (every 30 s) with conditional
 * writes; another instance refuses to start while it is fresh. If the holder ever finds its lease
 * taken, it stops (`onLost`), so it can't keep writing behind the new holder's back.
 *
 * Handover (rolling deploys: Cloud Run revisions, Kubernetes updates start the new instance before
 * the old one stops): an instance started with takeover writes `<prefix>/lease-handover.json`
 * addressed to the holder. The holder notices within a few seconds (`onHandover`), stops writing,
 * syncs one last time and releases the lease (marked released with a conditional write, so it can
 * never wipe out a lease someone else just took). The new instance takes it and restores. A holder
 * that doesn't answer (an older Kalibra, or a crashed one) is waited out until its lease goes stale,
 * 90 s after its last renewal, as before.
 */

export const LEASE_KEY = 'lease.json';
export const HANDOVER_KEY = 'lease-handover.json';
const RENEW_MS = 30_000;
export const STALE_MS = 90_000;
/** How often the holder looks for a handover request. A small GET; about 29,000 a day. */
const HANDOVER_POLL_MS = 3_000;
/** How long a requester waits for the holder to answer before waiting for its lease to go stale. */
const HANDOVER_WAIT_MS = 60_000;

interface LeaseBody {
  owner: string;
  host: string;
  pid: number;
  startedAt: string;
  renewedAt: string;
  /** Given back on purpose (stop or handover): free to take at once. */
  released?: boolean;
}

interface HandoverRequest {
  /** The requesting instance's lease owner id. */
  from: string;
  /** The holder it is addressed to. */
  to: string;
  host: string;
  pid: number;
  startedAt: string;
  requestedAt: string;
}

export interface LeaseOptions {
  onLost: (why: string) => void;
  /**
   * The holder: another instance asks for the bucket. Return true to hand over (then stop writing,
   * sync and call `release()`); false to ignore the request for now (e.g. still starting).
   */
  onHandover?: (from: { host: string; pid: number }) => boolean;
  log?: (msg: string) => void;
  renewMs?: number;
  staleMs?: number;
  handoverPollMs?: number;
  handoverWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class BucketLease {
  readonly owner = randomBytes(8).toString('hex');
  private version?: string;
  private timer?: NodeJS.Timeout;
  private watcher?: NodeJS.Timeout;
  private readonly startedAt = new Date().toISOString();
  private lastRenewed = 0;
  /** A handover was accepted: no more requests are looked at. */
  private handingOver = false;
  /** A look for requests is in progress (on a slow link one can outlast the poll interval). */
  private checking = false;
  /** Renewals and the release run one at a time, so a late renewal can't undo (or trip over) a release. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private objects: ObjectStore,
    private opts: LeaseOptions,
  ) {}

  private body(extra: Partial<LeaseBody> = {}): Buffer {
    const b: LeaseBody = { owner: this.owner, host: hostname(), pid: process.pid, startedAt: this.startedAt, renewedAt: new Date().toISOString(), ...extra };
    return Buffer.from(JSON.stringify(b));
  }

  private get stale() {
    return this.opts.staleMs ?? STALE_MS;
  }

  private get handoverWait() {
    return this.opts.handoverWaitMs ?? HANDOVER_WAIT_MS;
  }

  private sleep(ms: number) {
    return (this.opts.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
  }

  /**
   * Takes the lease. Fails with a clear message while another instance holds it, unless `takeover`
   * is set: then asks the holder to hand over, and if it doesn't answer, waits until its lease goes
   * stale (the other instance must be stopped).
   */
  async acquire(takeover = false): Promise<void> {
    let askedAt: number | undefined;
    let toldWaiting = false;
    let toldNoAnswer = false;
    for (;;) {
      const cur = await this.objects.get(LEASE_KEY);
      try {
        if (!cur) {
          this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifAbsent: true, contentType: 'application/json' })).version;
          break;
        }
        const held: LeaseBody = JSON.parse(cur.data.toString('utf8'));
        const age = Date.now() - Date.parse(held.renewedAt);
        if (held.owner === this.owner || held.released || !(age < this.stale)) {
          this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifVersion: cur.info.version, contentType: 'application/json' })).version;
          if (held.owner !== this.owner) {
            this.opts.log?.(held.released ? `took the bucket over from ${held.host} (pid ${held.pid}), which handed it over` : `took over the bucket from ${held.host} (pid ${held.pid}), silent for ${Math.round(age / 1000)} s`);
          }
          break;
        }
        const msg = `Another Kalibra (${held.host}, pid ${held.pid}) is using ${this.objects.url}; it last checked in ${Math.max(0, Math.round(age / 1000))} s ago.`;
        if (!takeover) {
          throw new Error(
            `${msg} Two instances on one bucket would overwrite each other's data. Stop it first, or start this one with --takeover: it asks the running one to hand over (or, if that one stopped or crashed, waits until its lease expires, ${Math.round(this.stale / 1000)} s after its last check-in).`,
          );
        }
        // A newer holder won a race against us: don't ask it to step aside; wait like before.
        const holderIsNewer = Date.parse(held.startedAt) > Date.parse(this.startedAt);
        if (!holderIsNewer) {
          askedAt ??= Date.now();
          if (Date.now() - askedAt < this.handoverWait) {
            await this.requestHandover(held.owner);
            if (!toldWaiting) this.opts.log?.(`${msg} Asked it to hand over…`);
            toldWaiting = true;
            await this.sleep(Math.min(1_000, this.opts.handoverPollMs ?? HANDOVER_POLL_MS));
            continue;
          }
        }
        const wait = this.stale - age + 1000;
        if (!toldNoAnswer) this.opts.log?.(`${msg} ${holderIsNewer ? 'It started after this one.' : 'It did not hand over (an older Kalibra, or stuck).'} Waiting for its lease to expire (up to ${Math.round(wait / 1000)} s)…`);
        toldNoAnswer = true;
        await this.sleep(Math.min(wait, 15_000));
      } catch (e) {
        if (e instanceof PreconditionFailed) continue; // someone else wrote it at the same moment: look again
        throw e;
      }
    }
    this.lastRenewed = Date.now();
    this.handingOver = false;
    await this.clearOwnRequest();
    this.timer = setInterval(() => void this.renew(), this.opts.renewMs ?? RENEW_MS).unref();
    if (this.opts.onHandover) this.watcher = setInterval(() => void this.checkHandover().catch((e) => this.opts.log?.(`checking for a handover request failed (${e?.message ?? e})`)), this.opts.handoverPollMs ?? HANDOVER_POLL_MS).unref();
  }

  /** Makes sure a fresh request addressed to `holder` is in the bucket (ours, or a competitor's). */
  private async requestHandover(holder: string) {
    const body = (): Buffer => {
      const r: HandoverRequest = { from: this.owner, to: holder, host: hostname(), pid: process.pid, startedAt: this.startedAt, requestedAt: new Date().toISOString() };
      return Buffer.from(JSON.stringify(r));
    };
    const cur = await this.objects.get(HANDOVER_KEY);
    try {
      if (!cur) {
        await this.objects.put(HANDOVER_KEY, body(), { ifAbsent: true, contentType: 'application/json' });
        return;
      }
      const req: HandoverRequest = JSON.parse(cur.data.toString('utf8'));
      const fresh = Date.now() - Date.parse(req.requestedAt) < this.handoverWait;
      // Another new instance already asked the same holder: wait for the release and race for it.
      if (req.to === holder && fresh) return;
      await this.objects.put(HANDOVER_KEY, body(), { ifVersion: cur.info.version, contentType: 'application/json' });
    } catch (e) {
      if (!(e instanceof PreconditionFailed)) throw e; // someone else's request landed first: fine
    }
  }

  /** After taking the lease: our request has done its job. */
  private async clearOwnRequest() {
    try {
      const cur = await this.objects.get(HANDOVER_KEY);
      if (cur && JSON.parse(cur.data.toString('utf8')).from === this.owner) await this.objects.delete(HANDOVER_KEY);
    } catch {
      /* a leftover request goes stale on its own */
    }
  }

  /** The holder: is a newer instance asking for the bucket? */
  async checkHandover(): Promise<void> {
    if (this.checking || this.handingOver || !this.version || !this.opts.onHandover) return;
    this.checking = true;
    try {
      await this.lookForRequest();
    } finally {
      this.checking = false;
    }
  }

  private async lookForRequest() {
    let req: HandoverRequest;
    try {
      const cur = await this.objects.get(HANDOVER_KEY);
      if (!cur) return;
      req = JSON.parse(cur.data.toString('utf8'));
    } catch {
      return; // unreadable or the bucket hiccuped: look again next time
    }
    if (this.handingOver || !this.version) return;
    const fresh = Date.now() - Date.parse(req.requestedAt) < this.handoverWait;
    if (req.to !== this.owner || req.from === this.owner || !fresh || Date.parse(req.startedAt) < Date.parse(this.startedAt)) return;
    if (!this.opts.onHandover!({ host: req.host, pid: req.pid })) return;
    this.handingOver = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = undefined;
    this.opts.log?.(`${req.host} (pid ${req.pid}) asked for the bucket: handing over`);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  renew(): Promise<void> {
    return this.serial(async () => {
      if (!this.version) return;
      try {
        this.version = (await this.objects.put(LEASE_KEY, this.body(), { ifVersion: this.version, contentType: 'application/json' })).version;
        this.lastRenewed = Date.now();
      } catch (e: any) {
        if (e instanceof PreconditionFailed) {
          this.stop();
          this.version = undefined;
          this.opts.onLost(`another instance took over ${this.objects.url}`);
          return;
        }
        const silent = Date.now() - this.lastRenewed;
        this.opts.log?.(`renewing the bucket lease failed (${e?.message ?? e}); ${silent > this.stale / 2 ? 'other instances may take over soon' : 'will retry'}`);
      }
    });
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) clearInterval(this.watcher);
    this.timer = this.watcher = undefined;
  }

  /** Gives the lease back (marked released, only if it is still ours), so the next instance can start at once. */
  release(): Promise<void> {
    this.stop();
    return this.serial(async () => {
      if (!this.version) return;
      try {
        await this.objects.put(LEASE_KEY, this.body({ released: true }), { ifVersion: this.version, contentType: 'application/json' });
      } catch (e: any) {
        if (!(e instanceof PreconditionFailed)) this.opts.log?.(`releasing the bucket lease failed (${e?.message ?? e}); the next instance waits until it expires`);
      }
      this.version = undefined;
    });
  }

  /** After a handover: whether another instance has taken the lease (undefined when the bucket can't be read). */
  async takenByOther(): Promise<boolean | undefined> {
    try {
      const cur = await this.objects.get(LEASE_KEY);
      if (!cur) return false;
      const held: LeaseBody = JSON.parse(cur.data.toString('utf8'));
      return held.owner !== this.owner && !held.released;
    } catch {
      return undefined;
    }
  }
}

/** Whether the lease object says nobody holds the bucket (absent, released, or stale). For tests and tools. */
export function leaseIsFree(raw: Buffer | undefined, staleMs = STALE_MS): boolean {
  if (!raw) return true;
  const held: LeaseBody = JSON.parse(raw.toString('utf8'));
  return !!held.released || !(Date.now() - Date.parse(held.renewedAt) < staleMs);
}
