// Specs: specs/seo-snapshot.spec.ts, specs/seo-limits.spec.ts, specs/seo-sidebar.spec.ts, specs/seo-rules.spec.ts
// Acceptance: specs/seo-sidebar.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { NOINDEX_SCORE_CAP, NOT_INDEXABLE_LABEL } from '@app/specs/seo-rules.spec';
import { COMING_SOON_LABEL, PAGE_MIN_WIDTH, SEO_PANELS, SEO_UNAVAILABLE_MESSAGES, SIDEBAR_PANEL_WIDTH, SIDEBAR_RAIL_WIDTH, SIDEBAR_TOGGLE_MENU_ID } from '@app/specs/seo-sidebar.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const TEN_MB = 10 * 1024 * 1024;
const HOSTILE_LINKS = 100_000;
/** The hostile page's own scripts count every call into what they overrode. */
const HOSTILE_OVERRIDES = `<script>
window.__hits = 0;
const hit = () => { window.__hits += 1; };
const qsa = Document.prototype.querySelectorAll;
document.querySelectorAll = function (...args) { hit(); return qsa.apply(this, args); };
Document.prototype.querySelectorAll = function () { hit(); throw new Error('hijacked'); };
Element.prototype.getAttribute = function () { hit(); return '<img src=x onerror=owned()>'; };
Array.prototype.push = function () { hit(); return 0; };
JSON.stringify = function () { hit(); return '{}'; };
Object.defineProperty(Object.prototype, 'text', { set() { hit(); }, get() { hit(); return 'polluted'; }, configurable: true });
</script>`;

/**
 * Links nested 1000 deep around a large hidden subtree: every link's subtree is the rest of the page.
 * Sized so that reading each link's whole subtree (the extractor before its per-element visit cap)
 * takes longer than EXTRACT_TIMEOUT_MS on its own (about 4.8 s measured on Linux), while the capped
 * extractor reads it in a few hundred ms.
 */
const NESTED_LINKS = 1_000;
const NESTED_SPANS = 600_000;
const NESTED_PAGE = `<!doctype html><html lang="en"><head><title>Deeply nested links around a large subtree</title></head><body><script>
let parent = document.body;
for (let i = 0; i < ${NESTED_LINKS}; i++) { const a = document.createElement('a'); a.href = '/n/' + i; parent.appendChild(a); parent = a; }
const box = document.createElement('span'); box.style.display = 'none';
const many = document.createDocumentFragment();
for (let i = 0; i < ${NESTED_SPANS}; i++) many.appendChild(document.createElement('i'));
box.appendChild(many); parent.appendChild(box);
</script></body></html>`;

/** About 480 Japanese words written without spaces. */
const JAPANESE_PAGE = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>東京で毎日働く人のための通勤ガイドと便利な情報</title></head>
<body><h1>通勤ガイド</h1><p>${'私は毎日東京の会社で働いています。'.repeat(60)}</p></body></html>`;

const words = (n: number) => Array.from({ length: n }, (_, i) => ['cold', 'brew', 'coffee', 'water', 'grind', 'steep', 'filter', 'jar'][i % 8]).join(' ');

/** Its text inside a layout wrapper (`display: contents`, no box of its own), and 50 words in a `display: none` one. */
const WRAPPED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cold brew inside a layout wrapper element</title></head>
<body><div style="display:contents"><h1>Cold brew in a wrapper</h1><p>${words(420)}</p></div><div style="display:none"><span style="display:contents">${words(50)}</span></div></body></html>`;

/** Loopback pages for the sidebar: a good one, a bad one, an SPA, a hostile one, one with markup in its text, a busy one. */
async function startSeoServer() {
  let origin = '';
  const goodPage = () => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Cold-brew coffee at home: a simple guide</title>
<meta name="description" content="How to make smooth cold-brew coffee at home: the ratio, the grind, steeping times and storage, with no special kit.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${origin}/guides/cold-brew"><meta property="og:url" content="${origin}/guides/cold-brew">
<meta property="og:title" content="Cold-brew coffee at home"><meta property="og:description" content="The ratio, the grind and the steeping time.">
<meta property="og:image" content="https://example.org/cold-brew.png"><meta name="twitter:card" content="summary_large_image"></head>
<body><div hidden><h1>Hidden duplicate headline</h1></div><h1 style="display:none">Hidden by CSS</h1><h1>Cold-brew coffee at home</h1><p>${words(420)}</p><h2>What you need</h2><h3>Grind</h3><h3>Ratio</h3><h2>Storing it</h2>
<p><a href="/guides/">All guides</a> <a href="https://example.org/coffee">Coffee science</a> <a href="/ads" rel="sponsored">Sponsor</a></p>
<img src="/jar.png" alt="A jar of cold brew" width="320" height="200"></body></html>`;
  const badPage = `<!doctype html><html><head><meta name="robots" content="noindex"></head>
<body><h1>Big sale</h1><h1>Another headline</h1><p>Short page.</p><img src="/a.png"><img src="/b.png"><a href="/x">x</a></body></html>`;
  const spaPage = `<!doctype html><html lang="en"><head><title>SPA home route of the single page app</title></head><body><h1>Home</h1></body></html>`;
  const inertPage = `<!doctype html><html lang="en"><head><title>&lt;img src=x onerror="top.__pwned=1"&gt; ‮evil</title></head>
<body><h1>&lt;script&gt;top.__pwned=2&lt;/script&gt; heading</h1>
<img src="/a.png" alt="<img src=x onerror=top.__pwned=3>"><a href="javascript:top.__pwned=4">&lt;a href=javascript:alert(1)&gt;click</a></body></html>`;
  const busyPage = `<!doctype html><html lang="en"><head><title>A page that keeps its main thread busy</title>
<script>addEventListener('load', () => setTimeout(() => { const end = Date.now() + ${EXTRACT_TIMEOUT_MS + 2_000}; while (Date.now() < end) {} }, 50));</script></head><body><h1>Busy</h1></body></html>`;
  let hostile: string | null = null;
  const hostilePage = () => {
    hostile ??= [
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>',
      'T'.repeat(TEN_MB),
      '</title>',
      HOSTILE_OVERRIDES,
      '</head><body><h1>Hostile</h1>',
      // Separated by spaces: 100 000 anchors with no break opportunity between them keep Chromium's
      // own line layout busy for many seconds (the page's cost, not the extractor's; a page busy past
      // the limit is the `timeout` case, busy-page-times-out-then-retries).
      Array.from({ length: HOSTILE_LINKS }, (_, i) => `<a href="/l/${i}">l</a>`).join(' '),
      '</body></html>',
    ].join('');
    return hostile;
  };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/guides/cold-brew') html(goodPage());
    else if (pathname === '/bad') html(badPage);
    else if (pathname.startsWith('/spa')) html(spaPage);
    else if (pathname === '/hostile') html(hostilePage());
    else if (pathname === '/inert') html(inertPage);
    else if (pathname === '/busy') html(busyPage);
    else if (pathname === '/nested') html(NESTED_PAGE);
    else if (pathname === '/ja') html(JAPANESE_PAGE);
    else if (pathname === '/wrapped') html(WRAPPED_PAGE);
    else if (pathname === '/googlebot-noindex') html(goodPage().replace('<meta name="viewport"', '<meta name="googlebot" content="noindex"><meta name="viewport"'));
    else if (pathname.endsWith('.png')) response.writeHead(404).end();
    else html('<!doctype html><title>loopback</title><p>loopback</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
let page: Page;
let site: Awaited<ReturnType<typeof startSeoServer>>;
const { go, contentsIdAt, menu, run, press, strip, realClick } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const score = () => page.getByTestId('seo-score');

/** Opens the sidebar's `panel` (expanding the sidebar if needed). */
async function showPanel(panel: 'overview' | 'on-page'): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** The rule ids the Overview lists (all of them). */
async function issueIds(): Promise<string[]> {
  await showPanel('overview');
  const showAll = page.getByTestId('seo-show-all');
  if ((await showAll.count()) > 0 && (await showAll.getAttribute('aria-expanded')) === 'false') await showAll.click();
  return page.getByTestId('seo-issue').evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id') ?? ''));
}

/** Loads `url` in the active tab and waits for its audit (On-Page shows its URL). */
async function audit(url: string, timeout = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000): Promise<void> {
  await go(url);
  await showPanel('on-page');
  await expect(page.getByTestId('seo-fact-url')).toHaveText(url, { timeout });
}

/** The tab view's bounds (DIP), as main applied them. */
async function viewBounds(): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [view] = BrowserWindow.getAllWindows()[0]!.contentView.children;
    return view!.getBounds();
  });
}

test.beforeAll(async () => {
  site = await startSeoServer();
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('empty-tab-shows-hint', async () => {
  await expect(sidebar()).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('seo-empty')).toBeVisible();
  await expect(score()).toHaveCount(0);
  // The rail lists every panel, and every one is built now (Schema, Indexability, Page Speed and
  // Compliance have suites of their own: seo-schema, seo-indexability, seo-speed and
  // seo-compliance.e2e.ts): none is left disabled or "coming soon".
  await expect(page.getByTestId('seo-rail-item')).toHaveCount(SEO_PANELS.length);
  // Eleven since Phase 2.5 Task 2 (JavaScript, seo-javascript.e2e.ts).
  await expect(page.getByTestId('seo-rail-item')).toHaveCount(11);
  expect(SEO_PANELS.filter((panel) => !panel.available).map((panel) => panel.id)).toEqual([]);
  for (const panel of SEO_PANELS) await expect(railItem(panel.id)).toBeEnabled();
  await expect(page.locator(`[data-testid="seo-rail-item"][aria-label*="${COMING_SOON_LABEL}"]`)).toHaveCount(0);
});

test('good-page-scores-high', async () => {
  const url = `${site.origin}/guides/cold-brew`;
  await audit(url);
  await expect(page.getByTestId('seo-fact-title-value')).toHaveText('Cold-brew coffee at home: a simple guide');
  await expect(page.getByTestId('seo-fact-title-length-count')).toHaveText('40');
  await expect(page.getByTestId('seo-fact-title-length')).toHaveAttribute('data-indicator', 'ok');
  await expect(page.getByTestId('seo-fact-description-value')).toContainText('cold-brew coffee at home');
  await expect(page.getByTestId('seo-fact-canonical')).toHaveText(url);
  await expect(page.getByTestId('seo-fact-lang')).toHaveText('en');
  await expect(page.getByTestId('seo-fact-viewport')).toHaveText('width=device-width, initial-scale=1');
  await expect(page.getByTestId('seo-heading')).toHaveCount(5);
  expect(await page.getByTestId('seo-heading').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-level')} ${item.textContent}`))).toEqual([
    '1 H1Cold-brew coffee at home',
    '2 H2What you need',
    '3 H3Grind',
    '3 H3Ratio',
    '2 H2Storing it',
  ]);
  await expect(page.getByTestId('seo-links-internal')).toHaveText('2');
  await expect(page.getByTestId('seo-links-external')).toHaveText('1');
  await expect(page.getByTestId('seo-images-missing-alt')).toHaveText('0');

  await showPanel('overview');
  expect(Number(await score().textContent())).toBeGreaterThanOrEqual(90);
  await expect(score()).toHaveAttribute('data-band', 'good');
  await expect(page.getByTestId('seo-count-error')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('seo-count-warning')).toHaveAttribute('data-count', '0');
  await expect(railItem('on-page')).toHaveAttribute('data-status', 'pass');
});

test('bad-page-shows-issues', async () => {
  await audit(`${site.origin}/bad`);
  const ids = await issueIds();
  for (const id of ['title-missing', 'h1-multiple', 'images-missing-alt', 'robots-noindex']) expect(ids).toContain(id);
  // Errors rank first.
  expect(ids[0]).toBe('title-missing');
  expect(Number(await score().textContent())).toBeLessThan(60);
  await expect(score()).toHaveAttribute('data-band', 'poor');
  await expect(railItem('on-page')).toHaveAttribute('data-status', 'error');
  await expect(railItem('overview')).toHaveAttribute('data-status', 'error');

  // An issue expands to why it matters, how to fix it, and the offending values.
  const missingAlt = page.locator('[data-testid="seo-issue"][data-rule-id="images-missing-alt"]');
  await missingAlt.getByTestId('seo-issue-toggle').click();
  await expect(missingAlt.getByTestId('seo-issue-why')).toContainText('screen readers');
  await expect(missingAlt.getByTestId('seo-issue-fix')).toContainText('alt=""');
  await expect(missingAlt.getByTestId('seo-issue-samples')).toContainText(`${site.origin}/a.png`);
  await expect(missingAlt.getByTestId('seo-issue-facts')).toContainText('2 of 2');
});

test('spa-pushstate-reaudits', async () => {
  await audit(`${site.origin}/spa`);
  await expect(page.getByTestId('seo-fact-title-value')).toHaveText('SPA home route of the single page app');
  const id = await contentsIdAt(`${site.origin}/spa`);
  await run(id, `document.title = 'The pricing route, rendered by the app'; document.querySelector('h1').textContent = 'Pricing'; history.pushState({}, '', '/spa/pricing'); true`);
  // The new URL's audit replaces the old one; the old audit is never shown against it.
  await expect(page.getByTestId('seo-fact-url')).toHaveText(`${site.origin}/spa/pricing`, { timeout: AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 2_000 });
  await expect(page.getByTestId('seo-fact-title-value')).toHaveText('The pricing route, rendered by the app');
  await expect(page.getByTestId('seo-heading')).toHaveText(['H1Pricing']);
});

test('hostile-page-snapshot-is-bounded', async () => {
  const url = `${site.origin}/hostile`;
  const started = Date.now();
  await audit(url, 30_000);
  const elapsed = Date.now() - started;
  // Bounded: the full counts are reported, at most the caps are analysed.
  await expect(page.getByTestId('seo-links-total')).toHaveText(`First ${SNAPSHOT_LIMITS.maxLinks.toLocaleString('en-US')} of ${HOSTILE_LINKS.toLocaleString('en-US')} links analysed.`);
  await expect(page.getByTestId('seo-fact-title-length-count')).toHaveText(TEN_MB.toLocaleString('en-US'));
  await expect(page.getByTestId('seo-fact-title-length')).toHaveAttribute('data-indicator', 'long');
  expect((await page.getByTestId('seo-fact-title-value').textContent())!.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.maxTextChars);
  expect(Number(await page.getByTestId('seo-duration').getAttribute('data-ms'))).toBeLessThan(EXTRACT_TIMEOUT_MS);
  expect(elapsed).toBeLessThan(30_000);
  const ids = await issueIds();
  expect(ids).toContain('title-too-wide');
  // The page's main-world overrides never ran for the extractor (its isolated world has its own).
  const id = await contentsIdAt(url);
  expect(await run(id, 'window.__hits')).toBe(0);
  // …though they are live there: the page's own call is caught by them.
  expect(await run(id, `document.querySelectorAll('a').length + ':' + window.__hits`)).toBe(`${HOSTILE_LINKS}:1`);
  // The app stays responsive.
  const tabs = await strip().count();
  await menu('new-tab');
  await expect(strip()).toHaveCount(tabs + 1);
  await expect(page.getByTestId('seo-empty')).toBeVisible();
  await menu('close-tab');
  await expect(strip()).toHaveCount(tabs);
  await expect(page.getByTestId('ping')).toHaveText('pong');
});

test('deep-nested-anchors-is-bounded-not-timeout', async () => {
  const url = `${site.origin}/nested`;
  await audit(url);
  await expect(page.getByTestId('seo-links-total')).toContainText(`${NESTED_LINKS.toLocaleString('en-US')}`);
  expect(Number(await page.getByTestId('seo-duration').getAttribute('data-ms'))).toBeLessThan(EXTRACT_TIMEOUT_MS);
  await showPanel('overview');
  await expect(page.getByTestId('seo-unavailable')).toHaveCount(0);
});

test('cjk-page-is-not-thin', async () => {
  await audit(`${site.origin}/ja`);
  expect(Number((await page.getByTestId('seo-fact-words').textContent())!.replace(/,/g, ''))).toBeGreaterThan(300);
  expect(await issueIds()).not.toContain('content-thin');
});

test('wrapped-page-is-not-thin', async () => {
  await audit(`${site.origin}/wrapped`);
  // The wrapper's 420 words and its heading's count; the hidden wrapper's 50 do not.
  const count = Number((await page.getByTestId('seo-fact-words').textContent())!.replace(/,/g, ''));
  expect(count).toBeGreaterThanOrEqual(420);
  expect(count).toBeLessThan(470);
  expect(await issueIds()).not.toContain('content-thin');
});

test('noindex-page-is-not-indexable', async () => {
  await audit(`${site.origin}/googlebot-noindex`);
  await showPanel('overview');
  expect(Number(await score().textContent())).toBeLessThanOrEqual(NOINDEX_SCORE_CAP);
  await expect(score()).toHaveAttribute('data-band', 'poor');
  await expect(page.getByTestId('seo-band')).toHaveText(NOT_INDEXABLE_LABEL);
  await expect(page.getByTestId('seo-not-indexable')).toContainText('googlebot');
  const noindex = page.locator('[data-testid="seo-issue"][data-rule-id="robots-noindex"]');
  await noindex.getByTestId('seo-issue-toggle').click();
  await expect(noindex.getByTestId('seo-issue-facts')).toContainText('Meta robots (googlebot)');
});

test('page-text-is-inert-in-sidebar', async () => {
  await audit(`${site.origin}/inert`);
  const before = await sidebar().evaluate((root) => ({ img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, a: root.querySelectorAll('a').length }));
  expect(before).toEqual({ img: 0, script: 0, a: 0 });
  await expect(page.getByTestId('seo-fact-title-value')).toHaveText('<img src=x onerror="top.__pwned=1"> ‮evil');
  await expect(page.getByTestId('seo-heading')).toHaveText(['H1<script>top.__pwned=2</script> heading']);
  // Every issue expanded: their facts and samples are page text too.
  await issueIds();
  for (const toggle of await page.getByTestId('seo-issue-toggle').all()) await toggle.click();
  await expect(page.getByTestId('seo-issue-details').first()).toBeVisible();
  const after = await sidebar().evaluate((root) => ({
    img: root.querySelectorAll('img').length,
    script: root.querySelectorAll('script').length,
    a: root.querySelectorAll('a').length,
    iframe: root.querySelectorAll('iframe').length,
    style: root.querySelectorAll('[style]').length,
  }));
  expect(after).toEqual({ img: 0, script: 0, a: 0, iframe: 0, style: 0 });
  await expect(page.locator('[data-rule-id="links-javascript-href"]')).toContainText('<a href=javascript:alert(1)>click');
  // Nothing from the page ran in the chrome.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('busy-page-times-out-then-retries', async () => {
  await go(`${site.origin}/busy`);
  await expect(page.getByTestId('seo-unavailable')).toHaveAttribute('data-reason', 'timeout', { timeout: AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000 });
  await expect(page.getByTestId('seo-unavailable-message')).toHaveText(SEO_UNAVAILABLE_MESSAGES.timeout);
  // Once the page is idle again, Retry audits it.
  const id = await contentsIdAt(`${site.origin}/busy`);
  await expect.poll(() => run(id, '1'), { timeout: 15_000 }).toBe(1);
  await page.getByTestId('seo-retry').click();
  await showPanel('on-page');
  await expect(page.getByTestId('seo-fact-title-value')).toHaveText('A page that keeps its main thread busy');
});

test('narrow-window-keeps-page-usable', async () => {
  const url = `${site.origin}/guides/cold-brew`;
  await audit(url);
  // The chrome laid out 500 px wide (a window tiled beside another): the page keeps its minimum.
  await page.setViewportSize({ width: 500, height: 700 });
  try {
    await expect.poll(async () => (await viewBounds()).width).toBe(PAGE_MIN_WIDTH);
    await expect(page.getByTestId('seo-rail')).toBeVisible();
    const sidebarWidth = await sidebar().evaluate((el) => el.getBoundingClientRect().width);
    expect(sidebarWidth).toBeGreaterThanOrEqual(SIDEBAR_RAIL_WIDTH);
    expect(sidebarWidth).toBeLessThan(SIDEBAR_RAIL_WIDTH + SIDEBAR_PANEL_WIDTH);
    // A click in the page still lands.
    const id = await contentsIdAt(url);
    await run(id, `window.clicked = false; addEventListener('click', () => { window.clicked = true; }); true`);
    await realClick(id, 'h1');
    await expect.poll(() => run(id, 'window.clicked')).toBe(true);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.disableDeviceEmulation());
  }
});

test('sidebar-toggle-resizes-page', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-seo-profile-'));
  try {
    await closeApp(app);
    ({ app, page } = await launchApp([], { userDataDir: profile }));
    const url = `${site.origin}/guides/cold-brew`;
    await audit(url);
    const id = await contentsIdAt(url);
    const open = await viewBounds();
    const panel = page.getByTestId('seo-panel');

    // The toolbar button.
    await page.getByTestId('seo-toggle').click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('seo-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await viewBounds()).width).toBe(open.width + SIDEBAR_PANEL_WIDTH);
    // The persistent rail keeps the page's status.
    await expect(railItem('on-page')).toHaveAttribute('data-status', 'pass');
    // Collapsing from the panel's own button leaves focus on its rail item.
    await page.getByTestId('seo-toggle').click();
    await expect(panel).toBeVisible();
    await page.getByTestId('seo-collapse').click();
    await expect(panel).toHaveCount(0);
    await expect(railItem('on-page')).toBeFocused();

    // The View menu item (its accelerator, Mod+Shift+S).
    await menu(SIDEBAR_TOGGLE_MENU_ID);
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await viewBounds()).width).toBe(open.width);

    // The reserved shortcut, pressed in the page: taken before the page sees it.
    await run(id, `window.__keys = 0; addEventListener('keydown', () => { window.__keys += 1; }, true); true`);
    await press(id, 'S', ['mod', 'shift']);
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await viewBounds()).width).toBe(open.width + SIDEBAR_PANEL_WIDTH);
    expect(await run(id, 'window.__keys')).toBe(0);

    // Closed survives a relaunch on the same profile.
    await closeApp(app);
    ({ app, page } = await launchApp([], { userDataDir: profile }));
    await expect(sidebar()).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('seo-rail')).toBeVisible();
    await page.getByTestId('seo-toggle').click();
    await expect(sidebar()).toHaveAttribute('data-open', 'true');
  } finally {
    await closeApp(app);
    await rm(profile, { recursive: true, force: true });
  }
});
