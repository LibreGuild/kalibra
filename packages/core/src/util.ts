import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable, readable ids: `<prefix>_<time36><random>` (e.g. `run_mfx3k2a9q1z8w4`). */
export function newId(prefix: string): string {
  const bytes = randomBytes(8);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 36];
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export const nowIso = () => new Date().toISOString();

export class KalibraError extends Error {
  constructor(
    public code: 'not_found' | 'invalid' | 'conflict' | 'forbidden' | 'internal' | 'unavailable',
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new KalibraError('not_found', `${what} not found: ${id}`);
export const invalid = (message: string, details?: unknown) => new KalibraError('invalid', message, details);
export const conflict = (message: string, details?: unknown) => new KalibraError('conflict', message, details);

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Read a value at a dotted / bracketed path: `a.b[0].c`, `items[-1]`. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.match(/[^.[\]]+|\[(-?\d+)\]/g) ?? [];
  let cur: any = obj;
  for (let raw of parts) {
    if (cur == null) return undefined;
    if (raw.startsWith('[')) raw = raw.slice(1, -1);
    if (Array.isArray(cur) && /^-?\d+$/.test(raw)) {
      const i = Number(raw);
      cur = cur[i < 0 ? cur.length + i : i];
    } else {
      cur = cur[raw];
    }
  }
  return cur;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}
