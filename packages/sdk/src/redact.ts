/*
 * Removes personal data and secrets from trace values before they leave your process. Runs on the
 * background flush, never in the path of your functions.
 *
 * Built in: email addresses, phone numbers, payment card numbers (Luhn-checked) and common API
 * keys (OpenAI `sk-…`, AWS `AKIA…`, GitHub `ghp_…`/`github_pat_…`, Slack `xox…`, Kalibra
 * `kal_…`/`kik_…`). Pass your own function to `init({ redact })` for anything else.
 */

import type { Redactor } from './config.js';

export const REDACTED = '[redacted]';

const KEYS = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|ki?k_[A-Za-z0-9_-]{20,}|kal_[A-Za-z0-9_-]{20,})\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const PHONE = /(?<![\w.])(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?|\d{2,4}[\s-])\d{3,4}[\s-]?\d{3,4}(?![\w.])/g;

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactString(s: string): string {
  if (s.length < 6) return s;
  return s
    .replace(KEYS, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? REDACTED : m;
    })
    .replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 10 ? REDACTED : m));
}

/** Redacts every string inside a JSON-safe value (from serialize.ts). */
export function redactValue(v: unknown): unknown {
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = redactValue(x);
    return out;
  }
  return v;
}

/** The redaction the settings ask for: built-in, none, or your function (errors leave the value out). */
export function redactorFor(setting: boolean | Redactor): (v: unknown) => unknown {
  if (setting === false) return (v) => v;
  if (setting === true) return redactValue;
  return (v) => {
    try {
      return setting(v);
    } catch {
      return REDACTED;
    }
  };
}
