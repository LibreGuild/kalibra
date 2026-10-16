import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import clsx from 'clsx';
import { BookOpen, Bot, Crosshair, Database, Home, ListChecks, PanelLeftClose, PanelLeftOpen, Play, Plug, Settings } from 'lucide-react';
import { useLiveEvents, useOp } from '../../lib/api';
import { Tip } from '../ui/overlay';

const NAV = [
  { to: '/', label: 'Overview', icon: Home, end: true, hint: 'Getting started and recent activity' },
  { to: '/datasets', label: 'Datasets', icon: Database, hint: 'Test cases: inputs, expected values, audio and images' },
  { to: '/targets', label: 'Targets', icon: Crosshair, hint: 'The AI application under test: HTTP API, WebSocket, model or script' },
  { to: '/suites', label: 'Suites', icon: ListChecks, hint: 'Layered checks that score every result' },
  { to: '/runs', label: 'Runs', icon: Play, hint: 'Run a dataset through a target and score it with a suite' },
];
const NAV2 = [
  { to: '/connections', label: 'Connections', icon: Plug, hint: 'Model providers for judges, generation, images and speech' },
  { to: '/agents', label: 'Coding agents', icon: Bot, hint: 'Let Claude Code, Codex, Cursor and others drive Kalibra through MCP' },
  { to: '/docs', label: 'Docs', icon: BookOpen, hint: 'Short, illustrated guides to every feature' },
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Theme, reading font, text size, workspace' },
];

function NavItem({ to, label, icon: Icon, end, hint, count, collapsed }: { to: string; label: string; icon: any; end?: boolean; hint: string; count?: number; collapsed: boolean }) {
  return (
    <Tip content={collapsed ? <><b>{label}</b><br />{hint}</> : hint} side="right">
      {/* Wrapper div: the tooltip trigger merges classNames as strings, which would break NavLink's className function. */}
      <div>
      <NavLink
        to={to}
        end={end}
        aria-label={label}
        className={({ isActive }) =>
          clsx(
            'relative flex h-9 items-center rounded-lg text-[0.84375rem] font-medium transition-colors',
            collapsed ? 'justify-center' : 'gap-2.5 px-2.5',
            isActive ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-muted hover:bg-hover hover:text-ink',
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
            <Icon className={clsx('size-4 shrink-0', isActive && 'text-accent-ink')} />
            {!collapsed && <span className="flex-1 truncate">{label}</span>}
            {!!count && (collapsed ? <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warn" /> : <span className="rounded-md bg-warn-soft px-1.5 text-[0.6875rem] font-semibold tabular-nums text-warn">{count}</span>)}
          </>
        )}
      </NavLink>
      </div>
    </Tip>
  );
}

const readCollapsed = () => {
  try {
    return localStorage.getItem('kalibra.sidebar') === 'collapsed';
  } catch {
    return false;
  }
};

export function AppShell() {
  useLiveEvents();
  const datasets = useOp<any[]>('list_datasets');
  const review = (datasets.data ?? []).reduce((n, d) => n + (d.reviewCount ?? 0), 0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('kalibra.sidebar', c ? 'expanded' : 'collapsed');
      } catch {
        /* preference lasts for this session */
      }
      return !c;
    });

  // ⌘\ / Ctrl+\ toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full">
      <aside className={clsx('flex shrink-0 flex-col border-r border-line bg-sidebar pt-4 pb-3 transition-[width] duration-200', collapsed ? 'w-[60px] px-2' : 'w-[228px] px-3')}>
        <div className={clsx('mb-5 flex items-center gap-2', collapsed ? 'justify-center' : 'px-1.5')}>
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[0.9375rem] font-bold text-on-accent">K</div>
          {!collapsed && <span className="text-[1.0625rem] font-bold tracking-tight">Kalibra</span>}
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavItem key={n.to} {...n} collapsed={collapsed} count={n.to === '/datasets' ? review : undefined} />
          ))}
        </nav>
        <div className="my-3 h-px bg-line" />
        <nav className="flex flex-col gap-0.5">
          {NAV2.map((n) => (
            <NavItem key={n.to} {...n} collapsed={collapsed} />
          ))}
        </nav>
        <div className="mt-auto">
          <Tip content={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'} side="right">
            <button
              type="button"
              onClick={toggle}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={clsx('flex h-8 w-full items-center rounded-lg text-[0.8125rem] text-ink-faint hover:bg-hover hover:text-ink', collapsed ? 'justify-center' : 'gap-2.5 px-2.5')}
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              {!collapsed && 'Collapse'}
            </button>
          </Tip>
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
            <h1 className="truncate text-[1.5rem] font-bold tracking-tight">{title}</h1>
            {badge}
          </div>
          {description && <p className="mt-1 max-w-2xl text-[0.84375rem] text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className="text-[0.8125rem] text-ink-muted hover:text-ink">
      ← {children}
    </NavLink>
  );
}
