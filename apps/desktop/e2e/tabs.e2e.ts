// Spec: specs/tabs.spec.ts (MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES, RESERVED_TAB_SHORTCUTS, CHROME_ROW, CHROME_ROW_HEIGHT_PX, TAB_MIN_WIDTH_PX, ADDRESS_BASIS_PX, ADDRESS_MIN_WIDTH_PX, CHROME_MIN_CONTENT_WIDTH_PX) · Acceptance: specs/tabs.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { ADDRESS_BASIS_PX, ADDRESS_MIN_WIDTH_PX, CHROME_MIN_CONTENT_WIDTH_PX, CHROME_ROW, CHROME_ROW_HEIGHT_PX, MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES, TAB_MIN_WIDTH_PX } from '@app/specs/browser.spec';
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
  // Its URL commits before its script runs: wait for the key listener, or the control key is lost.
  await expect
    .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('Array.isArray(window.seen)') as Promise<boolean>, greedy))
    .toBe(true);
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
  // Focus stays in the strip, on the neighbour that remains.
  await expect(strip().nth(0)).toBeFocused();
});

const row = () => page.getByTestId('chrome-row');
const tablist = () => page.getByRole('tablist', { name: 'Tabs' });
/** A `CHROME_ROW` control: the tablist's is its one Tab stop, the active tab. */
const control = (id: (typeof CHROME_ROW)[number]) => (id === 'tab-strip' ? activeTab() : page.getByTestId(id));

test('chrome-row-holds-tabs-address-and-tools', async () => {
  await go(`${site.origin}/a`);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  const facts = await row().evaluate((el, ids) => {
    const box = el.getBoundingClientRect();
    const controls = ids.map((id) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`));
    const list = el.querySelector('[role="tablist"]')!;
    const input = el.querySelector('[data-testid="address"]')!;
    const below = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().top;
    return {
      top: box.top,
      height: box.height,
      found: controls.map((c) => c !== null),
      inOrder: controls.every((c, i) => i === 0 || (controls[i - 1]!.compareDocumentPosition(c!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      // Each control's centre against the row's.
      offCentre: controls.map((c) => {
        const r = c!.getBoundingClientRect();
        return Math.abs(r.top + r.height / 2 - (box.top + box.height / 2));
      }),
      addressIsNextSibling: list.nextElementSibling?.contains(input) === true && !list.contains(input),
      listHoldsOnlyTabs: [...list.querySelectorAll('input, button:not([aria-hidden="true"]), [data-testid="new-tab"]')].length === 0,
      tabsInList: list.querySelectorAll('[role="tab"]').length,
      bands: ['.prompt-slot', '.render-slot', '.find-slot', '[data-testid="page-area"]'].map(below),
      bottom: box.bottom,
    };
  }, [...CHROME_ROW]);
  expect(facts.top).toBe(0);
  expect(facts.height).toBe(CHROME_ROW_HEIGHT_PX);
  expect(facts.found).toEqual(CHROME_ROW.map(() => true));
  expect(facts.inOrder).toBe(true);
  for (const [i, off] of facts.offCentre.entries()) expect(off, CHROME_ROW[i]).toBeLessThanOrEqual(1);
  expect(facts.addressIsNextSibling).toBe(true);
  expect(facts.listHoldsOnlyTabs).toBe(true);
  expect(facts.tabsInList).toBe(1);
  for (const top of facts.bands) expect(top).toBeGreaterThanOrEqual(facts.bottom);
  // The tab's view starts at the page area's top, right under the row (and the bands, empty here).
  const areaTop = await page.getByTestId('page-area').evaluate((el) => el.getBoundingClientRect().top);
  expect(areaTop).toBeLessThanOrEqual(facts.bottom + 1);
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).getBounds().y))
    .toBe(Math.round(areaTop));
});

test('chrome-row-tab-order', async () => {
  // A background tab, then the active one with somewhere to go back and forward to.
  await go(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  for (const name of ['b', 'c', 'd']) {
    await go(`${site.origin}/${name}`);
    await expect(activeTab()).toHaveAttribute('title', `Page ${name.toUpperCase()}`);
  }
  await page.getByTestId('back').click();
  await expect(activeTab()).toHaveAttribute('title', 'Page C');
  await expect(page.getByTestId('back')).toBeEnabled();
  await expect(page.getByTestId('forward')).toBeEnabled();
  await expect(page.getByTestId('reload')).toBeEnabled();

  await page.getByTestId('back').focus();
  for (const id of CHROME_ROW.slice(1)) {
    await page.keyboard.press('Tab');
    await expect(control(id), `Tab to ${id}`).toBeFocused();
  }
  for (const id of CHROME_ROW.slice(0, -1).reverse()) {
    await page.keyboard.press('Shift+Tab');
    await expect(control(id), `Shift+Tab to ${id}`).toBeFocused();
  }
  // Shift+Tab from the address bar returns to the active tab, whose tablist keys still work.
  await address().focus();
  await page.keyboard.press('Shift+Tab');
  await expect(activeTab()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(strip().nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(strip().nth(1)).toBeFocused();
  // Mod+L from the page (the menu item its accelerator runs) focuses the address bar.
  await menu('focus-address-bar');
  await expect(address()).toBeFocused();
});

/** Runs `body` with the window's content `width` wide (`expected`: what the window gives); restores it after. */
async function withContentWidth(width: number, body: () => Promise<void>, expected = width): Promise<void> {
  const original = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
  await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0]!.setContentSize(w, 700), width);
  try {
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(expected);
    await body();
  } finally {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), original);
  }
}

/** Opens tabs until the strip holds `count`; each new tab focuses the address bar, which is waited for. */
async function openTabs(count: number): Promise<void> {
  const have = await strip().count();
  for (let i = have; i < count; i++) await menu('new-tab');
  await expect(strip()).toHaveCount(count);
  if (count > have) await expect(address()).toBeFocused();
}

/** Opens enough tabs to overflow the tablist in an 800px wide window; restores the window after. */
async function withNarrowWindowAndManyTabs(body: () => Promise<void>): Promise<void> {
  await withContentWidth(800, async () => {
    await openTabs(12);
    await body();
  });
}

/** The row's measurements: each tab's width, the address bar's, each tool's box, and whether anything left the row. */
const rowFacts = () =>
  row().evaluate((el, ids) => {
    const box = el.getBoundingClientRect();
    const list = el.querySelector('[role="tablist"]')!;
    const tools = ids.filter((id) => id !== 'tab-strip' && id !== 'address').map((id) => {
      const r = el.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      return { id, width: r.width, height: r.height };
    });
    const parts = [...el.children].filter((c) => !c.classList.contains('progress')).map((c) => c.getBoundingClientRect());
    return {
      tabWidths: [...list.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect().width),
      scrolls: list.scrollWidth > list.clientWidth,
      listWidth: list.getBoundingClientRect().width,
      address: el.querySelector('[data-testid="address"]')!.closest('.address')!.getBoundingClientRect().width,
      tools,
      inside: parts.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
      scrollLeft: el.scrollLeft,
    };
  }, [...CHROME_ROW]);

/** The focused tab's whole pill (its × too) is inside the tablist's box. */
const focusedPillInside = () =>
  tablist().evaluate((list) => {
    const pill = document.activeElement?.closest('.tab')?.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return pill !== undefined && pill.left >= box.left - 0.5 && pill.right <= box.right + 0.5;
  });

test('narrow-tabs-scroll-and-address-keeps-its-width', async () => {
  await withNarrowWindowAndManyTabs(async () => {
    // The active tab (the last one opened) is scrolled into view, whole.
    await expect
      .poll(() =>
        tablist().evaluate((list) => {
          const box = list.getBoundingClientRect();
          const active = list.querySelector('[role="tab"][aria-selected="true"]')!.closest('.tab')!.getBoundingClientRect();
          return active.left >= box.left && active.right <= box.right;
        }),
      )
      .toBe(true);
    const facts = await row().evaluate((el) => {
      const list = el.querySelector('[role="tablist"]')!;
      return {
        height: el.getBoundingClientRect().height,
        tabWidths: [...list.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect().width),
        scrolls: list.scrollWidth > list.clientWidth,
        address: el.querySelector('[data-testid="address"]')!.closest('.address')!.getBoundingClientRect().width,
      };
    });
    expect(facts.height).toBe(CHROME_ROW_HEIGHT_PX);
    for (const width of facts.tabWidths) expect(width).toBeGreaterThanOrEqual(TAB_MIN_WIDTH_PX - 0.5);
    expect(facts.scrolls).toBe(true);
    expect(facts.address).toBeGreaterThanOrEqual(ADDRESS_BASIS_PX - 0.5);
  });
});

test('tabs-give-way-before-the-address-bar', async () => {
  await withContentWidth(1280, async () => {
    await openTabs(6);
    let facts = await rowFacts();
    expect(Math.max(...facts.tabWidths)).toBeLessThan(224);
    expect(facts.address).toBeGreaterThanOrEqual(ADDRESS_BASIS_PX - 0.5);
    for (const tool of facts.tools) expect([tool.width, tool.height], tool.id).toEqual([34, 34]);
    await openTabs(20);
    facts = await rowFacts();
    for (const width of facts.tabWidths) expect(width).toBeCloseTo(TAB_MIN_WIDTH_PX, 1);
    expect(facts.scrolls).toBe(true);
    expect(facts.address).toBeGreaterThanOrEqual(ADDRESS_BASIS_PX - 0.5);
    for (const tool of facts.tools) expect([tool.width, tool.height], tool.id).toEqual([34, 34]);
    expect(facts.inside).toBe(true);
  });
});

test('narrowest-window-keeps-the-row-whole', async () => {
  // The minimum counts the frame, and is the OS's to enforce on a user's resize (Electron doesn't
  // clamp setContentSize): less the frame's width, it is the row's minimum.
  const minContent = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return win.getMinimumSize()[0]! - (win.getSize()[0]! - win.getContentSize()[0]!);
  });
  // Never less; a fractional display scale may round the frame's width by a pixel.
  expect(minContent).toBeGreaterThanOrEqual(CHROME_MIN_CONTENT_WIDTH_PX);
  expect(minContent).toBeLessThanOrEqual(CHROME_MIN_CONTENT_WIDTH_PX + 1);
  await withContentWidth(
    CHROME_MIN_CONTENT_WIDTH_PX,
    async () => {
      await openTabs(4);
      const facts = await rowFacts();
      expect(facts.inside).toBe(true);
      expect(facts.scrolls).toBe(true);
      // One whole tab and its ring room.
      expect(facts.listWidth).toBeGreaterThanOrEqual(TAB_MIN_WIDTH_PX + 8 - 0.5);
      await expect.poll(async () => (await activeTab().locator('xpath=..').boundingBox())!.width).toBeGreaterThanOrEqual(TAB_MIN_WIDTH_PX - 0.5);
      await activeTab().focus();
      await expect.poll(focusedPillInside).toBe(true);
      expect(facts.address).toBeCloseTo(ADDRESS_MIN_WIDTH_PX, 0);
      for (const tool of facts.tools) expect([tool.width, tool.height], tool.id).toEqual([34, 34]);
    },
  );
});

test('focus-never-scrolls-the-row', async () => {
  await openTabs(3);
  // A test-only width, narrower than the row's contents (the window's minimum keeps a real one whole).
  await row().evaluate((el) => el.style.setProperty('width', '300px'));
  try {
    await page.getByTestId('render-profile-toggle').focus();
    await expect(page.getByTestId('render-profile-toggle')).toBeFocused();
    const facts = await row().evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      back: el.querySelector('[data-testid="back"]')!.getBoundingClientRect().left - el.getBoundingClientRect().left,
    }));
    expect(facts).toEqual({ scrollLeft: 0, back: 12 });
  } finally {
    await row().evaluate((el) => el.style.removeProperty('width'));
  }
});

test('arrow-focus-brings-the-whole-tab-in', async () => {
  await withContentWidth(1280, async () => {
    await openTabs(20);
    await strip().nth(0).click();
    await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
    // Switching to an empty tab focuses the address bar (asynchronously): let it, then take focus back.
    await expect(address()).toBeFocused();
    await activeTab().focus();
    for (let i = 1; i < 20; i++) {
      await page.keyboard.press('ArrowRight');
      await expect(strip().nth(i)).toBeFocused();
      await expect.poll(focusedPillInside, `ArrowRight to tab ${i}`).toBe(true);
    }
    for (let i = 18; i >= 0; i--) {
      await page.keyboard.press('ArrowLeft');
      await expect(strip().nth(i)).toBeFocused();
      await expect.poll(focusedPillInside, `ArrowLeft to tab ${i}`).toBe(true);
    }
  });
});

/** Runs `body` with the row forced `width` wide (test-only: a tiled window can be narrower than its minimum). */
async function withRowWidth(width: number, body: () => Promise<void>): Promise<void> {
  await row().evaluate((el, w) => el.style.setProperty('width', `${w}px`), width);
  try {
    await body();
  } finally {
    await row().evaluate((el) => el.style.removeProperty('width'));
  }
}

/** Focus has stayed on `tab` a moment after an action (nothing asynchronous took it). */
async function focusStaysOn(tab: Locator): Promise<void> {
  await expect(tab).toBeFocused();
  // Main's state change and the chrome's effects arrive asynchronously: give them time to act.
  await chromeSettled();
  await expect(tab).toBeFocused();
}

/** Two state round trips: whatever main sent for the last action has been rendered. */
async function chromeSettled(): Promise<void> {
  for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 150))));
}

test('delete-keeps-focus-on-the-neighbour-tab', async () => {
  // An empty neighbour: [A, B (active), empty]; Delete on B.
  await go(`${site.origin}/a`);
  await page.getByTestId('new-tab').click();
  await go(`${site.origin}/b`);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  await openTabs(3);
  await strip().nth(1).click();
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await activeTab().focus();
  await page.keyboard.press('Delete');
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(1)).toHaveAttribute('aria-selected', 'true');
  await focusStaysOn(strip().nth(1));
  await expect(address()).not.toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(strip().nth(0)).toBeFocused();

  // A page neighbour: [A, C (active), D]; Delete on C.
  await strip().nth(1).click();
  await go(`${site.origin}/c`);
  await openTabs(3);
  await go(`${site.origin}/d`);
  const d = await contentsIdAt(`${site.origin}/d`);
  await strip().nth(1).click();
  await expect(activeTab()).toHaveAttribute('title', 'Page C');
  await activeTab().focus();
  await page.keyboard.press('Delete');
  await expect(strip()).toHaveCount(2);
  await expect(activeTab()).toHaveAttribute('title', 'Page D');
  await focusStaysOn(strip().nth(1));
  expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isFocused(), d)).toBe(false);
  await page.keyboard.press('ArrowLeft');
  await expect(strip().nth(0)).toBeFocused();
});

test('delete-at-the-minimum-keeps-the-survivor-whole', async () => {
  await withRowWidth(CHROME_MIN_CONTENT_WIDTH_PX, async () => {
    await openTabs(20);
    await strip().nth(0).click();
    await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(address()).toBeFocused();
    await activeTab().focus();
    await page.keyboard.press('ArrowRight');
    await expect(strip().nth(1)).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(strip()).toHaveCount(19);
    await expect(strip().nth(1)).toBeFocused();
    await expect.poll(focusedPillInside, "Delete's survivor").toBe(true);
    await chromeSettled();
    expect(await focusedPillInside()).toBe(true);
  });
});

test('tab-into-a-half-visible-active-tab', async () => {
  await openTabs(20);
  await strip().nth(0).click();
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(address()).toBeFocused();
  // Half of the active (first) tab scrolled out past the tablist's left edge.
  await tablist().evaluate((list) => {
    list.scrollLeft = 60;
  });
  expect(await tablist().evaluate((list) => list.scrollLeft)).toBeCloseTo(60, 0);
  await page.keyboard.press('Shift+Tab');
  await expect(activeTab()).toBeFocused();
  await expect.poll(focusedPillInside).toBe(true);
});

test('below-the-minimum-the-address-bar-gives-way', async () => {
  await openTabs(4);
  await withRowWidth(480, async () => {
    const facts = await rowFacts();
    expect(facts.inside).toBe(true);
    for (const tool of facts.tools) expect([tool.width, tool.height], tool.id).toEqual([34, 34]);
    expect(facts.listWidth).toBeGreaterThanOrEqual(TAB_MIN_WIDTH_PX + 8 - 0.5);
    expect(facts.address).toBeLessThan(ADDRESS_MIN_WIDTH_PX);
    await activeTab().focus();
    await expect.poll(focusedPillInside).toBe(true);
  });
});

test('focused-tab-ring-shows-in-scrolled-tablist', async () => {
  await withNarrowWindowAndManyTabs(async () => {
    /** The focused tab's box grown by the ring (4px), inside the tablist's box. */
    const ringInside = () =>
      tablist().evaluate((list) => {
        const tab = document.activeElement!.closest('.tab')!.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        return tab.left - 4 >= box.left - 0.5 && tab.right + 4 <= box.right + 0.5 && tab.top - 4 >= box.top - 0.5 && tab.bottom + 4 <= box.bottom + 0.5;
      });
    await activeTab().focus();
    await page.keyboard.press('Home');
    await expect(strip().nth(0)).toBeFocused();
    await expect.poll(ringInside).toBe(true);
    await page.keyboard.press('End');
    await expect(strip().nth(11)).toBeFocused();
    await expect.poll(ringInside).toBe(true);
  });
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
