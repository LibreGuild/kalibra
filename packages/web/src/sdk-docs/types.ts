/*
 * SDK docs content model. One section list serves both SDKs: anything that differs by language
 * (code, option names, notes) is a `{ js, python }` pair, and the page shows the reader's pick.
 * Inline text supports `code`, **bold** and [label](#section or https://…) links.
 */

export type Lang = 'js' | 'python';
export const LANGS: Lang[] = ['js', 'python'];

/** Text that is the same in both languages, or differs. */
export type Text = string | { js: string; python: string };

export type Syntax = 'ts' | 'python' | 'bash' | 'yaml' | 'json' | 'text';

/** A code sample: always both languages (the same string when it doesn't differ). */
export interface Code {
  js: string;
  python: string;
}

/** A table row for both languages, or for one only. */
export type Row = Text[] | { only: Lang; cells: Text[] };

export type Block =
  | { type: 'text'; text: Text }
  | { type: 'code'; code: Code; label?: Text; syntax?: Syntax | { js: Syntax; python: Syntax } }
  | { type: 'table'; head: Text[]; rows: Row[] }
  | { type: 'callout'; tone: 'tip' | 'warn' | 'note'; title?: Text; text: Text }
  | { type: 'list'; items: Text[] }
  | { type: 'steps'; items: Text[] }
  /** Short feature tiles. */
  | { type: 'cards'; items: { title: Text; text: Text }[] }
  /** Question / answer pairs. */
  | { type: 'qa'; items: { q: Text; a: Text }[] }
  /** Only for one language. */
  | { type: 'only'; lang: Lang; blocks: Block[] };

export interface Section {
  /** Anchor id, the same for both languages so switching keeps your place. */
  id: string;
  group: string;
  title: Text;
  /** One line: when you need this. */
  when: Text;
  blocks: Block[];
}

export const pick = (t: Text, lang: Lang): string => (typeof t === 'string' ? t : t[lang]);
