import { createBrowserRouter, isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppShell, Page } from './components/layout/shell';
import { buttonClass } from './components/ui/button';
import { ErrorBox } from './components/ui/display';
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

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      {
        // Pathless wrapper: a page that crashes, or an unknown URL, shows an error inside the app frame.
        errorElement: <RouteError />,
        children: [
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
          { path: 'agents', element: <AgentsPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'docs', element: <DocsPage /> },
          { path: 'docs/:slug', element: <DocsPage /> },
          { path: '*', element: <RouteError notFound /> },
        ],
      },
    ],
  },
]);

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
