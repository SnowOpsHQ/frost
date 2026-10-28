// Specs: specs/projects.spec.ts (DELETE_PROJECT, CAPTURE_RUN_NOTE, PROJECTS_TITLE), specs/capture-db.spec.ts
// (CAPTURES_DIR_NAME), specs/screenshot.spec.ts (SCREENSHOTS_DIR_NAME)
// Acceptance: specs/projects.feature.md (End to end). Loopback pages only: queries (search engines)
// are unit-tested, never visited here.
import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CAPTURES_DIR_NAME } from '@app/specs/capture-db.spec';
import { CAPTURE_RUN_NOTE, DELETE_PROJECT, PROJECTS_TITLE } from '@app/specs/projects.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { SCREENSHOTS_DIR_NAME } from '@app/specs/screenshot.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const RUN_WAIT = AUDIT_WAIT * 3;
const PROJECT = 'Coffee site';

function pageHtml(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} guide</title>
<meta name="description" content="The ${name} guide: how to brew it at home, step by step, with the gear you already have.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header><nav aria-label="Site"><a href="/alpha">Alpha</a> <a href="/beta">Beta</a></nav></header>
<main><h1>The ${name} guide</h1><p>Grind the beans, heat the water, and pour slowly over the grounds for the ${name} method.</p></main>
<footer><p>Written by the frost test kitchen.</p></footer></body></html>`;
}

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    if (pathname === '/alpha' || pathname === '/beta') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(pageHtml(pathname.slice(1)));
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
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
const { go, strip, activeTab } = chromeHelpers(
  () => app,
  () => page,
);
const alpha = () => `${site.origin}/alpha`;
const beta = () => `${site.origin}/beta`;

const sheet = () => page.getByTestId('projects-view');
const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const projectItem = (name: string) => page.locator('[data-testid="projects-item"]').filter({ hasText: name });
const pages = () => page.getByTestId('projects-page');
const targets = () => page.getByTestId('projects-run-target');

/** Opens the Changes panel (the sidebar too) if it is not shown. */
async function openChanges(): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'changes') await railItem('changes').click();
  await expect(page.getByTestId('changes')).toBeVisible();
}

/** Opens the Projects sheet from the Changes panel's Projects button. */
async function openSheet(): Promise<void> {
  await openChanges();
  await page.getByTestId('changes-open-projects').click();
  await expect(sheet()).toBeVisible();
}

/** Main's message box answers `index` for the test; every question is counted. */
async function answerDialogs(index: number): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    const holder = globalThis as { __projectBoxes?: string[]; __projectBox?: typeof dialog.showMessageBox };
    holder.__projectBox ??= dialog.showMessageBox;
    holder.__projectBoxes = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((arg): arg is { detail: string } => typeof arg === 'object' && arg !== null && 'detail' in arg);
      holder.__projectBoxes!.push(options?.detail ?? '');
      return { response: index, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, index);
}
const dialogsAsked = () => app.evaluate(() => (globalThis as { __projectBoxes?: string[] }).__projectBoxes ?? []);

let shotsDir: string;
/** The PNG files in the profile's screenshot directory. */
const screenshotFiles = (): string[] => {
  try {
    return readdirSync(shotsDir).filter((name) => name.endsWith('.png'));
  } catch {
    return [];
  }
};

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  shotsDir = path.join(await app.evaluate(({ app }) => app.getPath('userData')), CAPTURES_DIR_NAME, SCREENSHOTS_DIR_NAME);
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('projects-create-and-add-pages', async () => {
  await go(alpha());
  await expect(activeTab()).toHaveAttribute('title', 'alpha guide');
  await openSheet();
  await expect(sheet().getByRole('heading', { level: 1 })).toHaveText(PROJECTS_TITLE);
  // Over the page column, like History: the page area gives way.
  await expect(page.locator('.page-column')).toHaveAttribute('data-projects', 'open');
  await expect.poll(async () => (await page.locator('.page-area').boundingBox())?.height ?? 0).toBe(0);
  // Unfiled first.
  await expect(page.getByTestId('projects-item').first()).toHaveAttribute('data-unfiled', 'true');

  await page.getByTestId('projects-create-name').fill(PROJECT);
  await page.getByTestId('projects-create').click();
  await expect(page.getByTestId('projects-name')).toHaveText(PROJECT);
  await expect(projectItem(PROJECT)).toHaveAttribute('data-selected', 'true');
  for (const url of [alpha(), beta()]) {
    await page.getByTestId('projects-page-url').fill(url);
    await page.getByTestId('projects-page-add').click();
    await expect(page.getByTestId('projects-status')).toHaveText('Page added.');
  }
  await expect(pages()).toHaveCount(2);
  await expect(pages().nth(0)).toHaveAttribute('data-url', alpha());
  await expect(pages().nth(1)).toHaveAttribute('data-url', beta());
  await expect(pages().first().getByTestId('projects-page-last')).toHaveText('Not captured yet');
  // Not a web address: refused, nothing added.
  await page.getByTestId('projects-page-url').fill('javascript:alert(1)');
  await page.getByTestId('projects-page-add').click();
  await expect(page.getByTestId('projects-status')).toHaveText('Enter an http or https address.');
  await expect(pages()).toHaveCount(2);
  // Esc closes the sheet; the page is back.
  await page.getByTestId('projects-page-url').press('Escape');
  await expect(sheet()).toHaveCount(0);
  await expect.poll(async () => (await page.locator('.page-area').boundingBox())?.height ?? 0).toBeGreaterThan(100);
});

test('projects-capture-now', async () => {
  const before = await activeTab().getAttribute('data-tab-id');
  await expect(strip()).toHaveCount(1);
  await openSheet();
  await projectItem(PROJECT).getByTestId('projects-item-open').click();
  await expect(page.getByTestId('projects-run-note')).toHaveText(CAPTURE_RUN_NOTE);
  await page.getByTestId('projects-capture-screenshots').check();
  await page.getByTestId('projects-capture').click();
  // The run's own tab, in front; the sheet a band above it.
  await expect(strip()).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId('projects-run')).toBeVisible();
  // Both targets captured, each with its viewport screenshot.
  await expect(page.getByTestId('projects-run')).toHaveAttribute('data-state', 'done', { timeout: RUN_WAIT });
  await expect(targets()).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(targets().nth(index)).toHaveAttribute('data-outcome', 'captured');
    await expect(targets().nth(index)).toHaveAttribute('data-screenshot', 'saved');
  }
  await expect(page.getByTestId('projects-run-progress')).toHaveText('Done: 2 of 2 captured');
  // The run's tab is closed, and the tab in front before is again.
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('data-tab-id', before ?? '');
  await expect(activeTab()).toHaveAttribute('title', 'alpha guide');
  // Each page shows its capture.
  await expect(pages().first()).toHaveAttribute('data-captured', 'true');
  await expect(pages().first().getByTestId('projects-page-changes')).toHaveText('First version');
  await expect(pages().nth(1)).toHaveAttribute('data-captured', 'true');
  await page.getByTestId('projects-close').click();
  await expect(sheet()).toHaveCount(0);

  // The Changes panel of one of the pages: filed in the project (its picker starts there), one version.
  await go(beta());
  await expect(activeTab()).toHaveAttribute('title', 'beta guide');
  await openChanges();
  await expect(page.getByTestId('changes-project').locator('option:checked')).toHaveText(PROJECT);
  await expect(page.getByTestId('changes-version')).toHaveCount(1);
  await expect(page.getByTestId('screenshot')).toHaveCount(1);
  expect(screenshotFiles()).toHaveLength(2);
});

test('projects-delete-purges', async () => {
  await openSheet();
  await projectItem(PROJECT).getByTestId('projects-item-open').click();
  // Cancel in main's dialog: nothing goes.
  await answerDialogs(DELETE_PROJECT.dialog.cancelId);
  await page.getByTestId('projects-delete').click();
  await expect(page.getByTestId('projects-status')).toHaveText('Nothing was deleted.');
  expect(await dialogsAsked()).toEqual([expect.stringContaining(PROJECT)]);
  await expect(projectItem(PROJECT)).toHaveCount(1);
  // Confirmed: the project, its captures and its screenshots (rows and files) go.
  await answerDialogs(DELETE_PROJECT.confirmIndex);
  await page.getByTestId('projects-delete').click();
  await expect(page.getByTestId('projects-status')).toHaveText('Project deleted, with 2 captures and 2 screenshots.');
  await expect(projectItem(PROJECT)).toHaveCount(0);
  await expect.poll(() => screenshotFiles()).toEqual([]);
  await page.getByTestId('projects-close').click();
  // The Changes panel of the page has nothing left of it.
  await go(alpha());
  await expect(activeTab()).toHaveAttribute('title', 'alpha guide');
  await openChanges();
  await expect(page.getByTestId('changes-empty')).toBeVisible();
  await expect(page.getByTestId('screenshot')).toHaveCount(0);
  await expect(page.getByTestId('changes-project').locator('option:checked')).toHaveText('Unfiled');
  await app.evaluate(({ dialog }) => {
    const holder = globalThis as { __projectBox?: typeof dialog.showMessageBox };
    if (holder.__projectBox) dialog.showMessageBox = holder.__projectBox;
  });
});
