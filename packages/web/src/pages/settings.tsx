import { useQuery } from '@tanstack/react-query';
import { Page } from '../components/layout/shell';
import { Card, CopyButton, Loading, SectionTitle } from '../components/ui/display';
import { Field, Segmented } from '../components/ui/form';
import { useOp } from '../lib/api';
import { bytes } from '../lib/format';
import { useTheme, type ThemeChoice } from '../lib/theme';

export function SettingsPage() {
  const { choice, setChoice } = useTheme();
  const ws = useOp<any>('get_workspace');
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => fetch('/api/meta').then((r) => r.json()).then((b) => b.data) });

  return (
    <Page title="Settings">
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <SectionTitle>Appearance</SectionTitle>
          <Field label="Theme" inline help="Match system follows your operating system's light or dark setting.">
            <Segmented<ThemeChoice>
              value={choice}
              onChange={setChoice}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'Match system' },
              ]}
            />
          </Field>
        </Card>

        <Card>
          <SectionTitle help="Everything lives in this folder on your machine: the database (kalibra.db) and uploaded files (blobs/). Secrets are stored separately, encrypted with your OS keychain in the desktop app.">Workspace</SectionTitle>
          {ws.isLoading ? (
            <Loading />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2">
                <code className="truncate font-mono text-[12.5px]">{ws.data?.dir}</code>
                <CopyButton text={ws.data?.dir ?? ''} />
              </div>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-[13.5px] sm:grid-cols-3">
                {[
                  ['Datasets', ws.data?.datasets],
                  ['Rows', ws.data?.rows],
                  ['Targets', ws.data?.targets],
                  ['Suites', ws.data?.suites],
                  ['Connections', ws.data?.connections],
                  ['Runs', ws.data?.runs],
                  ['Database', bytes(ws.data?.storage?.databaseBytes)],
                  ['Files', `${ws.data?.storage?.blobCount ?? 0} · ${bytes(ws.data?.storage?.blobBytes)}`],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3 border-b border-line/70 py-1.5">
                    <dt className="text-ink-muted">{k}</dt>
                    <dd className="font-medium tabular-nums">{v as any}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle>About</SectionTitle>
          <div className="text-[13.5px] text-ink-muted">
            Kalibra {meta.data?.version ?? ''} · {meta.data?.mode === 'desktop' ? 'desktop app' : meta.data?.mode === 'dev' ? 'development mode' : 'local server'} · MIT licensed, open source. Your data stays on this machine; Kalibra only
            contacts the apps and model providers you configure.
          </div>
        </Card>
      </div>
    </Page>
  );
}
