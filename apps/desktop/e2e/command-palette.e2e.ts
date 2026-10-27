// Specs: specs/command-palette.spec.ts (COMMAND_PALETTE_MENU_ID, OPEN_IN_TEMPLATES, SITE_FILES, PALETTE_SHEET_HEIGHT),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['command-palette']), specs/browser.spec.ts (BROWSE_PARTITION),
// specs/render-profile.spec.ts (QUICK_RENDER_PROFILES; render-profile.feature.md, Command palette)
// Acceptance: specs/command-palette.feature.md (End to end)
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import {
  COMMAND_PALETTE_MENU_ID,
  OPEN_IN_CONSENT_MESSAGE,
  OPEN_IN_CONSENT_STORAGE_KEY,
  OPEN_IN_QUERY_NOTE,
  OPEN_IN_TEMPLATES,
  OPEN_TOOL_REFUSAL_MESSAGES,
} from '@app/specs/command-palette.spec';
import { QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/**
 * A public-looking name for the loopback server (`--host-resolver-rules`), so the "Open in" tools,
 * offered only for public host names, are offered for its pages; main then refuses them, as the
 * page came from a loopback address. (Reserved test names such as `.example` are not public.)
 */
const SITE_HOST = 'palette.frost-e2e.net';
/** A public name whose page the test serves itself (a browse-session protocol handler: no recorded address). */
const PUBLIC_HOST = 'public.frost-e2e.net';
const TITLE = 'Palette page: a well titled page about tea';

/**
 * Loopback pages: `/page` (an auditable page), `/greedy` (cancels every keydown), `/pushes` (calls
 * pushState a moment after a click), `/fullscreen` (asks for fullscreen a moment after a click),
 * `/robots.txt`. Every request path is logged.
 */
async function startSiteServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    requests.push(path);
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html>${body}`);
    if (path === '/robots.txt') response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    else if (path === '/pushes')
      html(`<html lang="en"><title>Pushes</title><button id="push">Push later</button><script>
        document.getElementById('push').addEventListener('click', () => setTimeout(() => history.pushState({}, '', '/pushes?moved=1'), 2500));
      </script></html>`);
    else if (path === '/fullscreen')
      html(`<html lang="en"><title>Fullscreen</title><button id="go">Go fullscreen</button><script>
        document.getElementById('go').addEventListener('click', () => setTimeout(() => document.documentElement.requestFullscreen(), 700));
      </script></html>`);
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
const { go, contentsIdAt, menu, press, strip, activeTab, address, closeAllTabs, run, realClick } = chromeHelpers(
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
  const before = site.requests.length;
  await go(url);
  const id = await contentsIdAt(url);
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  await input().fill('copy title');
  await expect(options().first()).toHaveAttribute('data-action', 'copy.title', { timeout: AUDIT_WAIT });
  await input().press('Escape');
  await expect(palette()).toHaveCount(0);
  // The audit's served-HTML fetch can land after the title is known: wait for it (the page's load and that fetch).
  await expect.poll(() => site.requests.slice(before).filter((path) => path === '/page').length, { timeout: AUDIT_WAIT }).toBe(2);
  return id;
}

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST}`]));
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
  // Its URL commits before its script runs: wait for the key listener, or the control key is lost.
  await expect.poll(() => run(greedy, 'Array.isArray(window.seen)')).toBe(true);
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

/** Records and cancels the browse session's requests to the tools' hosts (they never leave the test). */
async function interceptTools(): Promise<{ seen: () => Promise<string[]>; stop: () => Promise<void> }> {
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
  return {
    seen: () => app.evaluate(() => (globalThis as { __paletteSeen?: string[] }).__paletteSeen ?? []),
    stop: () => app.evaluate(({ session }, partition) => session.fromPartition(partition).webRequest.onBeforeRequest(null), BROWSE_PARTITION),
  };
}

test('palette-open-in-asks-first-and-opens', async () => {
  // A page on a public name, served by the test itself (no network, no recorded address).
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).protocol.handle('http', () => new Response('<!doctype html><html lang="en"><title>A public article</title><h1>Article</h1></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  }, BROWSE_PARTITION);
  await page.evaluate((key) => localStorage.removeItem(key), OPEN_IN_CONSENT_STORAGE_KEY);
  const tools = await interceptTools();
  const pageUrl = `http://${PUBLIC_HOST}/article?topic=tea`;
  try {
    await go(pageUrl);
    await contentsIdAt(pageUrl);
    await expect(activeTab()).toHaveAttribute('title', 'A public article');
    await press('chrome', 'K', ['mod']);
    // The destination host is in the label: matched and highlighted.
    await input().fill('rich google');
    await expect(activeOption()).toHaveAttribute('data-action', 'open-in.rich-results');
    await expect(activeOption()).toContainText('Rich results test — search.google.com');
    await expect(activeOption().locator('mark').filter({ hasText: /google/i })).toHaveCount(1);
    await expect(activeOption().getByTestId('command-palette-detail')).toContainText('query string');

    // First use of the host: asked, inline, with the query note; Back sends nothing.
    await input().press('Enter');
    const confirm = page.getByTestId('command-palette-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('command-palette-confirm-message')).toHaveText(OPEN_IN_CONSENT_MESSAGE.replace('{host}', 'search.google.com'));
    await expect(page.getByTestId('command-palette-confirm-note')).toHaveText(OPEN_IN_QUERY_NOTE);
    await expect(page.getByTestId('command-palette-confirm-accept')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(palette()).toBeVisible();
    await expect(input()).toBeFocused();
    await expect(activeOption()).toHaveAttribute('data-action', 'open-in.rich-results');
    expect(await tools.seen()).toEqual([]);
    await expect(strip()).toHaveCount(1);

    // Confirmed: one background tab, the page's tab still active, its request exactly the template's URL.
    await input().press('Enter');
    await expect(page.getByTestId('command-palette-confirm-accept')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(palette()).toHaveCount(0);
    await expect(strip()).toHaveCount(2);
    await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'false');
    const expected = `https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`;
    await expect.poll(tools.seen).toEqual([expected]);
    await expect(page.getByTestId('command-palette-status')).toHaveText('Opened search.google.com in a background tab');
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown, OPEN_IN_CONSENT_STORAGE_KEY)).toEqual(['search.google.com']);

    // The same host again: no question.
    await press('chrome', 'K', ['mod']);
    await input().fill('rich results');
    await input().press('Enter');
    await expect(palette()).toHaveCount(0);
    await expect(strip()).toHaveCount(3);
    await expect.poll(async () => (await tools.seen()).length).toBe(2);
  } finally {
    await tools.stop();
    await app.evaluate(({ session }, partition) => session.fromPartition(partition).protocol.unhandle('http'), BROWSE_PARTITION);
  }
});

test('palette-open-in-refuses-a-private-page', async () => {
  // A public-looking name that resolved to a loopback address.
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify(['search.google.com'])), OPEN_IN_CONSENT_STORAGE_KEY);
  const pageUrl = `${site.origin}/page`;
  await go(pageUrl);
  await contentsIdAt(pageUrl);
  await expect(activeTab()).toHaveAttribute('title', TITLE);
  const tools = await interceptTools();
  try {
    await press('chrome', 'K', ['mod']);
    await input().fill('rich results');
    await expect(activeOption()).toHaveAttribute('data-action', 'open-in.rich-results');
    await input().press('Enter');
    await expect(palette()).toHaveCount(0);
    await expect(page.getByTestId('command-palette-status')).toHaveText(OPEN_TOOL_REFUSAL_MESSAGES['private-address']);
    await expect(strip()).toHaveCount(1);
    expect(await tools.seen()).toEqual([]);
  } finally {
    await tools.stop();
  }

  // The site's own robots.txt is not a third party: it opens, on the page's own origin.
  await press('chrome', 'K', ['mod']);
  await input().fill('robots.txt');
  await expect(activeOption()).toHaveAttribute('data-action', 'open-in.robots-txt');
  await input().press('Enter');
  await expect(strip()).toHaveCount(2);
  await contentsIdAt(`${site.origin}/robots.txt`);
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
});

test('palette-selection-survives-list-changes', async () => {
  const pageUrl = `${site.origin}/pushes`;
  await go(pageUrl);
  const id = await contentsIdAt(pageUrl);
  await expect(activeTab()).toHaveAttribute('title', 'Pushes');
  // A real click; a moment later the page itself calls pushState (with that activation), which
  // makes "Go back" appear above the selection.
  await realClick(id, '#push');
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  const back = page.locator('[data-testid="command-palette-option"][data-action="page.back"]');
  await expect(back).toHaveCount(0);
  // Select "Zoom in" with the pointer (a real move picks a row).
  const zoomIn = page.locator('[data-testid="command-palette-option"][data-action="page.zoom-in"]');
  await zoomIn.hover({ position: { x: 30, y: 10 } });
  await zoomIn.hover({ position: { x: 40, y: 14 } });
  await expect(activeOption()).toHaveAttribute('data-action', 'page.zoom-in');
  await expect(back).toHaveCount(0);
  // The list changes under it: the selection stays on "Zoom in", and Enter runs exactly that.
  await expect(back).toHaveCount(1);
  await expect(activeOption()).toHaveAttribute('data-action', 'page.zoom-in');
  await input().press('Enter');
  await expect(palette()).toHaveCount(0);
  const zoom = () => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), id);
  await expect.poll(zoom).toBeCloseTo(1.1, 5);
  expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id)).toBe(`${site.origin}/pushes?moved=1`);
  // Zoom is per host: put it back for the other tests.
  await menu('zoom-reset');
  await expect.poll(zoom).toBe(1);
});

test('palette-closes-when-the-page-goes-fullscreen', async () => {
  const pageUrl = `${site.origin}/fullscreen`;
  await go(pageUrl);
  const id = await contentsIdAt(pageUrl);
  const windowFullscreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFullScreen());
  // A real click (the page's gesture); the page asks for fullscreen a moment later.
  await realClick(id, '#go');
  await press('chrome', 'K', ['mod']);
  await expect(palette()).toBeVisible();
  try {
    await expect.poll(windowFullscreen).toBe(true);
    await expect(palette()).toHaveCount(0);
    // Focus was not put back into the hidden chrome.
    expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === null)).toBe(true);
  } finally {
    // Esc, which main takes and leaves fullscreen with at once, asking the page only once the window
    // settled. Not the page's own `document.exitFullscreen()`: `isFullScreen()` is already true while
    // the macOS enter animation still runs, and a page exit asked for then never settles there.
    await press(id, 'Escape');
    await expect.poll(windowFullscreen).toBe(false);
    await expect.poll(() => run(id, 'document.fullscreenElement === null')).toBe(true);
  }
});

test('palette-clear-browsing-data-asks-once', async () => {
  await go(`${site.origin}/page`);
  await contentsIdAt(`${site.origin}/page`);
  const cookie = () =>
    app.evaluate(async ({ session }, { partition, url }) => (await session.fromPartition(partition).cookies.get({ url, name: 'kept' })).length, { partition: BROWSE_PARTITION, url: site.origin });
  await app.evaluate(async ({ session }, { partition, url }) => session.fromPartition(partition).cookies.set({ url, name: 'kept', value: '1', expirationDate: Date.now() / 1000 + 3600 }), {
    partition: BROWSE_PARTITION,
    url: site.origin,
  });
  expect(await cookie()).toBe(1);
  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify(['search.google.com'])), OPEN_IN_CONSENT_STORAGE_KEY);
  // Main's message box answers for the test (Cancel, then Clear); every question is counted.
  const answer = (index: number) =>
    app.evaluate(({ dialog }, index) => {
      const holder = globalThis as { __paletteBoxes?: number; __paletteBox?: typeof dialog.showMessageBox };
      holder.__paletteBox ??= dialog.showMessageBox;
      holder.__paletteBoxes = 0;
      dialog.showMessageBox = (async () => {
        holder.__paletteBoxes! += 1;
        return { response: index, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, index);
  const asked = () => app.evaluate(() => (globalThis as { __paletteBoxes?: number }).__paletteBoxes ?? 0);
  const runClear = async () => {
    await press('chrome', 'K', ['mod']);
    await input().fill('clear browsing');
    await expect(activeOption()).toHaveAttribute('data-action', 'browser.clear-data');
    await input().press('Enter');
    await expect(palette()).toHaveCount(0);
  };
  try {
    await answer(CLEAR_BROWSING_DATA.dialog.cancelId);
    await runClear();
    await expect.poll(asked).toBe(1);
    // Give a (wrong) clear time to happen: nothing was cleared, and it asked exactly once.
    await page.waitForTimeout(500);
    expect(await cookie()).toBe(1);
    expect(await asked()).toBe(1);

    await answer(CLEAR_BROWSING_DATA.confirmIndex);
    await runClear();
    await expect.poll(cookie).toBe(0);
    expect(await asked()).toBe(1);
    // The "Open in" answers are a preference, not browsing data: still remembered.
    expect(await page.evaluate((key) => localStorage.getItem(key), OPEN_IN_CONSENT_STORAGE_KEY)).toBe(JSON.stringify(['search.google.com']));
  } finally {
    await app.evaluate(({ dialog }) => {
      const holder = globalThis as { __paletteBox?: typeof dialog.showMessageBox };
      if (holder.__paletteBox) dialog.showMessageBox = holder.__paletteBox;
    });
  }
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
