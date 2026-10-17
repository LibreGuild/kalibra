import { useRef, useState, type ReactNode } from 'react';
import { Dialog as D, DropdownMenu as M, Tooltip as T, Popover as P } from 'radix-ui';
import clsx from 'clsx';
import { CircleHelp, X } from 'lucide-react';
import { Button } from './button';

/* Tooltips and help ─────────────────────────────────────────────────────── */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={250} skipDelayDuration={150}>{children}</T.Provider>;
}

/**
 * Calmer tooltips for places the pointer passes over all the time (the sidebar): they wait until the
 * pointer rests on an item, and moving to the next item starts the wait again instead of popping up.
 */
export function SlowTooltips({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={1200} skipDelayDuration={0}>{children}</T.Provider>;
}

/*
 * Radix opens a tooltip on any focus of its trigger. Browsers re-focus the last focused element when
 * the window comes back (after switching apps), which used to pop a tooltip with no mouse anywhere
 * near it. A focus therefore opens a tooltip only for keyboard users (the input mode is tracked on
 * <html data-input>, see main.tsx), and never right after the window regained focus; a real hover
 * always does.
 */
let windowFocusedAt = 0;
if (typeof window !== 'undefined') window.addEventListener('focus', () => (windowFocusedAt = Date.now()));

const focusMayOpenTip = (el: HTMLElement) =>
  el.matches(':hover') || (Date.now() - windowFocusedAt > 400 && document.documentElement.dataset.input === 'keyboard');

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  // Set when the latest focus should not open the tooltip; cleared by any pointer movement over it.
  const quiet = useRef(false);
  if (!content) return <>{children}</>;
  return (
    <T.Root open={open} onOpenChange={(next) => (!next || !quiet.current) && setOpen(next)}>
      <T.Trigger
        asChild
        onFocus={(e) => (quiet.current = !focusMayOpenTip(e.currentTarget as HTMLElement))}
        onBlur={() => (quiet.current = false)}
        onPointerMove={() => (quiet.current = false)}
      >
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className="z-[100] max-w-xs rounded-lg bg-ink px-2.5 py-1.5 text-[0.78125rem] leading-snug text-canvas shadow-card animate-in fade-in"
        >
          {content}
          <T.Arrow className="fill-ink" />
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** The (?) next to anything non-obvious. Hover or focus to read what it does. */
export function HelpTip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Tip content={children}>
      <button type="button" tabIndex={0} aria-label="Help" className={clsx('inline-flex text-ink-faint hover:text-ink-muted align-middle', className)}>
        <CircleHelp className="size-3.5" />
      </button>
    </Tip>
  );
}

/* Dialog ─────────────────────────────────────────────────────────────────── */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const w = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[width];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <D.Content
          // Without a description, say so explicitly (Radix otherwise warns and points to a missing element).
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={clsx(
            'fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-32px)] -translate-x-1/2 flex-col rounded-xl border border-line bg-surface shadow-card',
            w,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <D.Title className="text-[0.9375rem] font-semibold">{title}</D.Title>
              {description && <D.Description className="mt-0.5 text-[0.8125rem] text-ink-muted">{description}</D.Description>}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X className="size-4" />
              </Button>
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Right-hand panel for details and editing without leaving the page. */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  actions,
  width = 720,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  width?: number;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <D.Content
          style={{ width: `min(${width}px, calc(100vw - 48px))` }}
          className="fixed inset-y-0 right-0 z-40 flex flex-col border-l border-line bg-surface shadow-card"
        >
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <D.Title className="truncate text-[0.9375rem] font-semibold">{title}</D.Title>
              {subtitle ? <D.Description className="truncate text-[0.78125rem] text-ink-muted">{subtitle}</D.Description> : <D.Description className="sr-only">Details</D.Description>}
            </div>
            <div className="flex items-center gap-1.5">
              {actions}
              <D.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X className="size-4" />
                </Button>
              </D.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Confirmation for destructive actions. */
export function useConfirm() {
  const [state, setState] = useState<{ title: string; body?: ReactNode; confirm: string; resolve: (ok: boolean) => void } | null>(null);
  const ask = (title: string, body?: ReactNode, confirm = 'Delete') =>
    new Promise<boolean>((resolve) => setState({ title, body, confirm, resolve }));
  const close = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const element = (
    <Dialog
      open={!!state}
      onOpenChange={(o) => !o && close(false)}
      title={state?.title ?? ''}
      width="sm"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => close(true)}>
            {state?.confirm}
          </Button>
        </>
      }
    >
      <div className="text-[0.84375rem] text-ink-muted">{state?.body ?? 'This moves the item to the trash.'}</div>
    </Dialog>
  );
  return { ask, element };
}

/* Menus and popovers ─────────────────────────────────────────────────────── */

export function Menu({
  trigger,
  children,
  align = 'end',
  side = 'bottom',
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} side={side} sideOffset={6} collisionPadding={8} className="z-50 min-w-48 rounded-lg border border-line bg-surface p-1 shadow-card">
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({ icon, children, onSelect, danger, hint }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; danger?: boolean; hint?: ReactNode }) {
  return (
    <M.Item
      onSelect={onSelect}
      className={clsx(
        'flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-1.5 text-[0.84375rem] outline-none data-[highlighted]:bg-hover',
        danger ? 'text-bad' : 'text-ink',
      )}
    >
      {icon && <span className="mt-0.5 text-ink-muted [&>svg]:size-4">{icon}</span>}
      <span className="min-w-0">
        <span className="block">{children}</span>
        {hint && <span className="block text-[0.75rem] text-ink-faint">{hint}</span>}
      </span>
    </M.Item>
  );
}

export const MenuSeparator = () => <M.Separator className="my-1 h-px bg-line" />;

/** Quiet, non-interactive text in a menu (e.g. the app version at the bottom of the profile menu). */
export function MenuNote({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pt-1 pb-0.5 text-[0.71875rem] text-ink-faint">{children}</M.Label>;
}

export function Popover({ trigger, children, align = 'start', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={6} collisionPadding={12} className={clsx('z-50 rounded-xl border border-line bg-surface p-3 shadow-card', className)}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
