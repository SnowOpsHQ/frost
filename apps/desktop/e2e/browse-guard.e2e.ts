// Specs: specs/browse-guard.spec.ts (LOAD_ERROR_TITLES, CRASH_TITLE), specs/tabs.spec.ts (NOTICE_MESSAGES),
// specs/browser.spec.ts (BROWSE_PARTITION) · Acceptance: specs/browse-guard.feature.md (End to end)
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CRASH_TITLE, LOAD_ERROR_TITLES } from '@app/specs/browse-guard.spec';
import { BROWSE_PARTITION, NOTICE_MESSAGES } from '@app/specs/browser.spec';
import { closeApp, launchApp, launchUndrivenApp } from './harness';
import { chromeHelpers } from './helpers';
import { selfSignedCertificate } from './tls';

const MAILTO = 'mailto:someone@example.com?subject=hello';

/** What `/dialogs` pages reported (`POST /report`), in order. */
const dialogReports: unknown[] = [];

/** The loopback site's pages (see each route). `hop()` is the origin of a second loopback server. */
function route(request: IncomingMessage, response: ServerResponse, origin: () => string, hop: () => string): void {
  const html = (body: string): void => {
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html>${body}`);
  };
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  // Big hit targets for real clicks; `?auto` opens a popup from a timer (no gesture).
  const opener = `<title>Opener</title><style>a, button { display: block; margin: 8px; padding: 14px; font-size: 18px; }</style>
    <button id="open">window.open</button>
    <a id="blank" href="/c" target="_blank">target=_blank</a>
    <a id="mailto" href="${MAILTO}">mail</a>
    <a id="redirect-mailto" href="/redirect-mailto">redirect to mailto</a>
    <a id="chain-popup" href="/hop1?do=popup">via a redirect chain, then a popup</a>
    <a id="chain-mailto" href="/hop1?do=mailto">via a redirect chain, then mailto</a>
    <a id="blank-download" href="/file" target="_blank">download in a new tab</a>
    <a id="blank-mailto" href="${MAILTO}" target="_blank">mail in a new tab</a>
    <button id="open-mailto">window.open mailto</button>
    <script>
      document.getElementById('open').addEventListener('click', () => { window.open('/b'); });
      // Each retitles once its popup request is out (a later task), so the chrome's title shows main handled it.
      document.getElementById('open-mailto').addEventListener('click', () => { window.open(${JSON.stringify(MAILTO)}); setTimeout(() => { document.title = 'opened-mailto'; }); });
      document.getElementById('blank-mailto').addEventListener('click', () => { setTimeout(() => { document.title = 'clicked-blank-mailto'; }); });
      if (new URL(location.href).searchParams.has('auto')) setTimeout(() => { window.open('/b'); document.title = 'auto-opened'; }, 200);
    </script>`;
  const query = new URL(request.url ?? '/', 'http://x').search;
  switch (path) {
    case '/opener':
      return html(opener);
    // A real redirect chain: here → the other origin's /hop2 → back to /landing.
    case '/hop1':
      response.writeHead(302, { Location: `${hop()}/hop2${query}` }).end();
      return;
    // The landing page acts on its own 500 ms after load, with no input.
    case '/landing':
      return html(`<title>Landing</title><script>
        const act = new URL(location.href).searchParams.get('do');
        // It acts first, then retitles: once the chrome shows the title, main has handled the act.
        setTimeout(() => {
          if (act === 'popup') window.open('/b');
          if (act === 'mailto') location = ${JSON.stringify(MAILTO)};
          document.title = 'landing-acted';
        }, 500);
      </script>`);
    case '/frames':
      return html(`<title>Frames</title>
        <iframe id="data" src="data:text/html,<p>data frame</p>"></iframe>
        <iframe id="app" src="app://app/"></iframe>
        <iframe id="web" src="/a"></iframe>
        <script>
          const blob = document.createElement('iframe');
          blob.src = URL.createObjectURL(new Blob(['<p>blob frame</p>'], { type: 'text/html' }));
          document.body.append(blob);
        </script>`);
    // A big click target in the top frame, and a same-origin iframe.
    case '/subframes':
      return html(`<title>Subframes</title><style>button { display: block; margin: 8px; padding: 30px; font-size: 18px; }</style>
        <button id="target">top frame</button>
        <iframe id="frame" src="/a"></iframe>`);
    case '/redirect-app':
      response.writeHead(302, { Location: 'app://app/' }).end();
      return;
    case '/redirect-mailto':
      response.writeHead(302, { Location: MAILTO }).end();
      return;
    case '/redirect-data':
      response.writeHead(302, { Location: 'data:text/html,<h1>data</h1>' }).end();
      return;
    case '/file':
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="frost-e2e.bin"' }).end('payload');
      return;
    case '/webview':
      return html(`<title>Webview</title><webview src="${origin()}/a"></webview>`);
    // Calls every JavaScript dialog as it loads and reports what each gave it (a value, or what it threw).
    case '/dialogs':
      return html(`<title>Dialogs</title><script>
        const results = [() => typeof alert('frost'), () => confirm('frost?'), () => prompt('frost?', 'default')].map((call) => {
          try { return call(); } catch (error) { return String(error); }
        });
        fetch('/report', { method: 'POST', body: JSON.stringify(results) });
      </script>`);
    case '/report': {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        dialogReports.push(JSON.parse(body));
        response.writeHead(204).end();
      });
      return;
    }
    // Asks to keep the user on the page when it unloads (needs an activation: click the button).
    case '/beforeunload':
      return html(`<title>Stay</title><style>button { margin: 20px; padding: 20px; font-size: 18px; }</style>
        <button id="activate">activate</button>
        <script>
          window.activated = false;
          document.getElementById('activate').addEventListener('click', () => { window.activated = true; });
          addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = 'stay'; return 'stay'; });
        </script>`);
    default: {
      const name = path.slice(1).toUpperCase() || 'ROOT';
      return html(`<title>Page ${name}</title><h1>Page ${name}</h1>`);
    }
  }
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startSite() {
  let origin = '';
  let hopOrigin = '';
  const server = createServer((request, response) => route(request, response, () => origin, () => hopOrigin));
  // The redirect chain's middle hop, on another origin: /hop2 sends the request back to /landing.
  const hop = createServer((request, response) => {
    const query = new URL(request.url ?? '/', 'http://x').search;
    response.writeHead(302, { Location: `${origin}/landing${query}` }).end();
  });
  origin = `http://127.0.0.1:${await listen(server)}`;
  hopOrigin = `http://127.0.0.1:${await listen(hop)}`;
  return { origin, hopOrigin, close: async () => Promise.all([closeServer(server), closeServer(hop)]) };
}

/** A loopback port nothing listens on (bound once, then released). */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

/** What the main process saw, recorded by `instrumentMain` (test process only; no production hook). */
interface MainRecord {
  /** URLs `shell.openExternal` was called with (the stub opens nothing). */
  openExternal: string[];
  /** Browse-session WebContents created. */
  browseContentsCreated: number;
  /** WebContents of type `webview` created. */
  webviewsCreated: number;
  /** Downloads seen on the browse session, with their state right after the app's handler ran. */
  downloads: { url: string; state: string }[];
  certificateErrors: { url: string; error: string }[];
  /**
   * Every `will-frame-navigate` / `will-redirect` of a tab, with whether it was `defaultPrevented`
   * (this listener is added after the guard's, so `prevented` is the guard's verdict).
   */
  navigations: { event: 'navigate' | 'redirect'; url: string; isMainFrame: boolean; prevented: boolean }[];
}

async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, session, shell }, partition) => {
    const record: MainRecord = { openExternal: [], browseContentsCreated: 0, webviewsCreated: 0, downloads: [], certificateErrors: [], navigations: [] };
    (globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E = record;
    const descriptor = Object.getOwnPropertyDescriptor(shell, 'openExternal');
    if (!descriptor?.writable) throw new Error('e2e: shell.openExternal is not writable; cannot stub it');
    shell.openExternal = async (url: string) => {
      record.openExternal.push(url);
    };
    const browse = session.fromPartition(partition);
    electronApp.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') record.webviewsCreated += 1;
      if (contents.session !== browse) return;
      record.browseContentsCreated += 1;
      // Added after the app-wide guard's listeners (it ran first in this same event).
      contents.on('will-frame-navigate', (details) => {
        record.navigations.push({ event: 'navigate', url: details.url, isMainFrame: details.isMainFrame, prevented: details.defaultPrevented });
      });
      contents.on('will-redirect', (details) => {
        record.navigations.push({ event: 'redirect', url: details.url, isMainFrame: details.isMainFrame, prevented: details.defaultPrevented });
      });
    });
    // Registered after the app's own listener, so it sees the item after the app cancelled it.
    browse.on('will-download', (_event, item) => {
      record.downloads.push({ url: item.getURL(), state: item.getState() });
    });
    electronApp.on('certificate-error', (_event, _contents, url, error) => {
      record.certificateErrors.push({ url, error });
    });
  }, BROWSE_PARTITION);
}

const mainRecord = (): Promise<MainRecord> =>
  app.evaluate(() => structuredClone((globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E));

async function resetMainRecord(): Promise<void> {
  await app.evaluate(() => {
    const record = (globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E;
    record.openExternal.length = 0;
    record.downloads.length = 0;
    record.certificateErrors.length = 0;
    record.navigations.length = 0;
    record.browseContentsCreated = 0;
    record.webviewsCreated = 0;
  });
}

type Matcher = string | RegExp;
const matches = (url: string, target: Matcher) => (typeof target === 'string' ? url === target : target.test(url));

/** The guard itself dropped a `kind` attempt at `target` (seen and `defaultPrevented`), and never allowed one. */
async function expectGuardDropped(kind: 'navigate' | 'redirect', target: Matcher, isMainFrame = true): Promise<void> {
  const attempts = async () =>
    (await mainRecord()).navigations.filter((n) => n.event === kind && n.isMainFrame === isMainFrame && matches(n.url, target));
  await expect.poll(async () => (await attempts()).length, `${kind} ${String(target)} seen by the guard`).toBeGreaterThan(0);
  expect((await attempts()).every((n) => n.prevented), `${kind} ${String(target)} dropped by the guard`).toBe(true);
}

/** No navigation or redirect to `target` was ever let through (Chromium may refuse it before the guard sees it). */
async function expectNeverAllowed(target: Matcher): Promise<void> {
  const allowed = (await mainRecord()).navigations.filter((n) => matches(n.url, target) && !n.prevented);
  expect(allowed, String(target)).toEqual([]);
}

let app: ElectronApplication;
let page: Page;
const { browseContents, attachedViewIds, contentsIdAt, urlOf, run, realClick, menu, strip, activeTab, address, chromeCaughtUp, go, closeAllTabs } = chromeHelpers(
  () => app,
  () => page,
);
let site: Awaited<ReturnType<typeof startSite>>;
const extraServers: Server[] = [];

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  await instrumentMain(app);
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
  for (const server of extraServers) await closeServer(server);
});

/** Loads `path` of the site in the active tab; answers its WebContents id once it committed. */
async function open(path: string, title: string): Promise<number> {
  await go(`${site.origin}${path}`);
  await expect(activeTab()).toHaveAttribute('title', title);
  return contentsIdAt(`${site.origin}${path}`);
}

test.beforeEach(async () => {
  await closeAllTabs();
  await resetMainRecord();
});

test('page-cannot-navigate-to-non-web-scheme-e2e', async () => {
  const id = await open('/a', 'Page A');
  const stays = async (script: string) => {
    await run(id, `${script}; 0`);
    // Nothing in main marks a navigation Chromium refused before the guard saw it: a short wait.
    await page.waitForTimeout(250);
    expect(await urlOf(id), script).toBe(`${site.origin}/a`);
  };
  // Seen and dropped by the guard (a dropped navigation never commits, so no wait is needed).
  const dropped = async (script: string, target: string | RegExp) => {
    await run(id, `${script}; 0`);
    await expectGuardDropped('navigate', target);
    expect(await urlOf(id), script).toBe(`${site.origin}/a`);
  };
  for (const target of ['app://app/', 'vscode://x']) await dropped(`location = ${JSON.stringify(target)}`, target);
  await dropped(`location = URL.createObjectURL(new Blob(['<h1>blob</h1>'], { type: 'text/html' }))`, /^blob:/);
  // Refused by Chromium before the guard sees them (or, for javascript:, run in the page itself).
  for (const target of ['file:///etc/passwd', 'chrome://gpu', 'javascript:void 0', 'data:text/html,<h1>data</h1>']) {
    await stays(`location = ${JSON.stringify(target)}`);
  }
  for (const target of [/^app:/, /^vscode:/, /^blob:/, /^file:/, /^chrome:/, /^javascript:/, /^data:/]) await expectNeverAllowed(target);
  await expect(page.getByTestId('page-error')).toHaveCount(0);

  // Control: the same mechanism does navigate to a web URL…
  await run(id, `location = '/b'; 0`);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  expect(await urlOf(id)).toBe(`${site.origin}/b`);
  // …and to about:blank with a fragment (allowed as about:blank).
  await run(id, `location = 'about:blank#x'; 0`);
  await expect.poll(() => urlOf(id)).toBe('about:blank#x');
  const record = await mainRecord();
  expect(record.openExternal).toEqual([]);
  expect(record.browseContentsCreated).toBe(1);
});

test('browse-session-refuses-file-scheme-e2e', async () => {
  const id = await open('/a', 'Page A');
  // A readable file with content the page must never see.
  const dir = await mkdtemp(path.join(tmpdir(), 'frost-e2e-file-'));
  const marker = `frost-secret-${randomUUID()}`;
  const file = path.join(dir, 'secret.txt');
  await writeFile(file, marker);
  try {
    const target = pathToFileURL(file).href;
    // Main loads it directly into the tab (no navigation guard sees a main-initiated load).
    const result = await app.evaluate(
      async ({ webContents }, { id, target }) => {
        const contents = webContents.fromId(id)!;
        const committed: string[] = [];
        const onNavigate = (_event: unknown, url: string) => committed.push(url);
        contents.on('did-navigate', onNavigate);
        let error: string | null = null;
        try {
          await contents.loadURL(target);
        } catch (failure) {
          error = (failure as { code?: string }).code ?? String(failure);
        }
        contents.off('did-navigate', onNavigate);
        return { error, committed };
      },
      { id, target },
    );
    expect(result.error).toBe('ERR_FAILED');
    expect(result.committed).toEqual([]);
    const text = (await run(id, 'document.documentElement ? document.documentElement.innerText : ""')) as string;
    expect(text).not.toContain(marker);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subframe-and-redirect-dropped-e2e', async () => {
  const id = await open('/frames', 'Frames');
  const frameUrls = () =>
    app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((frame) => frame.url), id);
  // The web iframe loads; the guard drops the data:, app: and blob: ones, which never commit.
  await expect.poll(frameUrls).toContain(`${site.origin}/a`);
  await expectGuardDropped('navigate', /^data:/, false);
  await expectGuardDropped('navigate', 'app://app/', false);
  await expectGuardDropped('navigate', /^blob:/, false);
  for (const url of await frameUrls()) expect(/^(data|app|blob):/.test(url), url).toBe(false);

  // Server redirects off the web: the guard drops them, the tab stays where it was, nothing opens
  // externally, even on a real click.
  const opener = await open('/opener', 'Opener');
  await run(opener, `location = '/redirect-app'; 0`);
  await expectGuardDropped('redirect', 'app://app/');
  expect(await urlOf(opener)).toBe(`${site.origin}/opener`);
  await realClick(opener, '#redirect-mailto');
  // The guard decides (and would open) inside the redirect event; the cancelled navigation commits nothing.
  await expectGuardDropped('redirect', MAILTO);
  expect((await mainRecord()).openExternal).toEqual([]);
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), opener)).toBe(false);
  expect(await urlOf(opener)).toBe(`${site.origin}/opener`);
  await chromeCaughtUp();
  await expect(page.getByTestId('page-error')).toHaveCount(0);

  // A redirect to data: never reaches the guard: Chromium refuses it (ERR_UNSAFE_REDIRECT) and the
  // chrome reports that, rather than leaving a blank tab.
  await run(opener, `location = '/redirect-data'; 0`);
  await expect(page.getByTestId('page-error')).toHaveAttribute('data-error-class', 'generic');
  await expect(page.getByTestId('page-error-detail')).toHaveText('ERR_UNSAFE_REDIRECT');
  await expectNeverAllowed(/^data:/);
});

test('gesture-does-not-survive-navigation-e2e', async () => {
  for (const which of ['popup', 'mailto'] as const) {
    const id = await open('/opener', 'Opener');
    await resetMainRecord();
    await realClick(id, `#chain-${which}`);
    // The landing page acts, then retitles: by the time the chrome shows the title, main handled the act.
    await expect(activeTab()).toHaveAttribute('title', 'landing-acted');
    if (which === 'mailto') await expectGuardDropped('navigate', MAILTO);
    // The click really went through a two-hop, cross-origin redirect chain.
    const redirects = (await mainRecord()).navigations.filter((n) => n.event === 'redirect');
    expect(redirects.map((n) => [new URL(n.url).origin, n.prevented])).toEqual([
      [site.hopOrigin, false],
      [site.origin, false],
    ]);
    expect(await urlOf(id), which).toBe(`${site.origin}/landing?do=${which}`);
    await expect(strip(), which).toHaveCount(1);
    const record = await mainRecord();
    expect(record.openExternal, which).toEqual([]);
    expect(record.browseContentsCreated, which).toBe(0);
  }
});

test('popup-with-gesture-opens-background-tab-e2e', async () => {
  const id = await open('/opener', 'Opener');
  await realClick(id, '#open');
  await expect(strip()).toHaveCount(2);
  await realClick(id, '#blank');
  await expect(strip()).toHaveCount(3);
  // Right of the opener, in the order opened; each loads its page in its own view.
  await expect(strip().nth(1)).toHaveAttribute('title', 'Page B');
  await expect(strip().nth(2)).toHaveAttribute('title', 'Page C');
  await expect(strip().nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(address()).toHaveValue(`${site.origin}/opener`);
  const b = await contentsIdAt(`${site.origin}/b`);
  const c = await contentsIdAt(`${site.origin}/c`);
  expect(new Set([id, b, c]).size).toBe(3);
  expect(await attachedViewIds()).toEqual([id]);
  // They are ordinary tabs: switching shows them.
  await strip().nth(2).click();
  await expect.poll(attachedViewIds).toEqual([c]);
  expect((await mainRecord()).openExternal).toEqual([]);
});

test('popup-without-gesture-is-blocked-e2e', async () => {
  // From a timer after load, with no input at all.
  await go(`${site.origin}/opener?auto`);
  await expect(activeTab()).toHaveAttribute('title', 'auto-opened');
  const id = await contentsIdAt(`${site.origin}/opener?auto`);
  // From page script: a scripted click, and a synthetic mousedown + click.
  await run(id, `document.getElementById('open').click(); 0`);
  await run(
    id,
    `(() => { const b = document.getElementById('open'); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 0; })()`,
  );
  // Then a retitle from the same frame: once the chrome shows it, main has handled those opens.
  await run(id, `document.title = 'scripted-done'; 0`);
  await expect(activeTab()).toHaveAttribute('title', 'scripted-done');
  await expect(strip()).toHaveCount(1);
  expect(await browseContents()).toEqual([{ id, url: `${site.origin}/opener?auto` }]);
  const record = await mainRecord();
  expect(record.browseContentsCreated).toBe(1);
  expect(record.openExternal).toEqual([]);
});

test('mailto-on-gesture-opens-externally-e2e', async () => {
  const id = await open('/opener', 'Opener');
  // No gesture: a script-set location is dropped (the guard decides inside the event).
  await run(id, `location = ${JSON.stringify(MAILTO)}; 0`);
  await expectGuardDropped('navigate', MAILTO);
  expect((await mainRecord()).openExternal).toEqual([]);
  // A real click on the link reaches the external-open flow, once: one more navigation, one open.
  await realClick(id, '#mailto');
  await expect.poll(async () => (await mainRecord()).openExternal).toEqual([MAILTO]);
  expect((await mainRecord()).navigations.filter((n) => n.url === MAILTO).map((n) => n.prevented)).toEqual([true, true]);
  expect(await urlOf(id)).toBe(`${site.origin}/opener`);
  await expect(strip()).toHaveCount(1);
});

test('subframe-cannot-open-externally-e2e', async () => {
  const id = await open('/subframes', 'Subframes');
  const frameUrl = `${site.origin}/a`;
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((f) => f.url), id)).toEqual([frameUrl]);
  const inFrame = (script: string) =>
    app.evaluate(
      ({ webContents }, { id, frameUrl, script }) => webContents.fromId(id)!.mainFrame.frames.find((f) => f.url === frameUrl)!.executeJavaScript(script) as Promise<unknown>,
      { id, frameUrl, script },
    );
  await resetMainRecord();
  // A real click in the top frame, then the iframe tries to spend it: on itself, then on the top.
  await realClick(id, '#target');
  await inFrame(`location = ${JSON.stringify(MAILTO)}; 0`);
  await expectGuardDropped('navigate', MAILTO, false);
  await inFrame(`top.location = ${JSON.stringify(MAILTO)}; 0`);
  await expectGuardDropped('navigate', MAILTO, true);
  expect((await mainRecord()).openExternal).toEqual([]);
  // The click is still unspent: the top frame's own navigation uses it, once.
  await run(id, `location = ${JSON.stringify(MAILTO)}; 0`);
  await expect.poll(async () => (await mainRecord()).openExternal).toEqual([MAILTO]);
  expect(await urlOf(id)).toBe(`${site.origin}/subframes`);
});

test('popup-to-external-scheme-is-dropped-e2e', async () => {
  const id = await open('/opener', 'Opener');
  await realClick(id, '#blank-mailto');
  await expect(activeTab()).toHaveAttribute('title', 'clicked-blank-mailto');
  await realClick(id, '#open-mailto');
  await expect(activeTab()).toHaveAttribute('title', 'opened-mailto');
  const record = await mainRecord();
  expect(record.openExternal).toEqual([]);
  // The opener's own WebContents only: no tab for either popup.
  expect(record.browseContentsCreated).toBe(1);
  await expect(strip()).toHaveCount(1);
  expect(await urlOf(id)).toBe(`${site.origin}/opener`);
});

test('download-is-cancelled-with-notice-e2e', async () => {
  const id = await open('/a', 'Page A');
  await expect(page.getByTestId('status-notice')).toHaveCount(0);
  await run(id, `location = '/file'; 0`);
  await expect(page.getByTestId('status-notice')).toHaveText(NOTICE_MESSAGES['download-blocked']);
  expect((await mainRecord()).downloads).toEqual([{ url: `${site.origin}/file`, state: 'cancelled' }]);
  expect(await urlOf(id)).toBe(`${site.origin}/a`);
  await expect(page.getByTestId('page-error')).toHaveCount(0);
  expect(await attachedViewIds()).toEqual([id]);
});

test('popup-download-leaves-no-blank-tab-e2e', async () => {
  const id = await open('/opener', 'Opener');
  await realClick(id, '#blank-download');
  await expect(page.getByTestId('status-notice')).toHaveText(NOTICE_MESSAGES['download-blocked']);
  await expect.poll(async () => (await mainRecord()).downloads).toEqual([{ url: `${site.origin}/file`, state: 'cancelled' }]);
  // The popup's tab (created for the click) is gone again; the opener stays active and shown.
  expect((await mainRecord()).browseContentsCreated).toBe(2);
  await expect(strip()).toHaveCount(1);
  await expect.poll(async () => (await browseContents()).map((c) => c.id)).toEqual([id]);
  expect(await attachedViewIds()).toEqual([id]);
});

test('connection-refused-shows-error-panel-e2e', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/back`;
  await go(url);
  const panel = page.getByTestId('page-error');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-error-class', 'unreachable');
  await expect(page.getByTestId('page-error-title')).toHaveText(LOAD_ERROR_TITLES.unreachable);
  await expect(page.getByTestId('page-error-message')).toContainText(`127.0.0.1:${port}`);
  await expect(page.getByTestId('page-error-detail')).toHaveText('ERR_CONNECTION_REFUSED');
  await expect(page.getByTestId('page-error-back')).toHaveCount(0);
  await expect(address()).toHaveValue(url);
  const id = await contentsIdAt(url);
  expect(await attachedViewIds()).toEqual([]);

  // The server comes up; Try again loads the page in the same view.
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Back up</title><h1>Back up</h1>'));
  extraServers.push(server);
  await listen(server, port);
  await page.getByTestId('page-error-retry').click();
  await expect(activeTab()).toHaveAttribute('title', 'Back up');
  await expect(panel).toHaveCount(0);
  await expect.poll(attachedViewIds).toEqual([id]);
});

test('certificate-error-shows-error-panel-e2e', async () => {
  let requests = 0;
  const server = createHttpsServer(selfSignedCertificate(), (_request, response) => {
    requests += 1;
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Should not load</title>');
  });
  extraServers.push(server);
  const port = await listen(server);
  const url = `https://127.0.0.1:${port}/`;
  await go(url);
  const panel = page.getByTestId('page-error');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-error-class', 'certificate');
  await expect(page.getByTestId('page-error-title')).toHaveText(LOAD_ERROR_TITLES.certificate);
  await expect(page.getByTestId('page-error-detail')).toHaveText(/^ERR_CERT_/);
  // Try again is the only way out: nothing proceeds past a refused certificate.
  await expect(page.getByTestId('page-error-actions').getByRole('button')).toHaveText(['Try again']);
  await expect(page.locator('.address')).toHaveAttribute('data-security', 'insecure');
  const record = await mainRecord();
  expect(record.certificateErrors.map((e) => e.url)).toContain(url);
  expect(record.certificateErrors.every((e) => e.error.startsWith('net::ERR_CERT_'))).toBe(true);
  expect(requests).toBe(0);
  expect(await attachedViewIds()).toEqual([]);
});

test('crash-shows-panel-and-reload-recovers-e2e', async () => {
  const id = await open('/a', 'Page A');
  // SIGKILL from main: the renderer dies at once and writes no core dump (a crash would, and where
  // core dumps go to a slow pipe handler `render-process-gone` arrives far too late).
  await app.evaluate(({ webContents }, id) => process.kill(webContents.fromId(id)!.getOSProcessId(), 'SIGKILL'), id);
  const panel = page.getByTestId('page-crashed');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('page-crashed-title')).toHaveText(CRASH_TITLE);
  await expect.poll(attachedViewIds).toEqual([]);

  await page.getByTestId('page-crashed-reload').click();
  await expect(panel).toHaveCount(0);
  await expect.poll(attachedViewIds).toEqual([id]);
  await expect.poll(() => run(id, 'document.querySelector("h1")?.textContent')).toBe('Page A');
  expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isCrashed(), id)).toBe(false);
});

test('webview-tag-creates-nothing-e2e', async () => {
  const id = await open('/webview', 'Webview');
  // A <webview> would attach while the page loads.
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
  expect(await run(id, `document.querySelector('webview') !== null`)).toBe(true);
  expect(await browseContents()).toEqual([{ id, url: `${site.origin}/webview` }]);
  const record = await mainRecord();
  expect(record.webviewsCreated).toBe(0);
  expect(record.browseContentsCreated).toBe(1);
});

test('page-dialogs-are-disabled-e2e', async () => {
  // Playwright answers every dialog of a page it drives (over DevTools), so the page runs in an
  // app nothing drives: a profile whose restored tab is `/dialogs`, launched without Playwright.
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-dialogs-'));
  try {
    const first = await launchApp([], { userDataDir: profile });
    await first.page.getByTestId('address').fill(`${site.origin}/dialogs`);
    await first.page.getByTestId('address').press('Enter');
    await expect(first.page.locator('[data-testid="tab"][aria-selected="true"]')).toHaveAttribute('title', 'Dialogs');
    await expect.poll(() => dialogReports.length).toBe(1);
    await closeApp(first.app);
    dialogReports.length = 0;

    const undriven = launchUndrivenApp(profile);
    try {
      // A native dialog would block the page at alert() (nobody answers it): no report would come.
      await expect.poll(() => dialogReports.length, { timeout: 20_000 }).toBe(1);
      // alert() returns at once, confirm() is false, prompt() throws (Electron never supports it).
      expect(dialogReports[0]).toEqual(['undefined', false, 'Error: prompt() is not supported.']);
    } finally {
      undriven.stop();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('page-cannot-block-unload-e2e', async () => {
  const stay = async (): Promise<number> => {
    const id = await open('/beforeunload', 'Stay');
    // beforeunload only asks once the page had a user activation.
    await realClick(id, '#activate');
    await expect.poll(() => run(id, 'window.activated')).toBe(true);
    return id;
  };
  // Navigating away (the address bar) and reloading.
  let id = await stay();
  await go(`${site.origin}/b`);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  id = await stay();
  await run(id, 'document.title = "marked"; 0');
  await page.getByTestId('reload').click();
  await expect(activeTab()).toHaveAttribute('title', 'Stay');
  // Closing the tab: its WebContents goes.
  await menu('close-tab');
  await expect.poll(async () => (await browseContents()).map((c) => c.id)).not.toContain(id);
  await expect(strip()).toHaveCount(1);
  expect(await browseContents()).toEqual([]);

  // Closing the window (its own app, so this suite's window stays open).
  const other = await launchApp();
  try {
    await other.page.getByTestId('address').fill(`${site.origin}/beforeunload`);
    await other.page.getByTestId('address').press('Enter');
    await expect(other.page.locator('[data-testid="tab"][aria-selected="true"]')).toHaveAttribute('title', 'Stay');
    const pageId = await other.app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((c) => c.getURL() === url)!.id, `${site.origin}/beforeunload`);
    const [x, y] = (await other.app.evaluate(
      ({ webContents }, id) =>
        webContents.fromId(id)!.executeJavaScript('(() => { const r = document.getElementById("activate").getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()'),
      pageId,
    )) as [number, number];
    await other.app.evaluate(
      ({ webContents }, { id, x, y }) => {
        const contents = webContents.fromId(id)!;
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      },
      { id: pageId, x, y },
    );
    await expect.poll(() => other.app.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('window.activated'), pageId)).toBe(true);
    await other.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    // The window closes (on Linux the app then quits with it).
    await expect
      .poll(async () => {
        try {
          return await other.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
        } catch {
          return 0;
        }
      })
      .toBe(0);
  } finally {
    await closeApp(other.app);
  }
});
