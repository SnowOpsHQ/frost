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
  expect: {
    timeout: 10_000,
    // The screenshot baseline (visual.e2e.ts; specs/visual-baseline.feature.md): no other suite
    // compares screenshots.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002, scale: 'css' },
  },
  // Baselines are Linux CI's renderings, e.g. e2e/__screenshots__/visual.e2e.ts/seo-overview-dark.png
  // (no platform suffix: only Linux compares).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  // 'missing', in CI too: for a missing baseline Playwright then renders the state and writes its
  // `*-actual.png` under test-results/ (uploaded as the `playwright-report` artifact: the spec's
  // baseline procedure), where 'none' fails without rendering anything. The baseline it also writes
  // into CI's checkout is thrown away, and visual.e2e.ts fails a capture whose baseline was missing
  // in CI itself, so a missing baseline still fails CI.
  updateSnapshots: 'missing',
  forbidOnly: !!process.env['CI'],
  // In CI an HTML report is kept too (uploaded by .github/workflows/ci.yml when the job fails).
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
});
