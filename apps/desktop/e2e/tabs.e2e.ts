// Spec: specs/tabs.spec.ts (MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES, RESERVED_TAB_SHORTCUTS) · Acceptance: specs/tabs.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES } from '@app/specs/browser.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/**
 * Loopback pages: `/a` … `/c` (titled), `/untitled` (no <title>), `/slow` (held until released),
 * `/greedy` (cancels every keydown in the capture phase and counts the keys it saw).
 */
async function startSiteServer() {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>${body}`);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/untitled') html('<p>no title here</p>');
    else if (path === '/greedy')
      html(`<title>Greedy</title><input id="field" autofocus><script>
        window.seen = [];
        addEventListener('keydown', (event) => { seen.push(event.key); event.preventDefault(); event.stopImmediatePropagation(); }, true);
      </script>`);
    else if (path === '/slow') held.push(response);
    else {
      const name = path.slice(1).toUpperCase() || 'ROOT';
      html(`<title>Page ${name}</title><h1>Page ${name}</h1>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    releaseSlow: () => {
      for (const response of held.splice(0)) response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Slow</title>');
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
const { browseContents, attachedViewIds, contentsIdAt, menu, strip, activeTab, address, chromeCaughtUp, go, closeAllTabs, press } = chromeHelpers(
  () => app,
  () => page,
);
let site: Awaited<ReturnType<typeof startSiteServer>>;

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  site?.releaseSlow();
  await closeApp(app);
  await site?.close();
});

/** A tab's close button: a sibling of the `role="tab"` element, inside the same strip item. */
const closeOf = (tab: Locator) => tab.locator('xpath=..').getByTestId('tab-close');
test.beforeEach(async () => {
  await closeAllTabs();
});

test('new-tab-button-opens-empty-tab', async () => {
  await go(`${site.origin}/a`);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  await page.getByTestId('new-tab').click();
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(strip().nth(1)).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(address()).toBeFocused();
  await expect(address()).toHaveValue('');
  await expect.poll(attachedViewIds).toEqual([]);
});

test('tabs-keep-own-url-and-history', async () => {
  // Tab 1: /a then /b (can go back). Tab 2: /c only.
  await go(`${site.origin}/a`);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  await go(`${site.origin}/b`);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/c`);
  await expect(activeTab()).toHaveAttribute('title', 'Page C');
  await expect(page.getByTestId('back')).toBeDisabled();

  await strip().nth(0).click();
  await expect(address()).toHaveValue(`${site.origin}/b`);
  await expect(page.getByTestId('back')).toBeEnabled();
  await page.getByTestId('back').click();
  await expect(address()).toHaveValue(`${site.origin}/a`);
  await expect(page.getByTestId('forward')).toBeEnabled();

  await strip().nth(1).click();
  await expect(address()).toHaveValue(`${site.origin}/c`);
  await expect(page.getByTestId('back')).toBeDisabled();
  await expect(page.getByTestId('forward')).toBeDisabled();
  const urls = (await browseContents()).map((c) => c.url).sort();
  expect(urls).toEqual([`${site.origin}/a`, `${site.origin}/c`]);
});

test('switching-shows-exactly-one-view', async () => {
  await go(`${site.origin}/a`);
  const a = await contentsIdAt(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`);
  const b = await contentsIdAt(`${site.origin}/b`);
  await page.getByTestId('new-tab').click();
  await expect.poll(attachedViewIds).toEqual([]);

  for (const [index, expected] of [
    [0, [a]],
    [1, [b]],
    [2, []],
    [1, [b]],
    [0, [a]],
  ] as const) {
    await strip().nth(index).click();
    await expect(strip().nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(attachedViewIds).toEqual(expected);
  }
  await expect(page.getByTestId('start-view')).toBeHidden();
});

test('tab-labels-and-tooltip', async () => {
  await go(`${site.origin}/a`);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  await expect(activeTab().getByTestId('tab-label')).toHaveText('Page A');

  await page.getByTestId('new-tab').click();
  await expect(activeTab().getByTestId('tab-label')).toHaveText(NEW_TAB_LABEL);

  await go(`${site.origin}/untitled`);
  await expect(activeTab().getByTestId('tab-label')).toHaveText(`127.0.0.1:${site.port}`);
  await expect(activeTab()).toHaveAttribute('title', `127.0.0.1:${site.port}`);

  // A long title is truncated by CSS; the tooltip keeps all of it.
  const long = `Long ${'title '.repeat(40)}end`;
  const id = await contentsIdAt(`${site.origin}/untitled`);
  await app.evaluate(({ webContents }, { id, long }) => webContents.fromId(id)!.executeJavaScript(`document.title = ${JSON.stringify(long)}`), { id, long });
  await expect(activeTab()).toHaveAttribute('title', long);
  const label = activeTab().getByTestId('tab-label');
  const overflow = await label.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, ellipsis: getComputedStyle(el).textOverflow }));
  expect(overflow.scroll).toBeGreaterThan(overflow.client);
  expect(overflow.ellipsis).toBe('ellipsis');

  // A loading tab shows the loading indicator (and no favicon image anywhere in the strip).
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/slow`);
  await expect(activeTab().getByTestId('tab-loading')).toBeVisible();
  await expect(page.getByTestId('tab-strip').locator('img')).toHaveCount(0);
  site.releaseSlow();
  await expect(activeTab().getByTestId('tab-loading')).toHaveCount(0);
});

test('close-tab-releases-webcontents', async () => {
  await go(`${site.origin}/a`);
  const a = await contentsIdAt(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`);
  const b = await contentsIdAt(`${site.origin}/b`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/c`);
  const c = await contentsIdAt(`${site.origin}/c`);

  // Close the active middle tab → its right neighbour.
  await strip().nth(1).click();
  await expect.poll(attachedViewIds).toEqual([b]);
  await closeOf(strip().nth(1)).click();
  await expect(strip()).toHaveCount(2);
  await expect.poll(async () => (await browseContents()).map((x) => x.id)).not.toContain(b);
  await expect(activeTab()).toHaveAttribute('title', 'Page C');
  await expect.poll(attachedViewIds).toEqual([c]);

  // Close the active rightmost tab → its left neighbour.
  await closeOf(activeTab()).click();
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await browseContents()).map((x) => x.id)).toEqual([a]);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  await expect.poll(attachedViewIds).toEqual([a]);
  await expect(address()).toHaveValue(`${site.origin}/a`);
});

test('close-last-tab-leaves-empty-tab', async () => {
  await go(`${site.origin}/a`);
  await contentsIdAt(`${site.origin}/a`);
  await closeOf(activeTab()).click();
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect.poll(browseContents).toEqual([]);
  await expect.poll(attachedViewIds).toEqual([]);
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(address()).toBeFocused();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)).toBe(1);
});

test('keyboard-shortcuts-drive-tabs', async () => {
  await go(`${site.origin}/a`);
  const a = await contentsIdAt(`${site.origin}/a`);

  // The menu items are clicked in main, which is what their accelerators do (synthetic key events
  // do not reach native menu accelerators; the key path is `page-cannot-block-tab-shortcuts`). The
  // page view has focus, as when a user presses the shortcut on a page.
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), a);
  await menu('new-tab');
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(address()).toBeFocused();

  await go(`${site.origin}/b`);
  const b = await contentsIdAt(`${site.origin}/b`);
  await menu('new-tab');
  await expect(strip()).toHaveCount(3);
  await expect.poll(attachedViewIds).toEqual([]);

  await menu('select-tab-1');
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(attachedViewIds).toEqual([a]);
  await menu('select-tab-2');
  await expect.poll(attachedViewIds).toEqual([b]);
  // Past the end: nothing changes.
  await menu('select-tab-8');
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await menu('select-last-tab');
  await expect(strip().nth(2)).toHaveAttribute('aria-selected', 'true');
  // Next / previous wrap around.
  await menu('next-tab');
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await menu('previous-tab');
  await expect(strip().nth(2)).toHaveAttribute('aria-selected', 'true');

  // Cmd/Ctrl+L focuses (and selects) the address bar, even while the page has focus.
  await menu('select-tab-1');
  await expect.poll(attachedViewIds).toEqual([a]);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), a);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(address()).not.toBeFocused();
  await menu('focus-address-bar');
  await expect(address()).toBeFocused();
  expect(await address().evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, `${site.origin}/a`.length]);

  // Cmd/Ctrl+W closes the active tab.
  await menu('close-tab');
  await expect(strip()).toHaveCount(2);
  await expect.poll(async () => (await browseContents()).map((x) => x.id)).toEqual([b]);
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(attachedViewIds).toEqual([b]);
});

test('max-tabs-shows-notice', async () => {
  await expect(page.getByTestId('status-notice')).toHaveCount(0);
  for (let i = 1; i < MAX_TABS; i++) await menu('new-tab');
  await expect(strip()).toHaveCount(MAX_TABS);
  await page.getByTestId('new-tab').click();
  await expect(page.getByTestId('status-notice')).toHaveText(NOTICE_MESSAGES['tab-limit']);
  await expect(strip()).toHaveCount(MAX_TABS);
  await menu('new-tab');
  await expect(strip()).toHaveCount(MAX_TABS);
  // The active tab stays in view in the scrolled strip.
  await expect(activeTab()).toBeInViewport();
});

/** The keys the greedy page's keydown listener saw (lower-cased). */
const pageSaw = (id: number) =>
  app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.seen.map((k) => k.toLowerCase())') as Promise<string[]>,
    id,
  );

test('page-cannot-block-tab-shortcuts', async () => {
  await go(`${site.origin}/greedy`);
  const greedy = await contentsIdAt(`${site.origin}/greedy`);
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  // Control: the page really does swallow ordinary keys.
  await press(greedy, 'A');
  await expect.poll(() => pageSaw(greedy)).toEqual(['a']);

  // Mod+T from the greedy page: exactly one new tab (never twice), and the page never saw it.
  await press(greedy, 'T', ['mod']);
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(address()).toBeFocused();
  // Never a second one: the shortcut runs inside main's handling of the key events, so a state
  // taken after them still has two tabs.
  await chromeCaughtUp();
  await expect(strip()).toHaveCount(2);
  expect(await pageSaw(greedy)).toEqual(['a']);

  // The chrome's own WebContents: Mod+1 back to the greedy tab.
  await press('chrome', '1', ['mod']);
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(attachedViewIds).toEqual([greedy]);

  // Ctrl+Tab from the page: next tab; Ctrl+Shift+Tab from the chrome: back.
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  await press(greedy, 'Tab', ['control']);
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await press('chrome', 'Tab', ['control', 'shift']);
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');

  // Mod+W from the page closes its tab.
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), greedy);
  await press(greedy, 'W', ['mod']);
  await expect(strip()).toHaveCount(1);
  await expect.poll(browseContents).toEqual([]);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
});

test('middle-click-closes-tab', async () => {
  await go(`${site.origin}/a`);
  const a = await contentsIdAt(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`);
  const b = await contentsIdAt(`${site.origin}/b`);
  await strip().nth(0).click({ button: 'middle' });
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await browseContents()).map((c) => c.id)).toEqual([b]);
  expect((await browseContents()).map((c) => c.id)).not.toContain(a);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  await expect.poll(attachedViewIds).toEqual([b]);
});

test('tablist-keyboard-navigation', async () => {
  await page.getByTestId('new-tab').click();
  await page.getByTestId('new-tab').click();
  await expect(strip()).toHaveCount(3);
  // Roving tabindex: only the active tab is in the Tab order.
  expect(await strip().evaluateAll((tabs) => tabs.map((t) => t.getAttribute('tabindex')))).toEqual(['-1', '-1', '0']);
  // The close buttons are siblings of the tabs, never inside them.
  await expect(page.locator('[role="tab"] button')).toHaveCount(0);
  await expect(page.getByTestId('tab-close').first()).toHaveAttribute('aria-hidden', 'true');

  await strip().nth(2).focus();
  await page.keyboard.press('ArrowRight');
  await expect(strip().nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(strip().nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(strip().nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(strip().nth(2)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(strip().nth(1)).toBeFocused();
  // Moving focus does not activate; Enter does.
  await expect(strip().nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  // Delete closes the focused tab.
  await strip().nth(0).focus();
  await page.keyboard.press('Delete');
  await expect(strip()).toHaveCount(2);
});

test('background-page-close-closes-tab-e2e', async () => {
  await go(`${site.origin}/a`);
  const a = await contentsIdAt(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`);
  const b = await contentsIdAt(`${site.origin}/b`);
  await app.evaluate(({ webContents }, id) => {
    void webContents.fromId(id)!.executeJavaScript('window.close()').catch(() => {});
  }, a);
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await browseContents()).map((c) => c.id)).toEqual([b]);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  await expect.poll(attachedViewIds).toEqual([b]);
  await expect(address()).toHaveValue(`${site.origin}/b`);
});
