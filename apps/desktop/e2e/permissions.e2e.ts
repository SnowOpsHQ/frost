// Specs: specs/permissions.spec.ts (PERMISSION_PROMPT_ACTIONS), specs/browser.spec.ts (BROWSE_PARTITION, NEW_TAB_LABEL)
// Acceptance: specs/permissions.feature.md (End to end)
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { BROWSE_PARTITION, NEW_TAB_LABEL } from '@app/specs/browser.spec';
import {
  FULLSCREEN_BANNER_HEIGHT,
  FULLSCREEN_EXIT_SETTLE_MS,
  FULLSCREEN_NOTICE_MS,
  FULLSCREEN_NOTICE_TEXT,
  PERMISSION_PROMPT_ACTIONS,
  PROMPT_ARMING_DELAY_MS,
} from '@app/specs/permissions.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

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
const { contentsIdAt, runInFrame: run, menu, strip, activeTab, address, chromeCaughtUp, closeAllTabs } = chromeHelpers(
  () => app,
  () => page,
);
/** Sites opened by the current test (fresh origins per test: decisions last the app session). */
let sites: Awaited<ReturnType<typeof startSite>>[] = [];

async function site(): Promise<Awaited<ReturnType<typeof startSite>>> {
  const started = await startSite();
  sites.push(started);
  return started;
}

test.beforeAll(async () => {
  // Chromium's fake camera and microphone, so `getUserMedia` reaches the permission request on a
  // machine with no devices (it still asks: this is not the fake *UI* switch, which would not).
  ({ app, page } = await launchApp(['--use-fake-device-for-media-stream']));
  await page.waitForLoadState('domcontentloaded');
  // Counts every prompt bar the chrome ever renders (so "no prompt" means none, not "none now"),
  // and logs, with the renderer's own clock, each bar's mount and every change of its arming.
  await page.evaluate(() => {
    const record = globalThis as unknown as { __promptsShown: number; __promptLog: PromptLogEntry[] };
    record.__promptsShown = 0;
    record.__promptLog = [];
    const log = (bar: Element, event: 'mount' | 'change') =>
      record.__promptLog.push({
        at: performance.now(),
        event,
        bar: record.__promptsShown,
        armed: bar.getAttribute('data-armed') === 'true',
        covered: bar.getAttribute('data-covered') === 'true',
      });
    new MutationObserver((records) => {
      for (const mutation of records) {
        if (mutation.type === 'attributes') {
          if (mutation.target instanceof Element && mutation.target.matches('[data-testid="permission-prompt"]')) log(mutation.target, 'change');
          continue;
        }
        for (const node of mutation.addedNodes) {
          const bar = node instanceof Element ? (node.matches('[data-testid="permission-prompt"]') ? node : node.querySelector('[data-testid="permission-prompt"]')) : null;
          if (bar) {
            record.__promptsShown += 1;
            log(bar, 'mount');
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-armed', 'data-covered'] });
    addEventListener('pointerdown', () => ((globalThis as unknown as { __pointerDownAt: number }).__pointerDownAt = performance.now()), true);
  });
  // When the window or a tab last had a fullscreen event (see `windowSettled`).
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const record = globalThis as unknown as { __fullscreenEventAt: number };
    record.__fullscreenEventAt = 0;
    const mark = () => {
      record.__fullscreenEventAt = Date.now();
    };
    const win = BrowserWindow.getAllWindows()[0]!;
    win.on('enter-full-screen', mark);
    win.on('leave-full-screen', mark);
    electronApp.on('web-contents-created', (_event, contents) => {
      contents.on('enter-html-full-screen', mark);
      contents.on('leave-html-full-screen', mark);
    });
  });
});

test.afterAll(async () => {
  await closeApp(app);
});

const promptsShown = () => page.evaluate(() => (globalThis as unknown as { __promptsShown: number }).__promptsShown);

/** A prompt bar's mount or a change of its `data-armed` / `data-covered`, at the renderer's `performance.now()`. */
interface PromptLogEntry {
  at: number;
  event: 'mount' | 'change';
  /** Which bar (the `__promptsShown` count when it mounted). */
  bar: number;
  armed: boolean;
  covered: boolean;
}
const promptLog = () => page.evaluate(() => (globalThis as unknown as { __promptLog: PromptLogEntry[] }).__promptLog);

/** The latest bar's log (its mount and every arming change since). */
async function latestBarLog(): Promise<PromptLogEntry[]> {
  const log = await promptLog();
  const bar = log.at(-1)?.bar;
  return log.filter((entry) => entry.bar === bar);
}

/** Resolves `'pending'` if `promise` has not settled within `ms`. */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);
}

const prompt = () => page.getByTestId('permission-prompt');
/** Loads `url` in the active tab; answers its WebContents id once it committed with `title`. */
async function open(url: string, title: string): Promise<number> {
  await address().click();
  await address().fill(url);
  await address().press('Enter');
  await expect(activeTab()).toHaveAttribute('title', title);
  return contentsIdAt(url);
}

const ASK_NOTIFICATIONS = 'Notification.requestPermission()';
/** `getUserMedia` for `constraints`: the granted track kinds (`audio+video`), or the error's name. */
const askMedia = (constraints: { video?: true; audio?: true }) =>
  `navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)}).then((stream) => {
    const kinds = stream.getTracks().map((track) => track.kind).sort().join('+');
    for (const track of stream.getTracks()) track.stop();
    return kinds;
  }, (error) => error.name)`;
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
  await closeAllTabs();
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
  await chromeCaughtUp();
  expect(await promptsShown()).toBe(shown);
  await expect(prompt()).toHaveCount(0);
});

test('prompt-buttons-arm-after-delay-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/notify`, 'Page NOTIFY');
  const asked = run(id, ASK_NOTIFICATIONS);
  await expect(prompt()).toBeVisible();
  // A click on Allow while it is still disarmed (e.g. a click the page lured onto where the bar
  // appears) does nothing. When it landed is read from the renderer's clock (its pointerdown).
  await expect(page.getByTestId('permission-allow')).toBeDisabled();
  await expect(page.getByTestId('permission-block')).toBeDisabled();
  const box = (await page.getByTestId('permission-allow').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const clickedAt = await page.evaluate(() => (globalThis as unknown as { __pointerDownAt: number }).__pointerDownAt);
  // Once armed, the same click answers (nothing answered the early one: the bar is still there).
  await expect(prompt()).toHaveAttribute('data-armed', 'true');
  const log = await latestBarLog();
  const mounted = log.find((entry) => entry.event === 'mount')!;
  const armed = log.find((entry) => entry.armed)!;
  expect(mounted.armed).toBe(false);
  expect(clickedAt).toBeGreaterThan(mounted.at);
  expect(clickedAt).toBeLessThan(armed.at);
  // setTimeout never fires early; the observer reports both changes alike (a few ms of slack).
  expect(armed.at - mounted.at).toBeGreaterThanOrEqual(PROMPT_ARMING_DELAY_MS - 20);
  await expect(prompt()).toBeVisible();
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
  await chromeCaughtUp();
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

test('clearing-decisions-reevaluates-narrowed-prompts-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/media`, 'Page MEDIA');
  // The camera allowed; then camera + microphone prompts for the microphone only.
  const camera = run(id, askMedia({ video: true }));
  await expectPrompt(a.origin, a.host, 'camera');
  await allow();
  await expect(camera).resolves.toBe('video');
  await expect(prompt()).toHaveCount(0);
  const both = run(id, askMedia({ video: true, audio: true }));
  await expectPrompt(a.origin, a.host, 'microphone');

  // Clear Browsing Data… (main's message box stubbed to confirm) while that prompt is pending.
  await app.evaluate(({ dialog }, confirm) => {
    const record = { calls: 0 };
    (globalThis as unknown as { __clearDialog: typeof record }).__clearDialog = record;
    if (!Object.getOwnPropertyDescriptor(dialog, 'showMessageBox')?.writable) throw new Error('e2e: dialog.showMessageBox is not writable; cannot stub it');
    Object.assign(dialog, {
      showMessageBox: async () => {
        record.calls += 1;
        return { response: confirm, checkboxChecked: false };
      },
    });
  }, CLEAR_BROWSING_DATA.confirmIndex);
  await menu(CLEAR_BROWSING_DATA.menuItemId);
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __clearDialog: { calls: number } }).__clearDialog.calls)).toBe(1);
  // The camera's Allow is forgotten (the page's own check says so); the prompt is still pending.
  await expect.poll(() => run(id, 'navigator.permissions.query({ name: "camera" }).then((status) => status.state)')).toBe('denied');
  await expectPrompt(a.origin, a.host, 'microphone');

  // Allowing the microphone does not grant the camera the request also asked for.
  await allow();
  await expect(both).resolves.toBe('NotAllowedError');
  await expect(prompt()).toHaveCount(0);
  await expect(run(id, askMedia({ audio: true }))).resolves.toBe('audio');
  const cameraAgain = run(id, askMedia({ video: true }));
  await expectPrompt(a.origin, a.host, 'camera');
  await page.getByTestId('permission-dismiss').click();
  await expect(cameraAgain).resolves.toBe('NotAllowedError');
});

test('app-session-stays-deny-all-e2e', async () => {
  const shown = await promptsShown();
  await expect(page.evaluate(() => Notification.requestPermission())).resolves.toBe('denied');
  await expect(page.evaluate(() => navigator.permissions.query({ name: 'notifications' }).then((status) => status.state))).resolves.toBe('denied');
  await chromeCaughtUp();
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

/**
 * The window is out of (or, with `fullScreen`, in) OS fullscreen and had no fullscreen event for
 * `FULLSCREEN_EXIT_SETTLE_MS`, i.e. no macOS fullscreen animation is running or queued: a page's
 * fullscreen request made while the window still animates out of the last fullscreen is dropped
 * there, so each test enters only once the previous one's animation is over.
 */
async function windowSettled(fullScreen = false): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(
          ({ BrowserWindow }, { fullScreen, quiet }) => {
            const at = (globalThis as unknown as { __fullscreenEventAt: number }).__fullscreenEventAt;
            return BrowserWindow.getAllWindows()[0]!.isFullScreen() === fullScreen && Date.now() - at >= quiet;
          },
          { fullScreen, quiet: FULLSCREEN_EXIT_SETTLE_MS },
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** A real click (a user gesture) on the fullscreen page's button; waits until the page is fullscreen. */
async function enterFullscreen(id: number): Promise<void> {
  await windowSettled();
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

test('prompt-disarms-after-fullscreen-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/fullscreen`, 'Fullscreen');
  const asked = run(id, ASK_NOTIFICATIONS);
  await expectPrompt(a.origin, a.host, 'notifications');
  await expect(prompt()).toHaveAttribute('data-armed', 'true');
  // The page goes fullscreen over the bar: covered, and disarmed.
  await enterFullscreen(id);
  await expect(prompt()).toHaveAttribute('data-covered', 'true');
  await expect(prompt()).toHaveAttribute('data-armed', 'false');
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)!;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }, id);
  // Back from under the page: armed again only a whole delay after it was uncovered.
  await expect(prompt()).toHaveAttribute('data-covered', 'false');
  await expect(prompt()).toHaveAttribute('data-armed', 'true');
  const log = await latestBarLog();
  const coveredAt = log.findIndex((entry) => entry.covered);
  expect(coveredAt).toBeGreaterThan(0);
  expect(log.slice(coveredAt).some((entry) => entry.armed && entry.covered)).toBe(false);
  const uncovered = log.findIndex((entry, index) => index > coveredAt && !entry.covered);
  expect(log[uncovered]!.armed).toBe(false);
  const rearmed = log.find((entry, index) => index > uncovered && entry.armed)!;
  expect(rearmed.at - log[uncovered]!.at).toBeGreaterThanOrEqual(PROMPT_ARMING_DELAY_MS - 20);
  await windowSettled();
  await allow();
  await expect(asked).resolves.toBe('granted');
});

test('esc-leaves-fullscreen-on-hung-page-e2e', async () => {
  const a = await site();
  const id = await open(`${a.origin}/fullscreen`, 'Fullscreen');
  const before = await windowLayout();
  await enterFullscreen(id);
  // In OS fullscreen for good (on macOS, killing a renderer that got Esc during the enter animation
  // leaves Electron unable to grant the next page's fullscreen request).
  await windowSettled(true);
  // The page hangs: nothing runs in it any more (main's exit script included).
  void run(id, 'for (;;) {}').catch(() => undefined);
  await expect(settledWithin(run(id, '1').catch(() => 'gone'), 500)).resolves.toBe('pending');
  await app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id)!;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }, id);
  // frost left fullscreen without the page: the window, the notice, and the view back under the chrome.
  await expect.poll(async () => (await windowLayout()).fullScreen).toBe(false);
  await expect(page.getByTestId('fullscreen-notice')).toHaveCount(0);
  await expect.poll(async () => (await windowLayout()).view).toEqual(before.view);
  await expect(address()).toBeVisible();
  // The hung renderer is killed, so the next test can close its tab.
  await app.evaluate(({ webContents }, id) => process.kill(webContents.fromId(id)!.getOSProcessId(), 'SIGKILL'), id);
  await expect(page.getByTestId('page-crashed')).toBeVisible();
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
