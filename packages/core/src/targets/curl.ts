import { HttpTarget, type HttpTargetConfig, type KV } from '../specs.js';

/*
 * Turns a cURL command (e.g. "Copy as cURL" from browser devtools or API docs) into an HTTP
 * target config. Supports bash-style quoting including $'…', line continuations, and the common
 * flags: -X -H -d/--data* --json -F -u -G -A -b -e -m -L --url. Windows cmd ^-escaping is not handled.
 */

export function parseCurl(command: string): HttpTargetConfig {
  const args = tokenize(command);
  if (args[0] === 'curl') args.shift();

  let method: string | undefined;
  let url = '';
  const headers: KV[] = [];
  const data: string[] = [];
  const urlencoded: string[] = [];
  const formParts: { name: string; kind: 'text' | 'file'; value: string; filename: string; contentType: string }[] = [];
  let user: string | undefined;
  let getMode = false;
  let jsonFlag = false;
  let timeoutMs: number | undefined;
  let followRedirects = true;

  const takeValue = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) throw new Error(`Missing value after ${flag}`);
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    // --flag=value form
    let inline: string | undefined;
    if (a.startsWith('--') && a.includes('=')) {
      inline = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    const val = () => {
      if (inline !== undefined) return inline;
      const v = takeValue(i, a);
      i++;
      return v;
    };
    // Short flags glued to their value: -XPOST, -H'…'
    if (/^-[XHdFuAbemo]./.test(a) && !a.startsWith('--')) {
      args.splice(i + 1, 0, a.slice(2));
      a = a.slice(0, 2);
    }
    switch (a) {
      case '-X':
      case '--request':
        method = val().toUpperCase();
        break;
      case '-H':
      case '--header': {
        const h = val();
        const idx = h.indexOf(':');
        if (idx > 0) {
          const key = h.slice(0, idx).trim();
          const value = h.slice(idx + 1).trim();
          if (key.toLowerCase() !== 'content-length') headers.push({ key, value, enabled: true });
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        // "@file" bodies can't be read here; the literal is kept so the user can replace it.
        data.push(val());
        break;
      case '--data-urlencode':
        urlencoded.push(val());
        break;
      case '--json':
        data.push(val());
        jsonFlag = true;
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const f = val();
        const eq = f.indexOf('=');
        const name = eq > 0 ? f.slice(0, eq) : f;
        let value = eq > 0 ? f.slice(eq + 1) : '';
        if (value.startsWith('@') && a !== '--form-string') {
          const [path, ...opts] = value.slice(1).split(';');
          const type = opts.find((o) => o.startsWith('type='))?.slice(5) ?? '';
          const filename = opts.find((o) => o.startsWith('filename='))?.slice(9) ?? path.split(/[\\/]/).pop() ?? '';
          // The file comes from a dataset column; the user picks it (defaults to a column named "file").
          formParts.push({ name, kind: 'file', value: '{{file}}', filename, contentType: type });
        } else {
          value = value.replace(/^"(.*)"$/s, '$1');
          formParts.push({ name, kind: 'text', value, filename: '', contentType: '' });
        }
        break;
      }
      case '-u':
      case '--user':
        user = val();
        break;
      case '-G':
      case '--get':
        getMode = true;
        break;
      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: val(), enabled: true });
        break;
      case '-b':
      case '--cookie':
        headers.push({ key: 'Cookie', value: val(), enabled: true });
        break;
      case '-e':
      case '--referer':
        headers.push({ key: 'Referer', value: val(), enabled: true });
        break;
      case '-m':
      case '--max-time':
        timeoutMs = Math.round(Number(val()) * 1000) || undefined;
        break;
      case '--url':
        url = val();
        break;
      case '-L':
      case '--location':
        followRedirects = true;
        break;
      case '--max-redirs':
      case '-o':
      case '--output':
      case '--connect-timeout':
      case '--retry':
        val();
        break;
      default:
        if (a.startsWith('-')) break; // flags without a value we don't need: -s -S -v -i -k --compressed …
        if (!url) url = a;
    }
  }

  if (!url) throw new Error('No URL found in the cURL command');
  if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;

  // Split the query string into editable parameters.
  const query: KV[] = [];
  const qIndex = url.indexOf('?');
  if (qIndex >= 0) {
    for (const pair of url.slice(qIndex + 1).split('&')) {
      if (!pair) continue;
      const [k, v] = splitPair(pair);
      query.push({ key: safeDecode(k), value: safeDecode(v), enabled: true });
    }
    url = url.slice(0, qIndex);
  }

  const headerValue = (name: string) => headers.find((h) => h.key.toLowerCase() === name)?.value ?? '';
  const contentType = headerValue('content-type');
  let body: HttpTargetConfig['body'] = { type: 'none', content: '', contentType: '', form: [], parts: [], binary: '' };

  if (getMode && (data.length || urlencoded.length)) {
    for (const d of [...data, ...urlencoded.map(encodeUrlencodeArg)]) {
      for (const pair of d.split('&')) {
        const [k, v] = splitPair(pair);
        if (k) query.push({ key: safeDecode(k), value: safeDecode(v), enabled: true });
      }
    }
  } else if (formParts.length) {
    body = { ...body, type: 'multipart', parts: formParts };
    method ??= 'POST';
  } else if (data.length || urlencoded.length) {
    method ??= 'POST';
    const joined = data.join('&');
    const parsed = tryJson(joined);
    if (jsonFlag || /json/i.test(contentType) || (parsed !== undefined && !urlencoded.length && typeof parsed === 'object')) {
      body = { ...body, type: 'json', content: parsed !== undefined ? JSON.stringify(parsed, null, 2) : joined };
      if (jsonFlag && !headerValue('content-type')) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      if (jsonFlag && !headerValue('accept')) headers.push({ key: 'Accept', value: 'application/json', enabled: true });
    } else if (urlencoded.length || /x-www-form-urlencoded/i.test(contentType) || (!contentType && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(joined))) {
      const form: KV[] = [];
      for (const d of [...data, ...urlencoded.map(encodeUrlencodeArg)]) {
        for (const pair of d.split('&')) {
          const [k, v] = splitPair(pair);
          if (k) form.push({ key: safeDecode(k), value: safeDecode(v), enabled: true });
        }
      }
      body = { ...body, type: 'form', form };
    } else {
      body = { ...body, type: 'text', content: joined, contentType };
    }
  }

  // Content-Type for multipart must come from the client (boundary); drop a pasted one.
  const finalHeaders = body.type === 'multipart' ? headers.filter((h) => h.key.toLowerCase() !== 'content-type') : headers;

  let auth: HttpTargetConfig['auth'] = { type: 'none' };
  if (user !== undefined) {
    const idx = user.indexOf(':');
    auth = { type: 'basic', username: idx >= 0 ? user.slice(0, idx) : user, password: idx >= 0 ? user.slice(idx + 1) : '' };
  }

  const config = {
    kind: 'http',
    method: method ?? 'GET',
    url,
    query,
    headers: finalHeaders,
    auth,
    body,
    followRedirects,
    ...(timeoutMs ? { timeoutMs } : {}),
  };
  // Parsed twice so nested defaults (streaming, scripts) are filled; see normalizeTargetConfig.
  return HttpTarget.parse(HttpTarget.parse(config));
}

/** "key=value" split at the first "=" only: values such as base64 tokens keep their own "=". */
function splitPair(pair: string): [string, string] {
  const eq = pair.indexOf('=');
  return eq < 0 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
}

function encodeUrlencodeArg(arg: string) {
  // --data-urlencode "name=value with spaces" → name=value%20with%20spaces
  const eq = arg.indexOf('=');
  if (eq < 0) return encodeURIComponent(arg);
  return `${arg.slice(0, eq)}=${encodeURIComponent(arg.slice(eq + 1))}`;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Bash-like word splitting: '…', "…", $'…', backslash escapes and line continuations. */
export function tokenize(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
    } else if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      cur += src.slice(i + 1, end < 0 ? undefined : end);
      has = true;
      i = end < 0 ? src.length : end + 1;
    } else if (ch === '$' && src[i + 1] === "'") {
      i += 2;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          if (n === 'x') {
            cur += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          if (n === 'u') {
            cur += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          cur += map[n] ?? n;
          i += 2;
        } else cur += src[i++];
      }
      has = true;
      i++;
    } else if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && /["\\$`]/.test(src[i + 1] ?? '')) {
          cur += src[i + 1];
          i += 2;
        } else cur += src[i++];
      }
      has = true;
      i++;
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[i + 1];
      has = true;
      i += 2;
    } else {
      cur += ch;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}
