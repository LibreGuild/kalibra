import { Page } from '../components/layout/shell';
import { Card, SectionTitle } from '../components/ui/display';
import { Field, Segmented } from '../components/ui/form';
import { useMeta, useProjectId } from '../lib/api';
import { Link } from '../lib/nav';
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
  const meta = useMeta();
  const server = meta.data?.hubMode === 'server';
  const project = useProjectId();

  return (
    <Page title="Settings" description={<>How Kalibra looks for you, in this browser. Storage, members and sharing are in each project's <Link to={`/p/${encodeURIComponent(project)}/settings`} className="text-accent-ink underline">project settings</Link>.</>}>
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
              <div className="text-[0.75rem] font-semibold uppercase tracking-wide text-ink-faint">Preview</div>
              <p className="mt-1.5 text-[0.875rem] leading-relaxed">
                Transfer 1,500 rupees to Priya on Monday. Row <span className="font-mono text-[0.78125rem]">row_0O1lI</span> failed: WER 9.1% (1 substitution: <s className="text-bad">fifth</s> <span className="text-ok">fifths</span>).
              </p>
            </div>
          </div>
        </Card>


        <Card>
          <SectionTitle>About</SectionTitle>
          <div className="text-[0.84375rem] text-ink-muted">
            Kalibra {meta.data?.version ?? ''} · {server ? 'team server' : meta.data?.mode === 'desktop' ? 'desktop app' : meta.data?.mode === 'dev' ? 'development mode' : 'local server'} · MIT licensed, open source.{' '}
            {server
              ? 'Your data stays on this server; Kalibra only contacts the apps and model providers your projects configure.'
              : 'Your data stays on this machine; Kalibra only contacts the apps and model providers you configure.'}
          </div>
        </Card>
      </div>
    </Page>
  );
}
