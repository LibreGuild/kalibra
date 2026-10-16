import { useQuery } from '@tanstack/react-query';
import { Page } from '../components/layout/shell';
import { Card, CopyButton, Loading, SectionTitle } from '../components/ui/display';
import { Field, Segmented } from '../components/ui/form';
import { useOp } from '../lib/api';
import { bytes } from '../lib/format';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Tip } from '../components/ui/overlay';
import { useTheme, type AccentChoice, type FontChoice, type TextScale, type ThemeChoice } from '../lib/theme';

const ACCENTS: { id: AccentChoice; label: string; swatch: string }[] = [
  { id: 'clay', label: 'Clay orange (default)', swatch: '#e2703f' },
  { id: 'teal', label: 'Teal', swatch: '#1f9e96' },
  { id: 'sky', label: 'Sky blue', swatch: '#3d84ea' },
  { id: 'rose', label: 'Rose', swatch: '#d9507f' },
  { id: 'violet', label: 'Violet', swatch: '#7466ec' },
];

export function SettingsPage() {
  const { choice, setChoice, font, setFont, scale, setScale, accent, setAccent } = useTheme();
  const ws = useOp<any>('get_workspace');
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => fetch('/api/meta').then((r) => r.json()).then((b) => b.data) });

  return (
    <Page title="Settings">
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <SectionTitle>Appearance</SectionTitle>
          <div className="flex flex-col gap-5">
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
            <Field label="Accent colour" inline help="Used for buttons, links and highlights. Pass/fail colours never change, so results stay easy to read.">
              <div className="flex gap-2" role="radiogroup" aria-label="Accent colour">
                {ACCENTS.map((a) => (
                  <Tip key={a.id} content={a.label}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={accent === a.id}
                      aria-label={a.label}
                      onClick={() => setAccent(a.id)}
                      className={clsx('grid size-7 place-items-center rounded-full ring-offset-2 ring-offset-surface transition', accent === a.id ? 'ring-2 ring-ink' : 'hover:scale-110')}
                      style={{ background: a.swatch }}
                    >
                      {accent === a.id && <Check className="size-3.5 text-white" />}
                    </button>
                  </Tip>
                ))}
              </div>
            </Field>
            <Field label="Reading font" inline help="Atkinson Hyperlegible Next was designed to keep look-alike characters apart (0 and O, 1, l and I), which helps when reading transcripts, ids and outputs all day.">
              <Segmented<FontChoice>
                value={font}
                onChange={setFont}
                options={[
                  { value: 'atkinson', label: 'Hyperlegible' },
                  { value: 'inter', label: 'Inter' },
                  { value: 'plex', label: 'IBM Plex' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </Field>
            <Field label="Text size" inline help="Scales text and spacing across the app.">
              <Segmented<string>
                value={String(scale)}
                onChange={(v) => setScale(Number(v) as TextScale)}
                options={[
                  { value: '0.9', label: 'Small' },
                  { value: '1', label: 'Default' },
                  { value: '1.1', label: 'Large' },
                  { value: '1.25', label: 'Extra large' },
                ]}
              />
            </Field>
            <div className="rounded-lg border border-line bg-raised p-4">
              <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">Preview</div>
              <p className="mt-1.5 text-[14px] leading-relaxed">
                Transfer 1,500 rupees to Priya on Monday. Row <span className="font-mono text-[12.5px]">row_0O1lI</span> failed: WER 9.1% (1 substitution: <s className="text-bad">fifth</s> <span className="text-ok">fifths</span>).
              </p>
            </div>
          </div>
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
