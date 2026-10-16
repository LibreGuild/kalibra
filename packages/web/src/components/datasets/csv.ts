/** Minimal RFC 4180 CSV reader (quotes, escaped quotes, newlines in quotes). Used only for previews and column mapping. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((f) => f !== '')) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== '' || record.length) {
    record.push(field);
    if (record.some((f) => f !== '')) records.push(record);
  }
  const [head = [], ...body] = records;
  const headers = head.map((h) => h.trim());
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}

export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
