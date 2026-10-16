/*
 * Docs content model. Guides are short, typed lists of blocks so every page renders the same way.
 * Inline text supports `code`, **bold** and [label](/route) links.
 */

export type DemoName =
  | 'loop'
  | 'layers'
  | 'wer'
  | 'template'
  | 'passrate'
  | 'ws-timeline'
  | 'confusion'
  | 'mcp'
  | 'compare'
  | 'columns'
  | 'variants';

export type Block =
  /** The one-sentence "why it matters". */
  | { type: 'lead'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'steps'; title?: string; items: { text: string; link?: { to: string; label: string } }[] }
  | { type: 'tip' | 'gotcha' | 'note'; title?: string; text: string }
  | { type: 'links'; links: { to: string; label: string; primary?: boolean }[] }
  | { type: 'image'; src: string; alt: string; caption?: string }
  | { type: 'code'; code: string; label?: string }
  | { type: 'demo'; name: DemoName; caption?: string }
  /** Compact "term — one-liner" list. */
  | { type: 'defs'; items: { term: string; text: string }[] }
  /** Question / answer pairs. */
  | { type: 'qa'; items: { q: string; a: string }[] };

export type GuideGroup = 'Start here' | 'Build' | 'Measure' | 'Connect' | 'Recipes' | 'Reference';

export interface Guide {
  slug: string;
  title: string;
  /** One-line promise shown on cards. */
  promise: string;
  group: GuideGroup;
  /** lucide-react icon name (resolved in the renderer). */
  icon: string;
  minutes: number;
  image?: string;
  blocks: Block[];
  next?: string;
}
