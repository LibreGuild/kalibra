import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock, Search } from 'lucide-react';
import { Page } from '../components/layout/shell';
import { buttonClass } from '../components/ui/button';
import { Kbd, Progress } from '../components/ui/display';
import { BlockView, headingId, ICONS } from '../components/docs/blocks';
import { DocsSearch } from '../components/docs/search';
import { useReadGuides } from '../components/docs/progress';
import { GROUPS, GUIDES, guideBySlug } from '../docs/content';
import type { Guide } from '../docs/types';

/*
 * In-app docs: a home page of guide cards grouped by intent, and short guide pages with a
 * left navigator, deep links into the app, tiny interactive demos and reading progress.
 */

export function DocsPage() {
  const { slug } = useParams();
  const guide = slug ? guideBySlug(slug) : undefined;
  if (slug && !guide) return <NotFound slug={slug} />;
  return guide ? <GuideView guide={guide} /> : <DocsHome />;
}

function GuideIcon({ guide, size = 'md' }: { guide: Guide; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = ICONS[guide.icon] ?? BookOpen;
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink',
        size === 'sm' && 'size-7 rounded-lg [&>svg]:size-3.5',
        size === 'md' && 'size-9 [&>svg]:size-4.5',
        size === 'lg' && 'size-12 [&>svg]:size-6',
      )}
    >
      <Icon />
    </span>
  );
}

/* ── Home ─────────────────────────────────────────────────────────────────── */

function DocsHome() {
  const { read } = useReadGuides();
  const readCount = GUIDES.filter((g) => read.has(g.slug)).length;
  return (
    <Page title="Docs" description="Short, friendly guides. Most take two minutes. Every one ends with a button that takes you to the right place." width="wide">
      <section className="mb-10 grid items-center gap-6 overflow-hidden rounded-2xl border border-line bg-surface lg:grid-cols-[1fr_1.05fr]">
        <div className="flex flex-col gap-5 p-6 lg:p-8">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-ink">The Kalibra field guide</div>
            <h2 className="mt-2 text-[1.75rem] font-semibold leading-tight tracking-tight">Test your AI app like you mean it.</h2>
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">
              Build test data, point Kalibra at your app, decide what "good" means, and get numbers you can defend. No server, no account, nothing leaves your machine unless you say so.
            </p>
          </div>
          <DocsSearch />
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/docs/welcome" className={buttonClass('primary')}>
              Start: Kalibra in 60 seconds <ArrowRight className="size-4" />
            </Link>
            <Link to="/docs/recipe-stt" className={buttonClass()}>
              Jump to a recipe
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <Progress value={readCount / GUIDES.length} className="max-w-48" />
            <span className="text-sm text-ink-faint">
              {readCount} of {GUIDES.length} read
            </span>
          </div>
        </div>
        <img src="/docs/hero.jpg" alt="A friendly balance scale weighing audio clips and images" className="h-full max-h-[22rem] w-full object-cover lg:max-h-none" />
      </section>

      <div className="flex flex-col gap-10">
        {GROUPS.map((group) => {
          const guides = GUIDES.filter((g) => g.group === group.id);
          return (
            <section key={group.id}>
              <div className="mb-3 flex items-baseline gap-3">
                <h2 className="text-[1.0625rem] font-semibold tracking-tight">{group.id}</h2>
                <span className="text-sm text-ink-faint">{group.blurb}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {guides.map((g) => (
                  <GuideCard key={g.slug} guide={g} done={read.has(g.slug)} recipe={group.id === 'Recipes'} />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-10 flex items-center gap-2 text-sm text-ink-faint">
        <Search className="size-3.5" /> Press <Kbd>/</Kbd> to search, <Kbd>←</Kbd> <Kbd>→</Kbd> to move between guides.
      </p>
    </Page>
  );
}

function GuideCard({ guide, done, recipe }: { guide: Guide; done: boolean; recipe?: boolean }) {
  return (
    <Link
      to={`/docs/${guide.slug}`}
      className={clsx(
        'group flex h-full flex-col gap-3 rounded-xl border bg-surface p-4 transition-colors hover:border-accent/50 hover:bg-raised/50',
        recipe ? 'border-accent/25' : 'border-line',
      )}
    >
      <div className="flex items-start gap-3">
        <GuideIcon guide={guide} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug group-hover:text-accent-ink">{guide.title}</div>
          <div className="mt-0.5 text-sm leading-snug text-ink-muted">{guide.promise}</div>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between text-xs text-ink-faint">
        <span className="inline-flex items-center gap-1">
          <Clock className="size-3" /> {guide.minutes} min
        </span>
        {done ? (
          <span className="inline-flex items-center gap-1 font-medium text-ok">
            <Check className="size-3.5" /> Read
          </span>
        ) : (
          <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </Link>
  );
}

/* ── Guide ────────────────────────────────────────────────────────────────── */

function GuideView({ guide }: { guide: Guide }) {
  const { read, markRead } = useReadGuides();
  const navigate = useNavigate();
  const index = GUIDES.findIndex((g) => g.slug === guide.slug);
  const prev = index > 0 ? GUIDES[index - 1] : undefined;
  const next = (guide.next && guideBySlug(guide.next)) || GUIDES[index + 1];
  const end = useRef<HTMLDivElement>(null);
  const headings = useMemo(() => guide.blocks.filter((b) => b.type === 'heading').map((b) => (b as { text: string }).text), [guide]);

  // Reaching the end of a guide marks it as read.
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && markRead(guide.slug), { threshold: 1 });
    io.observe(el);
    return () => io.disconnect();
  }, [guide.slug, markRead]);

  // ← / → move between guides when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip keys a focused control already handled (tabs, sliders, menus) or that belong to typing.
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
      if (e.key === 'ArrowRight' && next) navigate(`/docs/${next.slug}`);
      if (e.key === 'ArrowLeft' && prev) navigate(`/docs/${prev.slug}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, navigate]);

  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, [guide.slug]);

  return (
    <div className="mx-auto flex max-w-[1180px] gap-10 px-8 pb-16 pt-7">
      <aside className="sticky top-7 hidden max-h-[calc(100vh-3.5rem)] w-56 shrink-0 self-start overflow-y-auto lg:block">
        <Link to="/docs" className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> All guides
        </Link>
        <div className="mb-4">
          <DocsSearch compact />
        </div>
        <nav className="flex flex-col gap-4">
          {GROUPS.map((group) => (
            <div key={group.id}>
              <div className="mb-1 px-2 text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-ink-faint">{group.id}</div>
              <ul className="flex flex-col">
                {GUIDES.filter((g) => g.group === group.id).map((g) => {
                  const current = g.slug === guide.slug;
                  return (
                    <li key={g.slug}>
                      <Link
                        to={`/docs/${g.slug}`}
                        className={clsx(
                          'flex items-center gap-2 rounded-md px-2 py-1 text-sm',
                          current ? 'bg-accent-soft font-medium text-accent-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{g.title}</span>
                        {read.has(g.slug) && !current && <Check className="size-3 shrink-0 text-ok" />}
                      </Link>
                      {current && headings.length > 0 && (
                        <ul className="my-1 ml-3 border-l border-line pl-2">
                          {headings.map((h) => (
                            <li key={h}>
                              <a href={`#${headingId(h)}`} className="block truncate py-0.5 text-xs text-ink-faint hover:text-ink">
                                {h}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <article className="min-w-0 max-w-[46rem] flex-1">
        <div className="mb-2 flex items-center gap-2 text-sm text-ink-faint lg:hidden">
          <Link to="/docs" className="hover:text-ink">
            Docs
          </Link>
          <span>/</span>
          <span>{guide.group}</span>
        </div>
        <header className="mb-6 flex items-start gap-4">
          <GuideIcon guide={guide} size="lg" />
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-accent-ink">{guide.group}</div>
            <h1 className="mt-1 text-[1.75rem] font-semibold leading-tight tracking-tight">{guide.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
              <span>{guide.promise}</span>
              <span className="inline-flex items-center gap-1 text-ink-faint">
                <Clock className="size-3.5" /> {guide.minutes} min
              </span>
              {read.has(guide.slug) && (
                <span className="inline-flex items-center gap-1 font-medium text-ok">
                  <Check className="size-3.5" /> Read
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="flex flex-col gap-5">
          {guide.image && (
            <figure className="overflow-hidden rounded-2xl border border-line bg-raised">
              <img src={guide.image} alt="" className="aspect-[21/9] w-full object-cover" />
            </figure>
          )}
          {guide.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </div>

        <div ref={end} className="h-px" />

        <nav className="mt-10 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
          {prev ? (
            <Link to={`/docs/${prev.slug}`} className="group rounded-xl border border-line bg-surface p-4 hover:border-accent/50">
              <div className="flex items-center gap-1 text-xs text-ink-faint">
                <ArrowLeft className="size-3" /> Previous
              </div>
              <div className="mt-1 font-semibold group-hover:text-accent-ink">{prev.title}</div>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={`/docs/${next.slug}`} className="group rounded-xl border border-accent/30 bg-accent-soft/40 p-4 text-right hover:border-accent/60">
              <div className="flex items-center justify-end gap-1 text-xs text-ink-faint">
                Next <ArrowRight className="size-3" />
              </div>
              <div className="mt-1 font-semibold group-hover:text-accent-ink">{next.title}</div>
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}

function NotFound({ slug }: { slug: string }) {
  return (
    <Page title="Guide not found" description={`There is no guide called "${slug}".`}>
      <div className="flex max-w-md flex-col gap-4">
        <DocsSearch autoFocus />
        <Link to="/docs" className={buttonClass('secondary', 'md', 'w-fit')}>
          <ArrowLeft className="size-4" /> All guides
        </Link>
      </div>
    </Page>
  );
}
