import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    // Each test boots an in-memory PGlite and hashes passwords with scrypt; on a loaded CI runner
    // (macOS, beside the desktop suites) that has taken past 30 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
