// Specs: specs/browse-guard.spec.ts (LOAD_ERROR_TITLES, CRASH_TITLE), specs/tabs.spec.ts (NOTICE_MESSAGES),
// specs/browser.spec.ts (BROWSE_PARTITION) · Acceptance: specs/browse-guard.feature.md (End to end)
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CRASH_TITLE, LOAD_ERROR_TITLES } from '@app/specs/browse-guard.spec';
import { BROWSE_PARTITION, NEW_TAB_LABEL, NOTICE_MESSAGES } from '@app/specs/browser.spec';
import { launchApp } from './harness';

const MAILTO = 'mailto:someone@example.com?subject=hello';

/** The loopback site's pages (see each route). */
function route(request: IncomingMessage, response: ServerResponse, origin: () => string): void {
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
    <script>
      document.getElementById('open').addEventListener('click', () => { window.open('/b'); });
      if (new URL(location.href).searchParams.has('auto')) setTimeout(() => { window.open('/b'); document.title = 'auto-opened'; }, 200);
    </script>`;
  switch (path) {
    case '/opener':
      return html(opener);
    case '/frames':
      return html(`<title>Frames</title>
        <iframe id="data" src="data:text/html,<p>data frame</p>"></iframe>
        <iframe id="app" src="app://app/"></iframe>
        <iframe id="web" src="/a"></iframe>`);
    case '/redirect-app':
      response.writeHead(302, { Location: 'app://app/' }).end();
      return;
    case '/redirect-mailto':
      response.writeHead(302, { Location: MAILTO }).end();
      return;
    case '/file':
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="frost-e2e.bin"' }).end('payload');
      return;
    case '/webview':
      return html(`<title>Webview</title><webview src="${origin()}/a"></webview>`);
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
  const server = createServer((request, response) => route(request, response, () => origin));
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  return { origin, close: () => closeServer(server) };
}

/** A loopback port nothing listens on (bound once, then released). */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

// A minimal DER encoder, enough for one self-signed X.509 v3 certificate (no new dependencies:
// node:crypto signs but cannot build certificates).
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length: number[] = [];
  for (let n = body.length; n > 0; n >>= 8) length.unshift(n & 0xff);
  const head = body.length < 0x80 ? [body.length] : [0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from([tag, ...head]), body]);
}
const derSequence = (...parts: Buffer[]) => der(0x30, ...parts);
function derOid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const derInteger = (value: Buffer) => der(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const derTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

/** A fresh self-signed certificate for `CN=localhost` (P-256, ECDSA-SHA256), as PEM. */
function selfSignedCertificate(): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = derSequence(derOid('1.2.840.10045.4.3.2'));
  const name = derSequence(der(0x31, derSequence(derOid('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now();
  const tbs = derSequence(
    der(0xa0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(8)),
    algorithm,
    name,
    derSequence(derTime(new Date(now - 86_400_000)), derTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const certificate = derSequence(tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const base64 = certificate.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
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
}

async function instrumentMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, session, shell }, partition) => {
    const record: MainRecord = { openExternal: [], browseContentsCreated: 0, webviewsCreated: 0, downloads: [], certificateErrors: [] };
    (globalThis as unknown as { __frostE2E: MainRecord }).__frostE2E = record;
    const descriptor = Object.getOwnPropertyDescriptor(shell, 'openExternal');
    if (!descriptor?.writable) throw new Error('e2e: shell.openExternal is not writable; cannot stub it');
    shell.openExternal = async (url: string) => {
      record.openExternal.push(url);
    };
    const browse = session.fromPartition(partition);
    electronApp.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') record.webviewsCreated += 1;
      if (contents.session === browse) record.browseContentsCreated += 1;
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
    record.browseContentsCreated = 0;
    record.webviewsCreated = 0;
  });
}

let app: ElectronApplication;
let page: Page;
let site: Awaited<ReturnType<typeof startSite>>;
const extraServers: Server[] = [];

test.beforeAll(async () => {
  site = await startSite();
  // Core dumps off: the crash test's renderer must die at once (see `launchApp`).
  ({ app, page } = await launchApp([], { coreDumps: false }));
  await page.waitForLoadState('domcontentloaded');
  await instrumentMain(app);
});

test.afterAll(async () => {
  await app?.close();
  await site?.close();
  for (const server of extraServers) await closeServer(server);
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

async function attachedViewIds(): Promise<number[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => (child as Electron.WebContentsView).webContents.id),
  );
}

async function contentsIdAt(url: string): Promise<number> {
  await expect.poll(async () => (await browseContents()).filter((c) => c.url === url).length).toBe(1);
  return (await browseContents()).find((c) => c.url === url)!.id;
}

const urlOf = async (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id);
const run = (id: number, script: string) =>
  app.evaluate(({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script) as Promise<unknown>, { id, script });

/** A real click (trusted `input-event`s, so a user gesture) at the centre of `selector` in a tab. */
async function realClick(id: number, selector: string): Promise<void> {
  const [x, y] = (await run(id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`)) as [number, number];
  await app.evaluate(
    ({ webContents }, { id, x, y }) => {
      const contents = webContents.fromId(id)!;
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    },
    { id, x, y },
  );
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
const address = () => page.getByTestId('address');

async function go(input: string): Promise<void> {
  await address().click();
  await address().fill(input);
  await address().press('Enter');
}

/** Loads `path` of the site in the active tab; answers its WebContents id once it committed. */
async function open(path: string, title: string): Promise<number> {
  await go(`${site.origin}${path}`);
  await expect(activeTab()).toHaveAttribute('title', title);
  return contentsIdAt(`${site.origin}${path}`);
}

test.beforeEach(async () => {
  const count = await strip().count();
  for (let i = 0; i < count; i++) await menu('close-tab');
  await expect(strip()).toHaveCount(1);
  await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
  await expect.poll(browseContents).toEqual([]);
  await resetMainRecord();
});

test('page-cannot-navigate-to-non-web-scheme-e2e', async () => {
  const id = await open('/a', 'Page A');
  for (const target of ['file:///etc/passwd', 'app://app/', 'chrome://gpu', 'javascript:void 0', 'data:text/html,<h1>data</h1>']) {
    await run(id, `location = ${JSON.stringify(target)}; 0`);
    await page.waitForTimeout(250);
    expect(await urlOf(id), target).toBe(`${site.origin}/a`);
  }
  // Control: the same mechanism does navigate to a web URL.
  await run(id, `location = '/b'; 0`);
  await expect(activeTab()).toHaveAttribute('title', 'Page B');
  expect(await urlOf(id)).toBe(`${site.origin}/b`);
  const record = await mainRecord();
  expect(record.openExternal).toEqual([]);
  expect(record.browseContentsCreated).toBe(1);
  await expect(page.getByTestId('page-error')).toHaveCount(0);
});

test('subframe-and-redirect-dropped-e2e', async () => {
  const id = await open('/frames', 'Frames');
  const frameUrls = () =>
    app.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.frames.map((frame) => frame.url), id);
  // The web iframe loads; the data: and app: ones never commit their URL.
  await expect.poll(frameUrls).toContain(`${site.origin}/a`);
  await page.waitForTimeout(300);
  for (const url of await frameUrls()) {
    expect(url.startsWith('data:'), url).toBe(false);
    expect(url.startsWith('app:'), url).toBe(false);
  }

  // Server redirects off the web: the tab stays where it was, nothing opens externally, even on a click.
  const opener = await open('/opener', 'Opener');
  await run(opener, `location = '/redirect-app'; 0`);
  await page.waitForTimeout(400);
  expect(await urlOf(opener)).toBe(`${site.origin}/opener`);
  await realClick(opener, '#redirect-mailto');
  await page.waitForTimeout(400);
  expect(await urlOf(opener)).toBe(`${site.origin}/opener`);
  expect((await mainRecord()).openExternal).toEqual([]);
  await expect(page.getByTestId('page-error')).toHaveCount(0);
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
  await page.waitForTimeout(500);
  await expect(strip()).toHaveCount(1);
  expect(await browseContents()).toEqual([{ id, url: `${site.origin}/opener?auto` }]);
  const record = await mainRecord();
  expect(record.browseContentsCreated).toBe(1);
  expect(record.openExternal).toEqual([]);
});

test('mailto-on-gesture-opens-externally-e2e', async () => {
  const id = await open('/opener', 'Opener');
  // No gesture: a script-set location is dropped.
  await run(id, `location = ${JSON.stringify(MAILTO)}; 0`);
  await page.waitForTimeout(400);
  expect((await mainRecord()).openExternal).toEqual([]);
  // A real click on the link reaches the external-open flow, once.
  await realClick(id, '#mailto');
  await expect.poll(async () => (await mainRecord()).openExternal).toEqual([MAILTO]);
  await page.waitForTimeout(300);
  expect((await mainRecord()).openExternal).toEqual([MAILTO]);
  expect(await urlOf(id)).toBe(`${site.origin}/opener`);
  await expect(strip()).toHaveCount(1);
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
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.forcefullyCrashRenderer(), id);
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
  await page.waitForTimeout(500);
  expect(await run(id, `document.querySelector('webview') !== null`)).toBe(true);
  expect(await browseContents()).toEqual([{ id, url: `${site.origin}/webview` }]);
  const record = await mainRecord();
  expect(record.webviewsCreated).toBe(0);
  expect(record.browseContentsCreated).toBe(1);
});
