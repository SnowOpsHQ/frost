// Specs: specs/devtools.spec.ts (DEVTOOLS_MENU_ID, DEVTOOLS_STORAGE_KEYS, MASKED_VALUE, CLEAR_SITE_DATA; Phase 11 Task 4:
// EXPORT_URLS_REDACTED_NOTE, EXPORT_REDACTION_HINT, HAR_NO_BODY_COMMENT, REDACTED_VALUE), specs/devtools.schema.ts (HarLogSchema),
// specs/browser.spec.ts (BrowserState.devtoolsToggleSeq)
// Acceptance: specs/devtools.feature.md (End to end)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CLEAR_SITE_DATA, DEVTOOLS_MENU_ID, DEVTOOLS_STORAGE_KEYS, EXPORT_REDACTION_HINT, EXPORT_URLS_REDACTED_NOTE, HAR_NO_BODY_COMMENT, MASKED_VALUE, REDACTED_VALUE } from '@app/specs/devtools.spec';
import { HarLogSchema } from '@app/specs/devtools.schema';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** The site's public-looking name and a third party's (`--host-resolver-rules`), both served by the loopback server. */
const SITE_HOST = 'devtools.frost-e2e.net';
const THIRD_HOST = 'cdn.thirdparty-e2e.org';
const SECRET = 'e2e-secret-token-4711';
const COOKIE_SECRET = 'cookie-secret-value-0815';
/** Values the export page sends in URLs (Phase 11 Task 4): none may reach the exported file. */
const URL_SECRETS = ['pagesecret-e2e', 'fragsecret-e2e', 'tokensecret-e2e', 'jane%40mail.example', 'jane@mail.example', 'statesecret-e2e', 'codesecret-e2e', 'sigsecret-e2e'];
const LOCAL_SECRET = 'local-storage-secret-2718';
const SESSION_SECRET = 'session-storage-secret-3141';
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
    if (path === '/no-content') return response.writeHead(204).end();
    if (path === '/final') return html('<html lang="en"><title>Final</title><h1>Final</h1></html>');
    // Phase 11 Task 4: a page whose URLs, Referer, Location and Link carry secrets, and one with web storage.
    if (path === '/r-token') return response.writeHead(302, { Location: '/final?code=codesecret-e2e&lang=en' }).end();
    if (path === '/export')
      return html(
        `<html lang="en"><title>Export</title><h1>Export</h1><script>
          fetch('/api?access_token=tokensecret-e2e&q=ok&to=jane%40mail.example');
          fetch('/r-token?state=statesecret-e2e');
        </script></html>`,
        { Link: '</site.css?sig=sigsecret-e2e>; rel=preload; as=style' },
      );
    if (path === '/storage')
      return html(`<html lang="en"><title>Storage</title><h1>Storage</h1><script>
        localStorage.setItem('auth_token', '${LOCAL_SECRET}');
        localStorage.setItem('theme', 'dark');
        sessionStorage.setItem('cart', '${SESSION_SECRET}');
      </script></html>`);
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
/** Main's save dialog answers `filePath` from now on (`restoreSaveDialog` puts Electron's back); the offered names are kept. */
const answerSaveDialog = (filePath: string) =>
  app.evaluate(({ dialog }, filePath) => {
    const holder = globalThis as { __devtoolsSave?: typeof dialog.showSaveDialog; __devtoolsSaveNames?: string[] };
    holder.__devtoolsSave ??= dialog.showSaveDialog;
    holder.__devtoolsSaveNames = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      const options = args.find((a): a is { defaultPath?: string } => typeof a === 'object' && a !== null && 'defaultPath' in a);
      holder.__devtoolsSaveNames!.push(options?.defaultPath ?? '');
      return { canceled: false, filePath };
    }) as typeof dialog.showSaveDialog;
  }, filePath);
const saveNames = () => app.evaluate(() => (globalThis as { __devtoolsSaveNames?: string[] }).__devtoolsSaveNames ?? []);
const restoreSaveDialog = () =>
  app.evaluate(({ dialog }) => {
    const holder = globalThis as { __devtoolsSave?: typeof dialog.showSaveDialog };
    if (holder.__devtoolsSave) dialog.showSaveDialog = holder.__devtoolsSave;
  });
const dialogsAsked = () => app.evaluate(() => (globalThis as { __devtoolsBoxes?: number }).__devtoolsBoxes ?? 0);
const restoreDialogs = () =>
  app.evaluate(({ dialog }) => {
    const holder = globalThis as { __devtoolsBox?: typeof dialog.showMessageBox };
    if (holder.__devtoolsBox) dialog.showMessageBox = holder.__devtoolsBox;
  });

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1,MAP ${THIRD_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST},${THIRD_HOST}`]));
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

test('network-log-survives-uncommitted-navigation', async () => {
  await setDrawer(true);
  await showTab('network');
  await go(`${site.origin}/page`);
  const id = await contentsIdAt(`${site.origin}/page`);
  await expect(rowFor('/api')).toHaveCount(1);
  await showTab('console');
  await expect(page.getByTestId('devtools-console-row').filter({ hasText: 'repeat me' })).toHaveCount(1);
  await showTab('network');
  // A navigation to a 204 never commits: the page, its log and its console stay.
  await go(`${site.origin}/no-content`);
  await expect(rowFor('/no-content')).toHaveCount(1);
  expect(await run(id, 'location.pathname')).toBe('/page');
  await expect(rowFor('/api')).toHaveCount(1);
  await expect(rowFor('/page')).toHaveCount(1);
  await showTab('console');
  await expect(page.getByTestId('devtools-console-row').filter({ hasText: 'repeat me' })).toHaveCount(1);
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

test('network-export-har-without-bodies-and-redacted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frost-har-'));
  const file = join(dir, 'export.har');
  try {
    await setDrawer(true);
    await showTab('network');
    const url = `${site.origin}/export?session=pagesecret-e2e#fragsecret-e2e`;
    await go(url);
    await contentsIdAt(url);
    await expect(rowFor('/api?access_token=tokensecret-e2e&q=ok&to=jane%40mail.example')).toHaveCount(1);
    await expect(rowFor('/final?code=codesecret-e2e&lang=en')).toHaveCount(1);
    await answerSaveDialog(file);
    await page.getByTestId('devtools-network-export').click();
    // The menu says what the file is: best-effort redaction, with the hint.
    const note = page.getByTestId('devtools-network-export-note');
    await expect(note).toContainText(EXPORT_URLS_REDACTED_NOTE);
    await expect(note).toContainText(EXPORT_REDACTION_HINT);
    await page.locator('[data-testid="devtools-network-export-format"][data-format="har"]').click();
    await expect(page.getByTestId('devtools-network-export-status')).toHaveText('Saved.');
    expect((await saveNames()).at(-1)).toMatch(/frost-network-devtools\.frost-e2e\.net-\d{8}-\d{6}\.har$/);

    const text = await readFile(file, 'utf8');
    const parsed = HarLogSchema.safeParse(JSON.parse(text));
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    const har = parsed.data!;
    expect(har.log.comment.startsWith(EXPORT_URLS_REDACTED_NOTE)).toBe(true);
    for (const secret of URL_SECRETS) expect(text, secret).not.toContain(secret);
    expect(har.log.pages.map((p) => p.title)).toContain(`${site.origin}/export?session=${REDACTED_VALUE}`);
    for (const entry of har.log.entries) {
      expect(entry.request.bodySize).toBe(-1);
      expect(entry.response.bodySize).toBe(-1);
      expect(entry.response.content.size).toBe(-1);
      expect(entry.response.content).not.toHaveProperty('text');
      expect(entry.response.content.comment).toBe(HAR_NO_BODY_COMMENT);
    }
    const api = har.log.entries.find((e) => e.request.url.includes('/api?'))!;
    expect(api.request.url).toBe(`${site.origin}/api?access_token=${REDACTED_VALUE}&q=ok&to=${REDACTED_VALUE}`);
    // Chromium may keep the referrer out of `onSendHeaders`; when the log has it, it is redacted (the unit tests cover it).
    const referer = api.request.headers.find((h) => h.name === 'referer');
    if (referer) expect(referer.value).toBe(`${site.origin}/export?session=${REDACTED_VALUE}`);
    const hop = har.log.entries.find((e) => e.request.url.includes('/r-token'))!;
    expect(hop.response.redirectURL).toBe(`${site.origin}/final?code=${REDACTED_VALUE}&lang=en`);
    expect(hop.response.headers).toContainEqual({ name: 'location', value: `${site.origin}/final?code=${REDACTED_VALUE}&lang=en` });
    const doc = har.log.entries.find((e) => e._resourceType === 'document')!;
    expect(doc.response.headers).toContainEqual({ name: 'link', value: `<${site.origin}/site.css?sig=${REDACTED_VALUE}>; rel=preload; as=style` });
  } finally {
    await restoreSaveDialog();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('storage-shows-local-and-session-keys-masked', async () => {
  await setDrawer(true);
  await showTab('network');
  await go(`${site.origin}/storage`);
  await contentsIdAt(`${site.origin}/storage`);
  // Opening the Storage tab runs main's reader once: keys and sizes, values masked.
  await showTab('storage');
  const local = page.locator('[data-testid="devtools-web-storage"][data-area="local"]');
  const session = page.locator('[data-testid="devtools-web-storage"][data-area="session"]');
  const token = local.locator('[data-testid="devtools-web-storage-item"][data-key="auth_token"]');
  await expect(token).toHaveAttribute('data-masked', 'true');
  await expect(token).toContainText(`${LOCAL_SECRET.length} characters`);
  await expect(local.locator('[data-testid="devtools-web-storage-item"][data-key="theme"]')).toHaveAttribute('data-masked', 'true');
  const cart = session.locator('[data-testid="devtools-web-storage-item"][data-key="cart"]');
  await expect(cart).toHaveAttribute('data-masked', 'true');
  await expect(token.getByTestId('devtools-web-storage-value')).toHaveText(MASKED_VALUE);
  let content = await page.content();
  expect(content).not.toContain(LOCAL_SECRET);
  expect(content).not.toContain(SESSION_SECRET);
  // Reveal: that one value only.
  await token.getByTestId('devtools-web-storage-reveal').click();
  await expect(token.getByTestId('devtools-web-storage-value')).toHaveText(LOCAL_SECRET);
  await expect(cart).toHaveAttribute('data-masked', 'true');
  expect(await page.content()).not.toContain(SESSION_SECRET);
  // Another document: nothing of the old one stays (Refresh reads the new one).
  await go(`${site.origin}/final`);
  await contentsIdAt(`${site.origin}/final`);
  await expect(page.getByTestId('devtools-web-storage-unread')).toBeVisible();
  content = await page.content();
  expect(content).not.toContain(LOCAL_SECRET);
  await page.getByTestId('devtools-storage-refresh').click();
  // Same origin: the keys are still there, masked.
  await expect(page.locator('[data-testid="devtools-web-storage"][data-area="local"] [data-key="auth_token"]')).toHaveAttribute('data-masked', 'true');
  expect(await page.content()).not.toContain(LOCAL_SECRET);
});
