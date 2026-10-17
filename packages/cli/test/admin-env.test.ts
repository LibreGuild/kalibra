import { describe, expect, it } from 'vitest';
import { adminFromEnv } from '../src/admin-env.js';

describe('first administrator from the environment', () => {
  it('drops the trailing newline secret managers add, and nothing else', () => {
    expect(adminFromEnv({ KALIBRA_ADMIN_USERNAME: 'admin\n', KALIBRA_ADMIN_PASSWORD: ' pass word \n' })).toEqual({ username: 'admin', password: ' pass word ' });
    expect(adminFromEnv({ KALIBRA_ADMIN_USERNAME: 'admin', KALIBRA_ADMIN_PASSWORD: 'secret\r\n' })?.password).toBe('secret');
  });

  it('needs both values', () => {
    expect(adminFromEnv({ KALIBRA_ADMIN_USERNAME: 'admin' })).toBeUndefined();
    expect(adminFromEnv({ KALIBRA_ADMIN_USERNAME: ' ', KALIBRA_ADMIN_PASSWORD: 'x' })).toBeUndefined();
    expect(adminFromEnv({ KALIBRA_ADMIN_PASSWORD: '\n', KALIBRA_ADMIN_USERNAME: 'admin' })).toBeUndefined();
  });
});
