import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useNavigate as useRawNavigate } from 'react-router';
import { NavLink } from '../../lib/nav';
import { withBase } from '../../lib/base';
import clsx from 'clsx';
import { Activity, BookOpen, Bot, Braces, Crosshair, Database, Eye, FlaskConical, Home, KeyRound, ListChecks, LogOut, PanelLeftClose, PanelLeftOpen, Play, Plug, Settings, Shield } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { authCall, forgetProject, useHubOp, useMeta, useOp } from '../../lib/api';
import { ProjectProvider, useProject, useSession } from '../../lib/session';
import { Menu, MenuItem, MenuNote, MenuSeparator, SlowTooltips, Tip } from '../ui/overlay';
import { toastError } from '../ui/toast';
import { ProjectSwitcher } from './project-switcher';
import { SdkDocsDialog } from '../../sdk-docs/picker-dialog';

/*
 * The app frame: sidebar (logo, project switcher, the project's pages, tools, and the profile menu
 * with everything personal or app-wide: account, administration, settings, docs, coding agents) and
 * the page area. `Page` below is the one place page headers are laid out.
 */

/** Pages of the current project. */
const NAV = [
  { to: '/', label: 'Overview', icon: Home, end: true, hint: 'Getting started and recent activity' },
  { to: '/datasets', label: 'Datasets', icon: Database, hint: 'Test cases: inputs, expected values, audio and images' },
  { to: '/targets', label: 'Targets', icon: Crosshair, hint: 'The AI application under test: HTTP API, WebSocket, model or script' },
  { to: '/suites', label: 'Suites', icon: ListChecks, hint: 'Layered checks that score every result' },
  { to: '/runs', label: 'Runs', icon: Play, hint: 'Run a dataset through a target and score it with a suite' },
  { to: '/traces', label: 'Traces', icon: Activity, hint: 'What happened inside your app: traces sent by the SDK, OpenTelemetry or the proxy' },
];
/** Project tools. */
const NAV2 = [
  { to: '/playground', label: 'Playground', icon: FlaskConical, hint: 'Try a prompt on a few rows across models, side by side' },
  { to: '/connections', label: 'Connections', icon: Plug, hint: 'Model providers for judges, generation, images and speech' },
];

/** The build's version, for when the server does not report one (set from packages/cli/package.json in vite.config.ts). */
declare const __APP_VERSION__: string;
export const useAppVersion = () => useMeta().data?.version || __APP_VERSION__;

function NavItem({ to, label, icon: Icon, end, hint, count, collapsed }: { to: string; label: string; icon: any; end?: boolean; hint: string; count?: number; collapsed: boolean }) {
  return (
    <Tip content={collapsed ? <><b>{label}</b><br />{hint}</> : hint} side="right">
      {/* Wrapper div: the tooltip trigger merges classNames as strings, which would break NavLink's className function. */}
      <div>
      <NavLink
        to={to}
        end={end}
        aria-label={count ? `${label}, ${count} to review` : label}
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
  return (
    <ProjectProvider>
      <Shell />
    </ProjectProvider>
  );
}

function Shell() {
  const session = useSession();
  const project = useProject();
  // Someone who is in no project yet (e.g. just signed in for the first time) gets a pointer to
  // Projects instead of project pages that would only say "not found".
  const projects = useHubOp<{ id: string }[]>('list_projects', {}, { staleTime: 30_000 });
  const noProjects = !project && projects.data?.length === 0;
  // Rows waiting for review in the current project (none on pages outside a project).
  const datasets = useOp<any[]>('list_datasets', {}, { retry: false, enabled: !!project });
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

  // The collapse and expand buttons replace each other; keep keyboard focus on whichever is shown.
  const toggleButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const toggleFromButton = (e: { currentTarget: HTMLButtonElement }) => {
    refocus.current = document.activeElement === e.currentTarget;
    toggle();
  };
  useEffect(() => {
    if (refocus.current) toggleButton.current?.focus();
    refocus.current = false;
  }, [collapsed]);

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
      <SlowTooltips>
        <aside className={clsx('flex shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-line bg-sidebar pt-4 pb-3 transition-[width] duration-200', collapsed ? 'w-[60px] px-2' : 'w-[228px] px-3')}>
          <div className={clsx('mb-4 flex items-center gap-2', collapsed ? 'justify-center' : 'px-1.5')}>
            {collapsed ? (
              // Collapsed: the logo tile is the expand control; hover or focus swaps the K for the icon.
              <Tip content={'Expand sidebar (⌘\\)'} side="right">
                <button
                  ref={toggleButton}
                  type="button"
                  onClick={toggleFromButton}
                  aria-label="Expand sidebar"
                  className="group relative grid size-7 shrink-0 place-items-center rounded-lg focus-visible:outline-offset-2"
                >
                  <Logo className="transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
                  <span className="absolute inset-0 grid place-items-center rounded-lg bg-hover text-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">
                    <PanelLeftOpen className="size-4" />
                  </span>
                </button>
              </Tip>
            ) : (
              <>
                <Logo />
                <span className="flex-1 text-[1.0625rem] font-bold tracking-tight">Kalibra</span>
                <Tip content={'Collapse sidebar (⌘\\)'} side="right">
                  <button
                    ref={toggleButton}
                    type="button"
                    onClick={toggleFromButton}
                    aria-label="Collapse sidebar"
                    className="grid size-7 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                  >
                    <PanelLeftClose className="size-4" />
                  </button>
                </Tip>
              </>
            )}
          </div>
          <div className="mb-3">
            <ProjectSwitcher collapsed={collapsed} />
          </div>
          {noProjects ? (
            !collapsed && (
              <div className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[0.8125rem] text-ink-muted">
                You are not in a project yet.{' '}
                <NavLink to="/projects" className="font-medium text-accent-ink hover:underline">
                  {session.isServer ? 'Create one or ask to be added' : 'Create one'}
                </NavLink>
                .
              </div>
            )
          ) : (
            <nav className="flex flex-col gap-0.5">
              {NAV.map((n) => (
                <NavItem key={n.to} {...n} collapsed={collapsed} count={n.to === '/datasets' ? review : undefined} />
              ))}
            </nav>
          )}
          {!noProjects && (
            <>
              <div className="my-3 h-px bg-line" />
              <nav className="flex flex-col gap-0.5">
                {NAV2.map((n) => (
                  <NavItem key={n.to} {...n} collapsed={collapsed} />
                ))}
              </nav>
            </>
          )}
          <ProfileMenu collapsed={collapsed} />
        </aside>
      </SlowTooltips>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {project && !project.canEdit && <ViewOnlyBar />}
        <Outlet />
      </main>
    </div>
  );
}

/** Quiet note for viewers: they can look around, but changes are for editors. */
function ViewOnlyBar() {
  return (
    <div className="flex items-center justify-center gap-2 border-b border-line bg-raised px-4 py-1.5 text-[0.78125rem] text-ink-muted">
      <Eye className="size-3.5" /> View only — you can look at everything in this project; ask an owner for the editor role to make changes.
    </div>
  );
}

/**
 * The app's logo: the icon image when it loads, else the "K" tile. `className` lets the collapsed
 * sidebar fade it out for its expand icon.
 */
function Logo({ className }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span className={clsx('grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[0.9375rem] font-bold text-on-accent', className)}>K</span>;
  }
  return <img src={withBase('/logo.png')} alt="" draggable={false} onError={() => setFailed(true)} className={clsx('size-7 shrink-0 rounded-lg object-cover', className)} />;
}

/**
 * Bottom of the sidebar, in every mode: who you are ("You" in local mode), and the menu for what
 * is yours or app-wide: account and administration (team server), settings, docs, coding agents,
 * sign out, and the app version.
 */
function ProfileMenu({ collapsed }: { collapsed: boolean }) {
  const { user, isAdmin, isServer } = useSession();
  const navigate = useRawNavigate();
  const qc = useQueryClient();
  const version = useAppVersion();
  const signedIn = isServer && !!user;
  const [sdkDocs, setSdkDocs] = useState(false);
  const name = signedIn ? user!.name : 'You';
  const detail = signedIn ? (isAdmin ? 'Administrator' : user!.username) : 'This computer';
  const initial = (signedIn ? user!.name || user!.username : 'You').slice(0, 1).toUpperCase();
  const signOut = async () => {
    try {
      await authCall('logout');
    } catch (e) {
      toastError(e, 'Could not sign out');
      return;
    }
    qc.clear();
    forgetProject();
    window.location.assign(withBase('/login'));
  };
  return (
    <div className="mt-auto border-t border-line pt-1.5">
      <Menu
        align={collapsed ? 'end' : 'start'}
        side={collapsed ? 'right' : 'top'}
        trigger={
          <button
            type="button"
            aria-label={`${name}: account, coding agents, docs and settings`}
            className={clsx('flex h-10 w-full items-center rounded-lg text-left text-[0.8125rem] hover:bg-hover', collapsed ? 'justify-center' : 'gap-2.5 px-2')}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[0.75rem] font-bold text-accent-ink">{initial}</span>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-tight">{name}</span>
                <span className="block truncate text-[0.6875rem] leading-tight text-ink-faint">{detail}</span>
              </span>
            )}
          </button>
        }
      >
        {signedIn && (
          <MenuItem icon={<KeyRound />} onSelect={() => navigate('/account')} hint="Password, access tokens, sign-ins">
            Your account
          </MenuItem>
        )}
        {signedIn && isAdmin && (
          <MenuItem icon={<Shield />} onSelect={() => navigate('/admin/users')} hint="Users, groups, sign-in, settings">
            Administration
          </MenuItem>
        )}
        {signedIn && <MenuSeparator />}
        <MenuItem icon={<Bot />} onSelect={() => navigate('/agents')} hint="Claude Code, Codex, Cursor… through MCP">
          Coding agents
        </MenuItem>
        <MenuItem icon={<Braces />} onSelect={() => setSdkDocs(true)} hint="JavaScript and Python SDK reference">
          SDK docs
        </MenuItem>
        <MenuItem icon={<BookOpen />} onSelect={() => navigate('/docs')} hint="Using Kalibra: short, illustrated guides">
          Platform docs
        </MenuItem>
        <MenuItem icon={<Settings />} onSelect={() => navigate('/settings')} hint="Theme, reading font, text size">
          Settings
        </MenuItem>
        {signedIn && (
          <>
            <MenuSeparator />
            <MenuItem icon={<LogOut />} onSelect={signOut}>
              Sign out
            </MenuItem>
          </>
        )}
        {version && (
          <>
            <MenuSeparator />
            <MenuNote>Kalibra {version}</MenuNote>
          </>
        )}
      </Menu>
      <SdkDocsDialog open={sdkDocs} onOpenChange={setSdkDocs} />
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
      {/* Title and actions share the first row (actions top-right, below the title on narrow screens);
          the description runs the full width underneath, so it never wraps early next to the buttons. */}
      <header className="mb-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="truncate text-[1.5rem] font-bold tracking-tight">{title}</h1>
            {badge}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
        </div>
        {description && <p className="mt-1.5 max-w-[160ch] text-[0.84375rem] text-ink-muted">{description}</p>}
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
