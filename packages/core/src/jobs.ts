import type { EventBus } from './events.js';
import type { Actor } from './registry.js';
import { newId, nowIso } from './util.js';

/*
 * In-process background jobs for long operations (image/speech generation, augmentation, …).
 * Ops start a job and return its id immediately; callers poll get_job or listen for job.updated.
 * Jobs live in memory: they do not survive a restart (the rows they already wrote do).
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

export class Jobs {
  private jobs = new Map<string, JobRecord>();
  private controllers = new Map<string, AbortController>();
  private lastEmit = new Map<string, number>();
  private pendingEmit = new Map<string, NodeJS.Timeout>();

  constructor(private events: EventBus) {}

  start<T>(kind: string, title: string, fn: (job: JobHandle) => Promise<T>, actor?: Actor, meta?: Record<string, unknown>): JobRecord {
    const id = newId('job');
    const job: JobRecord = { id, kind, title, status: 'queued', done: 0, total: 0, message: '', errors: [], actor, meta, createdAt: nowIso() };
    const ac = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, ac);
    this.prune();

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
