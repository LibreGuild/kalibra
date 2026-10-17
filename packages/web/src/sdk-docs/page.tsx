import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { AlertTriangle, ArrowUpRight, Info, Lightbulb, Moon, Sun } from 'lucide-react';
import { CopyButton } from '../components/ui/display';
import { withBase } from '../lib/base';
import { useTheme } from '../lib/theme';
import { GROUPS, SECTIONS, SDK_BRIEF } from './content';
import { highlight } from './highlight';
import { SDK_SLUG as SLUG, sdkDocsPath } from './links';
import { pick, type Block, type Code, type Lang, type Row, type Section, type Syntax, type Text } from './types';

/*
 * Public SDK docs at /sdk-docs/javascript and /sdk-docs/python: outside the sign-in gate (no API
 * calls), opened in a new tab from the profile menu and Connect your app. One section list for
 * both SDKs; the language switch swaps code and names and keeps the reader on the same section.
 */

const FROM_SLUG: Record<string, Lang> = { javascript: 'js', js: 'js', typescript: 'js', ts: 'js', node: 'js', python: 'python', py: 'python' };
const LANG_KEY = 'kalibra.sdkDocsLang';
const LABEL: Record<Lang, string> = { js: 'TypeScript', python: 'Python' };

function rememberedLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'python' ? 'python' : 'js';
  } catch {
    return 'js';
  }
}

function remember(lang: Lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* blocked storage: the URL still says which language */
  }
}

export function SdkDocsPage() {
  const { lang: param } = useParams();
  const location = useLocation();
  const lang = param ? FROM_SLUG[param.toLowerCase()] : undefined;
  if (!lang || param !== SLUG[lang]) return <Navigate to={`${sdkDocsPath(lang ?? rememberedLang())}${location.hash}`} replace />;
  return <Docs lang={lang} />;
}

function Docs({ lang }: { lang: Lang }) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = useActiveSection();
  const keepSection = useRef<string | undefined>(undefined);

  useEffect(() => {
    remember(lang);
    document.title = `Kalibra SDK for ${LABEL[lang]}`;
    return () => {
      document.title = 'Kalibra';
    };
  }, [lang]);

  // Arriving with #section (a shared link), or after switching language: scroll there.
  useLayoutEffect(() => {
    const id = keepSection.current ?? decodeURIComponent(location.hash.slice(1));
    keepSection.current = undefined;
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [lang, location.hash]);

  const switchTo = (next: Lang) => {
    if (next === lang) return;
    keepSection.current = active;
    navigate(sdkDocsPath(next, active), { replace: true });
  };

  return (
    <div className="min-h-full bg-canvas text-ink">
      <TopBar lang={lang} onLang={switchTo} />
      <div className="mx-auto flex max-w-[1240px] gap-10 px-4 pb-24 sm:px-6 lg:px-8">
        <aside className="sticky top-16 hidden max-h-[calc(100vh-4rem)] w-60 shrink-0 self-start overflow-y-auto py-8 lg:block">
          <Toc active={active} lang={lang} />
        </aside>
        <main className="min-w-0 flex-1 py-8">
          <Hero lang={lang} />
          <MobileToc active={active} lang={lang} />
          {SECTIONS.map((s) => (
            <SectionView key={s.id} section={s} lang={lang} />
          ))}
          <footer className="mt-16 border-t border-line pt-6 text-[0.8125rem] text-ink-faint">
            Kalibra is open source and MIT licensed. Found a mistake in these docs? Open an issue at{' '}
            <a className="text-accent-ink hover:underline" href="https://github.com/LibreGuild/kalibra/issues" target="_blank" rel="noopener noreferrer">
              github.com/LibreGuild/kalibra
            </a>
            .
          </footer>
        </main>
      </div>
    </div>
  );
}

// ── Frame ─────────────────────────────────────────────────────────────────────

function TopBar({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  const { resolved, setChoice } = useTheme();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1240px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <a href={withBase('/')} className="flex min-w-0 items-center gap-2" title="Open Kalibra">
          <Logo />
          <span className="truncate text-[0.9375rem] font-semibold tracking-tight">Kalibra</span>
          <span className="hidden rounded-md bg-raised px-1.5 py-0.5 text-[0.71875rem] font-medium text-ink-muted sm:inline">SDK docs</span>
        </a>
        <div className="ml-auto flex items-center gap-2">
          <LangSwitch lang={lang} onLang={onLang} />
          <button
            type="button"
            onClick={() => setChoice(resolved === 'dark' ? 'light' : 'dark')}
            aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-hover hover:text-ink"
          >
            {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}

function Logo() {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[0.9375rem] font-bold text-on-accent">K</span>;
  return <img src={withBase('/logo.png')} alt="" draggable={false} onError={() => setFailed(true)} className="size-7 shrink-0 rounded-lg object-cover" />;
}

function LangSwitch({ lang, onLang }: { lang: Lang; onLang: (l: Lang) => void }) {
  return (
    <div role="radiogroup" aria-label="SDK language" className="inline-flex rounded-lg border border-line bg-raised p-0.5">
      {(['js', 'python'] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === lang}
          onClick={() => onLang(l)}
          className={clsx(
            'h-7 rounded-md px-2.5 text-[0.8125rem] font-medium transition-colors sm:px-3',
            l === lang ? 'bg-accent text-on-accent shadow-sm' : 'text-ink-muted hover:text-ink',
          )}
        >
          {LABEL[l]}
        </button>
      ))}
    </div>
  );
}

function Hero({ lang }: { lang: Lang }) {
  const brief = SDK_BRIEF[lang];
  return (
    <div className="mb-10">
      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-ink">Kalibra SDK</div>
      <h1 className="mt-1.5 text-[2rem] font-bold leading-tight tracking-tight sm:text-[2.25rem]">{lang === 'js' ? 'JavaScript & TypeScript' : 'Python'}</h1>
      <p className="mt-2 max-w-[68ch] text-[0.9375rem] text-ink-muted">{brief.text}</p>
      <div className="mt-4 inline-flex items-center gap-1 rounded-lg border border-line bg-surface py-1 pl-3 pr-1 font-mono text-[0.8125rem]">
        <span className="select-none text-ink-faint">$</span>
        <span className="ml-1.5">{brief.install}</span>
        <CopyButton text={brief.install} label="" />
      </div>
    </div>
  );
}

function Toc({ active, lang }: { active?: string; lang: Lang }) {
  return (
    <nav aria-label="On this page" className="flex flex-col gap-5">
      {GROUPS.map((g) => (
        <div key={g}>
          <div className="mb-1 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-faint">{g}</div>
          <ul>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={active === s.id ? 'location' : undefined}
                  className={clsx(
                    'block rounded-md px-2 py-1 text-[0.8125rem]',
                    active === s.id ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  {pick(s.title, lang)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Below lg: the table of contents as one select. */
function MobileToc({ active, lang }: { active?: string; lang: Lang }) {
  return (
    <label className="mb-8 flex items-center gap-2 lg:hidden">
      <span className="text-[0.8125rem] font-medium text-ink-muted">Jump to</span>
      <select
        value={active ?? SECTIONS[0].id}
        onChange={(e) => document.getElementById(e.target.value)?.scrollIntoView({ block: 'start' })}
        className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[0.875rem]"
      >
        {GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <option key={s.id} value={s.id}>
                {pick(s.title, lang)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** The section at the top of the window (scroll-spy). */
function useActiveSection() {
  const [active, setActive] = useState<string | undefined>(SECTIONS[0].id);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 96) current = s.id;
      }
      // At the very bottom the last short sections can't reach the top: count them as read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return active;
}

// ── Sections and blocks ───────────────────────────────────────────────────────

function SectionView({ section, lang }: { section: Section; lang: Lang }) {
  return (
    <section id={section.id} className="scroll-mt-20 border-t border-line pt-10 pb-4 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-faint">{section.group}</div>
      <h2 className="group mt-1 text-[1.4375rem] font-semibold leading-snug tracking-tight">
        <a href={`#${section.id}`} className="hover:text-accent-ink">
          {pick(section.title, lang)}
          <span aria-hidden className="ml-2 text-ink-faint opacity-0 group-hover:opacity-100">
            #
          </span>
        </a>
      </h2>
      <p className="mt-2 border-l-2 border-accent pl-3 text-[0.9375rem] text-ink-muted">
        <Inline text={pick(section.when, lang)} />
      </p>
      <div className="mt-6 flex max-w-[52rem] flex-col gap-5">
        {section.blocks.map((b, i) => (
          <BlockView key={i} block={b} lang={lang} />
        ))}
      </div>
    </section>
  );
}

function BlockView({ block, lang }: { block: Block; lang: Lang }) {
  switch (block.type) {
    case 'text':
      return (
        <p className="text-[0.9375rem] leading-relaxed">
          <Inline text={pick(block.text, lang)} />
        </p>
      );
    case 'code':
      return <CodeSample code={block.code} lang={lang} label={block.label && pick(block.label, lang)} syntax={block.syntax} />;
    case 'table':
      return <Table head={block.head} rows={block.rows} lang={lang} />;
    case 'callout':
      return <Callout tone={block.tone} title={block.title && pick(block.title, lang)} text={pick(block.text, lang)} />;
    case 'list':
      return (
        <ul className="flex flex-col gap-2 text-[0.9375rem] leading-relaxed">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="min-w-0">
                <Inline text={pick(item, lang)} />
              </span>
            </li>
          ))}
        </ul>
      );
    case 'steps':
      return (
        <ol className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed">
          {block.items.map((item, i) => (
            <li key={i} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[0.75rem] font-semibold text-accent-ink">{i + 1}</span>
              <span className="min-w-0 pt-0.5">
                <Inline text={pick(item, lang)} />
              </span>
            </li>
          ))}
        </ol>
      );
    case 'cards':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {block.items.map((c, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-4">
              <div className="text-[0.9375rem] font-semibold">{pick(c.title, lang)}</div>
              <p className="mt-1 text-[0.84375rem] text-ink-muted">
                <Inline text={pick(c.text, lang)} />
              </p>
            </div>
          ))}
        </div>
      );
    case 'qa':
      return (
        <div className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface">
          {block.items.map((item, i) => (
            <details key={i} className="group px-4 py-3" open={i === 0}>
              <summary className="cursor-pointer list-none text-[0.9375rem] font-medium marker:content-none">
                <span className="mr-2 inline-block text-ink-faint transition-transform group-open:rotate-90">›</span>
                <Inline text={pick(item.q, lang)} />
              </summary>
              <p className="mt-2 pl-4 text-[0.875rem] leading-relaxed text-ink-muted">
                <Inline text={pick(item.a, lang)} />
              </p>
            </details>
          ))}
        </div>
      );
    case 'only':
      return block.lang === lang ? (
        <>
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} lang={lang} />
          ))}
        </>
      ) : null;
  }
}

function CodeSample({ code, lang, label, syntax }: { code: Code; lang: Lang; label?: string; syntax?: Syntax | { js: Syntax; python: Syntax } }) {
  const text = code[lang];
  const kind: Syntax = syntax ? (typeof syntax === 'string' ? syntax : syntax[lang]) : lang === 'js' ? 'ts' : 'python';
  const tokens = useMemo(() => highlight(text, kind), [text, kind]);
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-raised">
      <figcaption className="flex h-9 items-center gap-2 border-b border-line pl-3.5 pr-1.5 text-[0.75rem]">
        <span className="min-w-0 flex-1 truncate font-medium text-ink-muted">{label ?? (kind === 'ts' ? 'TypeScript' : kind === 'python' ? 'Python' : kind)}</span>
        <CopyButton text={text} />
      </figcaption>
      <pre className="overflow-x-auto p-3.5 font-mono text-[0.78125rem] leading-[1.65] text-ink [font-variant-ligatures:none]">
        <code>{tokens}</code>
      </pre>
    </figure>
  );
}

function Table({ head, rows, lang }: { head: Text[]; rows: Row[]; lang: Lang }) {
  const visible = rows.flatMap((r) => (Array.isArray(r) ? [r] : r.only === lang ? [r.cells] : []));
  const heads = head.map((h) => pick(h, lang));
  const showHead = heads.some(Boolean);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full border-collapse text-left text-[0.84375rem]">
        {showHead && (
          <thead>
            <tr className="border-b border-line bg-raised">
              {heads.map((h, i) => (
                <th key={i} className="px-3.5 py-2 text-[0.75rem] font-semibold whitespace-nowrap text-ink-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {visible.map((cells, i) => (
            <tr key={i} className="border-b border-line align-top last:border-b-0">
              {cells.map((c, j) => (
                <td
                  key={j}
                  className={clsx(
                    'px-3.5 py-2.5 leading-relaxed',
                    j === 0 ? 'font-medium text-ink' : 'text-ink-muted',
                    // Short names stay on one line; long lists of names may wrap.
                    j === 0 && pick(c, lang).length < 48 && 'whitespace-nowrap',
                    j === 0 && !showHead && 'w-[1%]',
                  )}
                >
                  <Inline text={pick(c, lang)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Callout({ tone, title, text }: { tone: 'tip' | 'warn' | 'note'; title?: string; text: string }) {
  const style = {
    tip: { box: 'border-accent/30 bg-accent-soft', icon: <Lightbulb className="size-4 text-accent-ink" /> },
    warn: { box: 'border-warn/30 bg-warn-soft', icon: <AlertTriangle className="size-4 text-warn" /> },
    note: { box: 'border-info/30 bg-info-soft', icon: <Info className="size-4 text-info" /> },
  }[tone];
  return (
    <div className={clsx('flex gap-3 rounded-xl border px-4 py-3', style.box)}>
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0 text-[0.875rem] leading-relaxed">
        {title && <div className="font-semibold text-ink">{title}</div>}
        <div className="text-ink-muted">
          <Inline text={text} />
        </div>
      </div>
    </div>
  );
}

/** `code`, **bold**, [label](#section) and [label](https://…) (opens in a new tab). */
function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      out.push(
        <code key={k++} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-ink">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <strong key={k++} className="font-semibold text-ink">
          {m[2]}
        </strong>,
      );
    } else {
      const external = /^https?:\/\//.test(m[4]);
      out.push(
        <a
          key={k++}
          href={m[4]}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {m[3]}
          {external && <ArrowUpRight className="ml-0.5 inline size-3 align-[-1px]" />}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
