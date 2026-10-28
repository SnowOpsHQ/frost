// Specs: specs/seo-sidebar.spec.ts (SEO_PANELS), specs/changes.spec.ts (CAPTURE_REFUSAL_MESSAGES),
// specs/capture.spec.ts (DIFF_REGION_LABELS, DIFF_FIELD_LABELS)
// Acceptance: specs/changes-panel.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DIFF_FIELD_LABELS, DIFF_REGION_LABELS } from '@app/specs/capture.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;

/** The page's two states: v2 edits the title, a main paragraph and a navigation link's text. */
const VERSIONS = {
  1: {
    title: 'Cold brew at home: a starter guide',
    paragraph: 'Steep coarse ground coffee in cold water for twelve hours, then strain it through a paper filter and serve it over ice.',
    nav: 'Pricing',
  },
  2: {
    title: 'Cold brew at home: the complete guide',
    paragraph: 'Steep coarse ground coffee in cold water for sixteen hours, then strain it through a paper filter and serve it over ice.',
    nav: 'Plans and pricing',
  },
} as const;

/** Text that holds markup (escaped in the HTML, so the page shows it as text). */
const MARKUP_TITLE = '<img src=x onerror="top.__pwned=1"> <b>bold</b>';
const MARKUP_LINK = 'Next <i>page</i>';
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pageHtml(version: 1 | 2, markup: boolean): string {
  const v = VERSIONS[version];
  const title = markup && version === 2 ? MARKUP_TITLE : v.title;
  const extra = markup && version === 2 ? `<p><a href="/next?q=%3Cscript%3E">${escape(MARKUP_LINK)}</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title>
<meta name="description" content="How to make cold brew coffee at home with coarse grounds, cold water and a paper filter.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header><nav aria-label="Site"><a href="/pricing">${escape(v.nav)}</a> <a href="/about">About</a></nav></header>
<main><h1>Cold brew at home</h1><p>${escape(v.paragraph)}</p><p>Keep the concentrate in the fridge for up to a week and dilute it to taste.</p>${extra}</main>
<footer><p>Written by the frost test kitchen.</p></footer></body></html>`;
}

async function startSite() {
  const state = { version: 1 as 1 | 2, stall: false, stalled: [] as ServerResponse[] };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const send = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    if (pathname === '/guide') send(pageHtml(state.version, false));
    else if (pathname === '/markup') send(pageHtml(state.version, true));
    else if (pathname === '/slow') {
      if (!state.stall) return send(pageHtml(1, false));
      // The document commits, then its body never finishes until released: the tab keeps loading.
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.write(pageHtml(1, false).replace('</body></html>', ''));
      state.stalled.push(response);
    } else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    release: () => {
      state.stall = false;
      for (const response of state.stalled.splice(0)) response.end('</body></html>');
    },
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
const { go } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const panel = () => page.getByTestId('changes');
const captureButton = () => page.getByTestId('changes-capture');
const captureStatus = () => page.getByTestId('changes-capture-status');
const versions = () => page.getByTestId('changes-version');
const diff = () => page.getByTestId('changes-diff');
const region = (id: string) => page.locator(`[data-testid="changes-diff-region"][data-region="${id}"]`);
const changeIn = (regionId: string, field: string) => region(regionId).locator(`[data-testid="changes-change"][data-field="${field}"]`);

/** Opens the Changes panel (the sidebar too) if it is not shown. */
async function openChanges(): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'changes') await railItem('changes').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'changes');
  await expect(panel()).toBeVisible();
}

/** Loads `url` and waits, in the Changes panel, for its settled ready audit (Capture now enabled). */
async function load(url: string): Promise<void> {
  await go(url);
  await openChanges();
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(panel()).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
  await expect(captureButton()).toBeEnabled({ timeout: AUDIT_WAIT });
}

/** Reloads the tab and waits for an audit taken after the reload. */
async function reloadAndWait(): Promise<void> {
  const before = await panel().getAttribute('data-audit-at');
  await page.getByTestId('reload').click();
  await expect(panel()).not.toHaveAttribute('data-audit-at', before ?? '', { timeout: AUDIT_WAIT });
  await expect(panel()).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
  await expect(captureButton()).toBeEnabled({ timeout: AUDIT_WAIT });
}

/** Presses Capture now and waits for its outcome. */
async function capture(outcome: string): Promise<void> {
  await expect(captureButton()).toBeEnabled({ timeout: AUDIT_WAIT });
  await captureButton().click();
  await expect(captureStatus()).toHaveAttribute('data-outcome', outcome);
}

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  site?.release();
  await closeApp(app);
  await site?.close();
});

test('changes-capture-first-version', async () => {
  // The rail has the Changes item, after JavaScript (the Inspector follows it).
  await expect(page.getByTestId('seo-rail-item')).toHaveCount(SEO_PANELS.length);
  await expect(page.getByTestId('seo-rail-item').nth(SEO_PANELS.length - 2)).toHaveAttribute('data-panel', 'changes');
  await expect(page.getByTestId('seo-rail-item').last()).toHaveAttribute('data-panel', 'inspector');
  await expect(railItem('changes')).toHaveAttribute('aria-label', 'Changes');
  // Without a web page: a hint, and nothing to capture.
  await openChanges();
  await expect(page.getByTestId('changes-no-page')).toBeVisible();
  await expect(captureButton()).toHaveCount(0);

  await load(`${site.origin}/guide`);
  await expect(page.getByTestId('changes-empty')).toHaveText(/No captures of this page yet/);
  // It scores nothing: no status dot, while the audited panels have theirs.
  await expect(railItem('overview').locator('.seo-rail-dot')).toHaveCount(1);
  await expect(railItem('changes').locator('.seo-rail-dot')).toHaveCount(0);
  // The live region is there before it speaks.
  await expect(captureStatus()).toHaveAttribute('role', 'status');
  await capture('first');
  await expect(captureStatus()).toHaveText('Captured the first version of this page.');
  await expect(captureStatus()).toHaveAttribute('aria-live', 'polite');
  await expect(versions()).toHaveCount(1);
  await expect(versions().first().getByTestId('changes-version-summary')).toHaveText('First capture');
  await expect(versions().first().getByTestId('changes-version-count')).toHaveText('1 capture');
  await expect(diff()).toHaveAttribute('data-state', 'first');
});

test('changes-capture-no-change', async () => {
  await capture('same');
  await expect(captureStatus()).toHaveText('No change since the last capture.');
  await expect(versions()).toHaveCount(1);
  await expect(versions().first().getByTestId('changes-version-count')).toHaveText('2 captures');
});

test('changes-diff-by-region', async () => {
  site.state.version = 2;
  await reloadAndWait();
  await capture('new');
  await expect(captureStatus()).toHaveText(/^Captured a new version: \d+ changes?\.$/);
  await expect(versions()).toHaveCount(2);
  // Newest first, selected; its summary names the regions it changed.
  await expect(versions().first()).toHaveAttribute('data-selected', 'true');
  await expect(versions().first().getByTestId('changes-version-summary')).toContainText(DIFF_REGION_LABELS.head);
  await expect(versions().first().getByTestId('changes-version-summary')).toContainText(DIFF_REGION_LABELS.main);
  await expect(versions().nth(1).getByTestId('changes-version-summary')).toHaveText('First capture');
  // The latest pair's diff, grouped by region under region headings.
  await expect(diff()).toHaveAttribute('data-state', 'ready');
  await expect(region('head').getByRole('heading')).toContainText(DIFF_REGION_LABELS.head);
  await expect(region('main').getByRole('heading')).toContainText(DIFF_REGION_LABELS.main);
  await expect(region('nav').getByRole('heading')).toContainText(DIFF_REGION_LABELS.nav);
  // Regions come in DIFF_REGIONS order.
  const order = await page.getByTestId('changes-diff-region').evaluateAll((items) => items.map((item) => item.getAttribute('data-region')));
  expect(order.indexOf('head')).toBeLessThan(order.indexOf('main'));
  expect(order.indexOf('main')).toBeLessThan(order.indexOf('nav'));
  // Head: the title changed, before and after as text, the kind in words.
  const title = changeIn('head', 'title');
  await expect(title).toHaveAttribute('data-kind', 'changed');
  await expect(title.getByTestId('changes-change-field')).toHaveText(DIFF_FIELD_LABELS.title);
  await expect(title.getByTestId('changes-change-kind')).toHaveText('Changed');
  await expect(title.getByTestId('changes-change-before')).toHaveText(VERSIONS[1].title);
  await expect(title.getByTestId('changes-change-after')).toHaveText(VERSIONS[2].title);
  // Main content: the edited paragraph with inline word segments.
  const text = changeIn('main', 'text');
  await expect(text).toHaveCount(1);
  await expect(text).toHaveAttribute('data-kind', 'changed');
  await expect(text.locator('[data-testid="changes-segment"][data-op="del"]')).toHaveText(['twelve']);
  await expect(text.locator('[data-testid="changes-segment"][data-op="ins"]')).toHaveText(['sixteen']);
  // Navigation: the link's text changed; its href is the context, as text.
  const link = changeIn('nav', 'link');
  await expect(link).toHaveAttribute('data-kind', 'changed');
  await expect(link.getByTestId('changes-change-before')).toHaveText(VERSIONS[1].nav);
  await expect(link.getByTestId('changes-change-after')).toHaveText(VERSIONS[2].nav);
  await expect(link.getByTestId('changes-change-context')).toContainText(`${site.origin}/pricing`);
  // Unchanged regions on request.
  await expect(page.getByTestId('changes-unchanged')).toHaveCount(0);
  await page.getByTestId('changes-unchanged-toggle').click();
  await expect(page.getByTestId('changes-unchanged')).toContainText(DIFF_REGION_LABELS.footer);
  // Selecting the first version: nothing older in its lane.
  await versions().nth(1).click();
  await expect(diff()).toHaveAttribute('data-state', 'first');
  // Roving tabindex: only the selected version is in the Tab order.
  await expect(versions().nth(1)).toHaveAttribute('tabindex', '0');
  await expect(versions().first()).toHaveAttribute('tabindex', '-1');
  // The list is keyboard-navigable: ArrowUp moves to the newer version, Enter selects it.
  await versions().nth(1).focus();
  await page.keyboard.press('ArrowUp');
  await expect(versions().first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(versions().first()).toHaveAttribute('data-selected', 'true');
  await expect(diff()).toHaveAttribute('data-state', 'ready');
  // No inline styles (strict CSP).
  expect(await panel().evaluate((root) => root.querySelectorAll('[style]').length)).toBe(0);
});

test('changes-history-shows-while-pending', async () => {
  const url = `${site.origin}/slow`;
  await load(url);
  await capture('first');
  await expect(versions()).toHaveCount(1);
  // Away, then back to a load that never finishes: its audit stays pending (a reload of the same URL
  // would keep the ready audit on screen), and the history still shows.
  await load(`${site.origin}/guide`);
  site.state.stall = true;
  try {
    await go(url);
    // The tab is still loading it (the toolbar offers Stop, the tab its spinner) and its audit is pending.
    await expect(page.getByTestId('reload')).toHaveAttribute('aria-label', 'Stop', { timeout: AUDIT_WAIT });
    await expect(page.getByTestId('tab-loading')).toBeVisible();
    await expect(panel()).toHaveAttribute('data-audit', 'pending', { timeout: AUDIT_WAIT });
    // The history of this page shows anyway, not the audit's skeleton.
    await expect(page.getByTestId('seo-pending')).toHaveCount(0);
    await expect(page.getByTestId('changes-history')).toBeVisible();
    await expect(versions()).toHaveCount(1);
    await expect(versions().first().getByTestId('changes-version-summary')).toHaveText('First capture');
    await expect(captureButton()).toBeDisabled();
    await expect(page.getByTestId('changes-capture-hint')).toHaveText('Wait for the page to finish loading, then capture it.');
    // Still loading, still pending: it was the stalled load all along.
    await expect(page.getByTestId('reload')).toHaveAttribute('aria-label', 'Stop');
    await expect(panel()).toHaveAttribute('data-audit', 'pending');
  } finally {
    site.release();
  }
  await expect(panel()).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
  await expect(captureButton()).toBeEnabled();
});

test('changes-renders-page-text-inert', async () => {
  site.state.version = 1;
  await load(`${site.origin}/markup`);
  await capture('first');
  site.state.version = 2;
  await reloadAndWait();
  await capture('new');
  await expect(diff()).toHaveAttribute('data-state', 'ready');
  // The title's markup is text, before and after.
  await expect(changeIn('head', 'title').getByTestId('changes-change-after')).toHaveText(MARKUP_TITLE);
  // The added link's text and its href are text too.
  const added = region('main').locator('[data-testid="changes-change"][data-field="link"][data-kind="added"]');
  await expect(added.getByTestId('changes-change-after')).toHaveText(MARKUP_LINK);
  await expect(added.getByTestId('changes-change-before')).toHaveCount(0);
  await expect(added.getByTestId('changes-change-context')).toContainText('/next?q=%3Cscript%3E');
  await expect(added.getByTestId('changes-change-kind')).toHaveText('Added');
  // Nothing from the page became an element, a link or a script; nothing ran.
  expect(await panel().evaluate((root) => root.querySelectorAll('a, img, script, b, i, iframe, [href], [src], [onerror]').length)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
});
