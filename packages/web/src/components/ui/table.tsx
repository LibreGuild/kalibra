import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { HelpTip } from './overlay';

export interface Column<T> {
  key: string;
  header: ReactNode;
  help?: ReactNode;
  /** CSS grid track, e.g. '120px', 'minmax(200px, 2fr)'. Default 'minmax(120px, 1fr)'. */
  width?: string;
  align?: 'left' | 'right' | 'center';
  render: (row: T, index: number) => ReactNode;
}

/**
 * Virtualized grid: only visible rows are rendered, so 100k-row datasets and runs stay smooth.
 * The table scrolls inside its own box; the page never scrolls horizontally.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowHeight = 44,
  height = 'calc(100vh - 300px)',
  minHeight = 360,
  selected,
  onToggleSelect,
  onToggleAll,
  empty,
  footer,
  activeKey,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowHeight?: number;
  height?: string | number;
  minHeight?: number;
  selected?: Set<string>;
  onToggleSelect?: (key: string) => void;
  onToggleAll?: () => void;
  empty?: ReactNode;
  footer?: ReactNode;
  activeKey?: string | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => rowHeight, overscan: 12 });
  const selectable = !!selected && !!onToggleSelect;
  const template = [selectable ? '36px' : null, ...columns.map((c) => c.width ?? 'minmax(120px, 1fr)')].filter(Boolean).join(' ');
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected!.has(rowKey(r)));

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div ref={parentRef} className="overflow-auto" style={{ height, minHeight }}>
        <div style={{ minWidth: 'fit-content' }}>
          <div className="sticky top-0 z-10 grid border-b border-line bg-raised text-[12px] font-semibold uppercase tracking-wide text-ink-faint" style={{ gridTemplateColumns: template }}>
            {selectable && (
              <div className="flex items-center justify-center">
                <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => onToggleAll?.()} className="size-3.5 accent-[var(--k-accent)]" />
              </div>
            )}
            {columns.map((c) => (
              <div key={c.key} className={clsx('flex h-9 items-center gap-1 px-3', c.align === 'right' && 'justify-end', c.align === 'center' && 'justify-center')}>
                {c.header}
                {c.help && <HelpTip className="normal-case">{c.help}</HelpTip>}
              </div>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-ink-muted">{empty ?? 'Nothing here yet.'}</div>
          ) : (
            <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
              {virtual.getVirtualItems().map((v) => {
                const row = rows[v.index];
                const key = rowKey(row);
                return (
                  <div
                    key={key}
                    data-index={v.index}
                    ref={virtual.measureElement}
                    onClick={() => onRowClick?.(row)}
                    className={clsx(
                      'absolute left-0 grid w-full border-b border-line/70 text-[13px] transition-colors',
                      onRowClick && 'cursor-pointer hover:bg-hover',
                      activeKey === key && 'bg-accent-soft/60',
                      selected?.has(key) && 'bg-accent-soft/40',
                    )}
                    style={{ transform: `translateY(${v.start}px)`, gridTemplateColumns: template, minHeight: rowHeight }}
                  >
                    {selectable && (
                      <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label="Select row" checked={selected!.has(key)} onChange={() => onToggleSelect!(key)} className="size-3.5 accent-[var(--k-accent)]" />
                      </div>
                    )}
                    {columns.map((c) => (
                      <div key={c.key} className={clsx('flex min-w-0 items-center px-3 py-2', c.align === 'right' && 'justify-end', c.align === 'center' && 'justify-center')}>
                        <div className={clsx('min-w-0', c.align !== 'right' && 'w-full')}>{c.render(row, v.index)}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {footer && <div className="border-t border-line bg-raised px-3 py-2 text-[12.5px] text-ink-muted">{footer}</div>}
    </div>
  );
}

/** Plain table for short lists (no virtualization). */
export function SimpleTable<T>({ rows, columns, rowKey, onRowClick, empty }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; onRowClick?: (r: T) => void; empty?: ReactNode }) {
  const template = columns.map((c) => c.width ?? 'minmax(120px, 1fr)').join(' ');
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <div className="grid border-b border-line bg-raised text-[12px] font-semibold uppercase tracking-wide text-ink-faint" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <div key={c.key} className={clsx('flex h-9 items-center gap-1 px-4', c.align === 'right' && 'justify-end')}>
            {c.header}
            {c.help && <HelpTip className="normal-case">{c.help}</HelpTip>}
          </div>
        ))}
      </div>
      {rows.length === 0 && <div className="px-4 py-10 text-center text-[13px] text-ink-muted">{empty ?? 'Nothing here yet.'}</div>}
      {rows.map((r, i) => (
        <div
          key={rowKey(r)}
          onClick={() => onRowClick?.(r)}
          className={clsx('grid border-b border-line/70 text-[13.5px] last:border-b-0', onRowClick && 'cursor-pointer hover:bg-hover')}
          style={{ gridTemplateColumns: template }}
        >
          {columns.map((c) => (
            <div key={c.key} className={clsx('flex min-w-0 items-center px-4 py-3', c.align === 'right' && 'justify-end')}>
              <div className={clsx('min-w-0', c.align !== 'right' && 'w-full')}>{c.render(r, i)}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
