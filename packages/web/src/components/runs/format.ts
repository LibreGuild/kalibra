import { ms, pct } from '../../lib/format';

/** Rate-like check values (WER, recall, similarity, BLEU...) read best as percentages. */
const RATE_TYPES = new Set(['wer', 'semantic_wer', 'keyword_recall', 'bleu', 'rouge_l', 'chrf', 'token_f1', 'similarity']);

export function formatMetric(type: string, v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  if (RATE_TYPES.has(type)) return pct(v);
  if (type === 'latency') return ms(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

export const metricLabel = (key: string) => key.replace(/_ms$/, '').replace(/_/g, ' ');
export const formatMetricKey = (key: string, v: number | null | undefined) => (key.endsWith('_ms') ? ms(v) : v == null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(3));

/** The most telling input value for previews: an audio clip if the row has one, else the first text. */
export function firstPreviewValue(input: Record<string, unknown>): unknown {
  const entries = Object.entries(input ?? {});
  const audio = entries.find(([, v]) => v && typeof v === 'object' && (v as any).blob && String((v as any).mime ?? '').startsWith('audio/'));
  const text = entries.find(([, v]) => typeof v === 'string' && v.trim());
  return (audio ?? text ?? entries[0])?.[1];
}
