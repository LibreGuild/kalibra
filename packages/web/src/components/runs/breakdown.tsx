import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, Loading, Progress, SectionTitle } from '../ui/display';
import { Select } from '../ui/form';
import { Tip } from '../ui/overlay';
import { SimpleTable, type Column } from '../ui/table';
import { useOp } from '../../lib/api';
import { ms, pct } from '../../lib/format';

/* Where does a run fail? Split its results by tag, row status or any dataset column. */

interface Group {
  key: string;
  n: number;
  passed: number;
  failed: number;
  passRate: number | null;
  passRateCi: [number, number] | null;
  meanScore: number | null;
  checks: { id: string; name: string; type: string; passRate: number | null; corpus?: { metric: string; value: number; errors: number; refUnits: number } }[];
  latency: Record<string, { p50: number; p95: number; count: number }>;
}

interface Breakdown {
  overall: Group;
  groups: Group[];
  truncated: boolean;
  weakest: string | null;
  latencyKeys: string[];
  suggestBy: { by: 'tag' | 'column' | 'status'; column?: string };
  columns: string[];
  hasTags: boolean;
}

const SLICEABLE = new Set(['text', 'number', 'boolean', 'list']);

const encode = (s: { by: string; column?: string }) => (s.by === 'column' ? `column:${s.column}` : s.by);
const decode = (v: string) => (v.startsWith('column:') ? { by: 'column' as const, column: v.slice(7) } : { by: v as 'tag' | 'status' });

export function BreakdownCard({
  runId,
  datasetId,
  checks,
  onFilter,
}: {
  runId: string;
  datasetId: string | null;
  checks: { id: string; name: string }[];
  /** Narrows the results grid to a group (column splits only: matches the value in row inputs). */
  onFilter?: (value: string) => void;
}) {
  const [split, setSplit] = useState<string | null>(null);
  const [checkId, setCheckId] = useState('');
  const schema = useOp<any>('get_dataset_schema', { dataset: datasetId ?? '', sampleRows: 0 }, { enabled: !!datasetId });
  const q = useOp<Breakdown>('run_breakdown', { runId, ...decode(split ?? 'tag'), checkId: checkId || undefined }, { placeholderData: (prev: any) => prev } as any);

  // Adopt the engine's suggestion (e.g. "accent") the first time, unless the user already picked.
  useEffect(() => {
    if (split === null && q.data?.suggestBy) setSplit(encode(q.data.suggestBy));
  }, [q.data, split]);

  const current = decode(split ?? 'tag');
  const good = new Set(q.data?.columns ?? []);
  const columnOptions = ((schema.data?.columns ?? []) as { key: string; type: string }[])
    .filter((c) => SLICEABLE.has(c.type))
    .map((c) => ({ value: `column:${c.key}`, label: c.key, hint: good.has(c.key) ? 'Good split: a few distinct values' : undefined }));
  const splitOptions = [
    ...(q.data?.hasTags ? [{ value: 'tag', label: 'Tags', hint: 'A row with several tags counts in each' }] : []),
    { value: 'status', label: 'Row status', hint: 'Approved, needs review, …' },
    ...columnOptions,
  ];

  const corpusChecks = useMemo(() => (q.data?.overall.checks ?? []).filter((c) => c.corpus), [q.data]);
  const latencyKey = q.data?.latencyKeys.includes('latency_ms') ? 'latency_ms' : q.data?.latencyKeys[0];
  const clickable = current.by === 'column' && !!onFilter;

  const columns: Column<Group>[] = [
    {
      key: 'group',
      header: current.by === 'column' ? current.column : current.by === 'tag' ? 'Tag' : 'Status',
      width: 'minmax(180px, 2fr)',
      render: (g) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{g.key}</span>
          {g.key === q.data?.weakest && (
            <Tip content="Lowest pass rate among groups with at least 3 rows">
              <span>
                <Badge tone="bad">Weakest</Badge>
              </span>
            </Tip>
          )}
        </div>
      ),
    },
    { key: 'n', header: 'Rows', width: '70px', align: 'right', render: (g) => <span className="tabular-nums text-ink-muted">{g.n}</span> },
    {
      key: 'rate',
      header: checkId ? 'Check pass rate' : 'Pass rate',
      width: 'minmax(160px, 1.4fr)',
      help: 'Hover for the 95% interval. Small groups have wide intervals, so be careful comparing them.',
      render: (g) => (
        <Tip content={g.passRateCi ? `95% interval ${pct(g.passRateCi[0])} – ${pct(g.passRateCi[1])} · ${g.passed} passed, ${g.failed} failed` : 'Nothing judged yet'}>
          <div className="flex items-center gap-2.5">
            <span className="w-14 shrink-0 text-right tabular-nums">{pct(g.passRate)}</span>
            <Progress value={g.passRate ?? 0} tone={g.passRate == null ? 'accent' : g.passRate >= 0.8 ? 'ok' : g.passRate < 0.5 ? 'bad' : 'accent'} />
          </div>
        </Tip>
      ),
    },
    ...corpusChecks.map(
      (c): Column<Group> => ({
        key: `corpus-${c.id}`,
        header: `Corpus ${c.corpus!.metric.toUpperCase()}`,
        help: `${c.name}: total errors ÷ total reference units in this group.`,
        width: '120px',
        align: 'right',
        render: (g) => {
          const v = g.checks.find((x) => x.id === c.id)?.corpus;
          return <span className="tabular-nums">{v ? pct(v.value) : '–'}</span>;
        },
      }),
    ),
    ...(latencyKey
      ? [
          {
            key: 'lat',
            header: latencyKey === 'latency_ms' ? 'Latency p50' : `${latencyKey.replace(/_ms$/, '').replace(/_/g, ' ')} p50`,
            width: '120px',
            align: 'right' as const,
            render: (g: Group) => <span className="tabular-nums text-ink-muted">{ms(g.latency[latencyKey]?.p50)}</span>,
          },
        ]
      : []),
  ];

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <SectionTitle className="mb-0" help="Where does it fail? Split results by tag or any column, e.g. accent for speech-to-text, or category for a chatbot.">
          Breakdown
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-muted">Split by</span>
          <div className="w-44">
            <Select size="sm" value={split ?? undefined} onChange={setSplit} options={splitOptions} placeholder="Choose…" />
          </div>
          <span className="text-xs text-ink-muted">Judge by</span>
          <div className="w-48">
            <Select
              size="sm"
              value={checkId || 'row'}
              onChange={(v) => setCheckId(v === 'row' ? '' : v)}
              options={[{ value: 'row', label: 'Whole row' }, ...checks.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </div>
        </div>
      </div>
      <div className="px-5 pt-3 pb-5">
        {q.isLoading && !q.data ? (
          <Loading />
        ) : !q.data || q.data.groups.length === 0 ? (
          <div className="text-sm text-ink-muted">Nothing to split yet.</div>
        ) : q.data.groups.length < 2 ? (
          <div className="text-sm text-ink-muted">Every row falls into one group ({q.data.groups[0].key}). Try another split.</div>
        ) : (
          <>
            <SimpleTable rows={q.data.groups} rowKey={(g) => g.key} columns={columns} onRowClick={clickable ? (g) => onFilter!(g.key === '(empty)' ? '' : g.key) : undefined} />
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-ink-faint">
              <span>
                All rows: {pct(q.data.overall.passRate)} of {q.data.overall.n}
                {q.data.truncated && ' · showing the 50 largest groups'}
              </span>
              {clickable && <span>Click a group to filter the results below.</span>}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
