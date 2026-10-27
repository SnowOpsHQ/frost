// Specs: specs/render-profile.spec.ts (DEVICE_PRESETS, USER_AGENT_TEMPLATES, NETWORK_PRESETS, RELOAD_TO_APPLY_LABEL),
// specs/render-profile.schema.spec.ts
// Acceptance: specs/render-profile.feature.md (End to end); review focus render-profile-is-tab-scoped,
// emulation-is-invisible-to-page
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DEVICE_PRESETS, RELOAD_TO_APPLY_LABEL } from '@app/specs/render-profile.spec';
import { closeApp, launchApp, launchUndrivenApp } from './harness';
import { chromeHelpers } from './helpers';

/** What the loopback site received: each request's path and `User-Agent`, in order. */
const requests: { path: string; userAgent: string }[] = [];
/** What `/probe` pages reported (`POST /report`). */
const reports: Record<string, unknown>[] = [];
/** What the cross-site frames reported (`POST /frame-report`): their name and what they saw. */
const frameReports: { name: string; ua: string; touch: number; mobile: boolean | null; screen: number }[] = [];

/** A frame page (`/frame?name=…`, served on every origin): an image, its report, and the frame nested in it. */
function framePage(name: string, nested: string): string {
  const child = nested === '' ? '' : `<iframe src="${nested}" width="240" height="120"></iframe>`;
  return PAGE(
    `<h1>${name}</h1><img src="/frame-img?name=${name}" width="1" height="1" alt="">${child}`,
    `<script>addEventListener('load', () => fetch('/frame-report', { method: 'POST', body: JSON.stringify({ name: ${JSON.stringify(name)}, ua: navigator.userAgent, touch: navigator.maxTouchPoints, mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null, screen: screen.width }) }));</script>`,
  );
}

const PAGE = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Render profile test</title>${head}</head><body>${body}</body></html>`;

/** A probe of what the page can see of its environment, reported back to the site when asked. */
const PROBE_SCRIPT = `
window.__probe = () => {
  let getterHit = false;
  const bait = new Error('bait');
  Object.defineProperty(bait, 'stack', { get() { getterHit = true; return ''; } });
  console.log(bait);
  console.debug(bait);
  console.table([bait]);
  const before = performance.now();
  debugger;
  const pausedMs = performance.now() - before;
  return {
    userAgent: navigator.userAgent,
    width: innerWidth,
    mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
    webdriver: navigator.webdriver,
    getterHit,
    pausedMs,
    touchPoints: navigator.maxTouchPoints,
    devtoolsGlobals: Object.getOwnPropertyNames(window).filter((name) => /^(cdc_|__playwright|__pw|__webdriver|__selenium|__nightmare|callPhantom|_phantom|domAutomation)/i.test(name)),
  };
};
if (location.search.includes('report')) {
  addEventListener('load', () => setTimeout(() => {
    fetch('/report', { method: 'POST', body: JSON.stringify(window.__probe()) });
  }, 300));
}
`;

function route(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://x');
  requests.push({ path: url.pathname === '/frame-img' ? `/frame-img?name=${url.searchParams.get('name') ?? ''}` : url.pathname, userAgent: String(request.headers['user-agent'] ?? '') });
  const html = (body: string): void => void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
  switch (url.pathname) {
    case '/page':
      // A marker only the page's own script writes; the user agent the server got, as text.
      return html(PAGE(`<h1>Page</h1><p id="server-ua"></p><noscript><p id="noscript">no script</p></noscript><script>document.body.insertAdjacentHTML('beforeend', '<p id="marker">written by script</p>')</script>`));
    case '/slow':
      // A page that loads a 120 KB resource: throttling makes it measurably slower.
      return html(PAGE(`<h1>Slow</h1><img src="/blob.bin?${Date.now()}" width="1" height="1" alt="">`));
    case '/blob.bin':
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(Buffer.alloc(120_000, 7));
      return;
    case '/frame-top':
      // The page on 127.0.0.1 embeds a frame on `localhost`, which embeds one on `[::1]`: three sites.
      return html(PAGE('<h1>Top</h1>', '') + `<iframe src="${otherOrigin}/frame?name=mid" width="320" height="240"></iframe>`);
    case '/frame':
      return html(framePage(url.searchParams.get('name') ?? '', url.searchParams.get('name') === 'mid' ? `${thirdOrigin}/frame?name=leaf` : ''));
    case '/frame-img':
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(Buffer.alloc(64, 1));
      return;
    case '/frame-report': {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        try {
          frameReports.push(JSON.parse(body) as (typeof frameReports)[number]);
        } catch {
          // Ignored.
        }
        response.writeHead(204).end();
      });
      return;
    }
    case '/probe':
      return html(PAGE('<h1>Probe</h1>', `<script>${PROBE_SCRIPT}</script>`));
    case '/report': {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        try {
          reports.push(JSON.parse(body) as Record<string, unknown>);
        } catch {
          // Ignored.
        }
        response.writeHead(204).end();
      });
      return;
    }
    default:
      response.writeHead(404).end();
  }
}

let server: ReturnType<typeof createServer>;
/** The same routes on the IPv6 loopback (a third site for nested frames). */
let server6: ReturnType<typeof createServer>;
/** The site on `127.0.0.1`, and the same server as other origins (`localhost`, `[::1]`). */
let origin = '';
let otherOrigin = '';
let thirdOrigin = '';

let app: ElectronApplication;
let chrome: Page;
const h = chromeHelpers(
  () => app,
  () => chrome,
);

test.beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  otherOrigin = `http://localhost:${port}`;
  server6 = createServer(route);
  await new Promise<void>((resolve) => server6.listen(port, '::1', resolve));
  thirdOrigin = `http://[::1]:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => server6.close(() => resolve()));
});

test.beforeEach(async () => {
  requests.length = 0;
  reports.length = 0;
  frameReports.length = 0;
  ({ app, page: chrome } = await launchApp());
});

test.afterEach(async () => {
  await closeApp(app);
});

/** Opens a new tab and waits until the chrome shows it (its address bar focused). */
async function newTab(count: number): Promise<void> {
  await h.menu('new-tab');
  await expect(h.strip()).toHaveCount(count);
  await expect(h.address()).toBeFocused();
}

/** Opens `path` of `base` in the active tab; resolves its WebContents id. */
async function open(pathname: string, base = origin): Promise<number> {
  await h.go(`${base}${pathname}`);
  const id = await h.contentsIdAt(`${base}${pathname}`);
  await waitLoaded(id);
  return id;
}

async function waitLoaded(id: number): Promise<void> {
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
}

/** Reloads the tab (as its Reload button does) and waits until the server answered it and it settled. */
async function reload(id: number, pathname: string): Promise<void> {
  const before = requests.filter((r) => r.path === pathname).length;
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)!.reload(), id);
  await expect.poll(() => requests.filter((r) => r.path === pathname).length).toBeGreaterThan(before);
  await waitLoaded(id);
}

/** What the page's main world sees. */
const sees = (id: number) => h.run(id, 'JSON.stringify({ ua: navigator.userAgent, width: innerWidth, mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null })').then((json) => JSON.parse(json as string) as { ua: string; width: number; mobile: boolean | null });

/** Reads the DOM from an isolated world of the test's own (runs with the page's JavaScript off too). */
const isolated = (id: number, code: string) => app.evaluate(({ webContents }, { id, code }) => webContents.fromId(id)!.executeJavaScriptInIsolatedWorld(4242, [{ code }]) as Promise<unknown>, { id, code });

const isAttached = (id: number) => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.debugger.isAttached(), id);

/** Sets a profile through the editor bar, as the user does, and closes the bar. */
async function applyProfile(options: { device?: string; userAgent?: string; network?: string; js?: boolean; cache?: boolean; pin?: boolean }): Promise<void> {
  if (!(await chrome.getByTestId('render-profile-bar').isVisible())) await chrome.getByTestId('render-profile-toggle').click();
  const bar = chrome.getByTestId('render-profile-bar');
  await expect(bar).toBeVisible();
  if (options.device) await bar.getByTestId('render-device').selectOption(options.device);
  if (options.userAgent) await bar.getByTestId('render-user-agent').selectOption(options.userAgent);
  if (options.network) await bar.getByTestId('render-network').selectOption(options.network);
  if (options.js !== undefined) await bar.getByTestId('render-js-off').setChecked(options.js);
  if (options.cache !== undefined) await bar.getByTestId('render-cache-off').setChecked(options.cache);
  if (options.pin !== undefined) await bar.getByTestId('render-pin').setChecked(options.pin);
  await bar.getByTestId('render-apply').click();
  await chrome.getByTestId('render-profile-close').click();
  await expect(bar).toBeHidden();
}

/** The active tab's badge, once its profile is in effect. */
async function profileActive(): Promise<void> {
  await expect(h.activeTab().getByTestId('tab-render-profile')).toHaveAttribute('data-status', 'active');
}

test('mobile-preset-viewport-and-ua', async () => {
  const id = await open('/page');
  const before = await sees(id);
  expect(before.width).not.toBe(DEVICE_PRESETS.phone.width);
  expect(before.ua).not.toContain('Mobile');

  await applyProfile({ device: 'phone', userAgent: 'mobile' });
  await profileActive();
  // Visible on the tab, in the status bar and around the page; the page loaded before it.
  await expect(chrome.getByTestId('status-render-profile')).toContainText(`Phone 412×915 · Mobile browser · ${RELOAD_TO_APPLY_LABEL}`);
  await expect(chrome.getByTestId('render-frame-summary')).toHaveText('Phone 412×915 · Mobile browser');
  const reloads = requests.filter((r) => r.path === '/page').length;
  await chrome.getByTestId('render-frame-reload').click();
  await expect.poll(() => requests.filter((r) => r.path === '/page').length).toBeGreaterThan(reloads);
  await waitLoaded(id);
  await expect(chrome.getByTestId('render-frame-reload')).toHaveCount(0);
  await expect(chrome.getByTestId('status-render-profile')).not.toContainText(RELOAD_TO_APPLY_LABEL);

  const after = await sees(id);
  expect(after.width).toBe(DEVICE_PRESETS.phone.width);
  expect(after.ua).toMatch(/^Mozilla\/5\.0 \(Linux; Android 10; K\) .* Mobile Safari\/537\.36$/);
  expect(after.mobile).toBe(true);
  // The server got it too (the request itself carried the profile).
  expect(requests.filter((r) => r.path === '/page').at(-1)!.userAgent).toBe(after.ua);

  // Back to frost's own user agent, keeping the device (an empty user-agent override restores it).
  await applyProfile({ userAgent: 'browser' });
  await expect(chrome.getByTestId('render-frame-summary')).toHaveText('Phone 412×915');
  await reload(id, '/page');
  const own = await sees(id);
  expect(own.ua).toBe(before.ua);
  expect(own.width).toBe(DEVICE_PRESETS.phone.width);
  expect(requests.filter((r) => r.path === '/page').at(-1)!.userAgent).toBe(before.ua);
});

test('javascript-off-marker-absent', async () => {
  const id = await open('/page');
  expect(await isolated(id, `document.getElementById('marker') !== null`)).toBe(true);
  await chrome.getByTestId('render-profile-toggle').click();
  await chrome.getByTestId('render-quick-no-javascript').click();
  await chrome.getByTestId('render-profile-close').click();
  await profileActive();
  await reload(id, '/page');
  // The page's script never ran; frost's isolated worlds still do (the audit, below).
  expect(await isolated(id, `document.getElementById('marker') !== null`)).toBe(false);
  expect(await isolated(id, `document.querySelector('h1').textContent`)).toBe('Page');

  // The audit records the profile it ran under (the Overview shows it).
  const panelShown = async (panel: string) => (await chrome.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true' && (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) === panel;
  if (!(await panelShown('overview'))) await chrome.locator('[data-testid="seo-rail-item"][data-panel="overview"]').click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await expect(chrome.getByTestId('seo-audit-profile-summary')).toHaveText('JavaScript off', { timeout: 20_000 });
  await expect(chrome.getByTestId('seo-audit-profile')).toHaveAttribute('data-partial', 'false');
  // The Speed panel's lab caveat names it.
  await chrome.locator('[data-testid="seo-rail-item"][data-panel="speed"]').click();
  await expect(chrome.getByTestId('seo-speed-lab-note')).toContainText('under the render profile “JavaScript off”');

  // Reset: one click, and the page loads again as it is by default.
  const reloads = requests.filter((r) => r.path === '/page').length;
  await chrome.getByTestId('render-frame-reset').click();
  await expect.poll(() => requests.filter((r) => r.path === '/page').length).toBeGreaterThan(reloads);
  await waitLoaded(id);
  await expect.poll(() => isolated(id, `document.getElementById('marker') !== null`)).toBe(true);
});

test('slow-network-is-slower', async () => {
  const id = await open('/slow');
  const timed = async (): Promise<number> => {
    const start = Date.now();
    await reload(id, '/slow');
    await expect.poll(() => requests.filter((r) => r.path === '/blob.bin').length).toBeGreaterThan(0);
    return Date.now() - start;
  };
  const fast = await timed();
  await applyProfile({ network: 'slow-3g' });
  await profileActive();
  requests.length = 0;
  const slow = await timed();
  // Slow 3G adds 2 s of latency per round trip and caps throughput at 50 kB/s (120 kB: over 2 s more).
  expect(slow).toBeGreaterThan(fast + 2_000);
});

test('render-profile-is-tab-scoped', async () => {
  const profiled = await open('/page');
  await applyProfile({ device: 'phone', userAgent: 'googlebot-smartphone' });
  await profileActive();
  await reload(profiled, '/page');
  const bot = await sees(profiled);
  expect(bot.ua).toContain('Googlebot/2.1');

  await newTab(2);
  const plain = await open('/page?plain');
  // Another tab: frost's own user agent and the page area's width, no badge, chip or frame.
  const own = await sees(plain);
  expect(own.ua).not.toContain('Googlebot');
  expect(own.width).not.toBe(DEVICE_PRESETS.phone.width);
  expect(requests.filter((r) => r.path === '/page').at(-1)!.userAgent).toBe(own.ua);
  await expect(h.activeTab().getByTestId('tab-render-profile')).toHaveCount(0);
  await expect(chrome.getByTestId('status-render-profile')).toHaveCount(0);
  await expect(chrome.getByTestId('render-frame')).toHaveCount(0);
  expect(await isAttached(plain)).toBe(false);
  expect(await isAttached(profiled)).toBe(true);
  // The profiled tab keeps its badge in the background.
  await expect(chrome.getByTestId('tab-render-profile')).toHaveCount(1);

  // Closing the profiled tab: nothing of it is left, and the other tab is unchanged.
  await chrome.locator(`[data-testid="tab"][data-tab-id]`).first().click();
  await h.menu('close-tab');
  await expect.poll(async () => (await h.browseContents()).map((c) => c.id)).toEqual([plain]);
  await reload(plain, '/page');
  expect((await sees(plain)).ua).toBe(own.ua);
  expect(requests.filter((r) => r.path === '/page').at(-1)!.userAgent).toBe(own.ua);
  expect(await isAttached(plain)).toBe(false);
});

test('emulation-is-invisible-to-page', async () => {
  // Driven by Playwright (which has CDP sessions of its own on every page): a profiled tab shows the
  // page nothing a tab without a profile does not, apart from the emulated values.
  const plain = await open('/probe');
  const baseline = (await h.run(plain, '__probe()')) as Record<string, unknown>;
  await newTab(2);
  const profiled = await open('/probe?profiled');
  await applyProfile({ device: 'phone', userAgent: 'googlebot-smartphone' });
  await profileActive();
  await reload(profiled, '/probe');
  const seen = (await h.run(profiled, '__probe()')) as Record<string, unknown>;
  expect(seen['userAgent']).toContain('Googlebot/2.1');
  expect(seen['width']).toBe(DEVICE_PRESETS.phone.width);
  for (const key of ['webdriver', 'getterHit', 'devtoolsGlobals']) expect(seen[key], key).toEqual(baseline[key]);
  expect(seen['pausedMs']).toBeLessThan(500);

  // The page cannot shake it off: no API reaches the debugger, and navigating, crossing origins and
  // reloading keep it.
  await h.run(profiled, `location.href = ${JSON.stringify(`${otherOrigin}/probe`)}`).catch(() => undefined);
  await expect.poll(() => h.urlOf(profiled)).toBe(`${otherOrigin}/probe`);
  await waitLoaded(profiled);
  await h.run(profiled, 'location.reload()').catch(() => undefined);
  await waitLoaded(profiled);
  expect(await isAttached(profiled)).toBe(true);
  expect(((await h.run(profiled, '__probe()')) as Record<string, unknown>)['userAgent']).toContain('Googlebot/2.1');
  await h.run(profiled, 'history.back()').catch(() => undefined);
  await expect.poll(() => h.urlOf(profiled)).toBe(`${origin}/probe?profiled`);
  await waitLoaded(profiled);
  expect(((await h.run(profiled, '__probe()')) as Record<string, unknown>)['width']).toBe(DEVICE_PRESETS.phone.width);

  // With nothing driving the app at all, the page sees only the emulated device and user agent:
  // pinned to the site, relaunched without Playwright, the restored tab reports what it sees.
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-render-'));
  try {
    const first = await launchApp([], { userDataDir: profile });
    const helpers = chromeHelpers(
      () => first.app,
      () => first.page,
    );
    await helpers.go(`${origin}/probe?report`);
    await helpers.contentsIdAt(`${origin}/probe?report`);
    const [previousApp, previousChrome] = [app, chrome];
    [app, chrome] = [first.app, first.page];
    await applyProfile({ device: 'phone', userAgent: 'googlebot-smartphone', pin: true });
    await profileActive();
    [app, chrome] = [previousApp, previousChrome];
    await closeApp(first.app);
    reports.length = 0;
    const undriven = launchUndrivenApp(profile);
    try {
      await expect.poll(() => reports.length, { timeout: 20_000 }).toBeGreaterThan(0);
      const clean = reports[0]!;
      expect(clean['userAgent']).toContain('Googlebot/2.1');
      expect(clean['width']).toBe(DEVICE_PRESETS.phone.width);
      expect(clean['mobile']).toBe(true);
      expect(clean['touchPoints']).toBe(5);
      // No automation flag, no observing session (a console getter never runs), no pause, no globals.
      expect(clean['webdriver']).toBe(false);
      expect(clean['getterHit']).toBe(false);
      expect(clean['pausedMs']).toBeLessThan(200);
      expect(clean['devtoolsGlobals']).toEqual([]);
    } finally {
      undriven.stop();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('cross-site-iframes-are-emulated', async () => {
  const id = await open('/frame-top');
  await expect.poll(() => frameReports.map((r) => r.name).sort()).toEqual(['leaf', 'mid']);
  const own = frameReports[0]!.ua;
  expect(own).not.toContain('Googlebot');

  // Googlebot smartphone: the cross-site frame and the one nested in it run under it too.
  await applyProfile({ device: 'phone', userAgent: 'googlebot-smartphone' });
  await profileActive();
  frameReports.length = 0;
  requests.length = 0;
  await reload(id, '/frame-top');
  await expect.poll(() => frameReports.map((r) => r.name).sort(), { timeout: 15_000 }).toEqual(['leaf', 'mid']);
  for (const report of frameReports) {
    expect(report.ua, report.name).toContain('Googlebot/2.1');
    expect(report.mobile, report.name).toBe(true);
    expect(report.touch, report.name).toBe(5);
  }
  // Their own requests carry it.
  for (const name of ['mid', 'leaf']) expect(requests.find((r) => r.path === `/frame-img?name=${name}`)?.userAgent, name).toContain('Googlebot/2.1');

  // JavaScript off: neither frame's script runs (they still load, and their images with the profile).
  await applyProfile({ js: true });
  await profileActive();
  frameReports.length = 0;
  requests.length = 0;
  await reload(id, '/frame-top');
  await expect.poll(() => requests.filter((r) => r.path.startsWith('/frame-img')).length, { timeout: 15_000 }).toBe(2);
  await waitLoaded(id);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(frameReports).toEqual([]);
  for (const name of ['mid', 'leaf']) expect(requests.find((r) => r.path === `/frame-img?name=${name}`)?.userAgent, name).toContain('Googlebot/2.1');
});

test('reset-restores-defaults', async () => {
  const id = await open('/page');
  const before = await sees(id);
  await applyProfile({ device: 'phone', userAgent: 'googlebot-smartphone', cache: true, network: 'fast-3g' });
  await profileActive();
  await reload(id, '/page');
  expect((await sees(id)).ua).toContain('Googlebot');
  const reloads = requests.filter((r) => r.path === '/page').length;
  await chrome.getByTestId('render-frame-reset').click();
  await expect.poll(() => requests.filter((r) => r.path === '/page').length).toBeGreaterThan(reloads);
  await waitLoaded(id);
  await expect(chrome.getByTestId('render-frame')).toHaveCount(0);
  await expect(chrome.getByTestId('status-render-profile')).toHaveCount(0);
  await expect(h.activeTab().getByTestId('tab-render-profile')).toHaveCount(0);
  await expect.poll(() => sees(id)).toEqual(before);
  expect(requests.filter((r) => r.path === '/page').at(-1)!.userAgent).toBe(before.ua);
  expect(await isAttached(id)).toBe(false);
});

test('pin-persists-across-relaunch', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-render-pin-'));
  try {
    await closeApp(app);
    ({ app, page: chrome } = await launchApp([], { userDataDir: profile }));
    await open('/page');
    await applyProfile({ userAgent: 'googlebot-desktop', pin: true });
    await profileActive();
    await expect(chrome.getByTestId('render-frame')).toHaveAttribute('data-source', 'site');
    await closeApp(app);

    requests.length = 0;
    ({ app, page: chrome } = await launchApp([], { userDataDir: profile }));
    // The restored tab's very first request already carried the pinned profile.
    await expect.poll(() => requests.filter((r) => r.path === '/page').length).toBeGreaterThan(0);
    expect(requests.find((r) => r.path === '/page')!.userAgent).toContain('Googlebot/2.1');
    await profileActive();
    await expect(chrome.getByTestId('render-frame')).toHaveAttribute('data-source', 'site');
    await expect(chrome.getByTestId('status-render-profile')).not.toContainText(RELOAD_TO_APPLY_LABEL);
    // The pin belongs to its site: another origin in the same tab is rendered as frost does.
    const other = await open('/page', otherOrigin);
    await expect(chrome.getByTestId('render-frame')).toHaveCount(0);
    expect((await sees(other)).ua).not.toContain('Googlebot');
  } finally {
    await closeApp(app);
    await rm(profile, { recursive: true, force: true });
  }
});
