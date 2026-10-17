import type { ReactNode } from 'react';
import type { Syntax } from './types';

/*
 * A small syntax highlighter for the docs' own samples: comments, strings, keywords, numbers,
 * decorators and keys. One regex pass per sample, rendered as spans (no HTML strings).
 */

const KEYWORDS: Record<string, string[]> = {
  ts: ['import', 'from', 'export', 'const', 'let', 'var', 'async', 'await', 'function', 'return', 'if', 'else', 'for', 'of', 'in', 'new', 'yield', 'throw', 'try', 'catch', 'class', 'type', 'interface', 'default', 'true', 'false', 'null', 'undefined', 'typeof'],
  python: ['import', 'from', 'as', 'def', 'async', 'await', 'return', 'yield', 'with', 'for', 'in', 'if', 'else', 'elif', 'not', 'and', 'or', 'is', 'class', 'lambda', 'try', 'except', 'raise', 'True', 'False', 'None', 'pass'],
  bash: ['npm', 'npx', 'pip', 'gh', 'export', 'cat'],
  yaml: ['true', 'false', 'null'],
  json: ['true', 'false', 'null'],
  text: [],
};

const RULES: Record<Syntax, RegExp> = {
  // comment | string | template | number | word | decorator
  ts: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`(?:\\.|[^`\\])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(@\w+)/g,
  python: /(#[^\n]*)|([rbfu]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'))|($^)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_]\w*)|(@[\w.]+)/g,
  bash: /((?:^|(?<=\s))#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\{\{[^}]*\}\}|\$\(?[\w]+\)?)|(\b\d+\b)|([A-Za-z_][\w-]*(?==)|[A-Za-z_][\w-]*)|($^)/gm,
  yaml: /(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\$\{\{[^}]*\}\})|(\b\d+(?:\.\d+)?\b)|([\w-]+(?=:\s|:$))|($^)/gm,
  json: /($^)|("(?:\\.|[^"\\])*")|($^)|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_]\w*)|($^)/g,
  text: /($^)/g,
};

const CLS = {
  comment: 'text-ink-faint italic',
  string: 'text-ok',
  number: 'text-warn',
  keyword: 'text-accent-ink font-medium',
  key: 'text-info',
  decorator: 'text-info',
};

export function highlight(code: string, syntax: Syntax): ReactNode[] {
  const re = new RegExp(RULES[syntax].source, RULES[syntax].flags);
  const words = new Set(KEYWORDS[syntax]);
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const push = (text: string, cls?: string) => out.push(cls ? <span key={k++} className={cls}>{text}</span> : text);
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) push(code.slice(last, m.index));
    const [, comment, str, tmpl, num, word, deco] = m;
    if (comment) push(comment, CLS.comment);
    else if (str) push(str, CLS.string);
    else if (tmpl) push(tmpl, syntax === 'ts' ? CLS.string : CLS.key);
    else if (num) push(num, CLS.number);
    else if (word) {
      const isKey = (syntax === 'yaml' || syntax === 'bash') && code[m.index + word.length] === (syntax === 'yaml' ? ':' : '=');
      push(word, isKey ? CLS.key : words.has(word) ? CLS.keyword : undefined);
    } else if (deco) push(deco, CLS.decorator);
    else push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) push(code.slice(last));
  return out;
}
