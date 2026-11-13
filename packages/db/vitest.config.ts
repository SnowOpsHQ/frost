import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The default 5 s per test and hook is too tight on a shared CI runner under load (macOS most of
    // all): correct tests that take well under a second alone have timed out there. 20 s still
    // catches a hang.
    // Windows gets 120 s, as the desktop app's suites do (`apps/desktop/vitest.config.ts`): these
    // tests open file-backed databases, every write there is synced, and a slow runner triples the
    // time. `non-regular-file-moved-aside` opens three and passed 20 s twice (2026-11-12), in a file
    // whose seven tests take 15 to 19 s on an ordinary Windows run.
    testTimeout: process.platform === 'win32' ? 120_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 120_000 : 20_000,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
