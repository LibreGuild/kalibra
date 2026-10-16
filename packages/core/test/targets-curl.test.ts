import { describe, expect, it } from 'vitest';
import { parseCurl, tokenize } from '../src/targets/curl.js';

describe('parseCurl', () => {
  it('parses a JSON POST copied from browser devtools', () => {
    const cfg = parseCurl(`curl 'https://api.example.com/v1/chat?lang=en&debug=1' \\
  -H 'authorization: Bearer abc' \\
  -H 'content-type: application/json' \\
  --data-raw '{"message":"hi","n":2}' \\
  --compressed`);
    expect(cfg.method).toBe('POST');
    expect(cfg.url).toBe('https://api.example.com/v1/chat');
    expect(cfg.query).toEqual([
      { key: 'lang', value: 'en', enabled: true },
      { key: 'debug', value: '1', enabled: true },
    ]);
    expect(cfg.headers.map((h) => h.key)).toEqual(['authorization', 'content-type']);
    expect(cfg.body.type).toBe('json');
    expect(JSON.parse(cfg.body.content)).toEqual({ message: 'hi', n: 2 });
  });

  it('handles -X, glued flags, and $-quoted strings', () => {
    // In $'…', \\n is a literal backslash-n (what browsers emit for JSON escapes).
    const cfg = parseCurl(`curl -XPUT -H"X-Id: 7" https://x.test/items/1 --data $'{"note":"line\\\\nbreak"}'`);
    expect(cfg.method).toBe('PUT');
    expect(cfg.headers).toEqual([{ key: 'X-Id', value: '7', enabled: true }]);
    expect(JSON.parse(cfg.body.content)).toEqual({ note: 'line\nbreak' });
  });

  it('maps -F to multipart parts, with files left for a column', () => {
    const cfg = parseCurl(`curl https://stt.test/transcribe -F "file=@sample.wav;type=audio/wav" -F language=en -H "Content-Type: multipart/form-data"`);
    expect(cfg.method).toBe('POST');
    expect(cfg.body.type).toBe('multipart');
    expect(cfg.body.parts).toEqual([
      { name: 'file', kind: 'file', value: '{{file}}', filename: 'sample.wav', contentType: 'audio/wav' },
      { name: 'language', kind: 'text', value: 'en', filename: '', contentType: '' },
    ]);
    expect(cfg.headers).toEqual([]);
  });

  it('maps urlencoded data to a form body and -u to basic auth', () => {
    const cfg = parseCurl(`curl -u alice:s3cret https://x.test/token -d grant_type=client_credentials -d scope=read`);
    expect(cfg.body.type).toBe('form');
    expect(cfg.body.form).toEqual([
      { key: 'grant_type', value: 'client_credentials', enabled: true },
      { key: 'scope', value: 'read', enabled: true },
    ]);
    expect(cfg.auth).toEqual({ type: 'basic', username: 'alice', password: 's3cret' });
  });

  it('puts -G data into the query string and adds a scheme when missing', () => {
    const cfg = parseCurl(`curl -G localhost:8080/search --data-urlencode "q=hello world"`);
    expect(cfg.method).toBe('GET');
    expect(cfg.url).toBe('http://localhost:8080/search');
    expect(cfg.query).toEqual([{ key: 'q', value: 'hello world', enabled: true }]);
  });

  it('--json sets JSON headers; -m sets the timeout', () => {
    const cfg = parseCurl(`curl --json '{"a":1}' -m 2.5 https://x.test/a`);
    expect(cfg.body.type).toBe('json');
    expect(cfg.timeoutMs).toBe(2500);
    expect(cfg.headers.map((h) => h.key)).toEqual(['Content-Type', 'Accept']);
  });

  it('throws without a URL', () => {
    expect(() => parseCurl('curl -X POST')).toThrow(/No URL/);
  });

  it('tokenizes quoting and escapes', () => {
    expect(tokenize(`a "b c" 'd e' f\\ g $'h\\ti'`)).toEqual(['a', 'b c', 'd e', 'f g', 'h\ti']);
  });
});
