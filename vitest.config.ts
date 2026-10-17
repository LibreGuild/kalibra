import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Runs every Hub/Engine against Postgres when KALIBRA_TEST_DATABASE_URL is set (see the file).
    setupFiles: ['./vitest.setup.ts'],
  },
});
