// Specs: specs/devtools.spec.ts (DEVTOOLS_MENU_ID, DEVTOOLS_STORAGE_KEYS, MASKED_VALUE, CLEAR_SITE_DATA),
// specs/browser.spec.ts (BrowserState.devtoolsToggleSeq)
// Acceptance: specs/devtools.feature.md (End to end)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CLEAR_SITE_DATA, DEVTOOLS_MENU_ID, DEVTOOLS_STORAGE_KEYS, MASKED_VALUE } from '@app/specs/devtools.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** The site's public-looking name and a third party's (`--host-resolver-rules`), both served by the loopback server. */
const SITE_HOST = 'devtools.frost-e2e.net';
const THIRD_HOST = 'cdn.thirdparty-e2e.org';
const SECRET = 'e2e-secret-token-4711';
const COOKIE_SECRET = 'cookie-secret-value-0815';
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/**
 * Loopback pages: `/page` (a stylesheet, scripts of its own, one robots.txt blocks, one third-party
 * script, two images (one missing), a fetch sent with an `Authorization` header and console
 * messages), a 301 → 302 → 200 chain at `/r301`, `/cookies` (sets two cookies), `/greedy` (cancels
 * every key) and `/robots.txt`.
 */
async function startSiteServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const path = url.pathname;
    const html = (body: string, headers: Record<string, string | string[]> = {}) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(`<!doctype html>${body}`);
    const text = (type: string, body: string | Buffer) => response.writeHead(200, { 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), 'Cache-Control': 'no-store' }).end(body);
    if (path === '/robots.txt') return text('text/plain', 'User-agent: *\nDisallow: /blocked/\n');
    if (path === '/site.css') return text('text/css', 'body { margin: 0 }');
    if (path === '/app.js' || path === '/blocked/tracker.js' || path === '/lib.js') return text('text/javascript', '/* ok */');
    if (path === '/logo.png') return text('image/png', PNG);
    if (path === '/api') return text('application/json', '{"ok":true}');
    if (path === '/r301') return response.writeHead(301, { Location: '/r302', 'Cache-Control': 'max-age=60' }).end();
    if (path === '/r302') return response.writeHead(302, { Location: '/final', 'X-Robots-Tag': 'noarchive' }).end();
    if (path === '/final') return html('<html lang="en"><title>Final</title><h1>Final</h1></html>');
    if (path === '/cookies')
      return html('<html lang="en"><title>Cookies</title><h1>Cookies</h1></html>', { 'Set-Cookie': [`session_id=${COOKIE_SECRET}; Path=/; HttpOnly`, 'theme=dark; Path=/; SameSite=Lax; Max-Age=3600'] });
    if (path === '/greedy')
      return html(`<html lang="en"><title>Greedy</title><input id="field" autofocus><script>
        window.seen = [];
        addEventListener('keydown', (event) => { seen.push(event.key); event.preventDefault(); event.stopImmediatePropagation(); }, true);
      </script></html>`);
    if (path === '/page') {
      const port = (server.address() as AddressInfo).port;
      return html(`<html lang="en"><head><meta charset="utf-8"><title>Devtools page</title>
        <link rel="stylesheet" href="/site.css">
        <script src="/app.js"></script><script src="/blocked/tracker.js"></script>
        <script src="http://${THIRD_HOST}:${port}/lib.js"></script></head>
        <body><h1>Devtools</h1><img src="/logo.png" alt="Logo"><img src="/missing.png" alt="Missing">
        <script>
          for (let i = 0; i < 3; i++) console.log('repeat me');
          console.warn('only once');
          fetch('/api', { headers: { Authorization: 'Bearer ${SECRET}' } });
        </script></body></html>`);
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://${SITE_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
let site: Awaited<ReturnType<typeof startSiteServer>>;
const { go, contentsIdAt, menu, press, closeAllTabs, run } = chromeHelpers(
  () => app,
  () => page,
);
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;

const drawer = () => page.getByTestId('devtools');
const tabButton = (id: string) => page.locator(`[data-testid="devtools-tab"][data-tab="${id}"]`);
const rows = () => page.getByTestId('devtools-network-row');
const rowFor = (suffix: string) => page.locator('[data-testid="devtools-network-row"]').filter({ has: page.locator(`[title$="${suffix}"]`) });
/** The attached tab view's bounds, as main laid it out. */
const viewBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => child.getBounds())[0] ?? null);

async function setDrawer(open: boolean): Promise<void> {
  if ((await drawer().count()) === (open ? 1 : 0)) return;
  await menu(DEVTOOLS_MENU_ID);
  await expect(drawer()).toHaveCount(open ? 1 : 0);
}

async function showTab(id: string): Promise<void> {
  await tabButton(id).click();
  await expect(page.getByTestId('devtools-panel')).toHaveAttribute('data-tab', id);
}

/** Main's message box answers `index` from now on (`restore` puts Electron's back). */
const answerDialogs = (index: number) =>
  app.evaluate(({ dialog }, index) => {
    const holder = globalThis as { __devtoolsBoxes?: number; __devtoolsBox?: typeof dialog.showMessageBox };
    holder.__devtoolsBox ??= dialog.showMessageBox;
    holder.__devtoolsBoxes = 0;
    dialog.showMessageBox = (async () => {
      holder.__devtoolsBoxes! += 1;
      return { response: index, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, index);
const dialogsAsked = () => app.evaluate(() => (globalThis as { __devtoolsBoxes?: number }).__devtoolsBoxes ?? 0);
const restoreDialogs = () =>
  app.evaluate(({ dialog }) => {
    const holder = globalThis as { __devtoolsBox?: typeof dialog.showMessageBox };
    if (holder.__devtoolsBox) dialog.showMessageBox = holder.__devtoolsBox;
  });

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1,MAP ${THIRD_HOST} 127.0.0.1`]));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await closeAllTabs();
});

test('drawer-toggles-and-page-shrinks', async () => {
  await setDrawer(false);
  await go(`${site.origin}/final`);
  await contentsIdAt(`${site.origin}/final`);
  await expect.poll(async () => (await viewBounds())?.height ?? 0).toBeGreaterThan(0);
  const full = (await viewBounds())!;
  // The shortcut, from the chrome.
  await press('chrome', 'D', ['mod', 'shift']);
  await expect(drawer()).toBeVisible();
  const band = (await drawer().boundingBox())!;
  await expect.poll(async () => (await viewBounds())!.height).toBe(full.height - Math.round(band.height));
  expect((await viewBounds())!.y).toBe(full.y);
  // The page area ends where the drawer starts.
  expect(Math.abs(full.y + (await viewBounds())!.height - band.y)).toBeLessThanOrEqual(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), DEVTOOLS_STORAGE_KEYS.open)).toBe('1');
  // The menu item closes it; the page gets its height back.
  await menu(DEVTOOLS_MENU_ID);
  await expect(drawer()).toHaveCount(0);
  await expect.poll(async () => (await viewBounds())!.height).toBe(full.height);
  // The palette's action opens it again; its close button closes it.
  await press('chrome', 'K', ['mod']);
  await page.getByTestId('command-palette-input').fill('toggle seo devtools');
  await expect(page.locator('[data-testid="command-palette-option"][aria-selected="true"]')).toHaveAttribute('data-action', 'devtools.toggle');
  await page.getByTestId('command-palette-input').press('Enter');
  await expect(drawer()).toBeVisible();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  const reopened = (await drawer().boundingBox())!;
  await expect.poll(async () => (await viewBounds())!.height).toBe(full.height - Math.round(reopened.height));
  // Resizing from the keyboard moves the page's bottom edge.
  const before = (await viewBounds())!.height;
  await page.getByTestId('devtools-resize').focus();
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await viewBounds())!.height).toBeLessThan(before);
  await page.getByTestId('devtools-close').click();
  await expect(drawer()).toHaveCount(0);
  await expect.poll(async () => (await viewBounds())!.height).toBe(full.height);
});

test('network-lists-requests-and-filters', async () => {
  await setDrawer(true);
  await showTab('network');
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  await expect(rowFor('/api')).toHaveCount(1);
  await expect(rowFor('/page')).toHaveAttribute('data-type', 'document');
  await expect(rowFor('/page')).toHaveAttribute('data-status', '200');
  await expect(rowFor('/app.js')).toHaveAttribute('data-type', 'script');
  await expect(rowFor('/site.css')).toHaveAttribute('data-type', 'stylesheet');
  await expect(rowFor('/logo.png')).toHaveAttribute('data-type', 'image');
  await expect(rowFor('/missing.png')).toHaveAttribute('data-status', '404');
  await expect(rowFor('/lib.js')).toHaveAttribute('data-third-party', 'true');
  await expect(rowFor('/app.js')).toHaveAttribute('data-third-party', 'false');
  // robots.txt: the page's own crawlable requests only.
  await expect(rowFor('/blocked/tracker.js')).toHaveAttribute('data-robots', 'blocked', { timeout: AUDIT_WAIT });
  await expect(rowFor('/app.js')).toHaveAttribute('data-robots', 'allowed');
  await expect(rowFor('/lib.js')).toHaveAttribute('data-robots', 'not-checked');
  await expect(rowFor('/api')).toHaveAttribute('data-robots', 'not-checked');

  const all = await rows().count();
  await page.getByTestId('devtools-network-type').selectOption('script');
  await expect(rows()).toHaveCount(3);
  for (const type of await rows().evaluateAll((els) => els.map((el) => el.getAttribute('data-type')))) expect(type).toBe('script');
  await page.getByTestId('devtools-network-type').selectOption('all');
  await page.getByTestId('devtools-network-third-party').check();
  await expect(rows()).toHaveCount(1);
  await expect(rowFor('/lib.js')).toHaveCount(1);
  await page.getByTestId('devtools-network-third-party').uncheck();
  await page.getByTestId('devtools-network-failed').check();
  await expect(rows()).toHaveCount(1);
  await expect(rowFor('/missing.png')).toHaveCount(1);
  await page.getByTestId('devtools-network-failed').uncheck();
  await page.getByTestId('devtools-network-search').fill('LOGO');
  await expect(rows()).toHaveCount(1);
  await page.getByTestId('devtools-network-search').fill('');
  await expect(rows()).toHaveCount(all);
});

test('network-masks-authorization', async () => {
  await setDrawer(true);
  await showTab('network');
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  await expect(rowFor('/api')).toHaveCount(1);
  await rowFor('/api').getByTestId('devtools-network-name').click();
  const details = page.getByTestId('devtools-network-details');
  await expect(details).toBeVisible();
  const auth = details.getByTestId('devtools-request-headers').locator('[data-testid="devtools-header"][data-name="authorization"]');
  await expect(auth).toHaveAttribute('data-masked', 'true');
  await expect(auth.locator('dd')).toHaveText(MASKED_VALUE);
  // The secret is nowhere in the chrome.
  expect(await page.content()).not.toContain(SECRET);
});

test('redirects-show-the-chain', async () => {
  await setDrawer(true);
  await showTab('redirects');
  await go(`${site.origin}/r301`);
  await contentsIdAt(`${site.origin}/final`);
  const hops = page.getByTestId('devtools-redirect-hop');
  await expect(hops).toHaveCount(2);
  await expect(hops.nth(0)).toHaveAttribute('data-status', '301');
  await expect(hops.nth(1)).toHaveAttribute('data-status', '302');
  await expect(hops.nth(0)).toContainText(`${site.origin}/r302`);
  await expect(hops.nth(0).locator('[data-testid="devtools-header"][data-name="cache-control"]')).toContainText('max-age=60');
  await expect(hops.nth(1).locator('[data-testid="devtools-header"][data-name="x-robots-tag"]')).toContainText('noarchive');
  await expect(page.getByTestId('devtools-redirect-final')).toHaveAttribute('data-status', '200');
  await expect(page.getByTestId('devtools-redirect-final')).toContainText(`${site.origin}/final`);
});

test('console-dedupes-messages', async () => {
  await setDrawer(true);
  await showTab('console');
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  const repeated = page.getByTestId('devtools-console-row').filter({ hasText: 'repeat me' });
  await expect(repeated).toHaveCount(1);
  await expect(repeated.getByTestId('devtools-console-count')).toHaveText('×3');
  const once = page.getByTestId('devtools-console-row').filter({ hasText: 'only once' });
  await expect(once).toHaveAttribute('data-level', 'warning');
  await expect(once.getByTestId('devtools-console-count')).toHaveCount(0);
});

test('cookies-masked-reveal-resets', async () => {
  await setDrawer(true);
  await showTab('storage');
  await go(`${site.origin}/cookies`);
  await contentsIdAt(`${site.origin}/cookies`);
  const session = page.locator('[data-testid="devtools-cookie"][data-name="session_id"]');
  await expect(session).toHaveAttribute('data-masked', 'true');
  await expect(page.locator('[data-testid="devtools-cookie"][data-name="theme"]')).toHaveAttribute('data-masked', 'true');
  await expect(session.getByTestId('devtools-cookie-value')).toHaveText(MASKED_VALUE);
  expect(await page.content()).not.toContain(COOKIE_SECRET);
  await session.getByTestId('devtools-cookie-reveal').click();
  await expect(session.getByTestId('devtools-cookie-value')).toHaveText(COOKIE_SECRET);
  await expect(page.locator('[data-testid="devtools-cookie"][data-name="theme"]')).toHaveAttribute('data-masked', 'true');
  // Another document: masked again.
  await go(`${site.origin}/cookies?again=1`);
  await contentsIdAt(`${site.origin}/cookies?again=1`);
  await expect(session).toHaveAttribute('data-masked', 'true');
  expect(await page.content()).not.toContain(COOKIE_SECRET);
});

test('clear-site-data-asks', async () => {
  await setDrawer(true);
  await showTab('storage');
  await go(`${site.origin}/cookies`);
  await contentsIdAt(`${site.origin}/cookies`);
  const cookies = page.getByTestId('devtools-cookie');
  await expect(cookies).toHaveCount(2);
  try {
    await answerDialogs(CLEAR_SITE_DATA.dialog.cancelId);
    await page.getByTestId('devtools-clear-site-data').click();
    await expect(page.getByTestId('devtools-storage-status')).toHaveText('Nothing was cleared.');
    expect(await dialogsAsked()).toBe(1);
    await expect(cookies).toHaveCount(2);

    await answerDialogs(CLEAR_SITE_DATA.confirmIndex);
    await page.getByTestId('devtools-clear-site-data').click();
    await expect(page.getByTestId('devtools-storage-status')).toHaveText('This site’s data was cleared.');
    expect(await dialogsAsked()).toBe(1);
    const left = () =>
      app.evaluate(async ({ session }, url) => (await session.fromPartition('persist:frost-browser').cookies.get({ url })).length, site.origin);
    await expect.poll(left).toBe(0);
    await expect(cookies).toHaveCount(0);
  } finally {
    await restoreDialogs();
  }
});

test('issues-jump-to-panel', async () => {
  await setDrawer(true);
  await showTab('issues');
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  const issues = page.getByTestId('devtools-issue');
  await expect(issues.first()).toBeVisible({ timeout: AUDIT_WAIT });
  // Sortable: by rule id, A to Z.
  await page.locator('[data-testid="devtools-issue-sort"][data-key="rule"]').click();
  const rules = await issues.evaluateAll((els) => els.map((el) => el.getAttribute('data-rule') ?? ''));
  expect(rules).toEqual([...rules].sort());
  // Collapse the sidebar first: the jump opens it on the issue's panel.
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true') await menu('toggle-seo-sidebar');
  await expect(page.getByTestId('seo-sidebar')).toHaveAttribute('data-open', 'false');
  const target = issues.filter({ has: page.locator('[data-panel]:not([data-panel="on-page"])') }).first();
  const row = (await target.count()) > 0 ? target : issues.first();
  const panel = (await row.getAttribute('data-panel'))!;
  await row.getByTestId('devtools-issue-open').click();
  await expect(page.getByTestId('seo-sidebar')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
});

test('devtools-shortcut-not-swallowed', async () => {
  await setDrawer(false);
  await go(`${site.origin}/greedy`);
  const greedy = await contentsIdAt(`${site.origin}/greedy`);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  // Its URL commits before its script runs: wait for the key listener, or the control key is lost.
  await expect.poll(() => run(greedy, 'Array.isArray(window.seen)')).toBe(true);
  // Control: the page really does swallow ordinary keys.
  await press(greedy, 'A');
  await expect.poll(() => run(greedy, 'window.seen.map((k) => k.toLowerCase())')).toEqual(['a']);
  await press(greedy, 'D', ['mod', 'shift']);
  await expect(drawer()).toBeVisible();
  await press(greedy, 'D', ['mod', 'shift']);
  await expect(drawer()).toHaveCount(0);
  // The page never saw the shortcut.
  expect(await run(greedy, 'window.seen.map((k) => k.toLowerCase())')).toEqual(['a']);
});
