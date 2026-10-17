import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE_PATH, publicOrigin } from '../src/base-path.js';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

/** Everything Kalibra serves starts with one path, so a load balancer can route on it. */
describe('base path', () => {
  it('is the same in the server, the web UI and both SDKs', () => {
    expect(BASE_PATH).toBe('/kalibra');
    expect(read('packages/web/vite.config.ts')).toContain(`const base = '${BASE_PATH}/';`);
    expect(read('packages/sdk/src/config.ts')).toContain(`export const BASE_PATH = '${BASE_PATH}';`);
    expect(read('sdks/python/src/kalibra/_transport.py')).toContain(`BASE_PATH = "${BASE_PATH}"`);
  });

  it('turns a configured public address into the origin', () => {
    for (const url of ['https://k.example.com', 'https://k.example.com/', 'https://k.example.com/kalibra', 'https://k.example.com/kalibra/', ' https://k.example.com// ']) {
      expect(publicOrigin(url), url).toBe('https://k.example.com');
    }
    expect(publicOrigin(undefined)).toBeUndefined();
    expect(publicOrigin('')).toBeUndefined();
    // Only a whole /kalibra segment is the base path.
    expect(publicOrigin('https://k.example.com/notkalibra')).toBe('https://k.example.com/notkalibra');
  });
});
