import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type Kind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: Kind;
  title: ReactNode;
  body?: ReactNode;
}

let items: ToastItem[] = [];
let listeners: ((t: ToastItem[]) => void)[] = [];
let nextId = 1;
const publish = () => listeners.forEach((l) => l(items));

/** Fire-and-forget notifications. Errors stay longer than successes. */
export function toast(kind: Kind, title: ReactNode, body?: ReactNode) {
  const id = nextId++;
  items = [...items, { id, kind, title, body }].slice(-4);
  publish();
  setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 3500);
}
toast.success = (t: ReactNode, b?: ReactNode) => toast('success', t, b);
toast.error = (t: ReactNode, b?: ReactNode) => toast('error', t, b);
toast.info = (t: ReactNode, b?: ReactNode) => toast('info', t, b);

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  publish();
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.push(setList);
    return () => {
      listeners = listeners.filter((l) => l !== setList);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {list.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info;
        return (
          <div key={t.id} role="status" className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 shadow-card">
            <Icon className={clsx('mt-0.5 size-4 shrink-0', t.kind === 'success' && 'text-ok', t.kind === 'error' && 'text-bad', t.kind === 'info' && 'text-info')} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[12.5px] break-words text-ink-muted">{t.body}</div>}
            </div>
            <button className="text-ink-faint hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Standard error toast for failed operations. */
export const toastError = (e: unknown, title = 'Something went wrong') => toast.error(title, (e as any)?.message ?? String(e));
