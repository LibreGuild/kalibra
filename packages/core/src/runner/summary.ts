import { percentile } from '../util.js';

/** Wilson score interval for a proportion (95%). Behaves well for small n and extreme rates. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n === 0) return null;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export interface RunSummary {
  total: number;
  completed: number;
  targetErrors: number;
  passed: number;
  failed: number;
  passRate: number | null;
  passRateCi: [number, number] | null;
  meanScore: number | null;
  checks: {
    id: string;
    name: string;
    type: string;
    layer: number;
    pass: number;
    fail: number;
    skip: number;
    error: number;
    passRate: number | null;
    meanScore: number | null;
    meanValue: number | null;
    /** Corpus-level error rate (Σ errors / Σ reference units) for WER/CER-style checks. */
    corpus?: { metric: string; errors: number; refUnits: number; value: number };
  }[];
  metrics: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number; min: number; max: number }>;
}

export function summarize(results: { status: string; passed: boolean | null; score: number | null; error: string | null; checks: any[]; metrics: Record<string, number> }[], total: number): RunSummary {
  const finished = results.filter((r) => r.status === 'done' || r.status === 'error');
  const passed = finished.filter((r) => r.passed === true).length;
  const failed = finished.filter((r) => r.passed === false).length;
  const scores = finished.map((r) => r.score).filter((s): s is number => typeof s === 'number');

  const checkMap = new Map<string, RunSummary['checks'][number] & { scores: number[]; values: number[]; cErr: number; cRef: number; cMetric?: string }>();
  for (const r of finished) {
    for (const c of r.checks ?? []) {
      let agg = checkMap.get(c.id);
      if (!agg) {
        agg = { id: c.id, name: c.name, type: c.type, layer: c.layer, pass: 0, fail: 0, skip: 0, error: 0, passRate: null, meanScore: null, meanValue: null, scores: [], values: [], cErr: 0, cRef: 0 };
        checkMap.set(c.id, agg);
      }
      if (c.status in agg) (agg as any)[c.status]++;
      if (typeof c.score === 'number' && c.status !== 'skip') agg.scores.push(c.score);
      if (typeof c.value === 'number' && c.status !== 'skip') agg.values.push(c.value);
      const d = c.details;
      if (d && typeof d.errors === 'number' && typeof d.refUnits === 'number') {
        agg.cErr += d.errors;
        agg.cRef += d.refUnits;
        agg.cMetric = d.metric ?? c.type;
      }
    }
  }
  const checks = [...checkMap.values()]
    .sort((a, b) => a.layer - b.layer)
    .map(({ scores: s, values: v, cErr, cRef, cMetric, ...agg }) => {
      const judged = agg.pass + agg.fail + agg.error;
      return {
        ...agg,
        passRate: judged ? round(agg.pass / judged) : null,
        meanScore: s.length ? round(s.reduce((x, y) => x + y, 0) / s.length) : null,
        meanValue: v.length ? round(v.reduce((x, y) => x + y, 0) / v.length) : null,
        ...(cMetric ? { corpus: { metric: cMetric, errors: cErr, refUnits: cRef, value: cRef ? round(cErr / cRef) : cErr > 0 ? 1 : 0 } } : {}),
      };
    });

  const metricValues = new Map<string, number[]>();
  for (const r of finished) {
    for (const [k, v] of Object.entries(r.metrics ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (!metricValues.has(k)) metricValues.set(k, []);
      metricValues.get(k)!.push(v);
    }
  }
  const metrics: RunSummary['metrics'] = {};
  for (const [k, vals] of metricValues) {
    vals.sort((a, b) => a - b);
    metrics[k] = {
      count: vals.length,
      mean: round(vals.reduce((a, b) => a + b, 0) / vals.length, 2),
      p50: percentile(vals, 50)!,
      p95: percentile(vals, 95)!,
      p99: percentile(vals, 99)!,
      min: vals[0],
      max: vals[vals.length - 1],
    };
  }

  const judged = passed + failed;
  return {
    total,
    completed: finished.length,
    targetErrors: finished.filter((r) => r.error).length,
    passed,
    failed,
    passRate: judged ? round(passed / judged) : null,
    passRateCi: wilson(passed, judged),
    meanScore: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    checks,
    metrics,
  };
}
