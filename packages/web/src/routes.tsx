import { createBrowserRouter, isRouteErrorResponse, Navigate, useLocation, useRouteError, type RouteObject } from 'react-router';
import { BASE } from './lib/base';
import { AppShell, Page } from './components/layout/shell';
import { buttonClass } from './components/ui/button';
import { ErrorBox, Loading } from './components/ui/display';
import { Link } from './lib/nav';
import { DEFAULT_PROJECT, lastProject, useHubOp } from './lib/api';
import { AuthGate, ProjectScope } from './lib/session';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/auth';
import { ProjectSettingsPage, ProjectsPage } from './pages/projects';
import type { ComponentType } from 'react';

/**
 * Each page's code loads when it is first opened, so the first screen downloads only what it shows
 * (and the public SDK docs don't download the app). Pages of one module share a chunk.
 */
const page = <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType) => ({
  lazy: async () => ({ Component: pick(await load()) }),
  HydrateFallback: Loading,
});
const overview = () => import('./pages/overview');
const datasets = () => import('./pages/datasets');
const targets = () => import('./pages/targets');
const suites = () => import('./pages/suites');
const runs = () => import('./pages/runs');
const traces = () => import('./pages/traces');

/*
 * Pages inside a project live under /p/<project id>/…; account, administration, docs and app
 * settings are outside projects. Links inside pages use lib/nav, which adds the project prefix.
 */

/** Pages of one project (relative to /p/:projectId). */
const projectPages: RouteObject[] = [
  { index: true, ...page(overview, (m) => m.OverviewPage) },
  { path: 'datasets', ...page(datasets, (m) => m.DatasetsPage) },
  { path: 'datasets/:id', ...page(datasets, (m) => m.DatasetDetailPage) },
  { path: 'targets', ...page(targets, (m) => m.TargetsPage) },
  { path: 'targets/:id', ...page(targets, (m) => m.TargetEditorPage) },
  { path: 'suites', ...page(suites, (m) => m.SuitesPage) },
  { path: 'suites/:id', ...page(suites, (m) => m.SuiteEditorPage) },
  { path: 'runs', ...page(runs, (m) => m.RunsPage) },
  { path: 'runs/:id', ...page(runs, (m) => m.RunDetailPage) },
  { path: 'runs/:id/compare', ...page(runs, (m) => m.ComparePage) },
  { path: 'runs/:id/calibrate', ...page(() => import('./pages/calibrate'), (m) => m.CalibratePage) },
  { path: 'comparisons/:id', ...page(() => import('./pages/run-group'), (m) => m.RunGroupPage) },
  { path: 'playground', ...page(() => import('./pages/playground'), (m) => m.PlaygroundPage) },
  { path: 'connections', ...page(() => import('./pages/connections'), (m) => m.ConnectionsPage) },
  { path: 'traces', ...page(traces, (m) => m.TracesPage) },
  { path: 'traces/:id', ...page(traces, (m) => m.TracesPage) },
  { path: 'connect', ...page(() => import('./components/connect/connect-page'), (m) => m.ConnectPage) },
  { path: 'settings', element: <ProjectSettingsPage /> },
  { path: '*', element: <RouteError notFound /> },
];

/** Project pages from before projects existed: /datasets/x → /p/<last project>/datasets/x. */
const LEGACY = ['datasets/*', 'targets/*', 'suites/*', 'runs/*', 'comparisons/*', 'playground', 'connections', 'traces/*', 'connect'];

export const router = createBrowserRouter([
  // The SDK docs are public: readable without signing in, and they never call the API.
  { path: '/sdk-docs', ...page(() => import('./sdk-docs/page'), (m) => m.SdkDocsPage) },
  { path: '/sdk-docs/:lang', ...page(() => import('./sdk-docs/page'), (m) => m.SdkDocsPage) },
  {
    element: <AuthGate />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '/change-password', element: <ChangePasswordPage /> },
      {
        path: '/',
        element: <AppShell />,
        children: [
          {
            // Pathless wrapper: a page that crashes, or an unknown URL, shows an error inside the app frame.
            errorElement: <RouteError />,
            children: [
              { index: true, element: <HomeRedirect /> },
              { path: 'p/:projectId', element: <ProjectScope />, children: projectPages },
              { path: 'projects', element: <ProjectsPage /> },
              { path: 'account', ...page(() => import('./pages/account'), (m) => m.AccountPage) },
              { path: 'admin', element: <Navigate to="/admin/users" replace /> },
              { path: 'admin/:section', ...page(() => import('./pages/admin'), (m) => m.AdminPage) },
              { path: 'agents', ...page(() => import('./pages/agents'), (m) => m.AgentsPage) },
              { path: 'settings', ...page(() => import('./pages/settings'), (m) => m.SettingsPage) },
              { path: 'docs', ...page(() => import('./pages/docs'), (m) => m.DocsPage) },
              { path: 'docs/:slug', ...page(() => import('./pages/docs'), (m) => m.DocsPage) },
              ...LEGACY.map((path) => ({ path, element: <LegacyRedirect /> })),
              { path: '*', element: <RouteError notFound /> },
            ],
          },
        ],
      },
    ],
  },
], { basename: BASE });

/** "/" opens the project you used last (if you can still open it), else the default one, else your first. */
function HomeRedirect() {
  const projects = useHubOp<{ id: string }[]>('list_projects');
  if (projects.isLoading) return <Loading />;
  const list = projects.data ?? [];
  const remembered = lastProject();
  const pick = list.find((p) => p.id === remembered) ?? list.find((p) => p.id === DEFAULT_PROJECT) ?? list[0];
  return <Navigate to={pick ? `/p/${encodeURIComponent(pick.id)}` : '/projects'} replace />;
}

function LegacyRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`/p/${encodeURIComponent(lastProject())}${pathname}${search}${hash}`} replace />;
}

function RouteError({ notFound }: { notFound?: boolean }) {
  const error = useRouteError();
  const missing = notFound || (isRouteErrorResponse(error) && error.status === 404);
  return (
    <Page title={missing ? 'Page not found' : 'Something went wrong'} description={missing ? 'This address does not match any page.' : 'This page hit an error. Your data is safe; reload or go back.'}>
      <div className="flex max-w-2xl flex-col items-start gap-4">
        {!missing && <ErrorBox error={isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error} />}
        <div className="flex gap-2">
          <Link to="/" className={buttonClass('primary')}>
            Go to Overview
          </Link>
          {!missing && (
            <button type="button" className={buttonClass()} onClick={() => location.reload()}>
              Reload
            </button>
          )}
        </div>
      </div>
    </Page>
  );
}
