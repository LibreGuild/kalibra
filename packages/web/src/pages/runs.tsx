import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FileUp, GitCompare, Pause, Play, Plus, RotateCcw, Scale, Search, Trash2, X } from 'lucide-react';
import { BackLink, Page } from '../components/layout/shell';
import { Button } from '../components/ui/button';
import { Badge, Card, EmptyState, ErrorBox, Loading, OutcomeBar, Progress, SectionTitle, Stat, StatusBadge } from '../components/ui/display';
import { Input, Segmented, Select } from '../components/ui/form';
import { HelpTip, Menu, MenuItem, Tip, useConfirm } from '../components/ui/overlay';
import { CellValue } from '../components/ui/media';
import { DataTable, SimpleTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { ImportOutputsDialog, NewRunDialog } from '../components/runs/dialogs';
import { ResultSheet } from '../components/runs/result-sheet';
import { BreakdownCard } from '../components/runs/breakdown';
import { firstPreviewValue, formatMetric, formatMetricKey } from '../components/runs/format';
import { op, useOp } from '../lib/api';
import { actorLabel, ms, pct, preview, timeAgo } from '../lib/format';

/* ── Shared shapes (see core/src/repo/runs.ts and runner/summary.ts) ─────── */

interface CheckSummary {
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
  corpus?: { metric: string; errors: number; refUnits: number; value: number };
}

interface Summary {
  total?: number;
  completed?: number;
  targetErrors?: number;
  passed?: number;
  failed?: number;
  passRate?: number | null;
  passRateCi?: [number, number] | null;
  meanScore?: number | null;
  checks?: CheckSummary[];
  metrics?: Record<string, { count: number; mean: number; p50: number; p95: number; p99: number; min: number; max: number }>;
}

interface Run {
  id: string;
  number: number;
  name: string;
  kind: 'live' | 'imported';
  status: string;
  datasetId: string | null;
  targetId: string | null;
  suiteId: string | null;
  total: number;
  done: number;
  createdAt: string;
  createdBy: any;
  summary: Summary;
  error: string | null;
  active?: boolean;
  datasetName?: string | null;
  targetName?: string | null;
  suiteName?: string | null;
}

interface ResultLite {
  id: string;
  rowId: string;
  rep: number;
  seq: number;
  status: string;
  passed: boolean | null;
  score: number | null;
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  checks: { id: string; name: string; type: string; status: string; reason?: string; layer: number }[];
  metrics: Record<string, number>;
  error: string | null;
}

const isLive = (s: string) => s === 'running' || s === 'queued';

function useNameLookup() {
  const datasets = useOp<any[]>('list_datasets');
  const targets = useOp<any[]>('list_targets');
  const suites = useOp<any[]>('list_suites');
  return useMemo(() => {
    const map = (xs?: any[]) => new Map((xs ?? []).map((x) => [x.id, x.name as string]));
    return { dataset: map(datasets.data), target: map(targets.data), suite: map(suites.data) };
  }, [datasets.data, targets.data, suites.data]);
}

function PassRateCell({ s }: { s: Summary }) {
  if (s?.passRate == null) return <span className="text-ink-faint">—</span>;
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-12 text-right font-medium tabular-nums">{pct(s.passRate, 0)}</span>
      <div className="w-20">
        <OutcomeBar pass={s.passed ?? 0} fail={s.failed ?? 0} />
      </div>
    </div>
  );
}

/* ── Runs list ────────────────────────────────────────────────────────────── */

export function RunsPage() {
  const navigate = useNavigate();
  const [newRun, setNewRun] = useState(false);
  const [importing, setImporting] = useState(false);
  const names = useNameLookup();
  const runs = useOp<{ total: number; runs: Run[] }>('list_runs', { limit: 200 }, {
    refetchInterval: (q: any) => ((q.state.data as any)?.runs?.some((r: Run) => isLive(r.status)) ? 2000 : false),
  } as any);
  const list = runs.data?.runs ?? [];

  return (
    <Page
      title="Runs"
      description="A run sends every dataset row to a target and scores the results with a suite. Each run pins the exact dataset, target and suite versions it used."
      actions={
        <>
          <Tip content="Already have outputs from your own pipeline? Score them without calling any target.">
            <Button icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
              Score outputs from a file
            </Button>
          </Tip>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewRun(true)}>
            New run
          </Button>
        </>
      }
    >
      {runs.isLoading ? (
        <Loading />
      ) : runs.error ? (
        <ErrorBox error={runs.error} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Play />}
          title="No runs yet"
          action={
            <div className="flex gap-2">
              <Button icon={<FileUp className="size-4" />} onClick={() => setImporting(true)}>
                Score outputs from a file
              </Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewRun(true)}>
                Start a run
              </Button>
            </div>
          }
        >
          Pick a dataset, the target to test and a suite of checks. Or import outputs you produced elsewhere.
        </EmptyState>
      ) : (
        <SimpleTable
          rows={list}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          columns={[
            { key: 'n', header: '#', width: '56px', render: (r) => <span className="tabular-nums text-ink-muted">{r.number}</span> },
            {
              key: 'name',
              header: 'Run',
              width: 'minmax(220px, 2fr)',
              render: (r) => (
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    {r.kind === 'imported' && <Badge tone="info">Imported</Badge>}
                  </div>
                  <div className="truncate text-[0.78125rem] text-ink-muted">
                    {[names.dataset.get(r.datasetId ?? ''), r.kind === 'imported' ? 'imported outputs' : names.target.get(r.targetId ?? ''), names.suite.get(r.suiteId ?? '')].map((x) => x ?? '—').join(' · ')}
                  </div>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: '170px',
              render: (r) =>
                isLive(r.status) ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={r.status} />
                      <span className="text-[0.75rem] tabular-nums text-ink-faint">
                        {r.done}/{r.total}
                      </span>
                    </div>
                    <Progress value={r.total ? r.done / r.total : 0} />
                  </div>
                ) : (
                  <StatusBadge status={r.status} />
                ),
            },
            { key: 'pass', header: 'Pass rate', width: '170px', render: (r) => <PassRateCell s={r.summary} /> },
            { key: 'created', header: 'Started', width: '110px', render: (r) => <span className="text-ink-muted">{timeAgo(r.createdAt)}</span> },
            { key: 'by', header: 'By', width: '100px', render: (r) => <span className="truncate text-ink-muted">{actorLabel(r.createdBy)}</span> },
          ]}
        />
      )}
      {newRun && <NewRunDialog open={newRun} onOpenChange={setNewRun} />}
      {importing && <ImportOutputsDialog open={importing} onOpenChange={setImporting} />}
    </Page>
  );
}

/* ── Run detail ───────────────────────────────────────────────────────────── */

const PAGE = 500;

function CheckPills({ checks }: { checks: ResultLite['checks'] }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {[...checks].sort((a, b) => a.layer - b.layer).map((c) => (
        <Tip key={c.id} content={<span><b>{c.name}</b>: {c.status}{c.reason ? ` — ${c.reason}` : ''}</span>}>
          <span
            className={clsx(
              'inline-block size-2.5 rounded-full',
              c.status === 'pass' && 'bg-ok',
              c.status === 'fail' && 'bg-bad',
              c.status === 'error' && 'bg-warn',
              c.status === 'skip' && 'bg-line-strong',
            )}
          />
        </Tip>
      ))}
    </div>
  );
}

export function RunDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'all' | 'passed' | 'failed' | 'errors'>('all');
  const [checkId, setCheckId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'seq' | 'score' | 'latency'>('seq');
  const [pages, setPages] = useState(1);
  const [openResult, setOpenResult] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPages(1), [filter, checkId, debounced, sort]);

  const run = useOp<Run>('get_run', { runId: id }, { refetchInterval: (q: any) => ((q.state.data as Run | undefined)?.active || isLive((q.state.data as Run | undefined)?.status ?? '') ? 1000 : false) } as any);
  const r = run.data;
  const active = !!r && (r.active || isLive(r.status));

  const query = { runId: id, filter, checkId: checkId ?? undefined, search: debounced || undefined, sort };
  const results = useQuery({
    queryKey: ['query_results', query, pages],
    queryFn: async () => {
      let rows: ResultLite[] = [];
      let total = 0;
      for (let p = 0; p < pages; p++) {
        const res = await op<{ total: number; results: ResultLite[] }>('query_results', { ...query, offset: p * PAGE, limit: PAGE });
        rows = rows.concat(res.results);
        total = res.total;
        if (res.results.length < PAGE) break;
      }
      return { rows, total };
    },
    refetchInterval: active ? 2000 : false,
    placeholderData: (prev) => prev,
  });

  const otherRuns = useOp<{ runs: Run[] }>('list_runs', { dataset: r?.datasetId ?? undefined, limit: 50 }, { enabled: !!r?.datasetId });

  if (run.isLoading) return <Loading />;
  if (run.error || !r) return <Page title="Run" back={<BackLink to="/runs">Runs</BackLink>}><ErrorBox error={run.error ?? 'Run not found'} /></Page>;

  const s = r.summary ?? {};
  const latency = s.metrics?.latency_ms;
  const corpus = (s.checks ?? []).filter((c) => c.corpus);
  const judged = (s.passed ?? 0) + (s.failed ?? 0);
  const checkName = (cid: string) => s.checks?.find((c) => c.id === cid)?.name ?? cid;
  const compareTargets = (otherRuns.data?.runs ?? []).filter((x) => x.id !== r.id);

  const act = async (name: string, msg: string) => {
    try {
      await op(name, { runId: r.id });
      toast.success(msg);
      run.refetch();
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    if (!(await confirm.ask(`Delete ${r.name}?`, 'The run and its results move to the trash.'))) return;
    try {
      await op('delete_run', { runId: r.id });
      toast.success('Run deleted');
      navigate('/runs');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Page
      width="wide"
      back={<BackLink to="/runs">Runs</BackLink>}
      title={r.name}
      badge={
        <>
          <StatusBadge status={r.status} />
          {r.name !== `Run #${r.number}` && <span className="text-[0.8125rem] tabular-nums text-ink-faint">#{r.number}</span>}
          {r.kind === 'imported' && <Badge tone="info">Imported outputs</Badge>}
        </>
      }
      description={
        <span>
          {r.datasetName ?? 'dataset'} · {r.kind === 'imported' ? 'imported outputs' : r.targetName ?? 'target'} · {r.suiteName ?? 'suite'} · started {timeAgo(r.createdAt)} by {actorLabel(r.createdBy)}
        </span>
      }
      actions={
        <>
          {active && (
            <Button icon={<Pause className="size-4" />} onClick={() => act('cancel_run', 'Cancelling run…')}>
              Cancel
            </Button>
          )}
          {!active && (r.status === 'cancelled' || r.status === 'interrupted' || r.status === 'failed') && (
            <Tip content="Continue with the rows that have not finished yet">
              <Button icon={<RotateCcw className="size-4" />} onClick={() => act('resume_run', 'Run resumed')}>
                Resume
              </Button>
            </Tip>
          )}
          <Tip content="Label results yourself and see how well each check (e.g. an LLM judge) agrees with you">
            <Button icon={<Scale className="size-4" />} onClick={() => navigate(`/runs/${r.id}/calibrate`)} disabled={!(s.checks ?? []).length}>
              Review & calibrate
            </Button>
          </Tip>
          <Menu
            trigger={
              <Button icon={<GitCompare className="size-4" />} disabled={compareTargets.length === 0}>
                Compare with…
              </Button>
            }
          >
            {compareTargets.map((x) => (
              <MenuItem key={x.id} onSelect={() => navigate(`/runs/${r.id}/compare?base=${x.id}`)} hint={`${pct(x.summary?.passRate)} pass · ${timeAgo(x.createdAt)}`}>
                #{x.number} {x.name}
              </MenuItem>
            ))}
          </Menu>
          <Tip content="Delete this run">
            <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete run">
              <Trash2 className="size-4" />
            </Button>
          </Tip>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {active && (
          <Card>
            <div className="mb-2 flex items-center justify-between text-[0.8125rem]">
              <span className="font-medium">Running…</span>
              <span className="tabular-nums text-ink-muted">
                {r.done} of {r.total} rows
              </span>
            </div>
            <Progress value={r.total ? r.done / r.total : 0} />
          </Card>
        )}
        {r.error && <ErrorBox error={{ message: `Run failed: ${r.error}` }} />}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          <Stat
            label="Pass rate"
            value={pct(s.passRate)}
            tone={s.passRate == null ? undefined : s.passRate >= 0.9 ? 'ok' : s.passRate < 0.6 ? 'bad' : 'warn'}
            sub={s.passRateCi ? `95% CI ${pct(s.passRateCi[0], 0)}–${pct(s.passRateCi[1], 0)} · ${s.passed}/${judged}` : judged ? `${s.passed}/${judged}` : undefined}
            help="Share of rows where every check passed (or the weighted rule was met). The 95% interval shows how much this could move by chance with this many rows; small datasets give wide intervals."
          />
          <Stat label="Completed" value={`${r.done}/${r.total}`} sub={r.total ? pct(r.done / r.total, 0) : undefined} help="Rows (× repetitions) that finished, out of all rows in this run." />
          <Stat
            label="Target errors"
            value={s.targetErrors ?? 0}
            tone={(s.targetErrors ?? 0) > 0 ? 'bad' : undefined}
            help="Rows where calling the target failed outright (connection error, timeout, no output). These usually fail the transport checks."
          />
          <Stat label="Mean score" value={s.meanScore == null ? '–' : s.meanScore.toFixed(2)} help="Average weighted check score per row, from 0 to 1. Useful when rows partly pass." />
          <Stat label="Latency p50 / p95" value={latency ? `${ms(latency.p50)}` : '–'} sub={latency ? `p95 ${ms(latency.p95)} · max ${ms(latency.max)}` : undefined} help="Median and 95th-percentile total time per call. p95 means 95% of calls were at least this fast." />
          {corpus.map((c) => (
            <Stat
              key={c.id}
              label={`Corpus ${c.corpus!.metric.toUpperCase()}`}
              value={pct(c.corpus!.value)}
              sub={`${c.corpus!.errors} errors / ${c.corpus!.refUnits} reference ${c.corpus!.metric === 'cer' ? 'chars' : 'words'}`}
              help="Total errors across all rows divided by total reference words. More reliable than averaging per-row rates, which over-weights short clips."
            />
          ))}
        </div>

        <Card padded={false}>
          <div className="px-5 pt-4">
            <SectionTitle help="Click a check to list only the rows where it failed.">Checks</SectionTitle>
          </div>
          {(s.checks ?? []).length === 0 ? (
            <div className="px-5 pb-5 text-[0.8125rem] text-ink-muted">{active ? 'Waiting for the first results…' : 'No check results.'}</div>
          ) : (
            <div className="px-5 pb-5">
              <SimpleTable
                rows={s.checks ?? []}
                rowKey={(c) => c.id}
                onRowClick={(c) => {
                  setCheckId(c.id);
                  setFilter('all');
                }}
                columns={[
                  {
                    key: 'name',
                    header: 'Check',
                    width: 'minmax(180px, 2.2fr)',
                    render: (c) => (
                      <div className="min-w-0">
                        <div className="truncate font-medium">{c.name}</div>
                        <div className="truncate font-mono text-[0.71875rem] text-ink-faint">{c.type}</div>
                      </div>
                    ),
                  },
                  { key: 'layer', header: 'Layer', width: '52px', render: (c) => <span className="tabular-nums text-ink-muted">{c.layer}</span> },
                  { key: 'bar', header: 'Outcome', width: 'minmax(90px, 1fr)', help: 'Green passed, red failed, amber errored, grey skipped. Hover a segment for the count.', render: (c) => <OutcomeBar pass={c.pass} fail={c.fail} error={c.error} skip={c.skip} /> },
                  { key: 'rate', header: 'Pass', width: '70px', align: 'right', render: (c) => <span className="tabular-nums">{pct(c.passRate)}</span> },
                  {
                    key: 'counts',
                    header: 'Failed',
                    width: '64px',
                    align: 'right',
                    help: 'Rows where this check failed or errored. Skipped rows are not counted.',
                    render: (c) => <span className={c.fail + c.error > 0 ? 'tabular-nums text-bad' : 'tabular-nums text-ink-muted'}>{c.fail + c.error}</span>,
                  },
                  { key: 'mean', header: 'Mean', width: '78px', align: 'right', help: 'Average raw value, e.g. per-row WER or latency.', render: (c) => <span className="tabular-nums">{formatMetric(c.type, c.meanValue)}</span> },
                  {
                    key: 'corpus',
                    header: 'Corpus',
                    width: '74px',
                    align: 'right',
                    help: 'For WER/CER checks: total errors ÷ total reference words across all rows.',
                    render: (c) => <span className="tabular-nums">{c.corpus ? pct(c.corpus.value) : '–'}</span>,
                  },
                  {
                    key: 'calibrate',
                    header: '',
                    width: '48px',
                    align: 'right',
                    render: (c) => (
                      <Tip content="Label rows yourself and measure how often this check agrees with you">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Calibrate this check"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/runs/${r.id}/calibrate?check=${encodeURIComponent(c.id)}`);
                          }}
                        >
                          <Scale className="size-3.5" />
                        </Button>
                      </Tip>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Card>

        {(s.completed ?? 0) > 0 && (
          <BreakdownCard
            runId={r.id}
            datasetId={r.datasetId}
            checks={(s.checks ?? []).map((c) => ({ id: c.id, name: c.name }))}
            onFilter={(value) => {
              setCheckId(null);
              setFilter('all');
              setSearch(value);
              document.getElementById('run-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          />
        )}

        {s.metrics && Object.keys(s.metrics).length > 0 && (
          <Card padded={false}>
            <div className="px-5 pt-4">
              <SectionTitle help="Every number the target reported per row (latency, time to first partial, real-time factor, tokens…), summarized across the run.">Metrics</SectionTitle>
            </div>
            <div className="px-5 pb-5">
              <SimpleTable
                rows={Object.entries(s.metrics).map(([key, v]) => ({ key, ...v }))}
                rowKey={(m) => m.key}
                columns={[
                  { key: 'k', header: 'Metric', width: 'minmax(180px, 2fr)', render: (m) => <span className="font-mono text-[0.78125rem]">{m.key}</span> },
                  { key: 'count', header: 'Count', width: '80px', align: 'right', render: (m) => <span className="tabular-nums text-ink-muted">{m.count}</span> },
                  ...(['mean', 'p50', 'p95', 'p99', 'max'] as const).map((f) => ({
                    key: f,
                    header: f,
                    width: '100px',
                    align: 'right' as const,
                    render: (m: any) => <span className="tabular-nums">{formatMetricKey(m.key, m[f])}</span>,
                  })),
                ]}
              />
            </div>
          </Card>
        )}

        <section id="run-results" className="scroll-mt-4">
          <SectionTitle help="Every row of the run. Click a row for its inputs, outputs, each check's reasoning, the raw request/response and logs.">Results</SectionTitle>
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: s.completed ?? r.done },
                { value: 'passed', label: 'Passed', count: s.passed ?? 0 },
                { value: 'failed', label: 'Failed', count: s.failed ?? 0 },
                { value: 'errors', label: 'Errors', count: s.targetErrors ?? 0 },
              ]}
            />
            {checkId && (
              <Badge tone="accent" className="h-7 gap-1 pr-1">
                Failing: {checkName(checkId)}
                <button type="button" onClick={() => setCheckId(null)} className="rounded p-0.5 hover:bg-accent/20" aria-label="Clear check filter">
                  <X className="size-3" />
                </button>
              </Badge>
            )}
            <div className="relative ml-auto w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
              <Input value={search} placeholder="Search inputs and outputs…" onChange={(e) => setSearch(e.target.value)} className="pl-8" />
            </div>
            <div className="w-44">
              <Select
                value={sort}
                onChange={(v) => setSort(v as any)}
                options={[
                  { value: 'seq', label: 'Dataset order' },
                  { value: 'score', label: 'Lowest score first' },
                  { value: 'latency', label: 'Slowest first' },
                ]}
              />
            </div>
          </div>
          <DataTable
            rows={results.data?.rows ?? []}
            rowKey={(x) => x.id}
            activeKey={openResult}
            onRowClick={(x) => setOpenResult(x.id)}
            rowHeight={52}
            empty={results.isLoading ? 'Loading…' : active ? 'Results appear here as rows finish.' : 'No rows match these filters.'}
            footer={
              results.data && (
                <div className="flex items-center justify-between">
                  <span>
                    Showing {results.data.rows.length} of {results.data.total}
                  </span>
                  {results.data.rows.length < results.data.total && (
                    <Button size="sm" onClick={() => setPages(pages + 1)} loading={results.isFetching}>
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
              { key: 'input', header: 'Input', width: 'minmax(170px, 1.5fr)', render: (x) => <CellValue value={firstPreviewValue(x.input)} /> },
              {
                key: 'output',
                header: 'Output',
                width: 'minmax(200px, 2fr)',
                render: (x) =>
                  x.error && x.outputs?.output === undefined ? (
                    <span className="line-clamp-2 text-bad">{x.error}</span>
                  ) : (
                    <span className="line-clamp-2">{preview(x.outputs?.output, 200) || <span className="text-ink-faint">—</span>}</span>
                  ),
              },
              { key: 'checks', header: 'Checks', width: '116px', help: 'One dot per check, in layer order. Hover a dot for its result.', render: (x) => <CheckPills checks={x.checks} /> },
              { key: 'score', header: 'Score', width: '64px', align: 'right', render: (x) => <span className="tabular-nums">{x.score == null ? '–' : x.score.toFixed(2)}</span> },
              { key: 'latency', header: 'Latency', width: '84px', align: 'right', render: (x) => <span className="tabular-nums text-ink-muted">{ms(x.metrics?.latency_ms)}</span> },
              {
                key: 'status',
                header: 'Result',
                width: '96px',
                render: (x) => <StatusBadge status={x.status === 'pending' || x.status === 'running' ? x.status : x.passed === null ? x.status : x.passed ? 'pass' : 'fail'} />,
              },
            ]}
          />
        </section>
      </div>
      <ResultSheet resultId={openResult} onClose={() => setOpenResult(null)} />
      {confirm.element}
    </Page>
  );
}

/* ── Compare ──────────────────────────────────────────────────────────────── */

interface CompareRow {
  key: string;
  rowId: string;
  input: Record<string, unknown>;
  change: 'improved' | 'regressed' | 'same' | 'only_base' | 'only_new';
  base?: { resultId: string; passed: boolean | null; score: number | null; output: unknown; error: string | null; failing: string[] } | null;
  next?: { resultId: string; passed: boolean | null; score: number | null; output: unknown; error: string | null; failing: string[] } | null;
}

const CHANGE_TONE = { improved: 'ok', regressed: 'bad', same: 'neutral', only_base: 'warn', only_new: 'info' } as const;
const CHANGE_LABEL = { improved: 'Improved', regressed: 'Regressed', same: 'Same', only_base: 'Only in baseline', only_new: 'Only in new run' };

function PassMark({ v }: { v?: { passed: boolean | null } | null }) {
  if (!v) return <span className="text-ink-faint">—</span>;
  return <StatusBadge status={v.passed === null ? 'error' : v.passed ? 'pass' : 'fail'} />;
}

export function ComparePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const base = params.get('base') ?? '';
  const [view, setView] = useState<'regressed' | 'improved' | 'all'>('regressed');
  const [openResult, setOpenResult] = useState<string | null>(null);

  const run = useOp<Run>('get_run', { runId: id });
  const others = useOp<{ runs: Run[] }>('list_runs', { dataset: run.data?.datasetId ?? undefined, limit: 100 }, { enabled: !!run.data?.datasetId });
  const cmp = useOp<any>('compare_runs', { baseRunId: base, runId: id }, { enabled: !!base });

  const rows: CompareRow[] = cmp.data?.rows ?? [];
  const shown = view === 'all' ? rows : rows.filter((x) => x.change === view);
  const p = cmp.data?.passFlips?.pValue as number | null | undefined;

  return (
    <Page
      width="wide"
      back={<BackLink to={`/runs/${id}`}>{run.data?.name ?? 'Run'}</BackLink>}
      title="Compare runs"
      description="Rows are matched by dataset row (and repetition). See what got better, what got worse, and whether the difference is likely real."
      actions={
        <div className="w-72">
          <Select
            value={base || undefined}
            onChange={(v) => setParams({ base: v })}
            placeholder="Choose a baseline run"
            options={(others.data?.runs ?? []).filter((x) => x.id !== id).map((x) => ({ value: x.id, label: `#${x.number} ${x.name}`, hint: `${pct(x.summary?.passRate)} pass · ${timeAgo(x.createdAt)}` }))}
          />
        </div>
      }
    >
      {!base ? (
        <EmptyState icon={<GitCompare />} title="Choose a baseline">
          Pick an earlier run on the same dataset to compare against {run.data ? `“${run.data.name}”` : 'this run'}.
        </EmptyState>
      ) : cmp.isLoading ? (
        <Loading label="Comparing…" />
      ) : cmp.error ? (
        <ErrorBox error={cmp.error} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2 text-[0.84375rem]">
            <Badge>Baseline</Badge>
            <span className="font-medium">#{cmp.data.base.number} {cmp.data.base.name}</span>
            <span className="text-ink-muted">({pct(cmp.data.base.passRate)})</span>
            <span className="text-ink-faint">→</span>
            <Badge tone="accent">New</Badge>
            <span className="font-medium">#{cmp.data.next.number} {cmp.data.next.name}</span>
            <span className="text-ink-muted">({pct(cmp.data.next.passRate)})</span>
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
            <Stat label="Improved" value={cmp.data.counts.improved} tone={cmp.data.counts.improved ? 'ok' : undefined} help="Rows that now pass but failed before, or whose score went up." />
            <Stat label="Regressed" value={cmp.data.counts.regressed} tone={cmp.data.counts.regressed ? 'bad' : undefined} help="Rows that now fail but passed before, or whose score went down." />
            <Stat label="Unchanged" value={cmp.data.counts.same} />
            <Stat label="Only in one run" value={cmp.data.counts.onlyBase + cmp.data.counts.onlyNew} sub={`${cmp.data.counts.onlyBase} baseline · ${cmp.data.counts.onlyNew} new`} help="Rows that were added to or removed from the dataset between the runs, or filtered differently." />
          </div>

          <Card>
            <div className="flex flex-wrap items-center gap-2 text-[0.84375rem]">
              <span className="font-medium">
                {p == null ? 'No rows flipped between pass and fail.' : p < 0.05 ? `Likely a real change (p = ${p.toFixed(3)}).` : `Could be noise (p = ${p.toFixed(2)}).`}
              </span>
              <span className="text-ink-muted">
                {cmp.data.passFlips.failToPass} rows went fail → pass, {cmp.data.passFlips.passToFail} went pass → fail.
              </span>
              <HelpTip>Exact McNemar test on rows that flipped between pass and fail. p below 0.05 means a difference this large would rarely happen by chance alone. With few flips, collect more rows before drawing conclusions.</HelpTip>
            </div>
          </Card>

          {(cmp.data.checks ?? []).length > 0 && (
            <Card padded={false}>
              <div className="px-5 pt-4">
                <SectionTitle>Checks</SectionTitle>
              </div>
              <div className="px-5 pb-5">
                <SimpleTable
                  rows={cmp.data.checks}
                  rowKey={(c: any) => c.id}
                  columns={[
                    { key: 'name', header: 'Check', width: 'minmax(200px, 2fr)', render: (c: any) => <span className="font-medium">{c.name}</span> },
                    { key: 'base', header: 'Baseline', width: '110px', align: 'right', render: (c: any) => <span className="tabular-nums">{pct(c.base)}</span> },
                    { key: 'next', header: 'New', width: '110px', align: 'right', render: (c: any) => <span className="tabular-nums">{pct(c.next)}</span> },
                    {
                      key: 'delta',
                      header: 'Change',
                      width: '110px',
                      align: 'right',
                      render: (c: any) =>
                        c.delta == null ? (
                          <span className="text-ink-faint">–</span>
                        ) : (
                          <span className={clsx('font-medium tabular-nums', c.delta > 0 && 'text-ok', c.delta < 0 && 'text-bad')}>
                            {c.delta > 0 ? '+' : ''}
                            {(c.delta * 100).toFixed(1)} pts
                          </span>
                        ),
                    },
                    {
                      key: 'corpus',
                      header: 'Corpus metric',
                      width: '170px',
                      align: 'right',
                      help: 'For WER/CER checks: corpus error rate in the baseline → new run. Lower is better.',
                      render: (c: any) =>
                        c.corpusBase == null && c.corpusNext == null ? (
                          <span className="text-ink-faint">–</span>
                        ) : (
                          <span className="tabular-nums">
                            {pct(c.corpusBase)} → <span className={clsx(c.corpusNext != null && c.corpusBase != null && (c.corpusNext < c.corpusBase ? 'text-ok' : c.corpusNext > c.corpusBase ? 'text-bad' : ''))}>{pct(c.corpusNext)}</span>
                          </span>
                        ),
                    },
                  ]}
                />
              </div>
            </Card>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <SectionTitle className="mb-0">Rows</SectionTitle>
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'regressed', label: 'Regressed', count: cmp.data.counts.regressed },
                  { value: 'improved', label: 'Improved', count: cmp.data.counts.improved },
                  { value: 'all', label: 'All', count: rows.length },
                ]}
              />
            </div>
            <DataTable
              rows={shown}
              rowKey={(x) => x.key}
              activeKey={null}
              onRowClick={(x) => x.next?.resultId && setOpenResult(x.next.resultId)}
              rowHeight={56}
              height="calc(100vh - 260px)"
              empty={view === 'regressed' ? 'No regressions. Nothing got worse.' : view === 'improved' ? 'No improvements.' : 'No rows.'}
              columns={[
                { key: 'change', header: 'Change', width: '130px', render: (x) => <Badge tone={CHANGE_TONE[x.change]} dot>{CHANGE_LABEL[x.change]}</Badge> },
                { key: 'input', header: 'Input', width: 'minmax(200px, 2fr)', render: (x) => <CellValue value={firstPreviewValue(x.input)} /> },
                { key: 'bout', header: 'Baseline output', width: 'minmax(200px, 2fr)', render: (x) => <span className="line-clamp-2 text-ink-muted">{x.base ? preview(x.base.output, 200) || x.base.error || '—' : '—'}</span> },
                { key: 'nout', header: 'New output', width: 'minmax(200px, 2fr)', render: (x) => <span className="line-clamp-2">{x.next ? preview(x.next.output, 200) || x.next.error || '—' : '—'}</span> },
                {
                  key: 'pass',
                  header: 'Base → new',
                  width: '170px',
                  render: (x) => (
                    <div className="flex items-center gap-1.5">
                      <PassMark v={x.base} />
                      <span className="text-ink-faint">→</span>
                      <PassMark v={x.next} />
                    </div>
                  ),
                },
                {
                  key: 'failing',
                  header: 'Failing now',
                  width: 'minmax(160px, 1.2fr)',
                  render: (x) => <span className="line-clamp-2 text-[0.78125rem] text-bad">{x.next?.failing?.join(', ') || <span className="text-ink-faint">—</span>}</span>,
                },
              ]}
            />
          </section>
        </div>
      )}
      <ResultSheet resultId={openResult} onClose={() => setOpenResult(null)} />
    </Page>
  );
}
