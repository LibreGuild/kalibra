import { getCurrentUserId } from './api';

export const pct = (v: number | null | undefined, digits = 1) => (v == null || Number.isNaN(v) ? '–' : `${(v * 100).toFixed(digits)}%`);

export const ms = (v: number | null | undefined) => {
  if (v == null || Number.isNaN(v)) return '–';
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
};

export const bytes = (n: number | null | undefined) => {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '–';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const dateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';

/** Short single-line preview of any cell value. */
export function preview(v: unknown, max = 140): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (typeof v === 'object' && (v as any).blob) return (v as any).name ?? 'file';
  if (Array.isArray(v) && v.every((m) => m && typeof m === 'object' && 'role' in m)) return `${v.length} messages`;
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Who did something, for history lines: "You", a teammate's name, or an agent with the person it
 * acted for ("claude-code via Priya"). Entries from before projects had names fall back gracefully.
 */
export const actorLabel = (a: { kind?: string; client?: string; id?: string; name?: string } | undefined) => {
  if (!a) return 'unknown';
  // Agent and CLI entries from before accounts existed carry the client as id and no name: they were you.
  const me = a.id === getCurrentUserId() || a.id === 'local' || ((a.kind === 'agent' || a.kind === 'cli') && !a.name);
  const person = me ? 'you' : (a.name ?? a.id ?? 'someone');
  if (a.kind === 'agent') return me ? (a.client ?? 'agent') : `${a.client ?? 'agent'} via ${person}`;
  // The SDKs' evaluate() helpers call in as "cli" with their own client name.
  const tool = a.client?.startsWith('kalibra-sdk') ? 'SDK' : 'CLI';
  if (a.kind === 'cli') return me ? tool : `${tool} via ${person}`;
  if (a.kind === 'system') return 'Kalibra';
  return me ? 'You' : (a.name ?? a.id ?? 'someone');
};
