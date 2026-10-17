import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useMatch, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PROJECT,
  lastProject,
  rememberProject,
  setAuthProblemHandler,
  setCurrentProject,
  setCurrentUser,
  useAuthStatus,
  useHubOp,
  useLiveEvents,
  type AuthStatus,
  type User,
} from './api';

/*
 * Who is signed in and which project you are in.
 *
 *   AuthGate      – the whole app: sends you to setup, sign-in or "choose a new password" on a
 *                   team server; does nothing on the desktop (local mode).
 *   ProjectScope  – everything under /p/<id>: loads the project and your role in it, points
 *                   API calls at it, and subscribes to its live events.
 */

import type { ProjectRole } from './roles';
export type { ProjectRole } from './roles';
const RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, owner: 2 };

interface Session {
  mode: 'local' | 'server';
  user: User | null;
  isServer: boolean;
  isAdmin: boolean;
  status: AuthStatus;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside AuthGate');
  return s;
}

/** Pages that work while signed out. */
const PUBLIC = ['/login', '/setup'];

export function AuthGate() {
  const qc = useQueryClient();
  const status = useAuthStatus();
  const location = useLocation();

  // A 401 or "choose a new password" from any call re-reads the sign-in state, and the gate redirects.
  useEffect(() => {
    setAuthProblemHandler(() => qc.invalidateQueries({ queryKey: ['auth-status'] }));
  }, [qc]);

  const data = status.data;
  useEffect(() => {
    if (data?.user) setCurrentUser(data.user.id);
  }, [data?.user]);

  if (status.isLoading) return <FullScreen>Loading…</FullScreen>;
  if (!data) {
    return (
      <FullScreen>
        <div className="flex flex-col items-center gap-3">
          <div>Kalibra is not reachable.</div>
          <button type="button" className="text-accent-ink underline" onClick={() => status.refetch()}>
            Try again
          </button>
        </div>
      </FullScreen>
    );
  }

  const path = location.pathname;
  const here = `${path}${location.search}`;
  if (data.mode === 'server') {
    if (data.setupRequired && path !== '/setup') return <Navigate to={`/setup${location.search.includes('code=') ? location.search : ''}`} replace />;
    if (!data.setupRequired && !data.user && !PUBLIC.includes(path)) return <Navigate to={`/login${path === '/' ? '' : `?next=${encodeURIComponent(here)}`}`} replace />;
    if (data.user?.mustChangePassword && path !== '/change-password') return <Navigate to="/change-password" replace />;
    if (data.user && !data.user.mustChangePassword && path === '/change-password') return <Navigate to="/" replace />;
    if (data.user && PUBLIC.includes(path)) return <Navigate to={safeNext(new URLSearchParams(location.search).get('next'))} replace />;
  } else if (PUBLIC.includes(path) || path === '/change-password') {
    return <Navigate to="/" replace />;
  }

  const session: Session = { mode: data.mode, user: data.user, isServer: data.mode === 'server', isAdmin: data.mode === 'local' || data.user?.role === 'admin', status: data };
  return (
    <SessionContext.Provider value={session}>
      <Outlet />
    </SessionContext.Provider>
  );
}

/** Only same-site paths are followed after sign-in (never another site from a crafted link). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="grid h-full place-items-center bg-canvas text-[0.875rem] text-ink-muted">{children}</div>;
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  description: string;
  role: ProjectRole;
  /** May create, change and run things here. */
  canEdit: boolean;
  /** May manage members, connections, secrets and folder sync. */
  isOwner: boolean;
}

const ProjectContext = createContext<ProjectInfo | null>(null);

/** The project you are in. Outside a project (e.g. Docs) this is null. */
export const useProject = () => useContext(ProjectContext);

/** Whether you may change things in the current project (true outside projects, e.g. on Docs). */
export function useCanEdit(): boolean {
  const p = useProject();
  return !p || p.canEdit;
}

export const atLeast = (role: ProjectRole | undefined, needed: ProjectRole) => !!role && RANK[role] >= RANK[needed];

/** Shows children only to editors and owners of the current project. */
export function CanEdit({ children, fallback = null, owner }: { children: ReactNode; fallback?: ReactNode; owner?: boolean }) {
  const p = useProject();
  const ok = !p || (owner ? p.isOwner : p.canEdit);
  return <>{ok ? children : fallback}</>;
}

const toInfo = (p: any): ProjectInfo => {
  const role = p.role as ProjectRole;
  return { id: p.id, name: p.name, description: p.description ?? '', role, canEdit: atLeast(role, 'editor'), isOwner: role === 'owner' };
};

/** Makes the project in the URL (and your role in it) known to the whole app frame, sidebar included. */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const pid = useMatch('/p/:projectId/*')?.params.projectId;
  const project = useHubOp<any>('get_project', { project: pid }, { enabled: !!pid, staleTime: 30_000 });
  return <ProjectContext.Provider value={pid && project.data ? toInfo(project.data) : null}>{children}</ProjectContext.Provider>;
}

/** Route element for /p/:projectId: points API calls at the project and follows its live events. */
export function ProjectScope() {
  const { projectId = DEFAULT_PROJECT } = useParams();
  const [active, setActive] = useState<string>();
  // Point API calls at this project (and drop another project's unscoped cache) before pages render.
  useLayoutEffect(() => {
    setCurrentProject(projectId);
    setActive(projectId);
  }, [projectId]);
  const project = useHubOp<any>('get_project', { project: projectId }, { staleTime: 30_000 });
  useLiveEvents(projectId, active === projectId && !!project.data);

  useEffect(() => {
    if (project.data?.id) rememberProject(project.data.id);
  }, [project.data?.id]);

  if (active !== projectId || project.isLoading) return null;
  if (project.error || !project.data) return <ProjectMissing id={projectId} error={project.error} />;
  // Remount pages when the project changes, so no page keeps state from the previous project.
  return <Outlet key={project.data.id} />;
}

function ProjectMissing({ id, error }: { id: string; error: unknown }) {
  const notFound = (error as any)?.code === 'not_found';
  // Forget a remembered project that is gone, so "/" doesn't keep sending you here.
  useEffect(() => {
    if (notFound && lastProject() === id) rememberProject(DEFAULT_PROJECT);
  }, [notFound, id]);
  return (
    <div className="mx-auto max-w-xl px-8 pt-16 text-center">
      <h1 className="text-[1.25rem] font-bold">{notFound ? 'Project not found' : 'Could not open this project'}</h1>
      <p className="mt-2 text-[0.875rem] text-ink-muted">
        {notFound ? 'It may have been deleted, or you are not a member. Ask a project owner to add you.' : ((error as any)?.message ?? 'Try again in a moment.')}
      </p>
      <Link to="/projects" className="mt-5 inline-block text-[0.875rem] font-medium text-accent-ink underline">
        See your projects
      </Link>
    </div>
  );
}
