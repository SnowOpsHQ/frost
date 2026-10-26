// Spec: specs/browser.spec.ts (MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES) · Acceptance: specs/tabs.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION, MAX_TABS, NEW_TAB_LABEL, NOTICE_MESSAGES } from '@app/specs/browser.spec';
import { launchApp } from './harness';

/** Loopback pages: `/a` … `/c` (titled), `/untitled` (no <title>), `/slow` (held until released). */
async function startSiteServer() {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>${body}`);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/untitled') html('<p>no title here</p>');
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
let site: Awaited<ReturnType<typeof startSiteServer>>;

test.beforeAll(async () => {
  site = await startSiteServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  site?.releaseSlow();
  await app?.close();
  await site?.close();
});

/** Every live browse-session WebContents (the tabs' pages), as main sees them. */
async function browseContents(): Promise<{ id: number; url: string }[]> {
  return app.evaluate(({ session, webContents }, partition) => {
    const browse = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === browse)
      .map((c) => ({ id: c.id, url: c.getURL() }));
  }, BROWSE_PARTITION);
}

/** WebContents ids of the views attached to the app window's contentView (all visible ones). */
async function attachedViewIds(): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => (child as Electron.WebContentsView).webContents.id),
  );
}

/** The WebContents id showing `url`, once exactly one does. */
async function contentsIdAt(url: string): Promise<number> {
  await expect.poll(async () => (await browseContents()).filter((c) => c.url === url).length).toBe(1);
  return (await browseContents()).find((c) => c.url === url)!.id;
}

/** Clicks an application-menu item in main, as its accelerator would. */
async function menu(id: string): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
}

const strip = () => page.getByTestId('tab');
const activeTab = () => page.locator('[data-testid="tab"][aria-selected="true"]');
const address = () => page.getByTestId('address');

async function go(input: string): Promise<void> {
  await address().click();
  await address().fill(input);
  await address().press('Enter');
}

/** Closes every tab (the last close leaves one fresh empty tab). */
async function resetTabs(): Promise<void> {
  const count = await strip().count();
  for (let i = 0; i < count; i++) await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect.poll(browseContents).toEqual([]);
}

test.beforeEach(async () => {
  await resetTabs();
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
  await strip().nth(1).getByTestId('tab-close').click();
  await expect(strip()).toHaveCount(2);
  await expect.poll(async () => (await browseContents()).map((x) => x.id)).not.toContain(b);
  await expect(activeTab()).toHaveAttribute('title', 'Page C');
  await expect.poll(attachedViewIds).toEqual([c]);

  // Close the active rightmost tab → its left neighbour.
  await activeTab().getByTestId('tab-close').click();
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await browseContents()).map((x) => x.id)).toEqual([a]);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  await expect.poll(attachedViewIds).toEqual([a]);
  await expect(address()).toHaveValue(`${site.origin}/a`);
});

test('close-last-tab-leaves-empty-tab', async () => {
  await go(`${site.origin}/a`);
  await contentsIdAt(`${site.origin}/a`);
  await activeTab().getByTestId('tab-close').click();
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

  // Synthetic key events (Playwright's keyboard, `webContents.sendInputEvent`) never reach native
  // menu accelerators, so the items are clicked in main, exactly what their accelerators do. The
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
