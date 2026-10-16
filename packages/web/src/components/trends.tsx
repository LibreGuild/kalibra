import { Link } from 'react-router';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, SectionTitle } from './ui/display';
import { Tip } from './ui/overlay';
import { useOp } from '../lib/api';
import { pct, timeAgo } from '../lib/format';

/* Pass rate over recent runs, one small chart per suite. Hand-drawn SVG, theme-aware via CSS variables. */

interface TrendRun {
  id: string;
  number: number;
  name: string;
  createdAt: string;
  passRate: number | null;
  passRateCi: [number, number] | null;
  checks: { id: string; name: string; corpus: { metric: string; value: number } | null }[];
}

interface Series {
  suiteId: string;
  suiteName: string;
  runs: TrendRun[];
}

const W = 600;
const H = 120;
const PAD = { l: 34, r: 10, t: 10, b: 14 };

const rateColor = (v: number | null) => (v == null ? 'var(--k-ink-faint)' : v >= 0.8 ? 'var(--k-ok)' : v < 0.5 ? 'var(--k-bad)' : 'var(--k-warn)');

function Chart({ runs }: { runs: TrendRun[] }) {
  const pts = runs.filter((r) => r.passRate != null);
  const x = (i: number) => PAD.l + (pts.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (pts.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v) * (H - PAD.t - PAD.b);
  const path = pts.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.passRate!).toFixed(1)}`).join(' ');
  const band = pts.filter((r) => r.passRateCi);
  const area =
    band.length === pts.length && pts.length > 1
      ? `M${pts.map((r, i) => `${x(i).toFixed(1)},${y(r.passRateCi![1]).toFixed(1)}`).join(' L')} L${[...pts]
          .map((r, i) => [i, r] as const)
          .reverse()
          .map(([i, r]) => `${x(i).toFixed(1)},${y(r.passRateCi![0]).toFixed(1)}`)
          .join(' L')} Z`
      : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Pass rate over runs">
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--k-line)" strokeDasharray={g === 0.5 ? '3 4' : undefined} />
          <text x={PAD.l - 6} y={y(g) + 3.5} textAnchor="end" fontSize="10" fill="var(--k-ink-faint)">
            {g * 100}%
          </text>
        </g>
      ))}
      {area && <path d={area} fill="var(--k-accent)" opacity={0.1} />}
      <path d={path} fill="none" stroke="var(--k-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((r, i) => (
        <Tip
          key={r.id}
          content={
            <span>
              <b>
                #{r.number} {r.name}
              </b>
              <br />
              Pass rate {pct(r.passRate)}
              {r.passRateCi && ` (${pct(r.passRateCi[0], 0)}–${pct(r.passRateCi[1], 0)})`} · {timeAgo(r.createdAt)}
            </span>
          }
        >
          <g className="cursor-pointer">
            <circle cx={x(i)} cy={y(r.passRate!)} r={10} fill="transparent" />
            <circle cx={x(i)} cy={y(r.passRate!)} r={4} fill={rateColor(r.passRate)} stroke="var(--k-surface)" strokeWidth={1.5} />
          </g>
        </Tip>
      ))}
    </svg>
  );
}

/** Tiny sparkline of the first corpus metric (e.g. WER), lower is better. */
function Sparkline({ runs }: { runs: TrendRun[] }) {
  const id = runs.flatMap((r) => r.checks).find((c) => c.corpus)?.id;
  if (!id) return null;
  const vals = runs.map((r) => r.checks.find((c) => c.id === id)?.corpus?.value).filter((v): v is number => typeof v === 'number');
  if (vals.length < 2) return null;
  const metric = runs.flatMap((r) => r.checks).find((c) => c.id === id)!.corpus!.metric.toUpperCase();
  const max = Math.max(...vals, 0.0001);
  const w = 90;
  const h = 22;
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  const last = vals[vals.length - 1];
  const prev = vals[vals.length - 2];
  return (
    <Tip content={`Corpus ${metric} over the same runs (lower is better). Latest ${pct(last)}, before ${pct(prev)}.`}>
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
        {metric}
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
          <path d={d} fill="none" stroke={last <= prev ? 'var(--k-ok)' : 'var(--k-bad)'} strokeWidth={1.5} strokeLinejoin="round" />
        </svg>
        <span className="tabular-nums text-ink">{pct(last)}</span>
      </span>
    </Tip>
  );
}

export function TrendsCard() {
  const q = useOp<{ series: Series[] }>('suite_trend', { limit: 20 });
  const series = (q.data?.series ?? []).filter((s) => s.runs.filter((r) => r.passRate != null).length >= 2);

  return (
    <Card>
      <SectionTitle help="Pass rate of each suite across its recent completed runs. The shaded band is the 95% interval: when bands overlap, a change may be noise.">Trends</SectionTitle>
      {q.isLoading ? null : series.length === 0 ? (
        <div className="text-sm text-ink-muted">Run a suite at least twice to see how quality moves over time.</div>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {series.map((s) => {
            const done = s.runs.filter((r) => r.passRate != null);
            const last = done[done.length - 1];
            const prev = done[done.length - 2];
            const delta = (last.passRate ?? 0) - (prev.passRate ?? 0);
            return (
              <div key={s.suiteId} className="py-4 first:pt-0 last:pb-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                  <Link to={`/suites/${s.suiteId}`} className="truncate text-sm font-semibold hover:underline">
                    {s.suiteName}
                  </Link>
                  <div className="flex items-center gap-4">
                    <Sparkline runs={s.runs} />
                    <span className="inline-flex items-center gap-1 text-sm tabular-nums">
                      {pct(last.passRate)}
                      {Math.abs(delta) >= 0.0005 && (
                        <span className={delta > 0 ? 'inline-flex items-center gap-0.5 text-xs text-ok' : 'inline-flex items-center gap-0.5 text-xs text-bad'}>
                          {delta > 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
                          {delta > 0 ? '+' : ''}
                          {(delta * 100).toFixed(1)} pts
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                <Chart runs={s.runs} />
                <div className="mt-1 flex justify-between text-xs text-ink-faint">
                  <span>#{done[0].number}</span>
                  <span>
                    {done.length} runs · latest #{last.number}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
