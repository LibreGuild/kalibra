import { createBrowserRouter } from 'react-router';
import { AppShell } from './components/layout/shell';
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
    ],
  },
]);
