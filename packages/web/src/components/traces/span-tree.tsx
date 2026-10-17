import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Bot, ChevronRight, CircleDot, FileText, Search, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { Badge, CodeBlock } from '../ui/display';
import { ms } from '../../lib/format';
import { toSources, type Source, type Span, type ToolCall } from './types';

/*
 * The inside of one call: a waterfall of spans (model calls, tool calls, retrievals, agent steps)
 * where each row expands to its input, output and attributes. Used by the trace sheet and by the
 * Steps tab of a run result. Retrieved documents and tool calls get their own compact lists,
 * because those are what agent and RAG checks look at.
 */

const KIND: Record<string, { icon: LucideIcon; label: string; bar: string; text: string }> = {
  llm: { icon: Sparkles, label: 'Model', bar: 'bg-accent', text: 'text-accent' },
  tool: { icon: Wrench, label: 'Tool', bar: 'bg-info', text: 'text-info' },
  retrieval: { icon: Search, label: 'Retrieval', bar: 'bg-ok', text: 'text-ok' },
  agent: { icon: Bot, label: 'Agent', bar: 'bg-warn', text: 'text-warn' },
  step: { icon: CircleDot, label: 'Step', bar: 'bg-ink-faint', text: 'text-ink-muted' },
};
export const kindStyle = (kind: string) => KIND[kind] ?? KIND.step;

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const k = kindStyle(kind);
  const Icon = k.icon;
  return <Icon className={clsx('size-3.5 shrink-0', k.text, className)} aria-label={k.label} />;
}

interface Node {
  span: Span;
  depth: number;
}

/** Spans in tree order (parents before children, siblings by start time). Orphans become roots. */
function flatten(spans: Span[]): Node[] {
  const ids = new Set(spans.map((s) => s.id));
  const byParent = new Map<string, Span[]>();
  for (const s of spans) {
    const parent = s.parentId && ids.has(s.parentId) && s.parentId !== s.id ? s.parentId : '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const s of byParent.get(parent) ?? []) {
      if (seen.has(s.id)) continue; // guards against cycles in malformed input
      seen.add(s.id);
      out.push({ span: s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** Attributes worth showing at a glance in the row (model, tokens, cost). */
function headline(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return '';
  const a = attrs as any;
  const model = a.model ?? a['gen_ai.request.model'] ?? a['gen_ai.response.model'];
  const tin = a.tokens_in ?? a.input_tokens ?? a['gen_ai.usage.input_tokens'];
  const tout = a.tokens_out ?? a.output_tokens ?? a['gen_ai.usage.output_tokens'];
  const cost = a.cost ?? a.cost_usd;
  return [model, tin != null || tout != null ? `${tin ?? '?'}→${tout ?? '?'} tok` : '', typeof cost === 'number' ? `$${cost.toFixed(4)}` : ''].filter(Boolean).join(' · ');
}

export function SpanTree({ spans, empty = 'No steps were recorded.' }: { spans: Span[]; empty?: ReactNode }) {
  const nodes = useMemo(() => flatten(spans), [spans]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const bounds = useMemo(() => {
    const starts = spans.map((s) => Date.parse(s.startedAt)).filter(Number.isFinite);
    const start = starts.length ? Math.min(...starts) : 0;
    const end = Math.max(start + 1, ...spans.map((s) => Date.parse(s.startedAt) + (s.durationMs ?? 0)).filter(Number.isFinite));
    return { start, total: end - start };
  }, [spans]);
  if (!spans.length) return <div className="text-[0.8125rem] text-ink-faint">{empty}</div>;

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,38%)_64px] gap-2 border-b border-line bg-raised px-3 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-faint">
        <span>Step</span>
        <span>Timeline</span>
        <span className="text-right">Time</span>
      </div>
      {nodes.map(({ span: s, depth }) => {
        const isOpen = open.has(s.id);
        const left = bounds.total ? ((Date.parse(s.startedAt) - bounds.start) / bounds.total) * 100 : 0;
        const width = bounds.total ? Math.max(0.8, ((s.durationMs ?? 0) / bounds.total) * 100) : 100;
        const info = headline(s.attributes);
        return (
          <div key={s.id} className="border-b border-line/70 last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(s.id)}
              aria-expanded={isOpen}
              className={clsx('grid w-full grid-cols-[minmax(0,1fr)_minmax(120px,38%)_64px] items-center gap-2 px-3 py-1.5 text-left text-[0.8125rem] hover:bg-hover', s.error && 'bg-bad-soft/40')}
            >
              <span className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 14 }}>
                <ChevronRight className={clsx('size-3.5 shrink-0 text-ink-faint transition-transform', isOpen && 'rotate-90')} />
                <KindIcon kind={s.kind} />
                <span className="truncate font-medium">{s.name}</span>
                {info && <span className="truncate text-[0.75rem] text-ink-faint">{info}</span>}
                {s.error && <Badge tone="bad">error</Badge>}
              </span>
              <span className="relative h-2 rounded-full bg-raised">
                <span className={clsx('absolute inset-y-0 rounded-full opacity-80', kindStyle(s.kind).bar)} style={{ left: `${Math.min(left, 99.2)}%`, width: `${Math.min(width, 100 - Math.min(left, 99.2))}%` }} />
              </span>
              <span className="text-right text-[0.75rem] tabular-nums text-ink-muted">{ms(s.durationMs)}</span>
            </button>
            {isOpen && <SpanDetail span={s} />}
          </div>
        );
      })}
    </div>
  );
}

function SpanDetail({ span: s }: { span: Span }) {
  const sources = s.kind === 'retrieval' ? toSources(s.output) : [];
  const attrs = Object.entries(s.attributes ?? {});
  return (
    <div className="flex flex-col gap-3 border-t border-line/70 bg-canvas/40 px-4 py-3">
      {s.error && <div className="rounded-md bg-bad-soft px-2.5 py-1.5 text-[0.8125rem] text-bad">{s.error}</div>}
      {s.input !== undefined && s.input !== null && (
        <Labeled label={s.kind === 'tool' ? 'Arguments' : s.kind === 'retrieval' ? 'Query' : 'Input'}>
          <CodeBlock value={s.input} maxHeight={220} />
        </Labeled>
      )}
      {sources.length > 0 ? (
        <Labeled label={`Retrieved (${sources.length})`}>
          <SourcesList sources={sources} />
        </Labeled>
      ) : (
        s.output !== undefined &&
        s.output !== null && (
          <Labeled label="Output">
            <CodeBlock value={s.output} maxHeight={260} />
          </Labeled>
        )
      )}
      {attrs.length > 0 && (
        <Labeled label="Attributes">
          <div className="divide-y divide-line rounded-md border border-line bg-surface">
            {attrs.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[180px_1fr] gap-3 px-2.5 py-1 text-[0.75rem]">
                <span className="truncate font-mono text-ink-muted">{k}</span>
                <span className="min-w-0 break-words font-mono">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
              </div>
            ))}
          </div>
        </Labeled>
      )}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

/** Retrieved documents: id, score and a short excerpt; expected ids (from the dataset) are marked. */
export function SourcesList({ sources, expected }: { sources: Source[]; expected?: string[] }) {
  const want = new Set((expected ?? []).map(String));
  return (
    <div className="flex flex-col gap-1.5">
      {sources.map((d, i) => (
        <div key={`${d.id}-${i}`} className={clsx('rounded-md border px-2.5 py-1.5', want.has(d.id) ? 'border-ok/40 bg-ok-soft/40' : 'border-line bg-surface')}>
          <div className="flex items-center gap-2 text-[0.75rem]">
            <FileText className="size-3.5 text-ink-faint" />
            <span className="font-mono font-medium">{d.id}</span>
            {typeof d.score === 'number' && <span className="tabular-nums text-ink-faint">score {d.score.toFixed(3)}</span>}
            {want.has(d.id) && <Badge tone="ok">expected</Badge>}
          </div>
          {d.text && <div className="mt-0.5 line-clamp-3 text-[0.78125rem] text-ink-muted">{d.text}</div>}
        </div>
      ))}
    </div>
  );
}

/** Tool calls in order: name, arguments and result (or the error). */
export function ToolCallsList({ calls }: { calls: ToolCall[] }) {
  return (
    <ol className="flex flex-col gap-1.5">
      {calls.map((c, i) => (
        <li key={i} className={clsx('rounded-md border px-2.5 py-1.5', c.error ? 'border-bad/40 bg-bad-soft/30' : 'border-line bg-surface')}>
          <div className="flex items-center gap-2 text-[0.78125rem]">
            <span className="w-5 text-right tabular-nums text-ink-faint">{i + 1}.</span>
            <Wrench className="size-3.5 text-info" />
            <span className="font-mono font-medium">{c.name}</span>
            {c.error && <Badge tone="bad">failed</Badge>}
          </div>
          {c.args !== undefined && <div className="mt-1 break-words pl-7 font-mono text-[0.75rem] text-ink-muted">{typeof c.args === 'string' ? c.args : JSON.stringify(c.args)}</div>}
          {c.error ? (
            <div className="mt-0.5 pl-7 text-[0.75rem] text-bad">{c.error}</div>
          ) : (
            c.output !== undefined && <div className="mt-0.5 line-clamp-2 break-words pl-7 font-mono text-[0.75rem] text-ink-faint">→ {typeof c.output === 'string' ? c.output : JSON.stringify(c.output)}</div>
          )}
        </li>
      ))}
    </ol>
  );
}
