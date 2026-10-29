import { defineConfig } from 'vitest/config';
import { webVitalsSource } from './vite.web-vitals.ts';

export default defineConfig({
  plugins: [webVitalsSource()],
  test: {
    environment: 'node',
    // The default 5 s per test and hook is too tight on a shared CI runner under load (macOS most of
    // all): correct tests that take well under a second alone have timed out there. 20 s still
    // catches a hang.
    // Windows gets 60 s: its suites on file-backed SQLite (change intelligence, screenshots) run
    // several times slower there, where every write is synced.
    testTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 20_000,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
