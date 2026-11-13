import { defineConfig } from 'vitest/config';
import { webVitalsSource } from './vite.web-vitals.ts';

export default defineConfig({
  plugins: [webVitalsSource()],
  test: {
    environment: 'node',
    // The default 5 s per test and hook is too tight on a shared CI runner under load (macOS most of
    // all): correct tests that take well under a second alone have timed out there. 20 s still
    // catches a hang.
    // Windows gets 120 s: its suites on file-backed SQLite (change intelligence, screenshots, sync)
    // run several times slower there, where every write is synced, and a slow runner triples that
    // again: tests that take 20 to 30 s on most Windows runs took 54 and 55 s on one (2026-11-12).
    // A test that needs no file uses the in-memory store (`memoryStore` in crawl/__tests__/run-fakes.ts).
    testTimeout: process.platform === 'win32' ? 120_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 120_000 : 20_000,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
