import { Link } from '../../lib/nav';
import clsx from 'clsx';
import {
  ArrowLeftRight,
  ArrowRight,
  BookA,
  Bot,
  ChartColumn,
  Code2,
  Crosshair,
  Database,
  FileInput,
  Gavel,
  GitCompare,
  Image,
  Info,
  Lightbulb,
  ListChecks,
  MessageCircleQuestion,
  Mic,
  Play,
  Plug,
  Radio,
  Rocket,
  Scale,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  TriangleAlert,
  Wand2,
  Waves,
  FlaskConical,
  Gauge,
  Layers,
  MessagesSquare,
  Share2,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { buttonClass } from '../ui/button';
import { CodeBlock } from '../ui/display';
import type { Block } from '../../docs/types';
import { Demo } from './demos';
import { Inline } from './inline';

export const ICONS: Record<string, LucideIcon> = {
  ArrowLeftRight, BookA, Bot, ChartColumn, Code2, Crosshair, Database, FileInput, Gavel, GitCompare, Image, ListChecks,
  MessageCircleQuestion, Mic, Play, Plug, Radio, Rocket, Scale, ShieldAlert, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, Wand2, Waves,
  FlaskConical, Gauge, Layers, MessagesSquare, Share2, Trophy, Users,
};

export const headingId = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const CALLOUT = {
  tip: { icon: Lightbulb, title: 'Pro tip', cls: 'border-accent/30 bg-accent-soft/60', iconCls: 'text-accent-ink' },
  gotcha: { icon: TriangleAlert, title: 'Gotcha', cls: 'border-warn/30 bg-warn-soft/60', iconCls: 'text-warn' },
  note: { icon: Info, title: 'Good to know', cls: 'border-info/30 bg-info-soft/60', iconCls: 'text-info' },
} as const;

/** Renders one docs block. Spacing is owned by the parent (gap between blocks). */
export function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'lead':
      return (
        <p className="text-[1.0625rem] leading-relaxed text-ink">
          <Inline text={block.text} />
        </p>
      );
    case 'heading':
      return (
        <h2 id={headingId(block.text)} className="scroll-mt-6 pt-2 text-[1.0625rem] font-semibold tracking-tight">
          {block.text}
        </h2>
      );
    case 'text':
      return (
        <p className="text-[0.9375rem] leading-relaxed text-ink-muted">
          <Inline text={block.text} />
        </p>
      );
    case 'steps':
      return (
        <div className="flex flex-col gap-2">
          {block.title && <div className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{block.title}</div>}
          <ol className="flex flex-col gap-2">
            {block.items.map((item, i) => (
              <li key={i} className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-ink tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1 pt-0.5 text-[0.9375rem] leading-relaxed text-ink-muted">
                  <Inline text={item.text} />
                  {item.link && (
                    <Link to={item.link.to} className="ml-2 inline-flex items-center gap-0.5 text-sm font-medium text-accent-ink hover:underline">
                      {item.link.label}
                      <ArrowRight className="size-3.5" />
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      );
    case 'tip':
    case 'gotcha':
    case 'note': {
      const c = CALLOUT[block.type];
      return (
        <div className={clsx('flex gap-3 rounded-xl border px-4 py-3', c.cls)}>
          <c.icon className={clsx('mt-0.5 size-4.5 shrink-0', c.iconCls)} />
          <div className="min-w-0 text-[0.9375rem] leading-relaxed">
            <div className="font-semibold text-ink">{block.title ?? c.title}</div>
            <div className="text-ink-muted">
              <Inline text={block.text} />
            </div>
          </div>
        </div>
      );
    }
    case 'links':
      return (
        <div className="flex flex-wrap gap-2">
          {block.links.map((l) => (
            <Link key={l.to} to={l.to} className={buttonClass(l.primary ? 'primary' : 'secondary')}>
              {l.label}
              <ArrowRight className="size-4" />
            </Link>
          ))}
        </div>
      );
    case 'image':
      return (
        <figure className="overflow-hidden rounded-2xl border border-line bg-raised">
          <img src={block.src} alt={block.alt} loading="lazy" className="aspect-[3/2] w-full object-cover" />
          {block.caption && <figcaption className="border-t border-line bg-surface px-4 py-2 text-sm text-ink-muted">{block.caption}</figcaption>}
        </figure>
      );
    case 'code':
      return (
        <div className="flex flex-col gap-1.5">
          {block.label && <div className="text-xs font-medium text-ink-faint">{block.label}</div>}
          <CodeBlock value={block.code} />
        </div>
      );
    case 'demo':
      return (
        <figure className="flex flex-col gap-2">
          <Demo name={block.name} />
          {block.caption && <figcaption className="text-center text-sm text-ink-faint">{block.caption}</figcaption>}
        </figure>
      );
    case 'defs':
      return (
        <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {block.items.map((d) => (
            <div key={d.term} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(9rem,13rem)_1fr] sm:gap-4">
              <dt className="text-[0.9375rem] font-semibold text-ink">{d.term}</dt>
              <dd className="text-[0.9375rem] leading-relaxed text-ink-muted">
                <Inline text={d.text} />
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'qa':
      return (
        <div className="flex flex-col gap-2">
          {block.items.map((x) => (
            <details key={x.q} className="group rounded-xl border border-line bg-surface px-4 py-3 open:bg-raised/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[0.9375rem] font-semibold">
                {x.q}
                <ArrowRight className="size-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
              </summary>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-muted">
                <Inline text={x.a} />
              </p>
            </details>
          ))}
        </div>
      );
  }
}
