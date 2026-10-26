// Specs: specs/browser.spec.ts, specs/ipc-sender.spec.ts · Acceptance: specs/browser-chrome.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_WINDOW_TITLE, BROWSE_PARTITION, SEARCH_URL_TEMPLATE, TAB_VIEW_WEB_PREFERENCES } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_BRIDGE_KEY, IPC_CHANNEL } from '@app/specs/ipc-transport.spec';
import { appEntryScriptUrl, closeApp, launchApp } from './harness';

/** Loopback pages for the tab: `/a`, `/b` (titled), `/count` (counts its loads), `/slow` (held until released), `/ok.js`. */
async function startSiteServer() {
  let count = 0;
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const html = (title: string, body = '') =>
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    if (path === '/a') html('Page A', '<a href="/b">to b</a>');
    else if (path === '/b') html('Page B');
    else if (path === '/count') html(`Count ${++count}`);
    else if (path === '/slow') held.push(response);
    else if (path === '/ok.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('/* ok */');
    else html('loopback');
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
  await closeApp(app);
  await site?.close();
});

/** The browse-session WebContents (the tabs), as main sees them. */
async function tabs(): Promise<{ id: number; url: string; title: string; loading: boolean }[]> {
  return app.evaluate(({ session, webContents }, partition) => {
    const browse = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((c) => c.session === browse)
      .map((c) => ({ id: c.id, url: c.getURL(), title: c.getTitle(), loading: c.isLoading() }));
  }, BROWSE_PARTITION);
}

/** The single tab, once it exists. */
async function tab() {
  await expect.poll(async () => (await tabs()).length).toBe(1);
  const [only] = await tabs();
  return only!;
}

/** Views attached to the app window's contentView: their WebContents id, bounds and visibility. */
async function attachedViews() {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return win.contentView.children.map((child) => {
      const view = child as Electron.WebContentsView;
      return { contentsId: view.webContents.id, bounds: view.getBounds(), visible: view.getVisible() };
    });
  });
}

const windowTitle = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle());

async function go(input: string): Promise<void> {
  const address = page.getByTestId('address');
  await address.click();
  await address.fill(input);
  await address.press('Enter');
}

test('empty-tab-shows-start-view', async () => {
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect(page.getByTestId('start-view')).toContainText('Search or enter address');
  await expect(page.getByTestId('address')).toBeFocused();
  await expect(page.getByTestId('ping')).toHaveText('pong');
  expect(await tabs()).toEqual([]);
  expect(await attachedViews()).toEqual([]);
  expect(await windowTitle()).toBe(APP_WINDOW_TITLE);
});

test('typing-url-loads-page', async () => {
  await go(`127.0.0.1:${site.port}/a`);
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/a`);
  await expect(page.getByTestId('address')).toHaveValue(`${site.origin}/a`);
  await expect.poll(windowTitle).toBe('Page A — frost');
  await expect(page.getByTestId('start-view')).toBeHidden();
  const [view] = await attachedViews();
  expect(view).toMatchObject({ contentsId: (await tab()).id, visible: true });
});

test('back-forward-reload-stop', async () => {
  const back = page.getByTestId('back');
  const forward = page.getByTestId('forward');
  const reload = page.getByTestId('reload');

  await go(`${site.origin}/b`);
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/b`);
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();

  await back.click();
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/a`);
  await expect(page.getByTestId('address')).toHaveValue(`${site.origin}/a`);
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/b`);
  await expect(forward).toBeDisabled();

  await go(`${site.origin}/count`);
  await expect.poll(async () => (await tab()).title).toBe('Count 1');
  await expect(reload).toHaveAttribute('aria-label', 'Reload');
  await reload.click();
  await expect.poll(async () => (await tab()).title).toBe('Count 2');

  await go(`${site.origin}/slow`);
  await expect(reload).toHaveAttribute('aria-label', 'Stop');
  expect((await tab()).loading).toBe(true);
  await reload.click();
  await expect(reload).toHaveAttribute('aria-label', 'Reload');
  expect((await tab()).loading).toBe(false);
  site.releaseSlow();
});

test('page-view-tracks-page-area', async () => {
  const pageArea = () =>
    page.getByTestId('page-area').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  const matches = async () => {
    const [view] = await attachedViews();
    const area = await pageArea();
    if (!view) return false;
    return (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(view.bounds[k] - area[k]) <= 1);
  };
  await expect.poll(matches).toBe(true);
  for (const [width, height] of [
    [1000, 700],
    [1200, 760],
  ] as const) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), [width, height] as const);
    await expect.poll(matches).toBe(true);
  }
  const [view] = await attachedViews();
  expect(view!.bounds.width).toBeGreaterThan(0);
  expect(view!.bounds.height).toBeGreaterThan(0);
});

test('tab-has-no-ipc', async () => {
  const { id } = await tab();
  const facts = await app.evaluate(
    async ({ BrowserWindow, ipcMain, webContents }, { id, bridgeKey, channel }) => {
      const contents = webContents.fromId(id)!;
      const globals = (await contents.executeJavaScript(
        `({ bridge: typeof window[${JSON.stringify(bridgeKey)}], require: typeof require, process: typeof process })`,
      )) as Record<string, string>;
      const prefs = (contents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences();
      const owner = BrowserWindow.fromWebContents(contents);
      const appWindow = BrowserWindow.getAllWindows()[0]!;
      // The real transport handler, called with the tab's own WebContents and main frame as the
      // sender (test-only: Electron keeps invoke handlers in an internal map).
      const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const handler = handlers?.get(channel);
      const response = handler ? await handler({ sender: contents, senderFrame: contents.mainFrame }, { type: 'query', path: 'ping' }) : 'no handler';
      return {
        globals,
        prefs: prefs && { ...prefs, preload: prefs['preload'] ?? null },
        ownerId: owner?.id ?? null,
        appWindowId: appWindow.id,
        ownerContentsIsTab: owner ? owner.webContents.id === contents.id : null,
        response,
      };
    },
    { id, bridgeKey: IPC_BRIDGE_KEY, channel: IPC_CHANNEL },
  );
  expect(facts.globals).toEqual({ bridge: 'undefined', require: 'undefined', process: 'undefined' });
  const { partition: _partition, ...hardened } = TAB_VIEW_WEB_PREFERENCES;
  expect(facts.prefs).toMatchObject({ ...hardened, preload: null });
  // Hosted in the app window, but not its own WebContents → `not-window-contents`.
  expect(facts.ownerId).toBe(facts.appWindowId);
  expect(facts.ownerContentsIsTab).toBe(false);
  expect(facts.response).toEqual({
    error: { message: IPC_SENDER_ERROR_CODE, code: -32003, data: { code: IPC_SENDER_ERROR_CODE, httpStatus: 403 } },
  });
});

test('tab-cannot-load-app-scheme', async () => {
  const { id } = await tab();
  const loadError = await app.evaluate(async ({ webContents }, id) => {
    try {
      await webContents.fromId(id)!.loadURL('app://app/');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, id);
  expect(loadError).toMatch(/ERR_/);

  await go(`${site.origin}/a`);
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/a`);
  const loadScript = (src: string) =>
    app.evaluate(
      ({ webContents }, { id, src }) =>
        webContents.fromId(id)!.executeJavaScript(`new Promise((resolve) => {
          const script = document.createElement('script');
          script.onload = () => resolve('load');
          script.onerror = () => resolve('error');
          script.src = ${JSON.stringify(src)};
          document.head.append(script);
        })`) as Promise<string>,
      { id, src },
    );
  // Control: loopback scripts do load in the tab.
  expect(await loadScript(`${site.origin}/ok.js`)).toBe('load');
  expect(await loadScript(await appEntryScriptUrl())).toBe('error');
});

test('non-web-input-becomes-search-e2e', async () => {
  // Hermetic: the browse session answers every https: request locally for this test.
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).protocol.handle(
      'https',
      (request) => new Response(`<!doctype html><title>stub search</title><p>${new URL(request.url).search}</p>`, { headers: { 'Content-Type': 'text/html' } }),
    );
  }, BROWSE_PARTITION);
  try {
    for (const input of ['app://app/', 'javascript:alert(1)', 'file:///etc/passwd']) {
      await go(input);
      const expected = SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent(input));
      await expect.poll(async () => (await tab()).url, input).toBe(expected);
      await expect(page.getByTestId('address')).toHaveValue(expected);
    }
  } finally {
    await app.evaluate(({ session }, partition) => session.fromPartition(partition).protocol.unhandle('https'), BROWSE_PARTITION);
  }
});

test('page-close-closes-tab', async () => {
  await go(`${site.origin}/a`);
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/a`);
  const { id } = await tab();
  const stripTab = page.getByTestId('tab');
  await expect(stripTab).toHaveCount(1);
  const tabIdBefore = await stripTab.getAttribute('data-tab-id');
  // The page closes itself; Electron destroys the tab's WebContents.
  await app.evaluate(({ webContents }, id) => {
    void webContents.fromId(id)!.executeJavaScript('window.close()').catch(() => {});
  }, id);
  await expect.poll(async () => (await tabs()).length).toBe(0);
  await expect.poll(attachedViews).toEqual([]);
  await expect(page.getByTestId('start-view')).toBeVisible();
  await expect.poll(windowTitle).toBe(APP_WINDOW_TITLE);
  // The only tab closed: one fresh empty tab (a new id) replaced it.
  await expect(stripTab).toHaveCount(1);
  await expect(stripTab).toHaveAttribute('title', 'New Tab');
  expect(await stripTab.getAttribute('data-tab-id')).not.toBe(tabIdBefore);

  // A new view loads the next address.
  await go(`${site.origin}/b`);
  await expect.poll(async () => (await tab()).url).toBe(`${site.origin}/b`);
  expect((await tab()).id).not.toBe(id);
  await expect.poll(windowTitle).toBe('Page B — frost');
  const [view] = await attachedViews();
  expect(view).toMatchObject({ visible: true });
});
