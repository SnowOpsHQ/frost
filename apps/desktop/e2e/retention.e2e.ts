// Specs: specs/retention.spec.ts (PURGE_NOW, USAGE_NOTE, RETENTION_LABELS), specs/projects.spec.ts
// Acceptance: specs/retention.feature.md (End to end). One loopback page whose text changes on each
// request, so each "Capture now" makes a new version.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { PURGE_NOW, RETENTION_LABELS, USAGE_NOTE } from '@app/specs/retention.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const RUN_WAIT = AUDIT_WAIT * 2;
const PROJECT = 'Counter site';

/** A page whose heading and text name how many times it was served. */
async function startSite() {
  let served = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    if (pathname !== '/counter') return void response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
    served += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Counter ${served}</title>
<meta name="description" content="A page that changes each time it is served: this is visit number ${served} of the test.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><h1>Visit number ${served}</h1><p>This page was served ${served} times so far, so every capture of it finds a change.</p></main></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
let site: Awaited<ReturnType<typeof startSite>>;
const { go, activeTab } = chromeHelpers(
  () => app,
  () => page,
);
const counter = () => `${site.origin}/counter`;

const sheet = () => page.getByTestId('projects-view');
const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const status = () => page.getByTestId('projects-status');
const usageRow = (id: string) => page.locator(`[data-testid="retention-usage-row"][data-row="${id}"] dd`);

async function openChanges(): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'changes') await railItem('changes').click();
  await expect(page.getByTestId('changes')).toBeVisible();
}

/** Main's message box answers `index` for the test; every question's detail is kept. */
async function answerDialogs(index: number): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    const holder = globalThis as { __retentionBoxes?: string[]; __retentionBox?: typeof dialog.showMessageBox };
    holder.__retentionBox ??= dialog.showMessageBox;
    holder.__retentionBoxes = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((arg): arg is { detail: string } => typeof arg === 'object' && arg !== null && 'detail' in arg);
      holder.__retentionBoxes!.push(options?.detail ?? '');
      return { response: index, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, index);
}
const dialogsAsked = () => app.evaluate(() => (globalThis as { __retentionBoxes?: string[] }).__retentionBoxes ?? []);

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.evaluate(({ dialog }) => {
    const holder = globalThis as { __retentionBox?: typeof dialog.showMessageBox };
    if (holder.__retentionBox) dialog.showMessageBox = holder.__retentionBox;
  });
  await closeApp(app);
  await site?.close();
});

test('retention-keep-one-version', async () => {
  test.setTimeout(RUN_WAIT * 4 + 60_000);
  await go(counter());
  await expect(activeTab()).toHaveAttribute('title', /^Counter \d+$/);
  await openChanges();
  await page.getByTestId('changes-open-projects').click();
  await expect(sheet()).toBeVisible();
  await page.getByTestId('projects-create-name').fill(PROJECT);
  await page.getByTestId('projects-create').click();
  await expect(page.getByTestId('projects-name')).toHaveText(PROJECT);
  await page.getByTestId('projects-page-url').fill(counter());
  await page.getByTestId('projects-page-add').click();
  await expect(status()).toHaveText('Page added.');
  // Keep everything to start with: nothing to purge.
  await expect(page.locator('[data-testid="retention-mode"][data-mode="forever"]')).toBeChecked();
  await expect(page.getByTestId('retention-preview')).toHaveText('Keep everything: purging removes nothing.');
  await expect(page.getByTestId('retention-usage-note')).toHaveText(USAGE_NOTE);

  // Three runs, three versions (the page changed each time).
  for (let n = 1; n <= 3; n++) {
    await page.getByTestId('projects-capture').click();
    await expect(page.getByTestId('projects-run')).toHaveAttribute('data-state', 'done', { timeout: RUN_WAIT });
    await expect(page.getByTestId('projects-run-target').first()).toHaveAttribute('data-outcome', 'captured');
    await expect(usageRow('captures')).toHaveText(String(n));
  }
  await expect(usageRow('versions')).toHaveText('3');

  // Keep the last 1 version.
  await page.locator('[data-testid="retention-mode"][data-mode="versions"]').check();
  await expect(page.locator('[data-testid="retention-mode"][data-mode="versions"]').locator('xpath=..')).toContainText(RETENTION_LABELS.versions);
  await page.getByTestId('retention-value').fill('1');
  await page.getByTestId('retention-save').click();
  await expect(status()).toHaveText('Retention saved.');
  await expect(page.getByTestId('retention-preview')).toContainText('Purging now would remove 2 captures, 2 versions, 2 diffs and 0 screenshots (≈ ');

  // Purge now, confirmed in main's dialog (which shows the plan).
  await answerDialogs(PURGE_NOW.confirmIndex);
  await page.getByTestId('retention-purge').click();
  await expect(status()).toContainText('Purged 2 captures, 2 versions, 2 diffs and 0 screenshots (≈ ');
  expect(await dialogsAsked()).toEqual([expect.stringContaining('2 captures, 2 versions, 2 diffs and 0 screenshots')]);
  expect((await dialogsAsked())[0]).toContain(PROJECT);
  // The purge log lists it; usage is down to one capture and one version; nothing more to purge.
  await expect(page.getByTestId('retention-log-entry')).toHaveCount(1);
  await expect(page.getByTestId('retention-log-entry')).toHaveAttribute('data-reason', 'purge-now');
  await expect(page.getByTestId('retention-log-what')).toContainText('2 captures, 2 versions, 2 diffs and 0 screenshots');
  await expect(usageRow('captures')).toHaveText('1');
  await expect(usageRow('versions')).toHaveText('1');
  await expect(page.getByTestId('retention-preview')).toHaveText('Purging now would remove nothing.');
  await page.getByTestId('projects-close').click();
  await expect(sheet()).toHaveCount(0);

  // The Changes panel's history of the page in the project (read again on a fresh load): one version left.
  await go(counter());
  await expect(activeTab()).toHaveAttribute('title', /^Counter \d+$/);
  await openChanges();
  await expect(page.getByTestId('changes-project').locator('option:checked')).toHaveText(PROJECT);
  await expect(page.getByTestId('changes-version')).toHaveCount(1);
});
