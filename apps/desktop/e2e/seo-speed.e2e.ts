// Specs: specs/seo-speed.spec.ts (SPEED_WORLD_ID, SPEED_STATE_KEY, VITAL_THRESHOLDS, PAGE_WEIGHT_WARN_BYTES, REQUEST_COUNT_WARN,
// SPEED_POLL_MS, INP_HINT), specs/seo-speed.schema.spec.ts (PerformanceMeasurementSchema)
// Acceptance: specs/seo-speed.feature.md (End to end); review focus measurement-runs-isolated
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { INP_HINT, LOADED_HIDDEN_HINT, PAGE_WEIGHT_WARN_BYTES, REQUEST_COUNT_WARN, SPEED_MEASURE_TIMEOUT_MS, SPEED_POLL_MS, SPEED_STATE_KEY, VITAL_THRESHOLDS } from '@app/specs/seo-speed.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 8_000;

/**
 * On Linux the app is driven through X11 (XWayland under a Wayland compositor): some Wayland
 * compositors never deliver presentation feedback to Chromium, which then records no paint timing
 * at all (no FCP, no LCP, in any world). X11 always presents. Elsewhere nothing is added.
 */
const PLATFORM_ARGS = process.platform === 'linux' && process.env['DISPLAY'] ? ['--ozone-platform=x11'] : [];

/**
 * A PNG of `width` × `height` in `rgb`, every `noisyEvery`-th row noise (frost's own tiny encoder).
 * The noise matters: Chromium leaves low-entropy images (a flat colour compresses to almost nothing)
 * out of LCP, as placeholders.
 */
function png(width: number, height: number, rgb: [number, number, number], noisyEvery = 0): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  let seed = 7;
  const noise = () => {
    const r = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < r.length; i++) r[i] = (seed = (seed * 1_103_515_245 + 12_345) >>> 0) >>> 24;
    return r;
  };
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => (noisyEvery > 0 && y % noisyEvery === 0 ? noise() : row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const HERO = png(300, 180, [47, 111, 228], 1);
const DOT = png(4, 4, [200, 80, 40]);

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
const html = (title: string, head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body><h1>${title}</h1>${body}</body></html>`;

type Route = (request: IncomingMessage, response: ServerResponse) => void;
const page = (title: string, head: string, body: string): Route => (_request, response) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html(title, head, body));

/** The loopback site the suite measures. */
async function startSite() {
  const routes: Record<string, Route> = {
    // A hero image that arrives late: it becomes the LCP element when it paints (~1.4 s). It comes
    // first and is small enough to be the largest element even in a small (tiled) window.
    '/lcp': (_request, response) =>
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A page whose largest element is a late image</title></head><body style="margin:0"><img src="/hero.png" width="300" height="180" alt="Hero"><p>Short intro.</p></body></html>`),
    // A page that opens /lcp in a background tab (a gesture-backed target=_blank link).
    // The link comes first (the window may be small).
    '/opener': (_request, response) =>
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opener</title></head><body style="margin:0"><a id="open" href="/lcp?background=1" target="_blank" style="display:block;width:200px;height:60px">Open</a></body></html>`),
    '/hero.png': (_request, response) => {
      setTimeout(() => response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(HERO), 1_400);
    },
    // Content that is pushed down three times after load (no input): CLS well above 0.25.
    '/shift': page(
      'A page whose content jumps',
      '',
      `<div id="slot"></div><p id="text">${words(400)}</p><script>let n = 0; const t = setInterval(() => { const d = document.createElement('div'); d.style.height = '220px'; d.style.background = '#ccd'; document.getElementById('slot').prepend(d); if (++n === 3) clearInterval(t); }, 700);</script>`,
    ),
    // Content that jumps whenever the test calls `shift()` (no input: it counts), for the live updates.
    '/shifting': page('A page that shifts on cue', '', `<div id="banner"></div><p>${words(400)}</p><script>let h = 0; window.shift = () => { h += 90; const b = document.getElementById('banner'); b.style.height = h + 'px'; b.style.background = '#ccd'; };</script>`),
    '/still': page('A still page', '', `<p>${words(300)}</p>`),
    // A single-page app: `route()` changes the URL in place, then fetches the route's data.
    '/spa': page(
      'A single-page app',
      '',
      `<p>${words(300)}</p><script>window.route = async () => { history.pushState({}, '', '/spa/route'); const r = await fetch('/route.json', { cache: 'no-store' }); return (await r.json()).ok === true ? 'ok' : 'bad'; };</script>`,
    ),
    '/route.json': (_request, response) => response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"ok":true}'),
    // Many requests and many bytes, a blocking script in the head, and uncompressed JavaScript.
    '/heavy': page(
      'A heavy page',
      '<script src="/blocking.js"></script>',
      `<p>${words(300)}</p>${Array.from({ length: REQUEST_COUNT_WARN + 10 }, (_, i) => `<img src="/dot.png?i=${i}" width="4" height="4" alt="">`).join('')}${[1, 2, 3, 4].map((i) => `<script src="/big${i}.js" defer></script>`).join('')}`,
    ),
    '/blocking.js': (_request, response) => response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.blockingRan = true;'),
    '/dot.png': (_request, response) => response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(DOT),
    // The isolation probe: the page replaces its PerformanceObserver and performance methods and traps globals.
    '/hostile': page(
      'A page that fights the measurement',
      `<script>
        window.__spy = { constructed: 0, observed: 0, entries: 0, trapped: [] };
        const RealObserver = window.PerformanceObserver;
        const realObserve = RealObserver.prototype.observe;
        RealObserver.prototype.observe = function (...args) { window.__spy.observed += 1; return realObserve.apply(this, args); };
        window.PerformanceObserver = class extends RealObserver {
          constructor(callback) {
            window.__spy.constructed += 1;
            super(() => callback({ getEntries: () => [{ entryType: 'largest-contentful-paint', startTime: 99999, renderTime: 99999, loadTime: 99999, size: 1e9 }] }));
          }
        };
        window.PerformanceObserver.supportedEntryTypes = RealObserver.supportedEntryTypes;
        const realByType = performance.getEntriesByType.bind(performance);
        performance.getEntriesByType = (type) => { window.__spy.entries += 1; return type === 'resource' ? [] : realByType(type); };
        for (const name of ['webVitals', ${JSON.stringify(SPEED_STATE_KEY)}]) Object.defineProperty(window, name, { configurable: true, get() { window.__spy.trapped.push('get ' + name); }, set() { window.__spy.trapped.push('set ' + name); } });
        window.__globals = null;
        addEventListener('load', () => { window.__globals = Object.getOwnPropertyNames(window).length; });
      </script>`,
      `<p>${words(300)}</p><img src="/dot.png?a" width="40" height="40" alt=""><img src="/dot.png?b" width="40" height="40" alt="">`,
    ),
  };
  const server = createServer((request, response) => {
    const route = routes[new URL(request.url ?? '/', 'http://x').pathname];
    if (route) return route(request, response);
    const big = /^\/big(\d)\.js$/.exec(new URL(request.url ?? '/', 'http://x').pathname);
    if (big) return response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(`/* ${'x'.repeat(1_000_000)} */`);
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let app: ElectronApplication;
let chrome: Page;
let site: Awaited<ReturnType<typeof startSite>>;
const { go, strip, run, contentsIdAt, realClick } = chromeHelpers(
  () => app,
  () => chrome,
);

const railItem = (panel: string) => chrome.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const speed = () => chrome.getByTestId('seo-speed');
const metric = (name: string) => chrome.locator(`[data-testid="seo-speed-metric"][data-metric="${name}"]`);
const valueOf = async (name: string): Promise<number | null> => {
  const raw = await metric(name).getAttribute('data-value');
  return raw === null || raw === '' ? null : Number(raw);
};
const issueIds = () => chrome.locator('[data-testid="seo-speed-issues"] [data-testid="seo-issue"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));
const sidebarElements = () =>
  chrome.getByTestId('seo-sidebar').evaluate((root) => ({ img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, a: root.querySelectorAll('a').length, style: root.querySelectorAll('[style]').length }));

/** Loads `path`, opens Page Speed and waits for its live measurement of that URL. */
async function measure(path: string): Promise<string> {
  const url = `${site.origin}${path}`;
  await go(url);
  if ((await chrome.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true' || (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) !== 'speed') await railItem('speed').click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'speed');
  await expect(chrome.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(speed()).toHaveAttribute('data-source', 'live', { timeout: AUDIT_WAIT });
  return url;
}

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page: chrome } = await launchApp(PLATFORM_ARGS));
  await chrome.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('lcp-late-image-e2e', async () => {
  const url = await measure('/lcp');
  // The rail item is available now (no longer "coming soon").
  await expect(railItem('speed')).toBeEnabled();
  // LCP is the late hero image: about its delay, and in range.
  await expect.poll(() => valueOf('lcp'), { timeout: 15_000 }).toBeGreaterThan(1_200);
  const lcp = (await valueOf('lcp'))!;
  expect(lcp).toBeLessThan(VITAL_THRESHOLDS.lcp.poor * 2);
  await expect(metric('lcp')).toHaveAttribute('data-band', lcp <= VITAL_THRESHOLDS.lcp.good ? 'good' : lcp > VITAL_THRESHOLDS.lcp.poor ? 'poor' : 'needs-improvement');
  await expect(metric('lcp').getByTestId('seo-speed-metric-value')).toHaveText(/\d(\.\d)? s|\d+ ms/);
  expect(await valueOf('fcp')).toBeGreaterThan(0);
  expect(await valueOf('ttfb')).toBeGreaterThanOrEqual(0);
  // No interaction yet: INP says how to measure it.
  await expect(metric('inp').getByTestId('seo-speed-metric-hint')).toHaveText(INP_HINT);
  await expect(chrome.getByTestId('seo-speed-lab-note')).toContainText('Lab data');
  await expect(chrome.getByTestId('seo-speed-live')).toHaveAttribute('data-state', 'live');
  // Navigation timing and the requests: the document and the image.
  await expect(chrome.getByTestId('seo-speed-phase').first()).toBeAttached();
  await expect(chrome.locator('[data-testid="seo-speed-type"][data-type="image"]')).toHaveAttribute('data-requests', '1');
  await expect(chrome.locator('[data-testid="seo-speed-type"][data-type="document"]')).toHaveAttribute('data-requests', '1');
  const hero = chrome.locator('[data-testid="seo-speed-large"][data-type="image"]').first();
  await expect(hero).toContainText(`${site.origin}/hero.png`);
  // "Open in new tab": a background tab, the page stays.
  const tabs = await strip().count();
  await hero.getByTestId('seo-speed-open').click();
  await expect(strip()).toHaveCount(tabs + 1);
  await contentsIdAt(`${site.origin}/hero.png`);
  await expect(chrome.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`);
  // Inert: no images, scripts, links or inline styles in the sidebar; bars are SVG attributes.
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, style: 0 });
  expect(await chrome.locator('[data-testid="seo-speed-metric"] rect[width]').count()).toBeGreaterThan(5);
});

test('synthetic-pageshow-cannot-reset-vitals-e2e', async () => {
  // Its own URL, so every value shown is this document's.
  const url = await measure('/lcp?spoof=1');
  await expect.poll(() => valueOf('lcp'), { timeout: 15_000 }).toBeGreaterThan(1_200);
  const before = { lcp: await valueOf('lcp'), fcp: await valueOf('fcp') };
  // The page fakes a back/forward-cache restore and a visibility change: web-vitals would start its
  // metrics over on a pageshow; in the speed world only the browser's own events reach it.
  await run(await contentsIdAt(url), `(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); return true; })()`);
  await chrome.waitForTimeout(SPEED_POLL_MS * 3);
  expect({ lcp: await valueOf('lcp'), fcp: await valueOf('fcp') }).toEqual(before);
  await expect(chrome.getByTestId('seo-speed-live')).toHaveAttribute('data-state', 'live');
});

test('background-tab-has-no-false-paint-metrics-e2e', async () => {
  const opener = await measure('/opener');
  // A real click on a target=_blank link: the page opens in a background tab and loads there.
  const tabs = await strip().count();
  await realClick(await contentsIdAt(opener), '#open');
  await expect(strip()).toHaveCount(tabs + 1);
  const background = `${site.origin}/lcp?background=1`;
  await contentsIdAt(background);
  await chrome.waitForTimeout(4_000);
  // The user switches to it seconds later: it paints only now, so FCP / LCP / CLS would be "time until the switch".
  await strip().nth(tabs).click();
  await expect(chrome.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${background}⁩`, { timeout: AUDIT_WAIT });
  await expect(speed()).toHaveAttribute('data-source', 'live', { timeout: AUDIT_WAIT });
  await chrome.waitForTimeout(SPEED_POLL_MS * 2);
  for (const name of ['lcp', 'fcp', 'cls']) {
    expect(await valueOf(name), name).toBeNull();
    await expect(metric(name).getByTestId('seo-speed-metric-hint')).toHaveText(LOADED_HIDDEN_HINT);
  }
  // TTFB is the server's: still measured. And no paint finding, live or in the audit.
  expect(await valueOf('ttfb')).toBeGreaterThanOrEqual(0);
  expect((await issueIds()).filter((id) => /^(lcp|fcp|cls)-/.test(id ?? ''))).toEqual([]);
  // The audit's own measurement (the health score, the rail dot) has none either: the page has no
  // other speed issue, so the dot stays green once that measurement is in.
  await chrome.waitForTimeout(SPEED_MEASURE_TIMEOUT_MS + 1_000);
  await expect(railItem('speed')).toHaveAttribute('data-status', 'pass');
});

test('cls-flagged-e2e', async () => {
  await measure('/shift');
  // The shifts land after load; the live values follow them.
  await expect.poll(() => valueOf('cls'), { timeout: 15_000 }).toBeGreaterThan(VITAL_THRESHOLDS.cls.good);
  await expect.poll(issueIds, { timeout: 10_000 }).toEqual(expect.arrayContaining([expect.stringMatching(/^cls-(poor|needs-improvement)$/)]));
  await expect(metric('cls')).not.toHaveAttribute('data-band', 'good');
  await expect(railItem('speed')).toBeVisible();
});

test('heavy-page-flagged-e2e', async () => {
  await measure('/heavy');
  await expect.poll(async () => Number(await chrome.getByTestId('seo-speed-requests').getAttribute('data-total')), { timeout: 15_000 }).toBeGreaterThan(REQUEST_COUNT_WARN);
  await expect.poll(async () => Number(await chrome.getByTestId('seo-speed-weight').getAttribute('data-bytes')), { timeout: 15_000 }).toBeGreaterThan(PAGE_WEIGHT_WARN_BYTES);
  await expect.poll(issueIds, { timeout: 10_000 }).toEqual(expect.arrayContaining(['page-weight-heavy', 'request-count-high', 'render-blocking-scripts', 'uncompressed-text-resources']));
  await expect(chrome.locator('[data-testid="seo-speed-type"][data-type="script"]')).toHaveAttribute('data-requests', '5');
  // The largest requests are the four big scripts.
  await expect(chrome.locator('[data-testid="seo-speed-large"][data-type="script"]').filter({ hasText: /\/big\d\.js/ })).toHaveCount(4);
  // The audit (and so the health score and the rail dot) has them too. It never waited for its own
  // measurement: it was analysed at once without it and again once it settled, so wait for that one
  // (render-blocking scripts come from the snapshot; the three others only from the measurement).
  await railItem('overview').click();
  const category = chrome.locator('[data-testid="seo-categories"] [data-category="performance"]');
  await expect.poll(async () => Number(await category.getAttribute('data-count')), { timeout: SPEED_MEASURE_TIMEOUT_MS + 5_000 }).toBeGreaterThanOrEqual(4);
  await expect(category).toHaveAttribute('data-status', 'warning');
  await expect(railItem('speed')).toHaveAttribute('data-status', 'warn');
});

test('measurement-runs-isolated', async () => {
  const url = await measure('/hostile');
  await expect.poll(() => valueOf('fcp'), { timeout: 15_000 }).toBeGreaterThan(0);
  // The page's fake observer delivered an LCP of 99 999 ms: never seen by the measurement.
  const lcp = await valueOf('lcp');
  expect(lcp === null || lcp < 10_000).toBe(true);
  // Its getEntriesByType('resource') answers [] in the main world; the isolated world sees both images.
  await expect(chrome.locator('[data-testid="seo-speed-type"][data-type="image"]')).toHaveAttribute('data-requests', '2');
  const id = await contentsIdAt(url);
  // Let a few more polls run, then ask the main world what it saw.
  await chrome.waitForTimeout(SPEED_POLL_MS * 3);
  const seen = (await run(id, `({ spy: window.__spy, globals: Object.getOwnPropertyNames(window).length, before: window.__globals, webVitals: Object.getOwnPropertyDescriptor(window, 'webVitals')?.get !== undefined, state: Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(SPEED_STATE_KEY)}) })`)) as {
    spy: { constructed: number; observed: number; entries: number; trapped: string[] };
    globals: number;
    before: number;
    webVitals: boolean;
    state: boolean;
  };
  // Nothing of the measurement ran in the main world: no observer constructed or observed through its
  // PerformanceObserver, no call to its performance methods, no global read or written, none added.
  expect(seen.spy).toEqual({ constructed: 0, observed: 0, entries: 0, trapped: [] });
  expect(seen.globals).toBe(seen.before);
  // Its own traps are still in place (nothing replaced them).
  expect(seen.webVitals).toBe(true);
  expect(seen.state).toBe(true);
  // And the measurement is live, from the isolated world.
  await expect(chrome.getByTestId('seo-speed-live')).toHaveAttribute('data-state', 'live');
});

test('spa-route-requests-are-counted-e2e', async () => {
  const spa = await measure('/spa');
  const id = await contentsIdAt(spa);
  // Leave the panel (no live polls): the next collection comes only with the route's audit.
  await railItem('overview').click();
  await expect(speed()).toHaveCount(0);
  // The URL changes in place and the route's request finishes, all before that collection.
  expect(await run(id, 'window.route()')).toBe('ok');
  const routed = `${site.origin}/spa/route`;
  await expect(chrome.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${routed}⁩`, { timeout: AUDIT_WAIT });
  await railItem('speed').click();
  await expect(chrome.getByTestId('seo-speed-note-soft-navigation')).toBeAttached({ timeout: AUDIT_WAIT });
  // The route's request is counted (it was observed before the collection that noticed the change).
  await expect(chrome.locator('[data-testid="seo-speed-type"][data-type="fetch"]')).toHaveAttribute('data-requests', '1', { timeout: 10_000 });
  await expect(chrome.locator('[data-testid="seo-speed-large"]').filter({ hasText: '/route.json' })).toHaveCount(1);
});

test('reload-starts-a-fresh-speed-session-e2e', async () => {
  // Its own URL (the same page): the next test's `measure('/shifting')` must be a real navigation.
  const shifting = await measure('/shifting?reload');
  const live = chrome.getByTestId('seo-speed-live');
  const polls = async () => Number(await live.getAttribute('data-polls'));
  // The page shifts live, and the session has polled a few times.
  const before = (await valueOf('cls')) ?? 0;
  await run(await contentsIdAt(shifting), 'window.shift()');
  await expect.poll(() => valueOf('cls'), { timeout: 10_000 }).toBeGreaterThan(before);
  await expect.poll(polls, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  const reached = await polls();
  // The toolbar's Reload: the same tab and URL, a new document. The panel stays, its session starts
  // again (the count does not go on from the old document's), and the shift is not shown again.
  await chrome.getByTestId('reload').click();
  await expect.poll(polls, { timeout: AUDIT_WAIT }).toBeLessThan(reached);
  await expect(speed()).toHaveAttribute('data-source', 'live', { timeout: AUDIT_WAIT });
  await expect.poll(async () => (await valueOf('cls')) ?? 0, { timeout: 10_000 }).toBeLessThan(0.01);
});

test('live-updates-stop-after-navigation-e2e', async () => {
  const shifting = await measure('/shifting');
  // Live: the page shifts after the panel opened, and the panel follows.
  const before = (await valueOf('cls')) ?? 0;
  await run(await contentsIdAt(shifting), 'window.shift()');
  await expect.poll(() => valueOf('cls'), { timeout: 10_000 }).toBeGreaterThan(before);
  const polls = Number(await chrome.getByTestId('seo-speed-live').getAttribute('data-polls'));
  expect(polls).toBeGreaterThan(1);
  // Navigate: the shifting page's updates stop; the panel measures the still page afresh.
  const still = await measure('/still');
  await expect(chrome.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${still}⁩`);
  for (let i = 0; i < 3; i++) {
    expect((await valueOf('cls')) ?? 0).toBeLessThan(0.01);
    await chrome.waitForTimeout(SPEED_POLL_MS);
  }
  await expect(chrome.locator('[data-testid="seo-speed-large"]').filter({ hasText: '/shifting' })).toHaveCount(0);
  // Leaving the panel ends the polls (the poll counter is gone with it).
  await railItem('overview').click();
  await expect(chrome.getByTestId('seo-speed')).toHaveCount(0);
});
