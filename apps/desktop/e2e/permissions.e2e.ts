// Specs: specs/permissions.spec.ts (PERMISSION_PROMPT_ACTIONS), specs/browser.spec.ts (BROWSE_PARTITION, NEW_TAB_LABEL)
// Acceptance: specs/permissions.feature.md (End to end)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION, NEW_TAB_LABEL } from '@app/specs/browser.spec';
import {
  FULLSCREEN_BANNER_HEIGHT,
  FULLSCREEN_NOTICE_MS,
  FULLSCREEN_NOTICE_TEXT,
  PERMISSION_PROMPT_ACTIONS,
  PROMPT_ARMING_DELAY_MS,
} from '@app/specs/permissions.spec';
import { launchApp } from './harness';

/**
 * A loopback site: `/frame-host?frame=<origin>` embeds `<origin>/frame` in an iframe delegated
 * geolocation (`allow="geolocation"`); `/sandboxed` is served with CSP `sandbox allow-scripts` (an
 * opaque origin); `/sandboxed-frame-host` embeds its own `/plain` in `<iframe sandbox>`;
 * `/fullscreen` has a button that requests fullscreen and swallows every Escape keydown it sees;
 * every other path is a titled page (`/notify` → "Page NOTIFY").
 */
async function startSite(): Promise<{ origin: string; host: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>${body}`);
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/frame-host') {
      const frame = url.searchParams.get('frame') ?? '';
      return html(`<title>Frame host</title><h1>Frame host</h1><iframe id="frame" allow="geolocation" src="${frame}/frame"></iframe>`);
    }
    if (url.pathname === '/sandboxed') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': 'sandbox allow-scripts' });
      return response.end('<!doctype html><title>Sandboxed</title><h1>Sandboxed</h1>');
    }
    if (url.pathname === '/sandboxed-frame-host') {
      return html(`<title>Sandboxed frame host</title><iframe id="frame" sandbox="allow-scripts" allow="geolocation" src="/plain"></iframe>`);
    }
    if (url.pathname === '/fullscreen') {
      return html(`<title>Fullscreen</title><style>button { margin: 20px; padding: 20px; font-size: 18px; }</style>
        <button id="go">fullscreen</button>
        <script>
          window.escapes = 0;
          document.getElementById('go').addEventListener('click', () => document.documentElement.requestFullscreen());
          addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            window.escapes += 1;
            event.preventDefault();
            event.stopImmediatePropagation();
          }, true);
        </script>`);
    }
    const name = url.pathname.slice(1).toUpperCase() || 'ROOT';
    return html(`<title>Page ${name}</title><h1>Page ${name}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let page: Page;
/** Sites opened by the current test (fresh origins per test: decisions last the app session). */
let sites: Awaited<ReturnType<typeof startSite>>[] = [];

async function site(): Promise<Awaited<ReturnType<typeof startSite>>> {
  const started = await startSite();
  sites.push(started);
  return started;
}

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  // Counts every prompt bar the chrome ever renders (so "no prompt" means none, not "none now").
  await page.evaluate(() => {
    const counter = globalThis as unknown as { __promptsShown: number };
    counter.__promptsShown = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[data-testid="permission-prompt"]') || node.querySelector('[data-testid="permission-prompt"]'))) {
            counter.__promptsShown += 1;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
});

test.afterAll(async () => {
  await app?.close();
});

const promptsShown = () => page.evaluate(() => (globalThis as unknown as { __promptsShown: number }).__promptsShown);

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

/**
 * Runs `script` in a tab's main frame, or in its first subframe whose URL starts with `framePrefix`;
 * resolves its (awaited) value.
 */
function run(id: number, script: string, framePrefix?: string): Promise<unknown> {
  return app.evaluate(
    ({ webContents }, { id, script, framePrefix }) => {
      const main = webContents.fromId(id)!.mainFrame;
      const frame = framePrefix === undefined ? main : main.frames.find((f) => f.url.startsWith(framePrefix));
      if (!frame) throw new Error(`no frame at ${framePrefix}`);
      return frame.executeJavaScript(script) as Promise<unknown>;
    },
    { id, script, framePrefix },
  );
}

/** Resolves `'pending'` if `promise` has not settled within `ms`. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

async function menu(id: string): Promise<void> {
  await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`no menu item ${id}`);
    item.click();
  }, id);
}

const strip = () => page.getByTestId('tab');
const activeTab = () => page.locator('[data-testid="tab"][aria-selected="true"]');
const prompt = () => page.getByTestId('permission-prompt');
const address = () => page.getByTestId('address');

/** Loads `url` in the active tab; answers its WebContents id once it committed with `title`. */
async function open(url: string, title: string): Promise<number> {
  await address().click();
  await address().fill(url);
  await address().press('Enter');
  await expect(activeTab()).toHaveAttribute('title', title);
  return contentsIdAt(url);
}

const ASK_NOTIFICATIONS = 'Notification.requestPermission()';
const ASK_GEOLOCATION = 'new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("position"), (error) => resolve(`error ${error.code}`)))';

/** The prompt bar shows `origin` (embedded in `embedder`, if given) asking for `kind`. */
async function expectPrompt(
  origin: string,
  host: string,
  kind: keyof typeof PERMISSION_PROMPT_ACTIONS,
  embedder?: { origin: string; host: string },
): Promise<void> {
  const sentence = embedder ? `${host} (embedded in ${embedder.host}) wants to ${PERMISSION_PROMPT_ACTIONS[kind]}` : `${host} wants to ${PERMISSION_PROMPT_ACTIONS[kind]}`;
  await expect(prompt()).toBeVisible();
  await expect(prompt()).toHaveAttribute('data-origin', origin);
  await expect(prompt()).toHaveAttribute('data-permission', kind);
  if (embedder) await expect(prompt()).toHaveAttribute('data-top-level-origin', embedder.origin);
  else await expect(prompt()).not.toHaveAttribute('data-top-level-origin');
  await expect(page.getByTestId('permission-prompt-origin')).toHaveText(host);
  await expect(page.getByTestId('permission-prompt-text')).toHaveText(sentence);
  await expect(prompt()).toHaveAttribute('role', 'dialog');
  await expect(prompt()).toHaveAccessibleName(sentence);
}

/** Answers the shown prompt with Allow, once it has armed (the click waits for the button to enable). */
const allow = () => page.getByTestId('permission-allow').click();
const block = () => page.getByTestId('permission-block').click();

/** Asks for geolocation in `id` and allows it (the position itself may never come: no provider). */
async function allowGeolocation(id: number, origin: string, host: string): Promise<void> {
  void run(id, ASK_GEOLOCATION).catch(() => undefined);
  await expectPrompt(origin, host, 'geolocation');
  await allow();
  await expect(prompt()).toHaveCount(0);
}

test.beforeEach(async () => {
  const count = await strip().count();
  for (let i = 0; i < count; i++) await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect.poll(browseContents).toEqual([]);
  await expect(prompt()).toHaveCount(0);
});

test.afterEach(async () => {
  for (const started of sites.splice(0)) await started.close();
  sites = [];
});

test('allow-grants-and-is-remembered-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const shown = await promptsShown();
  const asked = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  // The page area shrank to make room: the tab's view starts below the bar, never over it.
  const bar = (await prompt().boundingBox())!;
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).getBounds().y))
    .toBeGreaterThanOrEqual(Math.floor(bar.y + bar.height));
  await page.getByTestId('permission-allow').click();
  await expect(asked).resolves.toBe('granted');
  await expect(prompt()).toHaveCount(0);
  expect(await promptsShown()).toBe(shown + 1);
  // Remembered: asked again, granted with no prompt; the page's own check agrees.
  await expect(run(id, ASK_NOTIFICATIONS)).resolves.toBe('granted');
  await expect(run(id, 'Notification.permission')).resolves.toBe('granted');
  expect(await promptsShown()).toBe(shown + 1);
});

test('block-denies-and-is-remembered-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const shown = await promptsShown();
  const asked = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await page.getByTestId('permission-block').click();
  await expect(asked).resolves.toBe('denied');
  await expect(prompt()).toHaveCount(0);
  await expect(run(id, ASK_NOTIFICATIONS)).resolves.toBe('denied');
  expect(await promptsShown()).toBe(shown + 1);
});

test('dismiss-denies-and-asks-again-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const shown = await promptsShown();
  const first = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await page.getByTestId('permission-dismiss').click();
  await expect(first).resolves.toBe('denied');
  await expect(prompt()).toHaveCount(0);
  // Nothing remembered: the next request prompts again; Esc inside the bar dismisses it too.
  const second = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  expect(await promptsShown()).toBe(shown + 2);
  await page.getByTestId('permission-dismiss').focus();
  await page.keyboard.press('Escape');
  await expect(second).resolves.toBe('denied');
  await expect(prompt()).toHaveCount(0);
  // Still nothing remembered.
  const third = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await page.getByTestId('permission-dismiss').click();
  await expect(third).resolves.toBe('denied');
});

test('prompt-names-requesting-origin-e2e', async () => {
  const top = await site();
  const embedded = await site();
  const id = await open(`${top.origin}/frame-host?frame=${encodeURIComponent(embedded.origin)}`, 'Frame host');
  await expect
    .poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((f) => f.url), id))
    .toEqual([`${embedded.origin}/frame`]);

  // The cross-origin iframe asks: the prompt names the iframe's origin, embedded in the page's.
  const framed = run(id, ASK_GEOLOCATION, embedded.origin);
  await expectPrompt(embedded.origin, embedded.host, 'geolocation', top);
  await block();
  await expect(framed).resolves.toBe('error 1');
  // Remembered for the iframe's origin under this page: asking again is denied at once…
  const shown = await promptsShown();
  await expect(run(id, ASK_GEOLOCATION, embedded.origin)).resolves.toBe('error 1');
  expect(await promptsShown()).toBe(shown);
  // …while the top-level page asking for itself still prompts, for its own origin…
  const own = run(id, ASK_GEOLOCATION);
  await expectPrompt(top.origin, top.host, 'geolocation');
  await page.getByTestId('permission-dismiss').click();
  await expect(own).resolves.toBe('error 1');
  // …and the iframe's origin as a top-level page is asked afresh (the decision was scoped).
  const alone = await open(`${embedded.origin}/frame`, 'Page FRAME');
  const asked = run(alone, ASK_GEOLOCATION);
  await expectPrompt(embedded.origin, embedded.host, 'geolocation');
  await page.getByTestId('permission-dismiss').click();
  await expect(asked).resolves.toBe('error 1');
});

test('sandboxed-document-denied', async () => {
  const a = await site();
  // The site's own origin is allowed notifications and geolocation.
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const asked = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await allow();
  await expect(asked).resolves.toBe('granted');
  await allowGeolocation(id, a.origin, a.host);
  const shown = await promptsShown();

  // The same origin's page under CSP `sandbox`: an opaque origin, not the URL's.
  const sandboxed = await open(`${a.origin}/sandboxed`, 'Sandboxed');
  await expect(run(sandboxed, 'self.origin')).resolves.toBe('null');
  await expect(run(sandboxed, ASK_NOTIFICATIONS)).resolves.toBe('denied');
  // An <iframe sandbox> of a same-origin URL.
  const host = await open(`${a.origin}/sandboxed-frame-host`, 'Sandboxed frame host');
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((f) => f.url), host)).toEqual([`${a.origin}/plain`]);
  await expect(run(host, 'self.origin', `${a.origin}/plain`)).resolves.toBe('null');
  await expect(run(host, ASK_GEOLOCATION, `${a.origin}/plain`)).resolves.toBe('error 1');
  await page.waitForTimeout(300);
  expect(await promptsShown()).toBe(shown);
  await expect(prompt()).toHaveCount(0);
});

test('prompt-buttons-arm-after-delay-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const asked = run(id, ASK_NOTIFICATIONS);
  await expect(prompt()).toBeVisible();
  const shownAt = Date.now();
  // An immediate click on Allow (e.g. a click the page lured onto where the bar appears) does nothing.
  await expect(prompt()).toHaveAttribute('data-armed', 'false');
  await expect(page.getByTestId('permission-allow')).toBeDisabled();
  await expect(page.getByTestId('permission-block')).toBeDisabled();
  const box = (await page.getByTestId('permission-allow').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(Date.now() - shownAt).toBeLessThan(PROMPT_ARMING_DELAY_MS);
  await expect(settledWithin(asked, 200)).resolves.toBe('pending');
  await expect(prompt()).toBeVisible();
  // Once armed, the same click answers.
  await expect(prompt()).toHaveAttribute('data-armed', 'true');
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(PROMPT_ARMING_DELAY_MS - 100);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(asked).resolves.toBe('granted');
});

test('navigate-away-denies-pending-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  // The asking document goes away with its pending request (its promise never settles in-page).
  void run(id, ASK_NOTIFICATIONS).catch(() => undefined);
  await expectPrompt(a.origin, a.host, 'notifications');
  await run(id, `location = '/other'; 0`);
  await expect(activeTab()).toHaveAttribute('title', 'Page OTHER');
  await expect(prompt()).toHaveCount(0);
  // Nothing was remembered: the new document's request prompts afresh.
  const shown = await promptsShown();
  const again = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  expect(await promptsShown()).toBe(shown + 1);
  await page.getByTestId('permission-allow').click();
  await expect(again).resolves.toBe('granted');
});

test('non-promptable-denied-without-prompt-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const shown = await promptsShown();
  await expect(run(id, 'navigator.requestMIDIAccess().then(() => "granted", (error) => error.name)')).resolves.toBe('NotAllowedError');
  await expect(run(id, 'navigator.requestMIDIAccess({ sysex: true }).then(() => "granted", (error) => error.name)')).resolves.toBe('NotAllowedError');
  await expect(run(id, 'navigator.storage.persist()')).resolves.toBe(false);
  await page.waitForTimeout(300);
  expect(await promptsShown()).toBe(shown);
  await expect(prompt()).toHaveCount(0);
});

test('background-tab-prompt-shows-dot-e2e', async () => {
  const a = await site();
  const first = await open(`${a.origin}/notify`, 'Page NOTIFY');
  await menu('new-tab');
  await expect(strip()).toHaveCount(2);
  await open(`${a.origin}/second`, 'Page SECOND');
  const asked = run(first, ASK_NOTIFICATIONS);
  const firstTab = strip().nth(0);
  await expect(firstTab.getByTestId('tab-permission-dot')).toBeVisible();
  await expect(firstTab).toHaveAccessibleName(/asking for a permission/);
  await expect(prompt()).toHaveCount(0);
  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expectPrompt(a.origin, a.host, 'notifications');
  await expect(firstTab.getByTestId('tab-permission-dot')).toHaveCount(0);
  await page.getByTestId('permission-dismiss').click();
  await expect(asked).resolves.toBe('denied');
});

test('app-session-stays-deny-all-e2e', async () => {
  const shown = await promptsShown();
  await expect(page.evaluate(() => Notification.requestPermission())).resolves.toBe('denied');
  await expect(page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((status) => status.state))).resolves.toBe('denied');
  await page.waitForTimeout(300);
  expect(await promptsShown()).toBe(shown);
  await expect(prompt()).toHaveCount(0);
});

/** The app window's content size, its OS fullscreen state, and the shown view's bounds. */
const windowLayout = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const [width = 0, height = 0] = win.getContentSize();
    const view = win.contentView.children[0] as Electron.WebContentsView | undefined;
    return { content: { width, height }, fullScreen: win.isFullScreen(), view: view?.getBounds() ?? null };
  });

/** A real click (a user gesture) on the fullscreen page's button; waits until the page is fullscreen. */
async function enterFullscreen(id: number): Promise<void> {
  const [x, y] = (await run(id, '(() => { const r = document.getElementById("go").getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()')) as [number, number];
  await app.evaluate(
    ({ webContents }, { id, x, y }) => {
      const contents = webContents.fromId(id)!;
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { id, x, y },
  );
  await expect.poll(() => run(id, 'document.fullscreenElement !== null')).toBe(true);
}

test('html-fullscreen-fills-window-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/fullscreen`, 'Fullscreen');
  const before = await windowLayout();
  expect(before.view?.y).toBeGreaterThan(0);
  // Granted without a prompt; frost's notice names the host above the page first.
  await enterFullscreen(id);
  const notice = page.getByTestId('fullscreen-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(`${a.host} ${FULLSCREEN_NOTICE_TEXT}`);
  expect((await notice.boundingBox())?.height).toBe(FULLSCREEN_BANNER_HEIGHT);
  await expect
    .poll(async () => {
      const { content, view } = await windowLayout();
      return view !== null && view.x === 0 && view.y === FULLSCREEN_BANNER_HEIGHT && view.width === content.width && view.height === content.height - FULLSCREEN_BANNER_HEIGHT;
    })
    .toBe(true);
  // Then the page covers the whole window.
  await expect(notice).toHaveCount(0, { timeout: FULLSCREEN_NOTICE_MS + 5_000 });
  await expect
    .poll(async () => {
      const { content, view } = await windowLayout();
      return view !== null && view.x === 0 && view.y === 0 && view.width === content.width && view.height === content.height;
    })
    .toBe(true);
  await expect(prompt()).toHaveCount(0);
  await run(id, 'document.exitFullscreen().then(() => 0)');
  await expect.poll(async () => (await windowLayout()).view?.y ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(false);
  // The chrome is still there and working.
  await expect(activeTab()).toHaveAttribute('title', 'Fullscreen');
});

test('esc-leaves-fullscreen-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/fullscreen`, 'Fullscreen');
  await enterFullscreen(id);
  // A prompt could not be seen over the page: a request while fullscreen is denied at once.
  const shown = await promptsShown();
  await expect(run(id, ASK_NOTIFICATIONS)).resolves.toBe('denied');
  expect(await promptsShown()).toBe(shown);
  // The page swallows every Escape keydown it sees, but never sees this one: main takes it.
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)!;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }, id);
  await expect.poll(() => run(id, 'document.fullscreenElement !== null')).toBe(false);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(false);
  await expect(run(id, 'window.escapes')).resolves.toBe(0);
  // Out of fullscreen, the page may ask again (and is prompted).
  const asked = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await page.getByTestId('permission-dismiss').click();
  await expect(asked).resolves.toBe('denied');
});

test('leaving-fullscreen-tab-restores-window-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/fullscreen`, 'Fullscreen');
  // Switching to another tab.
  await enterFullscreen(id);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(true);
  await menu('new-tab');
  await expect(strip()).toHaveCount(2);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(false);
  // Chromium finishes a hidden page's exit once it is shown again: back in the page area.
  await strip().nth(0).click();
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => run(id, 'document.fullscreenElement !== null')).toBe(false);
  await expect.poll(async () => (await windowLayout()).view?.y ?? 0).toBeGreaterThan(0);
  await expect(page.getByTestId('fullscreen-notice')).toHaveCount(0);
  // Closing a fullscreen tab.
  await enterFullscreen(id);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(true);
  await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(false);
});
