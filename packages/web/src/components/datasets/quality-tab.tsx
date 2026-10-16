import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Info, RefreshCw, Sparkles } from 'lucide-react';
import { Card, ErrorBox, Loading, SectionTitle } from '../ui/display';
import { Button } from '../ui/button';
import { HelpTip, Tip } from '../ui/overlay';
import { useOp } from '../../lib/api';
import { DuplicatesSection } from './quality/duplicates';
import { FillGapsDialog } from './quality/fill-gaps-dialog';
import { LocalModelStatus } from './quality/semantic-tools';
import type { ColumnQuality, QualityReport } from './quality/types';

/*
 * Dataset health at a glance: the few things worth fixing first, then coverage, duplicates and
 * variety. Advanced tools (the local embedding model) stay folded away until needed.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Chip({ label, value, tone, help }: { label: string; value: string | number; tone?: 'ok' | 'warn'; help?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
      <span className="text-[0.78125rem] text-ink-muted">{label}</span>
      <span className={clsx('text-[0.9375rem] font-semibold tabular-nums', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</span>
      {help && <HelpTip>{help}</HelpTip>}
    </div>
  );
}

function CoverageBars({ col, onFill }: { col: ColumnQuality; onFill: () => void }) {
  const values = col.topValues ?? [];
  const max = Math.max(1, ...values.map((v) => v.count));
  const shown = values.slice(0, 12);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[0.8125rem]">{col.key}</span>
        <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} onClick={onFill}>
          Fill gaps
        </Button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {shown.map((v) => (
          <li key={v.value} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_3.5rem] items-center gap-3 text-[0.78125rem]">
            <span className={clsx('truncate', v.count === 0 && 'text-ink-faint')} title={v.value}>
              {v.value}
            </span>
            <div className="h-2 overflow-hidden rounded-full bg-raised">
              <div className={clsx('h-full rounded-full', v.count === 0 ? 'bg-transparent' : v.share >= 0.8 ? 'bg-warn' : 'bg-accent')} style={{ width: `${(v.count / max) * 100}%` }} />
            </div>
            <span className="text-right tabular-nums text-ink-muted">{v.count === 0 ? 'none' : v.count}</span>
          </li>
        ))}
      </ul>
      {values.length > shown.length && <span className="text-[0.75rem] text-ink-faint">+{values.length - shown.length} more values</span>}
    </div>
  );
}

function Histogram({ bins }: { bins: { from: number; to: number; count: number }[] }) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div className="flex h-10 items-end gap-0.5">
      {bins.map((b, i) => (
        <Tip key={i} content={`${b.from}–${b.to} characters: ${b.count} row${b.count === 1 ? '' : 's'}`}>
          <div className="w-3 rounded-sm bg-accent/70" style={{ height: `${Math.max(6, (b.count / max) * 100)}%` }} />
        </Tip>
      ))}
    </div>
  );
}

function VarietyRow({ col }: { col: ColumnQuality }) {
  const d = col.diversity;
  const low = d && ((d.selfBleu ?? 0) >= 0.5 || d.distinct2 < 0.3 || d.compressionRatio >= 5);
  return (
    <div className="grid gap-3 border-b border-line/70 py-3 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)] sm:items-center">
      <div className="min-w-0">
        <div className="truncate font-mono text-[0.8125rem]">{col.key}</div>
        {low ? <div className="text-[0.75rem] text-warn">Similar phrasing</div> : <div className="text-[0.75rem] text-ink-faint">{d ? 'Varied' : `${col.filled} values`}</div>}
      </div>
      <div className="flex items-center gap-3">
        {col.length && <Histogram bins={col.length.histogram} />}
        {col.length && (
          <span className="text-[0.75rem] text-ink-muted tabular-nums">
            {col.length.min}–{col.length.max} chars, typically {col.length.median}
          </span>
        )}
      </div>
      {d ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.78125rem]">
          <Metric label="New word pairs" value={pct(d.distinct2)} help="Share of two-word sequences that appear only once across rows. Below about 30% means rows reuse the same phrases." />
          <Metric label="Overlap between rows" value={d.selfBleu === null ? '–' : pct(d.selfBleu)} help="How much each row looks like the others (self-BLEU on a sample). Above about 50% means rows are near-copies of a template." />
          <Metric label="Repetition" value={`${d.compressionRatio}×`} help="How much the text compresses. Natural writing is around 2–3×; 5× or more means lots of repeated wording." />
        </div>
      ) : (
        <span className="text-[0.78125rem] text-ink-faint">Variety is measured for text columns with at least two values.</span>
      )}
    </div>
  );
}

function Metric({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ink-muted">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
      <HelpTip>{help}</HelpTip>
    </span>
  );
}

export function QualityTab({ datasetId }: { datasetId: string; columns: { key: string; type: string }[] }) {
  const q = useOp<QualityReport>('dataset_quality', { dataset: datasetId }, { staleTime: 0 });
  const [fill, setFill] = useState<{ open: boolean; column?: string }>({ open: false });
  const [showAllFlags, setShowAllFlags] = useState(false);

  if (q.isLoading) return <Loading label="Checking the dataset…" />;
  if (q.error) return <ErrorBox error={q.error} />;
  const r = q.data!;
  const active = r.rows - (r.statuses.rejected ?? 0);
  if (r.rows === 0) return <div className="py-10 text-center text-[0.84375rem] text-ink-muted">Add some rows first, then come back for a health check.</div>;

  const emptyCells = r.columns.reduce((n, c) => n + c.empty, 0);
  const categorical = r.columns.filter((c) => c.categorical && (c.topValues?.length ?? 0) > 1 && !['audio', 'image', 'file'].includes(c.type));
  const gaps = categorical.filter((c) => c.missingValues?.length || (c.topValues?.[0]?.share ?? 0) >= 0.8).length;
  const textCols = r.columns.filter((c) => c.length || c.diversity);
  const flags = showAllFlags ? r.flags : r.flags.slice(0, 4);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label="Rows in use" value={active} help="Rows that runs will use. Rejected rows are left out of everything below." />
        <Chip label="Empty cells" value={emptyCells} tone={emptyCells ? 'warn' : 'ok'} />
        <Chip label="Exact copies" value={r.exactDuplicateRows} tone={r.exactDuplicateRows ? 'warn' : 'ok'} help="Rows identical to another row after ignoring case and spacing. Use Duplicates below to find near copies and paraphrases too." />
        {categorical.length > 0 && <Chip label="Columns with gaps" value={gaps} tone={gaps ? 'warn' : 'ok'} help="Category-like columns where one value dominates or allowed values have no rows." />}
        <Button size="sm" variant="ghost" className="ml-auto" icon={<RefreshCw className="size-3.5" />} onClick={() => q.refetch()} loading={q.isFetching}>
          Refresh
        </Button>
      </div>

      {r.flags.length > 0 ? (
        <Card padded={false}>
          <div className="px-5 pt-4">
            <SectionTitle>Worth fixing</SectionTitle>
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {flags.map((f, i) => (
              <li key={i} className="flex gap-3 px-5 py-3">
                {f.level === 'warn' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> : <Info className="mt-0.5 size-4 shrink-0 text-info" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[0.84375rem] font-medium">{f.message}</div>
                  <div className="text-[0.78125rem] text-ink-muted">{f.suggestion}</div>
                </div>
                {(f.kind === 'imbalanced' || f.kind === 'missing_values') && f.column && (
                  <Button size="sm" onClick={() => setFill({ open: true, column: f.column })}>
                    Fill gaps
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {r.flags.length > 4 && (
            <button type="button" onClick={() => setShowAllFlags((s) => !s)} className="w-full border-t border-line px-5 py-2 text-left text-[0.78125rem] text-ink-muted hover:text-ink">
              {showAllFlags ? 'Show fewer' : `Show ${r.flags.length - 4} more`}
            </button>
          )}
        </Card>
      ) : (
        <Card>
          <div className="text-[0.84375rem] text-ink-muted">Nothing stands out. Columns are filled, values are balanced and rows vary.</div>
        </Card>
      )}

      {categorical.length > 0 && (
        <Card>
          <SectionTitle help="How often each value appears in category-like columns (accent, category, language…). Uneven coverage means some cases are barely tested. Fill gaps asks a model for more rows of the rare values.">Coverage</SectionTitle>
          <div className="grid gap-6 lg:grid-cols-2">
            {categorical.map((c) => (
              <CoverageBars key={c.key} col={c} onFill={() => setFill({ open: true, column: c.key })} />
            ))}
          </div>
        </Card>
      )}

      <DuplicatesSection datasetId={datasetId} onChanged={() => q.refetch()} />

      {textCols.length > 0 && (
        <Card>
          <SectionTitle help="Real users write in many ways. If rows all look alike, a run tells you less than it seems. Lengths show the spread from short to long; the scores show how repetitive the wording is.">Variety</SectionTitle>
          <div>
            {textCols.map((c) => (
              <VarietyRow key={c.key} col={c} />
            ))}
          </div>
        </Card>
      )}

      <details className="group rounded-xl border border-line bg-surface px-5 py-4">
        <summary className="cursor-pointer text-[0.84375rem] font-semibold text-ink-muted group-open:text-ink">Meaning-based tools</summary>
        <div className="mt-4">
          <LocalModelStatus />
        </div>
      </details>

      {fill.open && <FillGapsDialog open onOpenChange={(o) => setFill((f) => ({ ...f, open: o }))} datasetId={datasetId} columns={r.columns} initialColumn={fill.column} />}
    </div>
  );
}
