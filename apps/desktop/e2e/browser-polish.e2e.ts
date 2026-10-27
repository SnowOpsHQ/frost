// Specs: specs/browser-polish.spec.ts (FIND_*, CLEAR_HISTORY, HISTORY_MENU_ID, JUMP_BACK_IN_TITLE, SEARCH_ENGINES),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['find-in-page' | 'reopen-closed-tab']), specs/browser.spec.ts (BROWSE_PARTITION)
// Acceptance: specs/browser-polish.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { CLEAR_HISTORY, HISTORY_EMPTY_MESSAGE, HISTORY_MENU_ID, JUMP_BACK_IN_TITLE, searchEngineUrl } from '@app/specs/browser-polish.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/**
 * Loopback pages: `/find` (three "tea"s; it logs every key and input event it sees), `/greedy`
 * (cancels every keydown), `/h/<name>` (a page titled `<Name> page`), anything else a plain page.
 */
async function startSiteServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en">${body}</html>`);
    if (url.pathname === '/find')
      html(`<title>Find page</title><body><p>Green tea is calm.</p><p>Black TEA is bold.</p><p>White tea is light.</p><p>${'Filler text. '.repeat(400)}</p><script>
        window.seen = [];
        for (const type of ['keydown', 'keypress', 'input', 'beforeinput']) addEventListener(type, (event) => seen.push(type + ':' + (event.key ?? event.data ?? '')), true);
      </script></body>`);
    else if (url.pathname === '/greedy')
      html(`<title>Greedy</title><input id="field" autofocus><script>
        window.seen = [];
        addEventListener('keydown', (event) => { seen.push(event.key); event.preventDefault(); event.stopImmediatePropagation(); }, true);
      </script>`);
    else if (url.pathname.startsWith('/h/')) {
      const name = url.pathname.slice(3);
      html(`<title>${name.charAt(0).toUpperCase()}${name.slice(1)} page</title><p>${name}</p>`);
    } else html(`<title>Plain ${url.pathname}</title><p>plain</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
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
const { go, contentsIdAt, menu, press, run, strip, activeTab, closeAllTabs, chromeCaughtUp } = chromeHelpers(
  () => app,
  () => page,
);

const findBar = () => page.getByTestId('find-bar');
const findInput = () => page.getByTestId('find-input');
const findCount = () => page.getByTestId('find-count');
const history = () => page.getByTestId('history-view');
const rows = () => page.getByTestId('history-row');
const pageSaw = (id: number) => run(id, 'window.seen') as Promise<string[]>;
const isPageFocused = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), id);

/** Answers every `https:` request of the browse session locally (nothing reaches a real engine); records each URL. */
async function stubHttps(): Promise<void> {
  await app.evaluate(({ session }, partition) => {
    const holder = globalThis as { __polishHttps?: string[] };
    holder.__polishHttps = [];
    session.fromPartition(partition).protocol.handle('https', (request) => {
      holder.__polishHttps!.push(request.url);
      return new Response('<!doctype html><title>stub search</title><p>stub</p>', { headers: { 'Content-Type': 'text/html' } });
    });
  }, BROWSE_PARTITION);
}
async function unstubHttps(): Promise<void> {
  await app.evaluate(({ session }, partition) => session.fromPartition(partition).protocol.unhandle('https'), BROWSE_PARTITION);
}
const httpsRequests = () => app.evaluate(() => (globalThis as { __polishHttps?: string[] }).__polishHttps ?? []);

/** Main's message box answers `index` for the test; every question is counted. */
async function answerDialogs(index: number): Promise<void> {
  await app.evaluate(({ dialog }, index) => {
    const holder = globalThis as { __polishBoxes?: number; __polishBox?: typeof dialog.showMessageBox };
    holder.__polishBox ??= dialog.showMessageBox;
    holder.__polishBoxes = 0;
    dialog.showMessageBox = (async () => {
      holder.__polishBoxes! += 1;
      return { response: index, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, index);
}
const dialogsAsked = () => app.evaluate(() => (globalThis as { __polishBoxes?: number }).__polishBoxes ?? 0);
async function restoreDialogs(): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const holder = globalThis as { __polishBox?: typeof dialog.showMessageBox };
    if (holder.__polishBox) dialog.showMessageBox = holder.__polishBox;
  });
}

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await closeAllTabs();
});

test('find-counts-steps-and-clears', async () => {
  const url = `${site.origin}/find`;
  await go(url);
  const id = await contentsIdAt(url);
  await expect(activeTab()).toHaveAttribute('title', 'Find page');
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), id);
  // Record how main clears the find.
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)!;
    const holder = globalThis as { __polishStops?: string[] };
    holder.__polishStops = [];
    const stop = contents.stopFindInPage.bind(contents);
    contents.stopFindInPage = (action) => {
      holder.__polishStops!.push(action);
      stop(action);
    };
  }, id);

  await press(id, 'F', ['mod']);
  await expect(findBar()).toBeVisible();
  await expect(findInput()).toBeFocused();
  // The bar is a row above the page area: the view moves below it (once the chrome reported the
  // new page area to main, which lays the view out: asynchronously).
  const bar = (await findBar().boundingBox())!;
  const viewTop = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children[0]!.getBounds().y);
  await expect.poll(viewTop).toBeGreaterThanOrEqual(Math.round(bar.y + bar.height) - 1);

  await findInput().fill('tea');
  await expect(findCount()).toHaveText('1 of 3');
  await findInput().press('Enter');
  await expect(findCount()).toHaveText('2 of 3');
  await findInput().press('Enter');
  await expect(findCount()).toHaveText('3 of 3');
  await findInput().press('Shift+Enter');
  await expect(findCount()).toHaveText('2 of 3');
  // Mod+G / Mod+Shift+G while the bar is open, from the chrome or the page.
  await press('chrome', 'G', ['mod']);
  await expect(findCount()).toHaveText('3 of 3');
  await press(id, 'G', ['mod', 'shift']);
  await expect(findCount()).toHaveText('2 of 3');
  // Match case: only the two lower-case ones (a new session starts from the active match).
  await page.getByTestId('find-case').click();
  await expect(findCount()).toHaveText(/^[12] of 2$/);
  await page.getByTestId('find-case').click();
  await expect(findCount()).toHaveText(/^[1-3] of 3$/);
  await findInput().fill('no such words');
  await expect(findCount()).toHaveText('No results');
  await findInput().fill('tea');
  await expect(findCount()).toHaveText('1 of 3');

  // Esc closes the bar, clears the page's find highlight and gives the page focus back.
  await findInput().press('Escape');
  await expect(findBar()).toHaveCount(0);
  await expect.poll(() => app.evaluate(() => (globalThis as { __polishStops?: string[] }).__polishStops ?? [])).toContain('clearSelection');
  await expect.poll(() => isPageFocused(id)).toBe(true);
  // The find text never reached the page: it saw no key or input event of it.
  expect((await pageSaw(id)).filter((entry) => /:(t|e|a|tea|no such words)$/i.test(entry))).toEqual([]);
  // Mod+F again: the text is kept (selected) and found again.
  await press(id, 'F', ['mod']);
  await expect(findInput()).toHaveValue('tea');
  await expect(findCount()).toHaveText('1 of 3');
  // A new document closes the bar.
  await go(`${site.origin}/plain`);
  await contentsIdAt(`${site.origin}/plain`);
  await expect(findBar()).toHaveCount(0);
});

test('find-shortcuts-beat-a-greedy-page', async () => {
  await go(`${site.origin}/a`);
  await contentsIdAt(`${site.origin}/a`);
  await menu('new-tab');
  await go(`${site.origin}/greedy`);
  const greedy = await contentsIdAt(`${site.origin}/greedy`);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  // Its URL commits before its script runs: wait for the key listener, or the control key is lost.
  await expect.poll(() => run(greedy, 'Array.isArray(window.seen)')).toBe(true);
  // Control: the page really does swallow ordinary keys.
  await press(greedy, 'A');
  await expect.poll(() => pageSaw(greedy)).toEqual(['a']);

  await press(greedy, 'F', ['mod']);
  await expect(findBar()).toBeVisible();
  await expect(findInput()).toBeFocused();

  // Close the other tab, then Mod+Shift+T from the greedy page brings it back.
  // (The close button shows on hover; a dispatched click runs it.)
  await page.getByTestId('tab-item').nth(0).getByTestId('tab-close').dispatchEvent('click');
  await expect(strip()).toHaveCount(1);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  await press(greedy, 'T', ['mod', 'shift']);
  await expect(strip()).toHaveCount(2);
  await contentsIdAt(`${site.origin}/a`);
  // The page saw neither shortcut.
  expect(await pageSaw(greedy)).toEqual(['a']);
});

test('reopen-closed-tab-restores-url-and-history', async () => {
  await go(`${site.origin}/one`);
  await contentsIdAt(`${site.origin}/one`);
  await go(`${site.origin}/two`);
  await contentsIdAt(`${site.origin}/two`);
  await menu('close-tab');
  await expect(activeTab()).toHaveAttribute('title', 'New Tab');
  await expect.poll(async () => (await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((c) => c.getURL()))).some((u) => u.endsWith('/two'))).toBe(false);

  await press('chrome', 'T', ['mod', 'shift']);
  const reopened = await contentsIdAt(`${site.origin}/two`);
  await expect(strip()).toHaveCount(2);
  await expect(activeTab()).toHaveAttribute('title', 'Plain /two');
  // Its back / forward history came back with it. Back once the restored page has loaded, as a
  // person would: on macOS, Back within the first few milliseconds of the history restore's own
  // load can crash the renderer (a second later, mid-load, it does not).
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), reopened)).toBe(false);
  await expect(page.getByTestId('back')).toBeEnabled();
  await page.getByTestId('back').click();
  await contentsIdAt(`${site.origin}/one`);
  // File › Reopen Closed Tab does the same.
  await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await menu('reopen-closed-tab');
  await expect(strip()).toHaveCount(2);
  await contentsIdAt(`${site.origin}/one`);
});

test('new-tab-page-jump-back-in', async () => {
  for (const name of ['kiwi', 'lime', 'kiwi', 'kiwi']) {
    await go(`${site.origin}/h/${name}`);
    await contentsIdAt(`${site.origin}/h/${name}`);
  }
  await menu('new-tab');
  const jump = page.getByTestId('jump-back-in');
  await expect(jump).toBeVisible();
  await expect(jump).toContainText(JUMP_BACK_IN_TITLE);
  const kiwi = page.locator(`[data-testid="jump-tile"][data-url="${site.origin}/h/kiwi"]`);
  await expect(kiwi).toContainText('Kiwi page');
  await expect(kiwi).toContainText('127.0.0.1');
  // No images at all: a frost-drawn monogram, no favicon.
  expect(await jump.locator('img').count()).toBe(0);
  await expect(page.locator(`[data-testid="jump-tile"][data-url="${site.origin}/h/lime"]`)).toBeVisible();
  await kiwi.click();
  await contentsIdAt(`${site.origin}/h/kiwi`);
  await expect(activeTab()).toHaveAttribute('title', 'Kiwi page');
});

test('history-lists-searches-deletes-clears', async () => {
  for (const name of ['alpha', 'beta', 'gamma']) {
    await go(`${site.origin}/h/${name}`);
    await contentsIdAt(`${site.origin}/h/${name}`);
  }
  await menu(HISTORY_MENU_ID);
  await expect(history()).toBeVisible();
  await expect(page.getByTestId('history-search')).toBeFocused();
  // The sheet fills the page column: the tab's view is laid out zero-high.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children[0]?.getBounds().height ?? 0)).toBe(0);
  const row = (name: string) => page.locator(`[data-testid="history-row"][data-url="${site.origin}/h/${name}"]`);
  await expect(row('gamma')).toContainText('Gamma page');
  // Newest first, under today's heading.
  const listed = await rows().evaluateAll((els) => els.map((el) => el.getAttribute('data-url')));
  expect(listed.indexOf(`${site.origin}/h/gamma`)).toBeLessThan(listed.indexOf(`${site.origin}/h/alpha`));
  await expect(page.getByTestId('history-list')).toContainText('Today');
  // Page text is inert: no links, no images.
  expect(await history().locator('a, img').count()).toBe(0);

  await page.getByTestId('history-search').fill('BETA');
  await expect(rows()).toHaveCount(1);
  await expect(rows().first()).toContainText('Beta page');
  await rows().first().getByTestId('history-delete').click();
  await expect(rows()).toHaveCount(0);
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await page.getByTestId('history-search').fill('');
  await expect(row('alpha')).toBeVisible();
  await expect(row('beta')).toHaveCount(0);

  // Opening a row loads it in this tab and closes the sheet.
  await row('alpha').getByTestId('history-open').click();
  await expect(history()).toHaveCount(0);
  await contentsIdAt(`${site.origin}/h/alpha`);
  await expect(activeTab()).toHaveAttribute('title', 'Alpha page');

  // Clear all history asks in main: Cancel keeps everything, Clear removes it all.
  await menu(HISTORY_MENU_ID);
  await expect(row('gamma')).toBeVisible();
  try {
    await answerDialogs(CLEAR_HISTORY.dialog.cancelId);
    await page.getByTestId('history-clear-all').click();
    await expect.poll(dialogsAsked).toBe(1);
    await expect(row('gamma')).toBeVisible();
    await answerDialogs(CLEAR_HISTORY.confirmIndex);
    await page.getByTestId('history-clear-all').click();
    await expect(page.getByTestId('history-empty')).toHaveText(HISTORY_EMPTY_MESSAGE);
    expect(await dialogsAsked()).toBe(1);
  } finally {
    await restoreDialogs();
  }
  await page.keyboard.press('Escape');
  await expect(history()).toHaveCount(0);
});

test('d-prefix-searches-duckduckgo', async () => {
  await stubHttps();
  try {
    await go('d test');
    const expected = searchEngineUrl('duckduckgo', 'test');
    expect(expected).toBe('https://duckduckgo.com/?q=test');
    await contentsIdAt(expected);
    await expect(activeTab()).toHaveAttribute('title', 'stub search');
    expect(await httpsRequests()).toContain(expected);
    // `javascript:` after a prefix is still only a search.
    await go('b javascript:alert(1)');
    await contentsIdAt(searchEngineUrl('bing', 'javascript:alert(1)'));
  } finally {
    await unstubHttps();
  }
});

test('search-engine-persists-across-relaunch', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-polish-'));
  const [mainApp, mainPage] = [app, page];
  try {
    ({ app, page } = await launchApp([], { userDataDir: profile }));
    await page.waitForLoadState('domcontentloaded');
    await stubHttps();
    await chromeCaughtUp();
    await press('chrome', 'K', ['mod']);
    await page.getByTestId('command-palette-input').fill('search with bing');
    await expect(page.locator('[data-testid="command-palette-option"][aria-selected="true"]')).toHaveAttribute('data-action', 'settings.search-engine.bing');
    await page.getByTestId('command-palette-input').press('Enter');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await go('green tea');
    await contentsIdAt(searchEngineUrl('bing', 'green tea'));
    await closeApp(app);

    ({ app, page } = await launchApp([], { userDataDir: profile }));
    await page.waitForLoadState('domcontentloaded');
    await stubHttps();
    await chromeCaughtUp();
    await go('black tea');
    await contentsIdAt(searchEngineUrl('bing', 'black tea'));
    // The palette no longer offers the engine in use.
    await press('chrome', 'K', ['mod']);
    await page.getByTestId('command-palette-input').fill('search with');
    await expect(page.locator('[data-action="settings.search-engine.google"]')).toBeVisible();
    await expect(page.locator('[data-action="settings.search-engine.bing"]')).toHaveCount(0);
  } finally {
    await closeApp(app);
    [app, page] = [mainApp, mainPage];
    await rm(profile, { recursive: true, force: true });
  }
});
