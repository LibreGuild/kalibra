import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '../../lib/nav';
import clsx from 'clsx';
import { CornerDownLeft, Search } from 'lucide-react';
import { GUIDES, guideText } from '../../docs/content';
import type { Guide } from '../../docs/types';
import { Kbd } from '../ui/display';
import { ICONS } from './blocks';

interface Hit {
  guide: Guide;
  snippet: string;
  score: number;
}

const INDEX = GUIDES.map((g) => ({ guide: g, title: g.title.toLowerCase(), promise: g.promise.toLowerCase(), body: guideText(g) }));

/** All words must appear somewhere; title hits rank highest. */
function search(q: string): Hit[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  for (const e of INDEX) {
    const lowerBody = e.body.toLowerCase();
    if (!terms.every((t) => lowerBody.includes(t))) continue;
    let score = 0;
    for (const t of terms) score += (e.title.includes(t) ? 6 : 0) + (e.promise.includes(t) ? 3 : 0) + 1;
    const at = lowerBody.indexOf(terms[0], e.title.length);
    const start = Math.max(0, (at < 0 ? 0 : at) - 40);
    const snippet = `${start > 0 ? '…' : ''}${e.body.slice(start, start + 120).trim()}…`;
    hits.push({ guide: e.guide, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 8);
}

/** Search box with a results list. Press / anywhere on a docs page to focus it. */
export function DocsSearch({ autoFocus, compact }: { autoFocus?: boolean; compact?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const hits = useMemo(() => search(q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (h: Hit | undefined) => {
    if (!h) return;
    navigate(`/docs/${h.guide.slug}`);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="relative w-full">
      <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 focus-within:border-accent/60 focus-within:ring-[3px] focus-within:ring-accent/12">
        <Search className="size-4 shrink-0 text-ink-faint" />
        <input
          ref={input}
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === 'Enter') go(hits[active]);
            else if (e.key === 'Escape') (setQ(''), input.current?.blur());
          }}
          placeholder={compact ? 'Search docs' : 'Search the docs: "WER", "secrets", "noisy audio"…'}
          aria-label="Search the docs"
          className={clsx('min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-faint', compact ? 'h-8.5 text-sm' : 'h-11 text-[0.9375rem]')}
        />
        {!compact && <Kbd>/</Kbd>}
      </div>
      {open && q.trim() && (
        <div className="absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {hits.length === 0 ? (
            <div className="px-4 py-3 text-sm text-ink-muted">Nothing matches "{q}". Try fewer words.</div>
          ) : (
            hits.map((h, i) => {
              const Icon = ICONS[h.guide.icon] ?? Search;
              return (
                <button
                  key={h.guide.slug}
                  type="button"
                  onMouseDown={(e) => (e.preventDefault(), go(h))}
                  onMouseEnter={() => setActive(i)}
                  className={clsx('flex w-full items-start gap-3 px-4 py-2.5 text-left', i === active && 'bg-hover')}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-accent-ink" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{h.guide.title}</span>
                    <span className="block truncate text-xs text-ink-faint">{h.snippet}</span>
                  </span>
                  {i === active && <CornerDownLeft className="mt-1 size-3.5 shrink-0 text-ink-faint" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
