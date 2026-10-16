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
  | { type: 'job.updated'; jobId: string; kind: string; status: string; done: number; total: number };

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(e: EngineEvent) {
    this.emitter.emit('event', e);
  }

  subscribe(fn: (e: EngineEvent) => void) {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
