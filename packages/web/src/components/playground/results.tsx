import { useState } from 'react';
import clsx from 'clsx';
import { Save } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/display';
import { Tip } from '../ui/overlay';
import { CellValue } from '../ui/media';
import { ms, pct, preview } from '../../lib/format';

/* The playground grid: one row per data row, one column per model variant. */

export interface PlaygroundCell {
  variant: number;
  output: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  passed?: boolean | null;
  checks?: { id: string; name: string; status: string; reason?: string }[];
  error?: string;
}

export interface PlaygroundResult {
  rows: { index: number; rowId?: string; values: Record<string, unknown>; cells: PlaygroundCell[] }[];
  variants: { index: number; label: string; connectionId: string; model: string; avgLatencyMs: number | null; outputTokens: number; errors: number; passRate: number | null }[];
}

function Cell({ cell }: { cell?: PlaygroundCell }) {
  const [open, setOpen] = useState(false);
  if (!cell) return <div className="p-3 text-[0.8125rem] text-ink-faint">—</div>;
  if (cell.error) return <div className="p-3 text-[0.8125rem] text-bad">{cell.error}</div>;
  const failing = (cell.checks ?? []).filter((c) => c.status === 'fail' || c.status === 'error');
  return (
    <div className="flex flex-col gap-2 p-3">
      <button type="button" onClick={() => setOpen(!open)} className="text-left" title={open ? 'Collapse' : 'Show all'}>
        <div className={clsx('whitespace-pre-wrap break-words text-[0.84375rem] leading-relaxed', !open && 'line-clamp-6')}>{cell.output || <span className="text-ink-faint">(empty)</span>}</div>
      </button>
      <div className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-ink-faint">
        {typeof cell.passed === 'boolean' && (
          <Tip content={failing.length ? failing.map((c) => `${c.name}: ${c.reason ?? c.status}`).join(' · ') : 'All checks passed'}>
            <span>
              <Badge tone={cell.passed ? 'ok' : 'bad'} dot>
                {cell.passed ? 'Pass' : 'Fail'}
              </Badge>
            </span>
          </Tip>
        )}
        <span className="tabular-nums">{ms(cell.latencyMs)}</span>
        {cell.outputTokens !== undefined && <span className="tabular-nums">· {cell.outputTokens} tokens</span>}
      </div>
    </div>
  );
}

function RowLabel({ row }: { row: PlaygroundResult['rows'][number] }) {
  const entries = Object.entries(row.values).filter(([, v]) => v !== undefined && v !== null && v !== '').slice(0, 3);
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <span className="text-[0.75rem] font-semibold tabular-nums text-ink-faint">#{row.index + 1}</span>
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0 text-[0.8125rem]">
          <span className="font-mono text-[0.75rem] text-ink-faint">{k} </span>
          {v && typeof v === 'object' && (v as any).blob ? <CellValue value={v} /> : <span className="line-clamp-3 break-words">{preview(v, 240)}</span>}
        </div>
      ))}
    </div>
  );
}

export function PlaygroundGrid({ result, onSave }: { result: PlaygroundResult; onSave: (variantIndex: number) => void }) {
  const template = `minmax(11rem, 0.8fr) repeat(${result.variants.length}, minmax(15rem, 1fr))`;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <div style={{ minWidth: 'fit-content' }}>
        <div className="grid border-b border-line bg-raised" style={{ gridTemplateColumns: template }}>
          <div className="p-3 text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Row</div>
          {result.variants.map((v) => (
            <div key={v.index} className="flex flex-col gap-1.5 border-l border-line p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[0.8125rem] font-semibold">
                  <span className="mr-1.5 text-ink-faint">{String.fromCharCode(65 + v.index)}</span>
                  {v.label}
                </span>
                <Tip content="Save this prompt + model as a target, to run it on a whole dataset">
                  <Button size="icon-sm" variant="ghost" aria-label="Save as target" onClick={() => onSave(v.index)}>
                    <Save className="size-3.5" />
                  </Button>
                </Tip>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[0.75rem] text-ink-muted">
                {v.passRate !== null && <Badge tone={v.passRate >= 0.8 ? 'ok' : v.passRate >= 0.5 ? 'warn' : 'bad'}>{pct(v.passRate, 0)} pass</Badge>}
                <span className="tabular-nums">avg {ms(v.avgLatencyMs)}</span>
                <span className="tabular-nums">· {v.outputTokens} tokens</span>
                {v.errors > 0 && <span className="text-bad">· {v.errors} failed</span>}
              </div>
            </div>
          ))}
        </div>
        {result.rows.map((row) => (
          <div key={row.index} className="grid border-b border-line/70 last:border-b-0" style={{ gridTemplateColumns: template }}>
            <RowLabel row={row} />
            {result.variants.map((v) => (
              <div key={v.index} className="min-w-0 border-l border-line/70">
                <Cell cell={row.cells.find((c) => c.variant === v.index)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
