// Specs: specs/security-policy.spec.ts (ALLOWED_EXTERNAL_SCHEMES, USER_ACTIVATION_INPUT_TYPES)
// Acceptance: specs/ci-gates.feature.md (openExternal deny e2e), specs/external-url.feature.md
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { USER_ACTIVATION_INPUT_TYPES } from '@app/specs/security-policy.spec';
import { closeApp, destroyWindows, launchApp, openUntrackedWindow, pageAt } from './harness';

const ALLOWED_URL = 'https://example.com/';
const NON_WEB_URLS = ['reaprobe://x', 'vscode://x', 'file:///etc/passwd', 'javascript:void(0)'] as const;
const BUTTON_URLS = [ALLOWED_URL, ...NON_WEB_URLS] as const;

/** What the main process saw, recorded by the instrumentation `instrumentMain` installs. */
interface MainRecord {
  /** URLs `shell.openExternal` was called with (the stub opens nothing). */
  openExternal: string[];
  /** Every window-open handler verdict: the URL Chromium passed and the returned action. */
  judged: { contentsId: number; url: string; action: string }[];
  /** Trusted `input-event`s per WebContents. */
  inputs: { contentsId: number; type: string }[];
  createdWindows: number;
  createdContents: number;
}

/** The loopback test page: one button per URL calling `window.open(url)` on click; `?auto=<url>` opens from a timer. */
function testPageHtml(): string {
  const buttons = BUTTON_URLS.map((url, i) => `<button data-testid="open-${i}" data-url="${url}">${url}</button>`).join('\n');
  return `<!doctype html><title>external-url</title>
${buttons}
<script>
  for (const button of document.querySelectorAll('button[data-url]')) {
    button.addEventListener('click', () => { window.open(button.dataset.url); });
  }
  const auto = new URL(location.href).searchParams.get('auto');
  if (auto) setTimeout(() => { window.open(auto); document.title = 'auto-opened'; }, 200);
</script>`;
}

async function startTestPageServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(testPageHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Main-process instrumentation (test process only; no production test hook): `shell.openExternal`
 * is replaced by a recorder, every window-open handler later installed on a WebContents is wrapped to
 * record its verdict (the app-wide guard installs one on each new WebContents), and window /
 * WebContents creation and trusted input events are counted.
 */
async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, shell, webContents }) => {
    const record: MainRecord = { openExternal: [], judged: [], inputs: [], createdWindows: 0, createdContents: 0 };
    (globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E = record;

    const descriptor = Object.getOwnPropertyDescriptor(shell, 'openExternal');
    if (!descriptor?.writable) throw new Error('e2e: shell.openExternal is not writable; cannot stub it');
    shell.openExternal = async (url: string) => {
      record.openExternal.push(url);
    };

    // setWindowOpenHandler lives on the WebContents prototype chain; wrap it where it is defined.
    const existing = webContents.getAllWebContents()[0];
    if (!existing) throw new Error('e2e: no WebContents to find the prototype from');
    let owner: object | null = Object.getPrototypeOf(existing) as object;
    while (owner && !Object.hasOwn(owner, 'setWindowOpenHandler')) owner = Object.getPrototypeOf(owner) as object | null;
    if (!owner) throw new Error('e2e: setWindowOpenHandler not found on the WebContents prototype chain');
    type Handler = (details: { url: string }) => { action: string };
    const target = owner as { setWindowOpenHandler(this: Electron.WebContents, handler: Handler): void };
    const original = target.setWindowOpenHandler;
    target.setWindowOpenHandler = function (handler) {
      const contentsId = this.id;
      original.call(this, (details) => {
        const verdict = handler(details);
        record.judged.push({ contentsId, url: details.url, action: verdict.action });
        return verdict;
      });
    };

    electronApp.on('browser-window-created', () => {
      record.createdWindows += 1;
    });
    electronApp.on('web-contents-created', (_event, contents) => {
      record.createdContents += 1;
      contents.on('input-event', (_inputEvent, input) => record.inputs.push({ contentsId: contents.id, type: input.type }));
    });
  });
}

async function mainRecord(app: ElectronApplication): Promise<MainRecord> {
  return app.evaluate(() => structuredClone((globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E));
}

async function resetMainRecord(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const record = (globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E;
    record.openExternal.length = 0;
    record.judged.length = 0;
    record.inputs.length = 0;
    record.createdWindows = 0;
    record.createdContents = 0;
  });
}

let app: ElectronApplication;
let server: Awaited<ReturnType<typeof startTestPageServer>>;
let windowIds: number[] = [];

test.beforeAll(async () => {
  server = await startTestPageServer();
  ({ app } = await launchApp());
  await app.firstWindow();
  await instrumentMain(app);
});

test.afterAll(async () => {
  await closeApp(app);
  await server?.close();
});

test.beforeEach(async () => {
  await resetMainRecord(app);
});

test.afterEach(async () => {
  await destroyWindows(app, windowIds);
  windowIds = [];
});

/** Opens the test page in a fresh test-only window (no prior input, so no stale activation). */
async function openTestPage(name: string, query = ''): Promise<{ page: Page; contentsId: number }> {
  const url = `${server.origin}/?case=${name}${query}`;
  const { id, loadError } = await openUntrackedWindow(app, url, { preload: false });
  windowIds.push(id);
  expect(loadError).toBeNull();
  const page = await pageAt(app, url);
  const contentsId = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.webContents.id, id);
  return { page, contentsId };
}

const button = (page: Page, url: (typeof BUTTON_URLS)[number]) => page.getByTestId(`open-${BUTTON_URLS.indexOf(url)}`);

/** Resolves once the window-open handler has judged `count` URLs for `contentsId`. */
async function judgedFor(contentsId: number, count: number): Promise<MainRecord['judged']> {
  await expect.poll(async () => (await mainRecord(app)).judged.filter((j) => j.contentsId === contentsId).length).toBeGreaterThanOrEqual(count);
  return (await mainRecord(app)).judged.filter((j) => j.contentsId === contentsId);
}

/** Exactly one window and one WebContents (the test's own) were created; nothing else. */
async function expectOnlyTestWindowCreated(): Promise<void> {
  const record = await mainRecord(app);
  expect(record.createdWindows).toBe(1);
  expect(record.createdContents).toBe(1);
}

test('real-click-is-a-trusted-activation', async () => {
  const { page, contentsId } = await openTestPage('activation');
  await button(page, 'reaprobe://x').click();
  await expect
    .poll(async () => (await mainRecord(app)).inputs.filter((i) => i.contentsId === contentsId).map((i) => i.type))
    .toContain('mouseDown');
  expect(USER_ACTIVATION_INPUT_TYPES).toContain('mouseDown');
});

test('does-not-open-non-web-schemes-on-click', async () => {
  const { page, contentsId } = await openTestPage('non-web');
  for (const url of NON_WEB_URLS) await button(page, url).click();
  // The pipeline is live: a real click on the allowlisted button afterwards is opened (control).
  await button(page, ALLOWED_URL).click();
  await expect.poll(async () => (await mainRecord(app)).openExternal).toEqual([ALLOWED_URL]);

  // What Chromium hands the handler: `javascript:` opens arrive as `about:blank`, and a web page's
  // `window.open('file:…')` is refused by Chromium before any handler runs. All are denied.
  expect(await judgedFor(contentsId, 4)).toEqual(
    ['reaprobe://x', 'vscode://x', 'about:blank', ALLOWED_URL].map((url) => ({ contentsId, url, action: 'deny' })),
  );
  expect((await mainRecord(app)).openExternal).toEqual([ALLOWED_URL]);
  await expectOnlyTestWindowCreated();
});

test('opens-allowlisted-url-once-on-real-click', async () => {
  const { page, contentsId } = await openTestPage('allowed');
  await button(page, ALLOWED_URL).click();
  await expect.poll(async () => (await mainRecord(app)).openExternal).toEqual([ALLOWED_URL]);
  expect(await judgedFor(contentsId, 1)).toEqual([{ contentsId, url: ALLOWED_URL, action: 'deny' }]);
  // No duplicate open: a later open from the same frame (never allowlisted) is judged right after
  // the click's one, with nothing in between, and nothing more was opened.
  await page.evaluate(() => void window.open('reaprobe://barrier'));
  expect(await judgedFor(contentsId, 2)).toEqual([
    { contentsId, url: ALLOWED_URL, action: 'deny' },
    { contentsId, url: 'reaprobe://barrier', action: 'deny' },
  ]);
  expect((await mainRecord(app)).openExternal).toEqual([ALLOWED_URL]);
  await expectOnlyTestWindowCreated();
});

test('does-not-open-without-gesture', async () => {
  // 1. From a timer after load, with no input at all.
  const timer = await openTestPage('timer', `&auto=${encodeURIComponent(ALLOWED_URL)}`);
  await expect(timer.page).toHaveTitle('auto-opened');
  expect(await judgedFor(timer.contentsId, 1)).toEqual([{ contentsId: timer.contentsId, url: ALLOWED_URL, action: 'deny' }]);

  // 2. `button.click()` from page script. Playwright's evaluate runs with Chromium user activation
  //    (CDP `userGesture`), but it is not OS/browser input, so no trusted `input-event` backs it.
  const scripted = await openTestPage('scripted');
  await scripted.page.evaluate((testId) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click(), 'open-0');
  // 3. A script-dispatched synthetic mousedown + click.
  await scripted.page.evaluate((testId) => {
    const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, 'open-0');
  expect(await judgedFor(scripted.contentsId, 2)).toEqual([
    { contentsId: scripted.contentsId, url: ALLOWED_URL, action: 'deny' },
    { contentsId: scripted.contentsId, url: ALLOWED_URL, action: 'deny' },
  ]);

  const record = await mainRecord(app);
  expect(record.inputs.filter((i) => i.contentsId === timer.contentsId || i.contentsId === scripted.contentsId)).toEqual([]);
  expect(record.openExternal).toEqual([]);
  expect(record.createdWindows).toBe(2);
  expect(record.createdContents).toBe(2);
});
