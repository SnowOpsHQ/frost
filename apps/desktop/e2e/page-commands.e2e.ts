// Specs: specs/page-commands.spec.ts (RESERVED_PAGE_SHORTCUTS, CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL,
// CONTEXT_MENU_SELECTION_MAX), specs/browser.spec.ts (SEARCH_URL_TEMPLATE)
// Acceptance: specs/page-commands.feature.md (End to end)
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION, NEW_TAB_LABEL, SEARCH_URL_TEMPLATE } from '@app/specs/browser.spec';
import { CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL, CONTEXT_MENU_SELECTION_MAX } from '@app/specs/page-commands.spec';
import { closeApp, launchApp } from './harness';

const SELECTION = 'Tom & Jerry chase each other around the house';

/**
 * Loopback pages: `/greedy` (cancels every keydown in the capture phase and records its key),
 * `/links` (a link to `/b` and a paragraph of text), `/slow` (held until released), and titled
 * pages. Every request is logged with its `Cache-Control` header.
 */
async function startSite() {
  const held: ServerResponse[] = [];
  const requests: { path: string; cacheControl: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>${body}`);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    requests.push({ path, cacheControl: request.headers['cache-control'] });
    if (path === '/greedy') {
      return html(`<title>Greedy</title><input id="field" autofocus><script>
        window.seen = [];
        addEventListener('keydown', (event) => { seen.push(event.key); event.preventDefault(); event.stopImmediatePropagation(); }, true);
      </script>`);
    }
    if (path === '/links') {
      return html(`<title>Links</title><style>a, p { display: block; margin: 12px; padding: 16px; font-size: 18px; }</style>
        <a id="link" href="/b">a link</a>
        <p id="text">${SELECTION.replace('&', '&amp;')}</p>`);
    }
    if (path === '/slow') {
      held.push(response);
      return;
    }
    const name = path.slice(1).toUpperCase() || 'ROOT';
    return html(`<title>Page ${name}</title><h1>Page ${name}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
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
let site: Awaited<ReturnType<typeof startSite>>;

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  // No native context menu in the test: record each menu main pops up instead of showing it.
  await app.evaluate(({ Menu }) => {
    const record = globalThis as unknown as { __contextMenus: Electron.Menu[] };
    record.__contextMenus = [];
    Menu.prototype.popup = function (this: Electron.Menu) {
      record.__contextMenus.push(this);
    };
  });
});

test.afterAll(async () => {
  site?.releaseSlow();
  await closeApp(app);
  await site?.close();
});

async function browseContents(): Promise<{ id: number; url: string }[]> {
  return app.evaluate(({ session, webContents }, partition) => {
    const browse = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((c) => !c.isDestroyed() && c.session === browse)
      .map((c) => ({ id: c.id, url: c.getURL() }));
  }, BROWSE_PARTITION);
}

async function contentsIdAt(url: string): Promise<number> {
  await expect.poll(async () => (await browseContents()).filter((c) => c.url === url).length).toBe(1);
  return (await browseContents()).find((c) => c.url === url)!.id;
}

const run = (id: number, script: string) =>
  app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script) as Promise<unknown>, { id, script });

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

/** Loads `path` of the site in the active tab; answers its WebContents id once it committed. */
async function open(path: string, title: string): Promise<number> {
  await address().click();
  await address().fill(`${site.origin}${path}`);
  await address().press('Enter');
  await expect(activeTab()).toHaveAttribute('title', title);
  return contentsIdAt(`${site.origin}${path}`);
}

type Modifier = 'mod' | 'control' | 'shift' | 'alt';

/** A real key press (down + up) sent to a tab's WebContents; it passes through `before-input-event`. */
async function press(id: number, keyCode: string, modifiers: Modifier[] = []): Promise<void> {
  await app.evaluate(
    ({ webContents }, { id, keyCode, modifiers }) => {
      const contents = webContents.fromId(id)!;
      const mods = modifiers.map((m) => (m === 'mod' ? (process.platform === 'darwin' ? 'meta' : 'control') : m));
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
    },
    { id, keyCode, modifiers },
  );
}

/** The keys the greedy page saw (lower-cased). */
const pageSaw = (id: number) => run(id, 'window.seen.map((k) => k.toLowerCase())') as Promise<string[]>;
const urlOf = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id);
const zoomOf = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getZoomFactor(), id);
const isLoading = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id);
const requestsFor = (path: string) => site.requests.filter((r) => r.path === path);

/** A real right-click at the centre of `selector` in a tab; answers the menu main built for it. */
async function rightClick(id: number, selector: string): Promise<{ id: string; label: string; enabled: boolean; type: string }[]> {
  const shown = await app.evaluate(() => (globalThis as unknown as { __contextMenus: Electron.Menu[] }).__contextMenus.length);
  const [x, y] = (await run(id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`)) as [number, number];
  await app.evaluate(
    ({ webContents }, { id, x, y }) => {
      const contents = webContents.fromId(id)!;
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    },
    { id, x, y },
  );
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __contextMenus: Electron.Menu[] }).__contextMenus.length)).toBe(shown + 1);
  return app.evaluate(() =>
    (globalThis as unknown as { __contextMenus: Electron.Menu[] }).__contextMenus.at(-1)!.items.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled, type: item.type })),
  );
}

/** Clicks an item of the last context menu, as Electron does when the user picks it. */
async function pick(itemId: string): Promise<void> {
  await app.evaluate((_electron, itemId) => {
    const item = (globalThis as unknown as { __contextMenus: Electron.Menu[] }).__contextMenus.at(-1)!.getMenuItemById(itemId);
    if (!item) throw new Error(`no context menu item ${itemId}`);
    item.click();
  }, itemId);
}

test.beforeEach(async () => {
  const count = await strip().count();
  for (let i = 0; i < count; i++) await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect.poll(browseContents).toEqual([]);
});

test('page-shortcuts-e2e', async () => {
  const mac = process.platform === 'darwin';
  await open('/a', 'Page A');
  const id = await open('/greedy', 'Greedy');
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), id);
  // Control: the page really does swallow ordinary keys.
  await press(id, 'Q');
  await expect.poll(() => pageSaw(id)).toEqual(['q']);

  // Zoom in twice, out once, then back to 100 %: the factor and the status bar follow.
  await expect(page.getByTestId('status-zoom')).toHaveCount(0);
  await press(id, '=', ['mod']);
  await expect.poll(() => zoomOf(id)).toBeCloseTo(1.1);
  await expect(page.getByTestId('status-zoom')).toHaveText('110%');
  await press(id, '=', ['mod', 'shift']);
  await expect.poll(() => zoomOf(id)).toBeCloseTo(1.25);
  await press(id, '-', ['mod']);
  await expect(page.getByTestId('status-zoom')).toHaveText('110%');
  await press(id, '0', ['mod']);
  await expect.poll(() => zoomOf(id)).toBeCloseTo(1);
  await expect(page.getByTestId('status-zoom')).toHaveCount(0);
  // The page never saw a zoom key.
  expect(await pageSaw(id)).toEqual(['q']);

  // Reload and hard reload request the page again (the hard one bypassing the cache).
  const loads = requestsFor('/greedy').length;
  await press(id, 'R', ['mod']);
  await expect.poll(() => requestsFor('/greedy').length).toBe(loads + 1);
  await expect(activeTab()).toHaveAttribute('title', 'Greedy');
  await press(id, 'R', ['mod', 'shift']);
  await expect.poll(() => requestsFor('/greedy').length).toBe(loads + 2);
  expect(requestsFor('/greedy').at(-1)?.cacheControl).toBe('no-cache');
  await expect(activeTab()).toHaveAttribute('title', 'Greedy');
  await press(id, 'F5');
  await expect.poll(() => requestsFor('/greedy').length).toBe(loads + 3);
  await expect(activeTab()).toHaveAttribute('title', 'Greedy');

  // Back and forward (each reload left a fresh document: the page saw none of the keys above).
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), id);
  await press(id, 'Q');
  await expect.poll(() => pageSaw(id)).toEqual(['q']);
  if (mac) await press(id, '[', ['mod']);
  else await press(id, 'Left', ['alt']);
  await expect.poll(() => urlOf(id)).toBe(`${site.origin}/a`);
  await expect(activeTab()).toHaveAttribute('title', 'Page A');
  if (mac) await press(id, ']', ['mod']);
  else await press(id, 'Right', ['alt']);
  await expect.poll(() => urlOf(id)).toBe(`${site.origin}/greedy`);
  await expect(activeTab()).toHaveAttribute('title', 'Greedy');
});

test('esc-stops-loading-e2e', async () => {
  const id = await open('/greedy', 'Greedy');
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), id);
  await run(id, `location = '/slow'; 0`);
  await expect.poll(() => requestsFor('/slow').length).toBe(1);
  await expect.poll(() => isLoading(id)).toBe(true);
  await press(id, 'Escape');
  await expect.poll(() => isLoading(id)).toBe(false);
  await expect(page.getByTestId('tab-loading')).toHaveCount(0);
  // The slow page never committed, and the page still got its Esc.
  expect(await urlOf(id)).toBe(`${site.origin}/greedy`);
  await expect.poll(() => pageSaw(id)).toEqual(['escape']);
  site.releaseSlow();
});

test('context-menu-open-link-in-new-tab-e2e', async () => {
  const id = await open('/links', 'Links');
  const items = await rightClick(id, '#link');
  expect(items).toEqual([
    { id: 'context-open-link', label: CONTEXT_MENU_LABELS['open-link'], enabled: true, type: 'normal' },
    { id: 'context-copy-link', label: CONTEXT_MENU_LABELS['copy-link'], enabled: true, type: 'normal' },
  ]);
  await pick('context-open-link');
  // A background tab right of this one, loading the link; this tab stays active.
  await expect(strip()).toHaveCount(2);
  await expect(strip().nth(1)).toHaveAttribute('title', 'Page B');
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await contentsIdAt(`${site.origin}/b`);

  // A plain spot of the page: history and reload.
  const plain = await rightClick(id, 'body');
  expect(plain.map((item) => item.id)).toEqual(['context-back', 'context-forward', 'context-reload']);
  expect(plain.map((item) => item.label)).toEqual([CONTEXT_MENU_LABELS.back, CONTEXT_MENU_LABELS.forward, CONTEXT_MENU_LABELS.reload]);
});

test('context-menu-search-e2e', async () => {
  // Hermetic: the browse session answers every https: request (the search) locally.
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).protocol.handle('https', () => new Response('<!doctype html><title>stub search</title>', { headers: { 'Content-Type': 'text/html' } }));
  }, BROWSE_PARTITION);
  try {
    const id = await open('/links', 'Links');
    await run(id, `getSelection().selectAllChildren(document.getElementById('text')); 0`);
    const items = await rightClick(id, '#text');
    const shown = `${[...SELECTION].slice(0, CONTEXT_MENU_SELECTION_MAX - 1).join('')}…`.replaceAll('&', '&&');
    expect(items.filter((item) => item.type !== 'separator').map((item) => [item.id, item.label])).toEqual([
      ['context-cut', CONTEXT_MENU_LABELS.cut],
      ['context-copy', CONTEXT_MENU_LABELS.copy],
      ['context-paste', CONTEXT_MENU_LABELS.paste],
      ['context-select-all', CONTEXT_MENU_LABELS['select-all']],
      ['context-search', CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', shown)],
    ]);
    // Not editable: only Copy and Select All are enabled.
    expect(items.filter((item) => item.type !== 'separator').map((item) => item.enabled)).toEqual([false, true, false, true, true]);
    await pick('context-search');
    await expect(strip()).toHaveCount(2);
    await expect(strip().nth(1)).toHaveAttribute('title', 'stub search');
    await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
    await contentsIdAt(SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent(SELECTION)));
  } finally {
    await app.evaluate(({ session }, partition) => session.fromPartition(partition).protocol.unhandle('https'), BROWSE_PARTITION);
  }
});
