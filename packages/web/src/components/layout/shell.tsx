import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import clsx from 'clsx';
import { Bot, Crosshair, Database, Home, ListChecks, Monitor, Moon, Play, Plug, Settings, Sun } from 'lucide-react';
import { useLiveEvents, useOp } from '../../lib/api';
import { useTheme, type ThemeChoice } from '../../lib/theme';
import { Tip } from '../ui/overlay';

const NAV = [
  { to: '/', label: 'Overview', icon: Home, end: true, hint: 'Getting started and recent activity' },
  { to: '/datasets', label: 'Datasets', icon: Database, hint: 'Test cases: inputs, expected values, audio and images' },
  { to: '/targets', label: 'Targets', icon: Crosshair, hint: 'The AI application under test: HTTP API, WebSocket, model or script' },
  { to: '/suites', label: 'Suites', icon: ListChecks, hint: 'Layered checks that score every result' },
  { to: '/runs', label: 'Runs', icon: Play, hint: 'Run a dataset through a target and score it with a suite' },
];
const NAV2 = [
  { to: '/connections', label: 'Connections', icon: Plug, hint: 'Model providers used for judges and data generation' },
  { to: '/agents', label: 'Coding agents', icon: Bot, hint: 'Let Claude Code, Codex, Cursor and others drive Kalibra through MCP' },
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Theme, workspace and storage' },
];

function NavItem({ to, label, icon: Icon, end, hint, count }: { to: string; label: string; icon: any; end?: boolean; hint: string; count?: number }) {
  return (
    <Tip content={hint} side="right">
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) =>
          clsx(
            'group flex h-8.5 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors',
            isActive ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:bg-hover hover:text-ink',
          )
        }
      >
        <Icon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{label}</span>
        {!!count && <span className="rounded-md bg-warn-soft px-1.5 text-[11px] font-semibold tabular-nums text-warn">{count}</span>}
      </NavLink>
    </Tip>
  );
}

function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  const opts: { v: ThemeChoice; icon: any; label: string }[] = [
    { v: 'light', icon: Sun, label: 'Light' },
    { v: 'dark', icon: Moon, label: 'Dark' },
    { v: 'system', icon: Monitor, label: 'Match system' },
  ];
  return (
    <div className="flex rounded-lg border border-line bg-raised p-0.5" role="radiogroup" aria-label="Theme">
      {opts.map(({ v, icon: Icon, label }) => (
        <Tip key={v} content={label}>
          <button
            type="button"
            role="radio"
            aria-checked={choice === v}
            aria-label={label}
            onClick={() => setChoice(v)}
            className={clsx('grid h-6.5 flex-1 place-items-center rounded-md', choice === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-faint hover:text-ink')}
          >
            <Icon className="size-3.5" />
          </button>
        </Tip>
      ))}
    </div>
  );
}

export function AppShell() {
  useLiveEvents();
  const datasets = useOp<any[]>('list_datasets');
  const review = (datasets.data ?? []).reduce((n, d) => n + (d.reviewCount ?? 0), 0);
  return (
    <div className="flex h-full">
      <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-sidebar px-3 pt-4 pb-3">
        <div className="mb-5 flex items-center gap-2 px-2">
          <div className="grid size-7 place-items-center rounded-lg bg-accent font-serif text-[17px] font-semibold text-on-accent">K</div>
          <span className="font-serif text-[19px] font-semibold tracking-tight">Kalibra</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavItem key={n.to} {...n} count={n.to === '/datasets' ? review : undefined} />
          ))}
        </nav>
        <div className="my-3 h-px bg-line" />
        <nav className="flex flex-col gap-0.5">
          {NAV2.map((n) => (
            <NavItem key={n.to} {...n} />
          ))}
        </nav>
        <div className="mt-auto">
          <ThemeSwitch />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** Standard page frame: title, description, actions, then content. */
export function Page({
  title,
  description,
  actions,
  children,
  back,
  width = 'default',
  badge,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  back?: ReactNode;
  width?: 'default' | 'wide' | 'full';
  badge?: ReactNode;
}) {
  return (
    <div className={clsx('mx-auto px-8 pt-7 pb-16', width === 'default' && 'max-w-[1180px]', width === 'wide' && 'max-w-[1480px]')}>
      {back && <div className="mb-2">{back}</div>}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="truncate font-serif text-[26px] font-semibold tracking-tight">{title}</h1>
            {badge}
          </div>
          {description && <p className="mt-1 max-w-2xl text-[13.5px] text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className="text-[13px] text-ink-muted hover:text-ink">
      ← {children}
    </NavLink>
  );
}
