import { describe, expect, it } from 'vitest';
import { MAX_FIELD_BYTES, toJsonSafe, describeError } from '../src/serialize.js';
import { redactString, redactValue, REDACTED } from '../src/redact.js';
import { resolveConfig } from '../src/config.js';

describe('JSON-safe copies', () => {
  it('handles cycles, BigInt, Buffers, Maps, Sets, Dates, Errors and functions', () => {
    const a: any = { name: 'a', n: 10n, buf: Buffer.from('hello'), when: new Date('2026-01-02T03:04:05Z'), err: new RangeError('bad'), fn: function named() {}, map: new Map([['k', 1]]), set: new Set([1, 2]) };
    a.self = a;
    a.list = [a, undefined, NaN];
    expect(toJsonSafe(a)).toEqual({
      name: 'a',
      n: '10',
      buf: '[5 bytes]',
      when: '2026-01-02T03:04:05.000Z',
      err: { name: 'RangeError', message: 'bad' },
      fn: '[function named]',
      map: { k: 1 },
      set: [1, 2],
      self: '[circular]',
      list: ['[circular]', null, 'NaN'],
    });
    expect(JSON.stringify(toJsonSafe(a))).toBeTruthy();
  });

  it('keeps the same object seen twice (not a cycle)', () => {
    const shared = { x: 1 };
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it(`keeps each field under ${MAX_FIELD_BYTES / 1024} KB, cheaply`, () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => ({ id: i, text: 'lorem ipsum '.repeat(100) }));
    const t0 = performance.now();
    const out: any = toJsonSafe(huge);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out.__truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_FIELD_BYTES + 64);
    // Under the limit, values are copied whole.
    const small = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    expect(toJsonSafe(small)).toEqual(small);
    expect(JSON.stringify(toJsonSafe('x'.repeat(100_000))).length).toBeLessThan(MAX_FIELD_BYTES);
  });

  it('caps depth and long arrays', () => {
    let deep: any = { v: 1 };
    for (let i = 0; i < 30; i++) deep = { deep };
    expect(JSON.stringify(toJsonSafe(deep))).toContain('[too deep]');
    const arr = toJsonSafe(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(201);
    expect(arr[200]).toBe('… 300 more items');
  });

  it('describes errors briefly', () => {
    expect(describeError(new TypeError('nope'))).toBe('TypeError: nope');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ code: 7 })).toBe('{"code":7}');
  });
});

describe('redaction', () => {
  it('replaces emails, phone and card numbers, and API keys', () => {
    const s = redactString(
      'mail jane@corp.example or +44 20 7946 0958, card 4242-4242-4242-4242, keys sk-abcdefghijklmnopqrstu AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwxyz0123456789 kik_abcdefghijklmnopqrstuv',
    );
    expect(s).toBe(`mail ${REDACTED} or ${REDACTED}, card ${REDACTED}, keys ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it('leaves ordinary numbers, ids and dates alone', () => {
    for (const s of ['order 12345', 'total 1,234,567.89', '2026-10-17T10:00:00Z', 'invoice 4111111111111112', 'v1.2.3', 'version 10.20.30.40']) expect(redactString(s)).toBe(s);
  });

  it('walks nested values', () => {
    expect(redactValue({ a: ['x@y.io', { b: 'ok' }], n: 5 })).toEqual({ a: [REDACTED, { b: 'ok' }], n: 5 });
  });
});

describe('settings from the environment', () => {
  it('reads KALIBRA_* and applies defaults', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { KALIBRA_URL: 'http://kalibra.test:4000/', KALIBRA_KEY: 'kik_env', KALIBRA_PROJECT: 'P', KALIBRA_SAMPLE_RATE: '0.25', KALIBRA_ENVIRONMENT: 'staging' });
      expect(resolveConfig()).toMatchObject({ enabled: true, url: 'http://kalibra.test:4000', key: 'kik_env', project: 'P', sampleRate: 0.25, environment: 'staging' });
      process.env.KALIBRA_ENABLED = '0';
      expect(resolveConfig({ enabled: true }).enabled).toBe(false);
      process.env.KALIBRA_ENABLED = 'true';
      expect(resolveConfig({ enabled: false }).enabled).toBe(false);
      expect(resolveConfig({ sampleRate: 7 }).sampleRate).toBe(1);
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('KALIBRA_') && !(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
