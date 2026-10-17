import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, DatabaseZap, Network, Plug, RefreshCw, Search, Trash2, Waves } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { Button, buttonClass } from '../components/ui/button';
import { Badge, EmptyState, ErrorBox, Loading } from '../components/ui/display';
import { Input, Select } from '../components/ui/form';
import { Tip, useConfirm } from '../components/ui/overlay';
import { DataTable } from '../components/ui/table';
import { toast, toastError } from '../components/ui/toast';
import { SOURCE_LABEL, TraceSheet } from '../components/traces/trace-sheet';
import { AddToDatasetDialog } from '../components/traces/to-dataset-dialog';
import { isMissingOp, normalizeTracePage, type Trace } from '../components/traces/types';
import { op, useProjectId } from '../lib/api';
import { Link, useNavigate } from '../lib/nav';
import { useCanEdit } from '../lib/session';
import { ms, preview, timeAgo } from '../lib/format';

/*
 * Traces: what really happened inside the user's app. Calls arrive from the SDK, OpenTelemetry or
 * the OpenAI proxy (see Connect your app). Here they can be searched and filtered, opened step by
 * step, and turned into dataset rows, so real traffic becomes test cases.
 */

const PAGE = 100;

const RANGES = [
  { value: '1h', label: 'Last hour', ms: 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { value: 'all', label: 'Any time', ms: 0 },
];

const ANY = 'any';

export function TracesPage() {
  const { id: routeTraceId } = useParams();
  const navigate = useNavigate();
  const project = useProjectId();
  const qc = useQueryClient();
  const canEdit = useCanEdit();
  const confirm = useConfirm();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState(ANY);
  const [source, setSource] = useState(ANY);
  const [name, setName] = useState(ANY);
  const [range, setRange] = useState('7d');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toDataset, setToDataset] = useState<string[] | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(routeTraceId ?? null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  // A deep link (/traces/<id>) opens that trace.
  useEffect(() => setOpenTrace(routeTraceId ?? null), [routeTraceId]);

  // "Since" is fixed when the filter changes (not on every render), so the query key stays stable.
  const since = useMemo(() => {
    const r = RANGES.find((x) => x.value === range);
    return r?.ms ? new Date(Date.now() - r.ms).toISOString() : undefined;
  }, [range]);

  const filters = {
    search: debounced || undefined,
    status: status === ANY ? undefined : status,
    source: source === ANY ? undefined : source,
    name: name === ANY ? undefined : name,
    since,
  };
  const traces = useInfiniteQuery({
    queryKey: ['list_traces', filters, { project }],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => normalizeTracePage(await op('list_traces', { ...filters, limit: PAGE, offset: pageParam }, project)),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.traces.length, 0);
      return last.traces.length === PAGE && loaded < last.total ? loaded : undefined;
    },
  });
  const rows = useMemo(() => traces.data?.pages.flatMap((p) => p.traces) ?? [], [traces.data]);
  const total = traces.data?.pages[0]?.total ?? 0;
  // Names seen so far (filtering by one name must not hide the others from this list).
  const [seenNames, setSeenNames] = useState<string[]>([]);
  useEffect(() => setSeenNames([]), [project]);
  useEffect(() => setSeenNames((cur) => (rows.every((t) => cur.includes(t.name)) ? cur : [...new Set([...cur, ...rows.map((t) => t.name)])].sort())), [rows]);
  const names = seenNames;
  // Forget selections that are no longer listed (after filtering or deleting).
  useEffect(() => setSelected((cur) => new Set([...cur].filter((id) => rows.some((r) => r.id === id)))), [rows]);

  const filtered = !!(debounced || status !== ANY || source !== ANY || name !== ANY || range !== '7d');
  const close = () => {
    setOpenTrace(null);
    if (routeTraceId) navigate('/traces', { replace: true });
  };

  const remove = async (ids: string[]) => {
    if (!(await confirm.ask(`Delete ${ids.length} trace${ids.length === 1 ? '' : 's'}?`, 'They are removed for good. Dataset rows made from them stay.'))) return;
    try {
      await op('delete_traces', { ids });
      toast.success(`${ids.length} trace${ids.length === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['list_traces'] });
    } catch (e) {
      toastError(e, 'Could not delete');
    }
  };

  const missing = isMissingOp(traces.error);

  return (
    <Page
      title="Traces"
      description="Real calls inside your app: each model call, tool call and retrieval, sent by the Kalibra SDK, OpenTelemetry or the OpenAI proxy. Turn interesting ones into test rows."
      actions={
        <>
          <Tip content="Reload the list">
            <Button variant="ghost" size="icon" aria-label="Reload traces" onClick={() => traces.refetch()}>
              <RefreshCw className="size-4" />
            </Button>
          </Tip>
          <Link to="/connect" className={buttonClass('primary')}>
            <Plug className="size-4" />
            Connect your app
          </Link>
        </>
      }
      width="wide"
    >
      {traces.isLoading ? (
        <Loading />
      ) : missing ? (
        <EmptyState icon={<Waves />} title="Traces are not available yet">
          This Kalibra engine does not record traces. Update Kalibra to use the SDK, OpenTelemetry and the OpenAI proxy.
        </EmptyState>
      ) : traces.error ? (
        <ErrorBox error={traces.error} />
      ) : rows.length === 0 && !filtered ? (
        <NoTracesYet />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
              <Input className="pl-8" value={search} placeholder="Search inputs, outputs and errors" onChange={(e) => setSearch(e.target.value)} aria-label="Search traces" />
            </div>
            <Select className="w-40" value={name} onChange={setName} aria-label="Trace name" options={[{ value: ANY, label: 'Any name' }, ...names.map((n) => ({ value: n, label: n }))]} />
            <Select
              className="w-32"
              value={status}
              onChange={setStatus}
              aria-label="Status"
              options={[
                { value: ANY, label: 'Any status' },
                { value: 'ok', label: 'OK' },
                { value: 'error', label: 'Errors' },
              ]}
            />
            <Select
              className="w-40"
              value={source}
              onChange={setSource}
              aria-label="Source"
              options={[{ value: ANY, label: 'Any source' }, ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))]}
            />
            <Select className="w-40" value={range} onChange={setRange} aria-label="Time range" options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
          </div>

          {selected.size > 0 && canEdit && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft/30 px-3 py-2 text-[0.8125rem]">
              <span className="font-medium">{selected.size} selected</span>
              <span className="ml-auto" />
              <Button size="sm" icon={<DatabaseZap className="size-3.5" />} onClick={() => setToDataset([...selected])}>
                Add to dataset
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => remove([...selected])}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          <DataTable<Trace>
            rows={rows}
            rowKey={(t) => t.id}
            onRowClick={(t) => setOpenTrace(t.id)}
            activeKey={openTrace}
            selected={canEdit ? selected : undefined}
            onToggleSelect={
              canEdit
                ? (id) =>
                    setSelected((cur) => {
                      const next = new Set(cur);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                : undefined
            }
            onToggleAll={() => setSelected((cur) => (rows.every((r) => cur.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))))}
            empty="No traces match these filters."
            rowHeight={52}
            footer={
              <div className="flex items-center justify-between gap-3">
                <span>
                  {rows.length} of {total} trace{total === 1 ? '' : 's'}
                </span>
                {traces.hasNextPage && (
                  <Button size="sm" loading={traces.isFetchingNextPage} onClick={() => traces.fetchNextPage()}>
                    Load more
                  </Button>
                )}
              </div>
            }
            columns={[
              {
                key: 'name',
                header: 'Trace',
                width: 'minmax(180px, 2.4fr)',
                render: (t) => (
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{t.name}</span>
                      {(t.tags ?? []).slice(0, 2).map((tag) => (
                        <Badge key={tag}>{tag}</Badge>
                      ))}
                    </div>
                    <div className="truncate text-[0.75rem] text-ink-faint">{t.error ? <span className="text-bad">{t.error}</span> : (t.inputPreview ?? preview(t.input, 110)) || '—'}</div>
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '90px',
                render: (t) => (
                  <Badge tone={t.status === 'error' ? 'bad' : 'ok'} dot>
                    {t.status === 'error' ? 'Error' : 'OK'}
                  </Badge>
                ),
              },
              { key: 'duration', header: 'Duration', width: '84px', align: 'right', render: (t) => <span className="tabular-nums text-ink-muted">{ms(t.durationMs)}</span> },
              {
                key: 'steps',
                header: 'Steps',
                width: '70px',
                align: 'right',
                help: 'How many steps (model calls, tool calls, retrievals) were recorded inside the call.',
                render: (t) => <span className="tabular-nums text-ink-muted">{t.spanCount ?? t.spans?.length ?? '—'}</span>,
              },
              { key: 'source', header: 'Source', width: '96px', render: (t) => <span className="text-ink-muted">{SOURCE_LABEL[t.source] ?? t.source}</span> },
              {
                key: 'env',
                header: 'Environment',
                width: 'minmax(120px, 0.8fr)',
                help: 'From the environment and release your app passes to the SDK.',
                render: (t) => {
                  const m = (t.metadata ?? {}) as Record<string, unknown>;
                  const parts = [m.environment, m.release].filter((x) => x !== undefined && x !== null && x !== '').map(String);
                  return parts.length ? <span className="truncate text-ink-muted">{parts.join(' · ')}</span> : <span className="text-ink-faint">—</span>;
                },
              },
              {
                key: 'run',
                header: 'Run',
                width: '72px',
                align: 'center',
                help: 'Calls made by an eval run link back to the run row they belong to.',
                render: (t) =>
                  t.runId ? (
                    <Tip content="Came from an eval run: open the row">
                      <Link
                        to={`/runs/${t.runId}${t.resultId ? `?result=${encodeURIComponent(t.resultId)}` : ''}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex text-accent-ink hover:text-accent"
                        aria-label="Open the run row"
                      >
                        <Network className="size-4" />
                      </Link>
                    </Tip>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  ),
              },
              { key: 'time', header: 'Time', width: '110px', render: (t) => <span className="text-ink-muted">{timeAgo(t.startedAt)}</span> },
            ]}
          />
        </div>
      )}
      <TraceSheet traceId={openTrace} onClose={close} onAddToDataset={(ids) => setToDataset(ids)} />
      {toDataset && <AddToDatasetDialog open={!!toDataset} onOpenChange={(o) => !o && setToDataset(null)} traceIds={toDataset} onDone={() => setSelected(new Set())} />}
      {confirm.element}
    </Page>
  );
}

/** First visit: the three ways traces get here, and the button to set one up. */
function NoTracesYet() {
  const ways = [
    { icon: Code2, title: 'Kalibra SDK', text: 'Two lines in your JS or Python app record each call and the steps inside it. Off in production unless you turn it on.' },
    { icon: Network, title: 'OpenTelemetry', text: 'Already using LangChain, LlamaIndex, the Vercel AI SDK or OpenAI Agents? Point their exporter here; no code changes.' },
    { icon: Plug, title: 'OpenAI proxy', text: 'Change the base URL of your OpenAI client. Kalibra forwards each request and keeps a copy.' },
  ];
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface/50 px-6 py-12 text-center">
      <Waves className="mb-3 size-8 text-ink-faint" />
      <div className="text-[0.9375rem] font-semibold">No traces yet</div>
      <p className="mt-1 max-w-xl text-[0.84375rem] text-ink-muted">Traces show what your app really did: the prompt it sent, the documents it found, the tools it called. Three ways in:</p>
      <div className="mt-5 grid w-full max-w-3xl gap-3 text-left sm:grid-cols-3">
        {ways.map((w) => (
          <div key={w.title} className="rounded-lg border border-line bg-surface p-3.5">
            <w.icon className="mb-1.5 size-4 text-accent" />
            <div className="text-[0.84375rem] font-semibold">{w.title}</div>
            <div className="mt-0.5 text-[0.78125rem] text-ink-muted">{w.text}</div>
          </div>
        ))}
      </div>
      <Link to="/connect" className={buttonClass('primary', 'md', 'mt-5')}>
        <Plug className="size-4" />
        Connect your app
      </Link>
    </div>
  );
}
