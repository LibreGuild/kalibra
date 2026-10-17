import { useRef, type KeyboardEvent } from 'react';
import { Page, useAppVersion } from '../components/layout/shell';
import { Card, SectionTitle } from '../components/ui/display';
import { Field, Segmented } from '../components/ui/form';
import { useMeta, useProjectId } from '../lib/api';
import { Link } from '../lib/nav';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useTheme, type AccentChoice, type FontChoice, type TextScale, type ThemeChoice } from '../lib/theme';

/** Keep in sync with the accent tokens in styles.css. */
const ACCENTS: { id: AccentChoice; label: string; swatch: string }[] = [
  { id: 'teal', label: 'Teal', swatch: '#1f9e96' },
  { id: 'clay', label: 'Clay', swatch: '#e2703f' },
  { id: 'sky', label: 'Sky', swatch: '#3d84ea' },
  { id: 'indigo', label: 'Indigo', swatch: '#5d67dd' },
  { id: 'violet', label: 'Violet', swatch: '#7466ec' },
  { id: 'plum', label: 'Plum', swatch: '#a24ea3' },
  { id: 'rose', label: 'Rose', swatch: '#d9507f' },
  { id: 'forest', label: 'Forest', swatch: '#3c8a53' },
  { id: 'amber', label: 'Amber', swatch: '#c47d16' },
  { id: 'slate', label: 'Slate', swatch: '#64708a' },
];

/**
 * Accent picker: a radio group of labelled swatches. Arrow keys move and select, like native radio
 * buttons; only the selected swatch is in the tab order.
 */
function AccentPicker({ value, onChange }: { value: AccentChoice; onChange: (a: AccentChoice) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? ACCENTS.length - 1 : step ? (i + step + ACCENTS.length) % ACCENTS.length : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(ACCENTS[to].id);
    refs.current[to]?.focus();
  };
  return (
    <div className="flex flex-wrap justify-end gap-1.5" role="radiogroup" aria-label="Accent colour">
      {ACCENTS.map((a, i) => {
        const checked = value === a.id;
        const tabStop = checked || (i === 0 && !ACCENTS.some((x) => x.id === value));
        return (
          <button
            key={a.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => onChange(a.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={clsx(
              'flex h-8 items-center gap-2 rounded-full border pr-3 pl-1 text-[0.8125rem] transition-colors',
              checked ? 'border-ink bg-raised font-medium text-ink' : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
            )}
          >
            <span className="grid size-6 place-items-center rounded-full" style={{ background: a.swatch }}>
              {checked && <Check className="size-3.5 text-white" />}
            </span>
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPage() {
  const { choice, setChoice, font, setFont, scale, setScale, accent, setAccent } = useTheme();
  const meta = useMeta();
  const version = useAppVersion();
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
              <AccentPicker value={accent} onChange={setAccent} />
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
            Kalibra {version} · {server ? 'team server' : meta.data?.mode === 'desktop' ? 'desktop app' : meta.data?.mode === 'dev' ? 'development mode' : 'local server'} · MIT licensed, open source.{' '}
            {server
              ? 'Your data stays on this server; Kalibra only contacts the apps and model providers your projects configure.'
              : 'Your data stays on this machine; Kalibra only contacts the apps and model providers you configure.'}
          </div>
        </Card>
      </div>
    </Page>
  );
}
