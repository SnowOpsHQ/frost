import { defineConfig } from '@playwright/test';

// Electron e2e suite (specs/ipc-e2e.feature.md). Runs against the unpackaged build in .vite/build,
// so `pnpm build` must run first (Turbo's `test:e2e` depends on `build`). Needs a display.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
});
