import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node's test runner owns the separate native offline-instrumentation checks.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
