import { createBrowserRouter, isRouteErrorResponse, Navigate, useLocation, useRouteError, type RouteObject } from 'react-router';
import { AppShell, Page } from './components/layout/shell';
import { buttonClass } from './components/ui/button';
import { ErrorBox, Loading } from './components/ui/display';
import { Link } from './lib/nav';
import { DEFAULT_PROJECT, lastProject, useHubOp } from './lib/api';
import { AuthGate, ProjectScope } from './lib/session';
import { OverviewPage } from './pages/overview';
import { DatasetsPage, DatasetDetailPage } from './pages/datasets';
import { TargetsPage, TargetEditorPage } from './pages/targets';
import { SuitesPage, SuiteEditorPage } from './pages/suites';
import { RunsPage, RunDetailPage, ComparePage } from './pages/runs';
import { ConnectionsPage } from './pages/connections';
import { AgentsPage } from './pages/agents';
import { SettingsPage } from './pages/settings';
import { DocsPage } from './pages/docs';
import { CalibratePage } from './pages/calibrate';
import { PlaygroundPage } from './pages/playground';
import { RunGroupPage } from './pages/run-group';
import { ChangePasswordPage, LoginPage, SetupPage } from './pages/auth';
import { ProjectSettingsPage, ProjectsPage } from './pages/projects';
import { AccountPage } from './pages/account';
import { AdminPage } from './pages/admin';
import { TracesPage } from './pages/traces';
import { ConnectPage } from './components/connect/connect-page';

/*
 * Pages inside a project live under /p/<project id>/…; account, administration, docs and app
 * settings are outside projects. Links inside pages use lib/nav, which adds the project prefix.
 */

/** Pages of one project (relative to /p/:projectId). */
const projectPages: RouteObject[] = [
  { index: true, element: <OverviewPage /> },
  { path: 'datasets', element: <DatasetsPage /> },
  { path: 'datasets/:id', element: <DatasetDetailPage /> },
  { path: 'targets', element: <TargetsPage /> },
  { path: 'targets/:id', element: <TargetEditorPage /> },
  { path: 'suites', element: <SuitesPage /> },
  { path: 'suites/:id', element: <SuiteEditorPage /> },
  { path: 'runs', element: <RunsPage /> },
  { path: 'runs/:id', element: <RunDetailPage /> },
  { path: 'runs/:id/compare', element: <ComparePage /> },
  { path: 'runs/:id/calibrate', element: <CalibratePage /> },
  { path: 'comparisons/:id', element: <RunGroupPage /> },
  { path: 'playground', element: <PlaygroundPage /> },
  { path: 'connections', element: <ConnectionsPage /> },
  { path: 'traces', element: <TracesPage /> },
  { path: 'traces/:id', element: <TracesPage /> },
  { path: 'connect', element: <ConnectPage /> },
  { path: 'settings', element: <ProjectSettingsPage /> },
  { path: '*', element: <RouteError notFound /> },
];

/** Project pages from before projects existed: /datasets/x → /p/<last project>/datasets/x. */
const LEGACY = ['datasets/*', 'targets/*', 'suites/*', 'runs/*', 'comparisons/*', 'playground', 'connections', 'traces/*', 'connect'];

export const router = createBrowserRouter([
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
              { path: 'account', element: <AccountPage /> },
              { path: 'admin', element: <Navigate to="/admin/users" replace /> },
              { path: 'admin/:section', element: <AdminPage /> },
              { path: 'agents', element: <AgentsPage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: 'docs', element: <DocsPage /> },
              { path: 'docs/:slug', element: <DocsPage /> },
              ...LEGACY.map((path) => ({ path, element: <LegacyRedirect /> })),
              { path: '*', element: <RouteError notFound /> },
            ],
          },
        ],
      },
    ],
  },
]);

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
