/*
 * Text normalizers for WER/CER and keyword matching. Normalization decides most WER comparisons,
 * so the profile used is always recorded next to the score.
 *
 *   none     – unchanged
 *   basic    – lowercase, punctuation/symbols → space, whitespace collapsed (apostrophes inside words kept)
 *   english  – a lite version of Whisper's EnglishTextNormalizer: basic + bracketed tags removed,
 *              common contractions expanded, spelled numbers 0–999 → digits, %/$/£/€/& spelled out,
 *              fillers (um, uh, hmm, …) removed, common British spellings → American
 *   custom   – a base profile, then ordered regex rules, then whole-word substitutions
 */

export type NormalizerProfile = 'none' | 'basic' | 'english' | 'custom';

export interface CustomRule {
  pattern: string;
  flags?: string;
  replace: string;
}

export interface NormalizeOptions {
  /** Base profile for `custom` (default `basic`). */
  base?: Exclude<NormalizerProfile, 'custom'>;
  /** Regex replacements applied in order (custom profile). */
  rules?: CustomRule[];
  /** Whole-word substitutions, e.g. { "ok": "okay" } (custom profile). */
  substitutions?: Record<string, string>;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Punctuation and symbols become spaces; apostrophes between letters/digits and (optionally) decimal points survive. */
function stripPunctuation(s: string, keepDecimals: boolean): string {
  return s.replace(/[\p{P}\p{S}]/gu, (ch, offset: number, str: string) => {
    const prev = str[offset - 1] ?? '';
    const next = str[offset + 1] ?? '';
    if (ch === "'" && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)) return ch;
    if (keepDecimals && ch === '.' && /\d/.test(prev) && /\d/.test(next)) return ch;
    return ' ';
  });
}

function basic(text: string): string {
  const s = text.normalize('NFKC').toLowerCase().replace(/[‘’ʼ]/g, "'");
  return collapse(stripPunctuation(s, false));
}

// ── english ────────────────────────────────────────────────────────────────

const CONTRACTIONS: [RegExp, string][] = [
  [/\bwon't\b/g, 'will not'],
  [/\bcan't\b/g, 'can not'],
  [/\bcannot\b/g, 'can not'],
  [/\bshan't\b/g, 'shall not'],
  [/\blet's\b/g, 'let us'],
  [/\by'all\b/g, 'you all'],
  [/n't\b/g, ' not'],
  [/'re\b/g, ' are'],
  [/'ve\b/g, ' have'],
  [/'ll\b/g, ' will'],
  [/'m\b/g, ' am'],
  [/'d\b/g, ' would'],
];

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'mm', 'mmm', 'mhm', 'er', 'erm']);

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const BRITISH: Record<string, string> = {
  colour: 'color', colours: 'colors', favour: 'favor', favours: 'favors', favourite: 'favorite',
  honour: 'honor', labour: 'labor', neighbour: 'neighbor', neighbours: 'neighbors', behaviour: 'behavior',
  flavour: 'flavor', humour: 'humor', rumour: 'rumor', centre: 'center', centres: 'centers',
  metre: 'meter', metres: 'meters', litre: 'liter', litres: 'liters', theatre: 'theater',
  organise: 'organize', organised: 'organized', organisation: 'organization', realise: 'realize',
  realised: 'realized', recognise: 'recognize', recognised: 'recognized', apologise: 'apologize',
  analyse: 'analyze', analysed: 'analyzed', travelled: 'traveled', travelling: 'traveling',
  cancelled: 'canceled', cancelling: 'canceling', programme: 'program', programmes: 'programs',
  grey: 'gray', licence: 'license', defence: 'defense', offence: 'offense', catalogue: 'catalog',
  dialogue: 'dialog', cheque: 'check', jewellery: 'jewelry', tyre: 'tire', tyres: 'tires',
  aluminium: 'aluminum', mum: 'mom', practise: 'practice', enrol: 'enroll', fulfil: 'fulfill',
};

/** Converts spelled-out numbers 0–999 to digits: "twenty five" → "25", "one hundred and two" → "102". */
function spelledNumbersToDigits(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    let value = 0;
    let matched = false;
    // [unit] hundred [and]
    if (j < words.length && words[j] in UNITS && words[j + 1] === 'hundred' && UNITS[words[j]] > 0) {
      value = UNITS[words[j]] * 100;
      j += 2;
      matched = true;
      if (words[j] === 'and' && (words[j + 1] in UNITS || words[j + 1] in TENS)) j++;
    } else if (words[j] === 'hundred') {
      value = 100;
      j += 1;
      matched = true;
    }
    // tens [unit] | unit
    if (j < words.length && words[j] in TENS) {
      value += TENS[words[j]];
      j++;
      matched = true;
      if (j < words.length && words[j] in UNITS && UNITS[words[j]] > 0 && UNITS[words[j]] < 10) {
        value += UNITS[words[j]];
        j++;
      }
    } else if (j < words.length && words[j] in UNITS && !(words[j] === 'oh' && !matched)) {
      value += UNITS[words[j]];
      j++;
      matched = true;
    }
    if (matched) {
      out.push(String(value));
      i = j;
    } else {
      out.push(words[i]);
      i++;
    }
  }
  return out;
}

function english(text: string): string {
  let s = text.normalize('NFKC').toLowerCase().replace(/[‘’ʼ]/g, "'");
  s = s.replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)/g, ' ');
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  s = s.replace(/\$\s?(\d+(?:\.\d+)?)/g, '$1 dollars');
  s = s.replace(/£\s?(\d+(?:\.\d+)?)/g, '$1 pounds');
  s = s.replace(/€\s?(\d+(?:\.\d+)?)/g, '$1 euros');
  s = s.replace(/%/g, ' percent ').replace(/\bper cent\b/g, 'percent').replace(/&/g, ' and ');
  for (const [re, rep] of CONTRACTIONS) s = s.replace(re, rep);
  s = stripPunctuation(s, true);
  let words = collapse(s).split(' ').filter(Boolean);
  words = spelledNumbersToDigits(words);
  words = words.filter((w) => !FILLERS.has(w)).map((w) => BRITISH[w] ?? w);
  return words.join(' ');
}

// ── custom ────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function custom(text: string, opts: NormalizeOptions): string {
  let s = normalizeText(text, opts.base ?? 'basic');
  for (const rule of opts.rules ?? []) {
    if (!rule.pattern) continue;
    const flags = rule.flags ?? 'g';
    s = s.replace(new RegExp(rule.pattern, flags.includes('g') ? flags : flags + 'g'), rule.replace ?? '');
  }
  for (const [from, to] of Object.entries(opts.substitutions ?? {})) {
    if (!from) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRe(from)}(?![\\p{L}\\p{N}'])`, 'giu');
    s = s.replace(re, to);
  }
  return collapse(s);
}

export function normalizeText(text: string, profile: NormalizerProfile = 'basic', options: NormalizeOptions = {}): string {
  const t = text ?? '';
  switch (profile) {
    case 'none':
      return t;
    case 'basic':
      return basic(t);
    case 'english':
      return english(t);
    case 'custom':
      return custom(t, options);
    default:
      throw new Error(`Unknown normalizer profile "${profile}"`);
  }
}
