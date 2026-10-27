// Specs: specs/command-palette.spec.ts (COMMAND_PALETTE_MENU_ID, OPEN_IN_TEMPLATES, SITE_FILES, PALETTE_SHEET_HEIGHT),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['command-palette']), specs/browser.spec.ts (BROWSE_PARTITION),
// specs/render-profile.spec.ts (QUICK_RENDER_PROFILES; render-profile.feature.md, Command palette)
// Acceptance: specs/command-palette.feature.md (End to end)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { COMMAND_PALETTE_MENU_ID, OPEN_IN_TEMPLATES } from '@app/specs/command-palette.spec';
import { QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/**
 * A public-looking name for the loopback server (`--host-resolver-rules`), so the "Open in" tools,
 * offered only for public hosts, are offered for its pages.
 */
const SITE_HOST = 'palette.frost-e2e.example';
const TITLE = 'Palette page: a well titled page about tea';

/** Loopback pages: `/page` (an auditable page), `/greedy` (cancels every keydown), `/robots.txt`. Every request path is logged. */
async function startSiteServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    requests.push(path);
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>${body}`);
    if (path === '/robots.txt') response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    else if (path === '/greedy')
      html(`<html lang="en"><title>Greedy</title><input id="field" autofocus><script>
        window.seen = [];
        addEventListener('keydown', (event) => { seen.push(event.key); event.preventDefault(); event.stopImmediatePropagation(); }, true);
      </script></html>`);
    else
      html(`<html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
        <meta name="description" content="A page the command palette copies its title and description from.">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Tea House"}</script></head>
        <body><h1>Tea, brewed well</h1><p>${'Words about tea. '.repeat(60)}</p><a href="/other">Other</a></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://${SITE_HOST}:${port}`,
    requests,
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
const { go, contentsIdAt, menu, press, strip, activeTab, address, closeAllTabs, run } = chromeHelpers(
  () => app,
  () => page,
);
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;

const palette = () => page.getByTestId('command-palette');
const input = () => page.getByTestId('command-palette-input');
const options = () => page.getByTestId('command-palette-option');
const activeOption = () => page.locator('[data-testid="command-palette-option"][aria-selected="true"]');
const sidebar = () => page.getByTestId('seo-sidebar');

/** The attached tab view's bounds, as main laid it out. */
const viewBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => child.getBounds())[0] ?? null);
const isPageFocused = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), id);
const pageSaw = (id: number) => run(id, 'window.seen.map((k) => k.toLowerCase())') as Promise<string[]>;

/** Loads `/page` and waits for its ready audit (the palette offers copies only then). */
async function auditedPage(): Promise<number> {
  const url = `${site.origin}/page`;
  await go(url);
  const id = await contentsIdAt(url);
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  await input().fill('copy title');
  await expect(options().first()).toHaveAttribute('data-action', 'copy.title', { timeout: AUDIT_WAIT });
  await input().press('Escape');
  await expect(palette()).toHaveCount(0);
  return id;
}

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`]));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await closeAllTabs();
});

test('palette-opens-with-mod-k-even-from-a-greedy-page', async () => {
  await go(`${site.origin}/greedy`);
  const greedy = await contentsIdAt(`${site.origin}/greedy`);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  // Control: the page really does swallow ordinary keys.
  await press(greedy, 'A');
  await expect.poll(() => pageSaw(greedy)).toEqual(['a']);

  await press(greedy, 'K', ['mod']);
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
  await expect(input()).toHaveAttribute('role', 'combobox');
  await expect(input()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('command-palette-list')).toHaveAttribute('role', 'listbox');
  await expect(input()).toHaveAttribute('aria-activedescendant', /.+/);
  // The page never saw Mod+K.
  expect(await pageSaw(greedy)).toEqual(['a']);

  // Mod+K again (now from the chrome) closes it; the menu item opens it.
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toHaveCount(0);
  await menu(COMMAND_PALETTE_MENU_ID);
  await expect(palette()).toBeVisible();
  await expect(input()).toBeFocused();
  await input().press('Escape');
  await expect(palette()).toHaveCount(0);
  expect(await pageSaw(greedy)).toEqual(['a']);
});

test('palette-sits-above-the-page-view', async () => {
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  const area = page.getByTestId('page-area');
  const full = (await area.boundingBox())!;
  await expect.poll(viewBounds).toMatchObject({ y: Math.round(full.y), height: Math.round(full.height) });

  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  const sheet = (await page.getByTestId('command-palette-sheet').boundingBox())!;
  const card = (await palette().boundingBox())!;
  // The view starts below the sheet: no part of it can cover the palette.
  await expect.poll(async () => (await viewBounds())!.y).toBeGreaterThanOrEqual(Math.floor(sheet.y + sheet.height));
  const shown = (await viewBounds())!;
  expect(card.y + card.height).toBeLessThanOrEqual(shown.y);
  expect(shown.y + shown.height).toBeLessThanOrEqual(Math.round(full.y + full.height) + 1);
  expect(shown.height).toBeGreaterThan(0);
  // Only the top moves: the page keeps its width, and the sidebar its own.
  expect({ x: shown.x, width: shown.width }).toEqual({ x: Math.round(full.x), width: Math.round(full.width) });
  // Typing never resizes the page area (short and long rows alike), so the view stays put.
  const openArea = (await area.boundingBox())!;
  for (const query of ['zoom', 'mobile rendering', 'copy', '']) {
    await input().fill(query);
    await expect(options().first()).toBeVisible();
    expect(await area.boundingBox(), query).toEqual(openArea);
    expect(await viewBounds(), query).toEqual(shown);
  }
  // Closing gives the page its whole area back.
  await input().press('Escape');
  await expect.poll(viewBounds).toMatchObject({ y: Math.round(full.y), height: Math.round(full.height) });

  // In a narrow chrome (the page column and the sidebar share too little room), opening the palette
  // and typing still never moves the column / sidebar split. The chrome is zoomed to get there
  // whatever the window manager made of the window; only DOM boxes are compared meanwhile.
  const chrome = (zoom: number) => app.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(zoom), zoom);
  const cssWidth = await page.evaluate(() => innerWidth);
  try {
    await chrome(cssWidth / 700);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(702);
    await expect(sidebar()).toHaveAttribute('data-open', 'true');
    const split = async () => ({ area: (await area.boundingBox())!.width, sidebar: (await sidebar().boundingBox())!.width });
    const closed = await split();
    await press('chrome', 'K', ['mod']);
    for (const query of ['', 'mobile rendering', 'zoom', 'copy']) {
      await input().fill(query);
      expect(await split(), query).toEqual(closed);
    }
    await input().press('Escape');
  } finally {
    await chrome(1);
  }
});

test('palette-search-runs-a-panel-jump', async () => {
  await go(`${site.origin}/page`);
  // Start with the sidebar's panel collapsed.
  if ((await sidebar().getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
  await expect(sidebar()).toHaveAttribute('data-open', 'false');

  await press('chrome', 'K', ['mod']);
  await input().fill('schema pan');
  await expect(options().first()).toHaveAttribute('data-action', 'panel.schema');
  await expect(activeOption()).toHaveAttribute('data-action', 'panel.schema');
  // The matched characters are marked.
  await expect(activeOption().locator('mark').first()).toHaveText(/schema/i);
  await input().press('Enter');
  await expect(palette()).toHaveCount(0);
  await expect(sidebar()).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'schema');
  await expect(page.locator('[data-testid="seo-rail-item"][data-panel="schema"]')).toBeFocused();

  // Arrow keys move and wrap; the recent action is listed first next time.
  await press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette-group').first()).toHaveAttribute('data-group', 'recent');
  await expect(options().first()).toHaveAttribute('data-action', 'panel.schema');
  await input().press('ArrowDown');
  await expect(activeOption()).toHaveAttribute('data-action', (await options().nth(1).getAttribute('data-action'))!);
  await input().press('ArrowUp');
  await input().press('ArrowUp');
  await expect(activeOption()).toHaveAttribute('data-action', (await options().last().getAttribute('data-action'))!);
  await input().press('Escape');
});

test('palette-copy-writes-main-clipboard', async () => {
  await auditedPage();
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await press('chrome', 'K', ['mod']);
  await input().fill('copy title');
  await expect(activeOption()).toHaveAttribute('data-action', 'copy.title');
  // The row previews the value, as text.
  await expect(activeOption().getByTestId('command-palette-detail')).toHaveText(TITLE);
  await input().press('Enter');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(TITLE);
  await expect(page.getByTestId('command-palette-status')).toHaveText('Copied the title');

  // The H1 too, and a JSON-LD block (main pretty-prints it).
  await press('chrome', 'K', ['mod']);
  await input().fill('copy h1');
  await expect(activeOption()).toHaveAttribute('data-action', 'copy.h1');
  await input().press('Enter');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Tea, brewed well');
  await press('chrome', 'K', ['mod']);
  await input().fill('json-ld block 1');
  await expect(activeOption()).toHaveAttribute('data-action', 'copy.json-ld.0');
  await input().press('Enter');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('"@type": "Organization"');
});

test('palette-open-in-opens-a-background-tab', async () => {
  const pageUrl = `${site.origin}/page`;
  await go(pageUrl);
  await contentsIdAt(pageUrl);
  await expect(activeTab()).toHaveAttribute('title', TITLE);
  // Requests to the tools' hosts never leave the test: recorded, then cancelled.
  const hosts = [...new Set(OPEN_IN_TEMPLATES.map((t) => new URL(t.origin).host))];
  await app.evaluate(
    ({ session }, { partition, hosts }) => {
      const seen: string[] = [];
      (globalThis as { __paletteSeen?: string[] }).__paletteSeen = seen;
      session.fromPartition(partition).webRequest.onBeforeRequest({ urls: hosts.map((host) => `https://${host}/*`) }, (details, callback) => {
        if (details.resourceType === 'mainFrame') seen.push(details.url);
        callback({ cancel: true });
      });
    },
    { partition: BROWSE_PARTITION, hosts },
  );
  const seen = () => app.evaluate(() => (globalThis as { __paletteSeen?: string[] }).__paletteSeen ?? []);
  try {
    await press('chrome', 'K', ['mod']);
    await input().fill('rich results');
    await expect(activeOption()).toHaveAttribute('data-action', 'open-in.rich-results');
    await expect(activeOption().getByTestId('command-palette-detail')).toContainText('search.google.com');
    await input().press('Enter');
    await expect(palette()).toHaveCount(0);
    // One background tab, the page's tab still active; its request is exactly the template's URL.
    await expect(strip()).toHaveCount(2);
    await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'false');
    const expected = `https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`;
    await expect.poll(seen).toEqual([expected]);
    expect(new URL(expected).protocol).toBe('https:');
    await expect(page.getByTestId('command-palette-status')).toHaveText('Opened search.google.com in a background tab');
  } finally {
    await app.evaluate(({ session }, partition) => session.fromPartition(partition).webRequest.onBeforeRequest(null), BROWSE_PARTITION);
  }

  // The site's robots.txt: on the page's own origin.
  await press('chrome', 'K', ['mod']);
  await input().fill('robots.txt');
  await expect(activeOption()).toHaveAttribute('data-action', 'open-in.robots-txt');
  await input().press('Enter');
  await expect(strip()).toHaveCount(3);
  await contentsIdAt(`${site.origin}/robots.txt`);
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
});

test('palette-esc-closes-and-restores-focus', async () => {
  // Opened from the page: focus goes back to the page.
  await go(`${site.origin}/greedy`);
  const greedy = await contentsIdAt(`${site.origin}/greedy`);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  await expect.poll(() => isPageFocused(greedy)).toBe(true);
  await press(greedy, 'K', ['mod']);
  await expect(input()).toBeFocused();
  await expect.poll(() => isPageFocused(greedy)).toBe(false);
  await input().press('Escape');
  await expect(palette()).toHaveCount(0);
  await expect.poll(() => isPageFocused(greedy)).toBe(true);

  // Opened from the address bar: focus goes back to it. (A real click in the chrome focuses its
  // WebContents natively; Playwright's click does not, so the test does that part.)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.focus());
  await expect.poll(() => isPageFocused(greedy)).toBe(false);
  await address().click();
  await expect(address()).toBeFocused();
  await press('chrome', 'K', ['mod']);
  await expect(input()).toBeFocused();
  await input().press('Escape');
  await expect(palette()).toHaveCount(0);
  await expect(address()).toBeFocused();
});

test('palette-makes-no-network-requests', async () => {
  await auditedPage();
  const chromeRequests: string[] = [];
  const record = (request: { url(): string }) => void chromeRequests.push(request.url());
  page.on('request', record);
  const before = site.requests.length;
  try {
    await press('chrome', 'K', ['mod']);
    for (const query of ['', 'o', 'open in', 'https://example.com/', 'search the web for tea', 'zz-no-match']) {
      await input().fill(query);
      await input().press('ArrowDown');
    }
    await expect(page.getByTestId('command-palette-empty')).toBeVisible();
    await input().fill('');
    await input().press('PageDown');
    await input().press('Escape');
    await expect(palette()).toHaveCount(0);
    // Long enough for a debounced fetch or a suggestion request to have gone out.
    await page.waitForTimeout(500);
  } finally {
    page.off('request', record);
  }
  expect(chromeRequests).toEqual([]);
  expect(site.requests.slice(before)).toEqual([]);
});

test('palette-runs-a-render-profile', async () => {
  const url = `${site.origin}/page`;
  await go(url);
  const id = await contentsIdAt(url);
  const quick = QUICK_RENDER_PROFILES.find((q) => q.id === 'googlebot-smartphone')!;
  const badge = () => activeTab().getByTestId('tab-render-profile');
  const chip = () => page.getByTestId('status-render-profile');
  await expect(badge()).toHaveCount(0);

  // A feature's registered action: no Reset while the tab has no profile.
  await press('chrome', 'K', ['mod']);
  await input().fill('render profile');
  await expect(options().first()).toHaveAttribute('data-action', /^render\.quick\./);
  await expect(page.locator('[data-testid="command-palette-option"][data-action="render.reset"]')).toHaveCount(0);
  await input().fill('render as googlebot smart');
  await expect(activeOption()).toHaveAttribute('data-action', `render.quick.${quick.id}`);
  await input().press('Enter');
  await expect(palette()).toHaveCount(0);
  await expect(page.getByTestId('command-palette-status')).toHaveText(`Render profile: ${quick.label}`);

  // On the tab, in the status bar and the frame; after a reload the page sees the crawler's user agent.
  await expect(badge()).toHaveAttribute('data-status', 'active');
  await expect(chip()).toContainText('Googlebot smartphone');
  await page.getByTestId('render-frame-reload').click();
  await expect.poll(() => run(id, 'navigator.userAgent')).toContain('Googlebot');
  await expect.poll(() => run(id, 'innerWidth')).toBe(412);

  // Reset is offered now, and restores the defaults.
  await press('chrome', 'K', ['mod']);
  await input().fill('reset render');
  await expect(activeOption()).toHaveAttribute('data-action', 'render.reset');
  await input().press('Enter');
  await expect(palette()).toHaveCount(0);
  await expect(badge()).toHaveCount(0);
  await expect(chip()).toHaveCount(0);
  await run(id, 'location.reload()');
  await expect.poll(() => run(id, 'navigator.userAgent')).not.toContain('Googlebot');
});
