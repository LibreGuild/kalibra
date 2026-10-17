import { EventEmitter } from 'node:events';
import type { Actor } from './registry.js';

/** Live change notifications. The UI subscribes (SSE) so edits made by agents or the CLI show up instantly. */
export type EngineEvent =
  | { type: 'dataset.changed'; datasetId: string; actor?: Actor }
  | { type: 'rows.changed'; datasetId: string; count: number; actor?: Actor }
  | { type: 'def.changed'; kind: string; id: string; actor?: Actor }
  | { type: 'run.updated'; runId: string; status: string; done: number; total: number }
  | { type: 'result.updated'; runId: string; resultId: string }
  | { type: 'activity'; op: string; summary: string; actor: Actor }
  | { type: 'job.updated'; jobId: string; kind: string; status: string; done: number; total: number }
  /** The app sent traces (SDK, OpenTelemetry, proxy); `resultIds` when some belong to eval rows. */
  | { type: 'traces.ingested'; count: number; resultIds?: string[] };

export class EventBus {
  private emitter = new EventEmitter();
  /**
   * Set when several instances share state (see Hub): every event raised here is also sent to the
   * other instances, whose listeners (live-event streams, run waiters) get it through deliver().
   */
  relay?: (e: EngineEvent) => void;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(e: EngineEvent) {
    this.emitter.emit('event', e);
    this.relay?.(e);
  }

  /** An event raised on another instance: given to the listeners here, not sent on again. */
  deliver(e: EngineEvent) {
    this.emitter.emit('event', e);
  }

  /** How many listeners (e.g. open live-event streams) are attached. */
  listenerCount() {
    return this.emitter.listenerCount('event');
  }

  subscribe(fn: (e: EngineEvent) => void) {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
