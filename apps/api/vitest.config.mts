import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The *.pg.spec.ts suites run against PGlite (src/testing/pglite.ts).
    testTimeout: 60_000,
  },
});
