import { useState, type ReactNode } from 'react';
import { Tabs as Tb } from 'radix-ui';
import clsx from 'clsx';
import { Check, Copy, Loader2 } from 'lucide-react';
import { HelpTip, Tip } from './overlay';
import { toast, toastError } from './toast';
import { copyText } from '../../lib/clipboard';

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={clsx('rounded-xl border border-line bg-surface', padded && 'p-5', className)}>{children}</div>;
}

export function SectionTitle({ children, help, action, className }: { children: ReactNode; help?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-3 flex items-center justify-between gap-3', className)}>
      <h3 className="flex items-center gap-1.5 text-[0.84375rem] font-semibold text-ink">
        {children}
        {help && <HelpTip>{help}</HelpTip>}
      </h3>
      {action}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'ok' | 'bad' | 'warn' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-raised text-ink-muted border-line',
  accent: 'bg-accent-soft text-accent-ink border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex h-5.5 items-center gap-1.5 rounded-md border px-1.5 text-[0.75rem] font-medium whitespace-nowrap', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  completed: 'ok', pass: 'ok', approved: 'ok', done: 'ok',
  running: 'info', queued: 'neutral', pending: 'neutral', draft: 'neutral',
  needs_review: 'warn', interrupted: 'warn', cancelled: 'neutral', skip: 'neutral',
  failed: 'bad', fail: 'bad', error: 'bad', rejected: 'bad',
};
const STATUS_LABEL: Record<string, string> = { needs_review: 'Needs review', skip: 'Skipped' };

export function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {status === 'running' && <Loader2 className="-ml-0.5 size-3 animate-spin" />}
      {label}
    </Badge>
  );
}

export function Stat({ label, value, sub, help, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; help?: ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[0.78125rem] font-medium text-ink-muted">
        {label}
        {help && <HelpTip>{help}</HelpTip>}
      </div>
      <div className={clsx('mt-1 text-[1.375rem] font-semibold tracking-tight tabular-nums', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</div>
      {sub && <div className="mt-0.5 text-[0.75rem] text-ink-faint">{sub}</div>}
    </div>
  );
}

export function Progress({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'ok' | 'bad'; className?: string }) {
  const color = { accent: 'bg-accent', ok: 'bg-ok', bad: 'bg-bad' }[tone];
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-raised', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/** Horizontal pass/fail/skip/error bar. */
export function OutcomeBar({ pass, fail, skip = 0, error = 0 }: { pass: number; fail: number; skip?: number; error?: number }) {
  const total = pass + fail + skip + error || 1;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 && (
      <Tip content={`${n} ${label}`}>
        <div className={cls} style={{ width: `${(n / total) * 100}%` }} />
      </Tip>
    );
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-raised">
      {seg(pass, 'bg-ok', 'passed')}
      {seg(fail, 'bg-bad', 'failed')}
      {seg(error, 'bg-warn', 'errors')}
      {seg(skip, 'bg-line-strong', 'skipped')}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-surface/50 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-faint [&>svg]:size-8">{icon}</div>}
      <div className="text-[0.9375rem] font-semibold">{title}</div>
      {children && <div className="mt-1 max-w-md text-[0.84375rem] text-ink-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-ink-faint', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[0.8125rem] text-ink-muted">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-[0.8125rem] text-bad">{(error as any)?.message ?? String(error)}</div>;
}

export function Tabs({ value, onChange, tabs, children }: { value: string; onChange: (v: string) => void; tabs: { value: string; label: ReactNode; count?: number }[]; children?: ReactNode }) {
  return (
    <Tb.Root value={value} onValueChange={onChange}>
      <Tb.List className="flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((t) => (
          <Tb.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 text-[0.84375rem] font-medium text-ink-muted transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
          >
            {t.label}
            {t.count !== undefined && <span className="rounded bg-raised px-1 text-[0.71875rem] tabular-nums text-ink-faint">{t.count}</span>}
          </Tb.Trigger>
        ))}
      </Tb.List>
      {children}
    </Tb.Root>
  );
}
export const TabPanel = Tb.Content;

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        copyText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          (e) => toastError(e, 'Could not copy'),
        )
      }
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.78125rem] font-medium text-ink-muted hover:bg-hover hover:text-ink"
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      {label ?? (done ? 'Copied' : 'Copy')}
    </button>
  );
}

/** Read-only code / JSON block. */
export function CodeBlock({ value, className, maxHeight = 420 }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className={clsx('group relative rounded-lg border border-line bg-raised', className)}>
      <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={text ?? ''} />
      </div>
      <pre className="overflow-auto p-3 font-mono text-[0.75rem] leading-relaxed whitespace-pre-wrap break-words text-ink" style={{ maxHeight }}>
        {text === undefined ? '—' : text}
      </pre>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-raised px-1 font-mono text-[0.6875rem] text-ink-muted">{children}</kbd>;
}
