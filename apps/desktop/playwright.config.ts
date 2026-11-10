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
    // compares screenshots. `threshold: 0`: any change of a pixel's colour counts as a difference
    // (the default 0.2 lets a subtle token colour shift pass), except pixels Playwright's pixelmatch
    // classifies as anti-aliasing, which it never counts; at most 0.2 % of pixels may differ.
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', threshold: 0, maxDiffPixelRatio: 0.002, scale: 'css' },
  },
  // Baselines are Linux CI's renderings, e.g. e2e/__screenshots__/visual.e2e.ts/seo-overview-dark.png
  // (no platform suffix: only Linux compares).
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  // 'missing', in CI too. For a missing baseline Playwright renders the state, writes it as the
  // baseline (into CI's throwaway checkout) and as `*-actual.png` under test-results/ (kept for
  // passing tests too: `preserveOutput` is 'always'; uploaded as the `playwright-report` artifact,
  // the spec's baseline procedure), and the test passes, so the suite's apps stay shared as in a
  // green run. Not 'none': it fails a missing baseline without rendering anything, so there is no
  // actual to adopt. Not 'default': it writes the actual but fails each test that had a missing
  // one, and a failure replaces the worker, so a baseline run would relaunch the app for every test.
  // A missing baseline still fails CI: visual.e2e.ts's 'every capture has a baseline' checks that
  // every capture's images are committed.
  updateSnapshots: 'missing',
  forbidOnly: !!process.env['CI'],
  // In CI an HTML report is kept too (uploaded by .github/workflows/ci.yml when the job fails).
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
});
