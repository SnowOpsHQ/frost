import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The default 5 s per test and hook is too tight on a shared CI runner under load (macOS most of
    // all): correct tests that take well under a second alone have timed out there. 20 s still
    // catches a hang.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
