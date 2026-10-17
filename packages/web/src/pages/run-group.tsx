import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useNavigate } from '../lib/nav';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Pause, Trash2 } from 'lucide-react';
import { BackLink, Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, EmptyState, ErrorBox, Loading, Progress, SectionTitle, StatusBadge } from '../components/ui/display';
import { Segmented } from '../components/ui/form';
import { Tip, useConfirm } from '../components/ui/overlay';
import { CellValue } from '../components/ui/media';
import { DataTable, SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { ResultSheet } from '../components/runs/result-sheet';
import { firstPreviewValue } from '../components/runs/format';
import { op, useOp } from '../lib/api';
import { actorLabel, ms, pct, preview, timeAgo } from '../lib/format';
import { useCanEdit } from '../lib/session';

/* Shapes returned by get_comparison / compare_rows (core/src/ops/groups.ts). */

interface VariantCheck {
  id: string;
  name: string;
  type: string;
  passRate: number | null;
  corpus: { metric: string; value: number } | null;
}

interface Variant {
  runId: string;
  number: number;
  label: string;
  targetName: string | null;
  overrides: { vars?: Record<string, string>; model?: { connectionId?: string; model?: string; temperature?: number }; config?: Record<string, unknown> } | null;
  status: string;
  active: boolean;
  done: number;
  total: number;
  passRate: number | null;
  passRateCi: [number, number] | null;
  meanScore: number | null;
  checks: VariantCheck[];
  latencyP50: number | null;
  latencyP95: number | null;
  outputTokens: number | null;
  rank: number;
  isBest: boolean;
  vsBest: { paired: number; bestOnly: number; thisOnly: number; pValue: number | null; verdict: 'tied' | 'no difference' | 'could be noise' | 'clearly worse' } | null;
}

interface Comparison {
  id: string;
  number: number;
  name: string;
  datasetName: string | null;
  suiteName: string | null;
  status: string;
  done: number;
  total: number;
  createdAt: string;
  createdBy: any;
  variants: Variant[];
}

interface Cell {
  resultId: string;
  status: string;
  passed: boolean | null;
  score: number | null;
  output: unknown;
  error: string | null;
  failing: string[];
  latencyMs: number | null;
}

interface CompareRowsResp {
  variants: { runId: string; label: string }[];
  counts: { all: number; disagreements: number; all_failed: number; all_passed: number };
  total: number;
  rows: { key: string; rowId: string; rep: number; seq: number; input: Record<string, unknown>; variants: Record<string, Cell> }[];
}

type RowFilter = 'disagreements' | 'all_failed' | 'all';

const VERDICT = {
  tied: { tone: 'neutral', label: 'Tied' },
  'no difference': { tone: 'neutral', label: 'No real difference' },
  'could be noise': { tone: 'warn', label: 'Could be noise' },
  'clearly worse': { tone: 'bad', label: 'Clearly worse' },
} as const;

const PAGE = 200;

/** Short description of what a variant changes, e.g. "gpt-4o · temp 0.2 · base_url=…". */
function changes(o: Variant['overrides']) {
  if (!o) return '';
  const parts: string[] = [];
  if (o.model?.model) parts.push(o.model.model);
  if (o.model?.temperature !== undefined) parts.push(`temp ${o.model.temperature}`);
  for (const [k, v] of Object.entries(o.vars ?? {})) parts.push(`${k}=${v}`);
  if (o.config && Object.keys(o.config).length) parts.push('config changed');
  return parts.join(' · ');
}

function RateBar({ rate, ci, best }: { rate: number | null; ci: [number, number] | null; best: boolean }) {
  if (rate == null) return <span className="text-ink-faint">—</span>;
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-12 text-right font-medium tabular-nums">{pct(rate, 0)}</span>
      <Tip content={ci ? `95% interval ${pct(ci[0], 0)}–${pct(ci[1], 0)}` : 'Pass rate'}>
        <div className="relative h-1.5 w-24 rounded-full bg-raised">
          <div className={clsx('absolute inset-y-0 left-0 rounded-full', best ? 'bg-ok' : 'bg-accent')} style={{ width: `${rate * 100}%` }} />
          {ci && <div className="absolute -top-0.5 h-2.5 rounded-sm border border-ink-faint" style={{ left: `${ci[0] * 100}%`, width: `${Math.max(0, ci[1] - ci[0]) * 100}%` }} />}
        </div>
      </Tip>
    </div>
  );
}

function OutputCell({ v, onOpen }: { v?: Cell; onOpen: (id: string) => void }) {
  if (!v) return <span className="text-ink-faint">—</span>;
  const pending = v.status === 'pending' || v.status === 'running';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(v.resultId);
      }}
      className={clsx(
        'flex h-full w-full min-w-0 flex-col justify-center gap-0.5 border-l-2 py-1 pl-2 text-left hover:bg-raised',
        pending ? 'border-line' : v.passed === true ? 'border-ok' : v.passed === false ? 'border-bad' : 'border-warn',
      )}
    >
      {pending ? (
        <span className="text-[0.8125rem] text-ink-faint">Running…</span>
      ) : v.error && v.output == null ? (
        <span className="line-clamp-2 text-[0.8125rem] text-bad">{v.error}</span>
      ) : (
        <span className="line-clamp-2 text-[0.8125rem]">{preview(v.output, 160) || <span className="text-ink-faint">(empty)</span>}</span>
      )}
      {v.failing.length > 0 && <span className="truncate text-[0.71875rem] text-bad">{v.failing.join(', ')}</span>}
    </button>
  );
}

export function RunGroupPage() {
  const canEdit = useCanEdit();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [view, setView] = useState<RowFilter>('disagreements');
  const [pages, setPages] = useState(1);
  const [openResult, setOpenResult] = useState<string | null>(null);
  useEffect(() => setPages(1), [view]);

  const cmp = useOp<Comparison>('get_comparison', { id }, { refetchInterval: (q: any) => ((q.state.data as Comparison | undefined)?.status === 'running' ? 1500 : false) } as any);
  const c = cmp.data;
  const running = c?.status === 'running';

  const rows = useQuery({
    queryKey: ['compare_rows', id, view, pages],
    queryFn: async () => {
      let out: CompareRowsResp | null = null;
      for (let p = 0; p < pages; p++) {
        const res = await op<CompareRowsResp>('compare_rows', { id, filter: view, offset: p * PAGE, limit: PAGE });
        out = out ? { ...res, rows: out.rows.concat(res.rows) } : res;
        if (res.rows.length < PAGE) break;
      }
      return out!;
    },
    enabled: !!c,
    refetchInterval: running ? 3000 : false,
    placeholderData: (prev) => prev,
  });

  // One row per check, one column per variant (leaderboard order).
  const checks = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; type: string }>();
    for (const v of c?.variants ?? []) for (const k of v.checks) if (!seen.has(k.id)) seen.set(k.id, { id: k.id, name: k.name, type: k.type });
    return [...seen.values()];
  }, [c]);

  if (cmp.isLoading) return <Loading />;
  if (cmp.error || !c) {
    return (
      <Page title="Comparison" back={<BackLink to="/runs">Runs</BackLink>}>
        <ErrorBox error={cmp.error ?? 'Comparison not found'} />
      </Page>
    );
  }

  const corpusCheck = c.variants.flatMap((v) => v.checks).find((k) => k.corpus);
  const hasTokens = c.variants.some((v) => v.outputTokens != null);
  const order = rows.data?.variants ?? [];
  const labelOf = new Map(c.variants.map((v) => [v.runId, v]));

  const cancel = async () => {
    try {
      await op('cancel_comparison', { id: c.id });
      toast.success('Cancelling comparison…');
      cmp.refetch();
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    if (!(await confirm.ask(`Delete ${c.name}?`, `The comparison and its ${c.variants.length} runs move to the trash.`))) return;
    try {
      await op('delete_comparison', { id: c.id });
      toast.success('Comparison deleted');
      navigate('/runs');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Page
      width="wide"
      back={<BackLink to="/runs">Runs</BackLink>}
      title={c.name}
      badge={<StatusBadge status={c.status} />}
      description={
        <span>
          {c.datasetName ?? 'dataset'} · {c.suiteName ?? 'suite'} · {c.variants.length} variants · started {timeAgo(c.createdAt)} by {actorLabel(c.createdBy)}
        </span>
      }
      actions={
        <>
          {canEdit && running && (
            <Button icon={<Pause className="size-4" />} onClick={cancel}>
              Cancel
            </Button>
          )}
          {canEdit && (
            <Tip content="Delete this comparison and its runs">
              <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete comparison">
                <Trash2 className="size-4" />
              </Button>
            </Tip>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {running && (
          <Card>
            <div className="mb-2 flex items-center justify-between text-[0.8125rem]">
              <span className="font-medium">Running every variant on the same rows…</span>
              <span className="tabular-nums text-ink-muted">
                {c.done} of {c.total}
              </span>
            </div>
            <Progress value={c.total ? c.done / c.total : 0} />
          </Card>
        )}

        <section>
          <SectionTitle help="Ranked by pass rate, then mean score, then median latency. Each variant ran on the same dataset version with the same suite. Click a variant to open its run.">Leaderboard</SectionTitle>
          <SimpleTable
            rows={c.variants}
            rowKey={(v) => v.runId}
            onRowClick={(v) => navigate(`/runs/${v.runId}`)}
            empty="This comparison has no runs left."
            columns={[
              { key: 'rank', header: '#', width: '44px', render: (v) => <span className="tabular-nums text-ink-muted">{v.rank}</span> },
              {
                key: 'label',
                header: 'Variant',
                width: 'minmax(200px, 2fr)',
                render: (v) => (
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{v.label}</span>
                      {v.isBest && (
                        <Badge tone="ok" dot>
                          Best
                        </Badge>
                      )}
                      {v.status !== 'completed' && <StatusBadge status={v.status} />}
                    </div>
                    <div className="truncate text-[0.78125rem] text-ink-muted">{[v.targetName, changes(v.overrides)].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                ),
              },
              { key: 'pass', header: 'Pass rate', width: '190px', help: 'Share of rows where every check passed. The outlined box is the 95% interval.', render: (v) => <RateBar rate={v.passRate} ci={v.passRateCi} best={v.isBest} /> },
              { key: 'score', header: 'Mean score', width: '96px', align: 'right', render: (v) => <span className="tabular-nums">{v.meanScore == null ? '–' : v.meanScore.toFixed(2)}</span> },
              ...(corpusCheck
                ? [
                    {
                      key: 'corpus',
                      header: corpusCheck.corpus!.metric.toUpperCase(),
                      width: '80px',
                      align: 'right' as const,
                      help: 'Corpus error rate (total errors ÷ total reference words). Lower is better.',
                      render: (v: Variant) => <span className="tabular-nums">{pct(v.checks.find((k) => k.id === corpusCheck.id)?.corpus?.value)}</span>,
                    },
                  ]
                : []),
              { key: 'lat', header: 'Latency p50', width: '100px', align: 'right', render: (v) => <span className="tabular-nums text-ink-muted">{v.latencyP50 == null ? '–' : ms(v.latencyP50)}</span> },
              ...(hasTokens ? [{ key: 'tokens', header: 'Output tokens', width: '110px', align: 'right' as const, render: (v: Variant) => <span className="tabular-nums text-ink-muted">{v.outputTokens ?? '–'}</span> }] : []),
              {
                key: 'verdict',
                header: 'vs best',
                width: 'minmax(170px, 1.2fr)',
                help: 'Exact McNemar test on rows both variants answered: counts rows only the best passes vs rows only this variant passes. "Clearly worse" means p < 0.05, so the gap is unlikely to be chance. "Could be noise" means collect more rows before deciding.',
                render: (v) =>
                  !v.vsBest ? (
                    <span className="text-ink-faint">{v.isBest ? '—' : 'Not enough data'}</span>
                  ) : (
                    <div className="min-w-0">
                      <Badge tone={VERDICT[v.vsBest.verdict].tone}>{VERDICT[v.vsBest.verdict].label}</Badge>
                      <div className="mt-0.5 truncate text-[0.71875rem] text-ink-faint">
                        {v.vsBest.bestOnly} only best passes · {v.vsBest.thisOnly} only this{v.vsBest.pValue != null ? ` · p ${v.vsBest.pValue < 0.001 ? '< 0.001' : v.vsBest.pValue.toFixed(3)}` : ''}
                      </div>
                    </div>
                  ),
              },
            ]}
          />
        </section>

        {checks.length > 0 && c.variants.length > 0 && (
          <section>
            <SectionTitle help="Pass rate of each check for each variant. The best value in each row is highlighted.">Checks</SectionTitle>
            <SimpleTable
              rows={checks}
              rowKey={(k) => k.id}
              columns={[
                {
                  key: 'name',
                  header: 'Check',
                  width: 'minmax(180px, 1.6fr)',
                  render: (k) => (
                    <div className="min-w-0">
                      <div className="truncate font-medium">{k.name}</div>
                      <div className="truncate font-mono text-[0.71875rem] text-ink-faint">{k.type}</div>
                    </div>
                  ),
                },
                ...c.variants.map((v) => ({
                  key: v.runId,
                  header: <span className="truncate normal-case">{v.label}</span>,
                  width: 'minmax(110px, 1fr)',
                  align: 'right' as const,
                  render: (k: { id: string }) => {
                    const cells = c.variants.map((x) => x.checks.find((y) => y.id === k.id));
                    const mine = v.checks.find((y) => y.id === k.id);
                    if (!mine) return <span className="text-ink-faint">–</span>;
                    // Corpus metrics: lower wins. Pass rates: higher wins. Only highlight when variants differ.
                    const vals = cells.map((x) => (x?.corpus ? x.corpus.value : x?.passRate)).filter((x): x is number => x != null);
                    const value = mine.corpus ? mine.corpus.value : mine.passRate;
                    const top = mine.corpus ? Math.min(...vals) : Math.max(...vals);
                    const best = value != null && new Set(vals).size > 1 && value === top;
                    return (
                      <span className={clsx('tabular-nums', best && 'font-semibold text-ok')}>
                        {pct(mine.passRate)}
                        {mine.corpus && <span className="ml-1 text-[0.75rem] text-ink-faint">{mine.corpus.metric.toUpperCase()} {pct(mine.corpus.value)}</span>}
                      </span>
                    );
                  },
                })),
              ]}
            />
          </section>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <SectionTitle className="mb-0" help="Each row of the dataset with every variant's output next to each other. Green edge passed, red failed. Click an output for its full result.">
              Side by side
            </SectionTitle>
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'disagreements', label: 'Disagreements', count: rows.data?.counts.disagreements },
                { value: 'all_failed', label: 'All failed', count: rows.data?.counts.all_failed },
                { value: 'all', label: 'All', count: rows.data?.counts.all },
              ]}
            />
          </div>
          {rows.error ? (
            <ErrorBox error={rows.error} />
          ) : c.variants.length === 0 ? (
            <EmptyState title="No variants">Every run of this comparison was deleted.</EmptyState>
          ) : (
            <DataTable
              rows={rows.data?.rows ?? []}
              rowKey={(x) => x.key}
              activeKey={null}
              rowHeight={72}
              height="calc(100vh - 260px)"
              empty={
                rows.isLoading
                  ? 'Loading…'
                  : view === 'disagreements'
                    ? running
                      ? 'Rows where variants disagree appear here as they finish.'
                      : 'Every row has the same outcome across variants.'
                    : view === 'all_failed'
                      ? 'No row failed on every variant.'
                      : 'No rows yet.'
              }
              footer={
                rows.data && (
                  <div className="flex items-center justify-between">
                    <span>
                      Showing {rows.data.rows.length} of {rows.data.total}
                    </span>
                    {rows.data.rows.length < rows.data.total && (
                      <Button size="sm" onClick={() => setPages(pages + 1)} loading={rows.isFetching}>
                        Load more
                      </Button>
                    )}
                  </div>
                )
              }
              columns={[
                {
                  key: 'n',
                  header: '#',
                  width: '52px',
                  render: (x) => (
                    <span className="tabular-nums text-ink-muted">
                      {x.seq + 1}
                      {x.rep > 0 && <span className="text-ink-faint"> ·{x.rep + 1}</span>}
                    </span>
                  ),
                },
                { key: 'input', header: 'Input', width: 'minmax(180px, 1.4fr)', render: (x) => <CellValue value={firstPreviewValue(x.input)} /> },
                ...order.map((v) => ({
                  key: v.runId,
                  header: (
                    <span className="flex min-w-0 items-center gap-1 normal-case">
                      <span className="truncate">{v.label}</span>
                      {labelOf.get(v.runId)?.isBest && <span className="text-ok">★</span>}
                    </span>
                  ),
                  width: 'minmax(180px, 1.5fr)',
                  render: (x: CompareRowsResp['rows'][number]) => <OutputCell v={x.variants[v.runId]} onOpen={setOpenResult} />,
                })),
              ]}
            />
          )}
        </section>
      </div>
      <ResultSheet resultId={openResult} onClose={() => setOpenResult(null)} />
      {confirm.element}
    </Page>
  );
}
