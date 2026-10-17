import type { Coordinator } from './coord/coordinator.js';
import type { EventBus } from './events.js';
import type { Actor } from './registry.js';
import { newId, nowIso } from './util.js';

/*
 * In-process background jobs for long operations (image/speech generation, augmentation, …).
 * Ops start a job and return its id immediately; callers poll get_job or listen for job.updated.
 * Jobs live in memory: they do not survive a restart (the rows they already wrote do).
 *
 * Several instances: a job runs on the instance that started it; its record is also kept on the
 * coordinator (with a heartbeat), so get_job, list_jobs and cancel_job work from any instance, and a
 * job whose instance stopped shows as failed instead of running forever.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  done: number;
  total: number;
  message: string;
  /** Per-item problems (kept short). */
  errors: { item?: string; error: string }[];
  result?: unknown;
  error?: string;
  actor?: Actor;
  /** Free-form context for UIs, e.g. { datasetId } so a dataset page can show its jobs. */
  meta?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  progress(done: number, total?: number, message?: string): void;
  /** Records a per-item failure without stopping the job. */
  itemError(error: string, item?: string): void;
}

const MAX_JOBS = 200;
const MAX_ITEM_ERRORS = 100;
/** Shared job records are kept this long. */
const SHARED_TTL_MS = 24 * 3_600_000;
/** A running job's instance rewrites its record this often; older than STALE_MS means it stopped. */
const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;

type SharedRecord = JobRecord & { owner: string; heartbeat: number };

export class Jobs {
  private jobs = new Map<string, JobRecord>();
  private controllers = new Map<string, AbortController>();
  private lastEmit = new Map<string, number>();
  private pendingEmit = new Map<string, NodeJS.Timeout>();
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private events: EventBus,
    private shared?: { coordinator: Coordinator; project: string },
  ) {}

  /** Jobs still queued or running. */
  activeCount() {
    return [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
  }

  start<T>(kind: string, title: string, fn: (job: JobHandle) => Promise<T>, actor?: Actor, meta?: Record<string, unknown>): JobRecord {
    const id = newId('job');
    const job: JobRecord = { id, kind, title, status: 'queued', done: 0, total: 0, message: '', errors: [], actor, meta, createdAt: nowIso() };
    const ac = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, ac);
    this.prune();
    if (this.shared) {
      void this.shared.coordinator.listPush(this.indexKey(), id, MAX_JOBS, SHARED_TTL_MS).catch(() => {});
      this.persist(job);
      this.beat();
    }

    const handle: JobHandle = {
      id,
      signal: ac.signal,
      progress: (done, total, message) => {
        job.done = done;
        if (total !== undefined) job.total = total;
        if (message !== undefined) job.message = message;
        this.emit(job);
      },
      itemError: (error, item) => {
        if (job.errors.length < MAX_ITEM_ERRORS) job.errors.push({ item, error: error.slice(0, 500) });
        this.emit(job);
      },
    };

    queueMicrotask(async () => {
      job.status = 'running';
      job.startedAt = nowIso();
      this.emit(job, true);
      try {
        job.result = await fn(handle);
        job.status = ac.signal.aborted ? 'cancelled' : 'completed';
      } catch (e: any) {
        job.status = ac.signal.aborted ? 'cancelled' : 'failed';
        job.error = e?.message ?? String(e);
      } finally {
        job.finishedAt = nowIso();
        this.controllers.delete(id);
        this.emit(job, true);
      }
    });
    return { ...job };
  }

  get(id: string): JobRecord | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j, errors: [...j.errors] } : undefined;
  }

  list(limit = 50): JobRecord[] {
    return [...this.jobs.values()].reverse().slice(0, limit).map((j) => ({ ...j, errors: j.errors.slice(0, 5) }));
  }

  cancel(id: string): boolean {
    const ac = this.controllers.get(id);
    if (!ac) return false;
    ac.abort(new Error('Cancelled'));
    return true;
  }

  cancelAll() {
    for (const ac of this.controllers.values()) ac.abort(new Error('Shutting down'));
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  // ── Any instance (get_job, list_jobs, cancel_job) ─────────────────────────

  /** A job started here or, with several instances, on another instance. */
  async find(id: string): Promise<JobRecord | undefined> {
    const local = this.get(id);
    if (local || !this.shared) return local;
    const raw = await this.shared.coordinator.get(this.recordKey(id));
    return raw ? fromShared(JSON.parse(raw)) : undefined;
  }

  /** Recent jobs of this project on every instance, newest first. */
  async listAll(limit = 50): Promise<JobRecord[]> {
    if (!this.shared) return this.list(limit);
    const ids = await this.shared.coordinator.listRange(this.indexKey(), MAX_JOBS);
    const raws = await this.shared.coordinator.getMany(ids.map((id) => this.recordKey(id)));
    const byId = new Map<string, JobRecord>();
    for (const raw of raws) {
      if (!raw) continue;
      const j = fromShared(JSON.parse(raw));
      byId.set(j.id, j);
    }
    for (const j of this.jobs.values()) byId.set(j.id, j);
    return [...byId.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((j) => ({ ...j, errors: j.errors.slice(0, 5) }));
  }

  /** Cancels a job here, or asks the instance running it to. */
  async cancelAnywhere(id: string): Promise<boolean> {
    if (this.cancel(id)) return true;
    if (!this.shared) return false;
    const job = await this.find(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
    await this.shared.coordinator.publish('control', JSON.stringify({ type: 'cancel-job', project: this.shared.project, jobId: id }));
    return true;
  }

  private indexKey() {
    return `jobs:${this.shared!.project}`;
  }

  private recordKey(id: string) {
    return `job:${this.shared!.project}:${id}`;
  }

  private persist(job: JobRecord) {
    if (!this.shared) return;
    const record: SharedRecord = { ...job, errors: job.errors.slice(0, 20), owner: this.shared.coordinator.instanceId, heartbeat: Date.now() };
    void this.shared.coordinator.set(this.recordKey(job.id), JSON.stringify(record), SHARED_TTL_MS).catch(() => {});
  }

  /** Keeps running jobs' shared records fresh, so other instances can tell they are alive. */
  private beat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const running = [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
      for (const j of running) this.persist(j);
      if (!running.length) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Waits for a job to finish (CLI, tests). */
  async wait(id: string, pollMs = 100): Promise<JobRecord> {
    for (;;) {
      const j = this.jobs.get(id);
      if (!j) throw new Error(`Unknown job ${id}`);
      if (j.status !== 'queued' && j.status !== 'running') return { ...j };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Throttled to ~4 events per second per job; state changes are sent immediately. */
  private emit(job: JobRecord, force = false) {
    const send = () => {
      this.lastEmit.set(job.id, Date.now());
      this.pendingEmit.delete(job.id);
      this.events.emit({ type: 'job.updated', jobId: job.id, kind: job.kind, status: job.status, done: job.done, total: job.total });
      this.persist(job);
    };
    const last = this.lastEmit.get(job.id) ?? 0;
    if (force || Date.now() - last >= 250) {
      clearTimeout(this.pendingEmit.get(job.id));
      send();
    } else if (!this.pendingEmit.has(job.id)) {
      this.pendingEmit.set(job.id, setTimeout(send, 250 - (Date.now() - last)));
    }
  }

  private prune() {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (j.status !== 'running' && j.status !== 'queued') {
        this.jobs.delete(id);
        this.lastEmit.delete(id);
      }
    }
  }
}

/** Runs `fn` over items with bounded concurrency, stopping early when the signal aborts. */
export async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** A job record from another instance; one whose instance stopped beating is reported as failed. */
function fromShared(r: SharedRecord): JobRecord {
  const { owner: _owner, heartbeat, ...job } = r;
  if ((job.status === 'queued' || job.status === 'running') && Date.now() - heartbeat > STALE_MS) {
    return { ...job, status: 'failed', error: 'The Kalibra instance running this job stopped. Start it again.', finishedAt: new Date(heartbeat).toISOString() };
  }
  return job;
}
