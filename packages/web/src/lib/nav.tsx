import { forwardRef, useCallback, type ComponentProps } from 'react';
import { Link as RLink, Navigate as RNavigate, NavLink as RNavLink, useNavigate as useRNavigate, type NavigateOptions, type To } from 'react-router';
import { useProjectId } from './api';

/*
 * Links inside a project are written as plain app paths ("/datasets/ds_1", "/runs"). These
 * wrappers put them under the current project ("/p/<id>/datasets/ds_1"), so pages and docs never
 * need to know which project they are in. Paths of pages outside projects pass through unchanged.
 */

/** First path segments of pages that are not inside a project. */
const GLOBAL = new Set(['p', 'docs', 'sdk-docs', 'settings', 'agents', 'projects', 'account', 'admin', 'login', 'setup', 'change-password']);

/** Pages outside the app frame (the public SDK docs): links to them open in a new tab. */
export const opensNewTab = (path: string) => path === '/sdk-docs' || path.startsWith('/sdk-docs/');

/** "/datasets/x" → "/p/<project>/datasets/x"; global and relative paths are left alone. */
export function projectPath(path: string, project: string): string {
  if (!path.startsWith('/')) return path;
  const first = path.slice(1).split(/[/?#]/)[0];
  // Docs link to the current project's settings by this name (plain /settings is the app's settings).
  if (first === 'project-settings') return `/p/${encodeURIComponent(project)}/settings${path.slice('/project-settings'.length)}`;
  if (GLOBAL.has(first)) return path;
  const rest = path === '/' ? '' : path;
  return `/p/${encodeURIComponent(project)}${rest.startsWith('/?') || rest.startsWith('/#') ? rest.slice(1) : rest}`;
}

function scoped(to: To, project: string): To {
  if (typeof to === 'string') return projectPath(to, project);
  return to.pathname ? { ...to, pathname: projectPath(to.pathname, project) } : to;
}

export const Link = forwardRef<HTMLAnchorElement, ComponentProps<typeof RLink>>(function Link({ to, ...rest }, ref) {
  const project = useProjectId();
  return <RLink ref={ref} to={scoped(to, project)} {...rest} />;
});

export const NavLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof RNavLink>>(function NavLink({ to, ...rest }, ref) {
  const project = useProjectId();
  return <RNavLink ref={ref} to={scoped(to, project)} {...rest} />;
});

export function Navigate({ to, ...rest }: ComponentProps<typeof RNavigate>) {
  const project = useProjectId();
  return <RNavigate to={scoped(to, project)} {...rest} />;
}

/** useNavigate that understands project paths. Numbers (history steps) pass through. */
export function useNavigate() {
  const navigate = useRNavigate();
  const project = useProjectId();
  return useCallback((to: To | number, opts?: NavigateOptions) => (typeof to === 'number' ? navigate(to) : navigate(scoped(to, project), opts)), [navigate, project]);
}
