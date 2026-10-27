// Specs: specs/seo-javascript.spec.ts (SERVED_ACCEPT, SERVED_FETCH_LIMITS, JS_VERDICT_LABELS), specs/fetcher.spec.ts,
// specs/seo-sidebar.spec.ts (SEO_PANELS)
// Acceptance: specs/seo-javascript.feature.md (End to end); review focus served-html-is-bounded
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { SERVED_ACCEPT, SERVED_FETCH_LIMITS } from '@app/specs/seo-javascript.spec';
import { ANALYSIS_TIMEOUT_MS, AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
/** How long after its first audit the served HTML may still arrive (its own deadline and the parse). */
const SERVED_WAIT = SERVED_FETCH_LIMITS.timeoutMs + ANALYSIS_TIMEOUT_MS + AUDIT_WAIT;

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 40}`).join(' ');
const HEAD = '<meta charset="utf-8"><meta name="description" content="A loopback page used to compare the served HTML with the page after JavaScript runs."><meta name="viewport" content="width=device-width, initial-scale=1">';

/** Title, canonical, links and most of the text are added by JavaScript. */
const INJECTED = `<!doctype html><html lang="en"><head>${HEAD}<title>Loading the app</title></head>
<body><div id="app"><a href="/about">About</a></div>
<script>
  document.title = 'The rendered title of a JavaScript app';
  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = '/canonical-from-js';
  document.head.append(canonical);
  const app = document.getElementById('app');
  for (const path of ['/js-one', '/js-two', '/js-three']) {
    const a = document.createElement('a');
    a.href = path;
    a.textContent = 'Link ' + path;
    app.append(a);
  }
  const h1 = document.createElement('h1');
  h1.textContent = 'Built in the browser';
  const p = document.createElement('p');
  p.textContent = ${JSON.stringify(words(400))};
  app.append(h1, p);
</script></body></html>`;

/** The same page served and rendered. */
const STATIC = `<!doctype html><html lang="en"><head>${HEAD}<title>A static page that needs no JavaScript at all</title><link rel="canonical" href="/static"></head>
<body><h1>Static</h1><p>${words(320)}</p><a href="/about">About</a></body></html>`;

type Route = (request: IncomingMessage, response: ServerResponse) => void;
const html =
  (body: string, headers: Record<string, string> = {}): Route =>
  (_request, response) =>
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(body);

/** 50 MB of markup, streamed: a title, then a comment that never ends within the cap. */
const HUGE: Route = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.write(`<!doctype html><html lang="en"><head>${HEAD}<title>A fifty megabyte page</title></head><body><h1>Huge</h1><p>${words(320)}</p><!--`);
  const chunk = 'x'.repeat(1024 * 1024);
  let sent = 0;
  const pump = () => {
    while (sent < 50) {
      sent += 1;
      if (!response.write(chunk)) {
        response.once('drain', pump);
        return;
      }
    }
    response.end('--></body></html>');
  };
  pump();
};

/** 100,000 nested elements. */
const DEEP = html(`<!doctype html><html lang="en"><head>${HEAD}<title>A deeply nested page</title></head><body>${'<div>'.repeat(100_000)}deep${'</div>'.repeat(100_000)}</body></html>`);

async function startSite(routes: Record<string, Route>) {
  const seen: { path: string; cookie: string | undefined; userAgent: string | undefined; accept: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    seen.push({ path: pathname, cookie: request.headers.cookie, userAgent: request.headers['user-agent'], accept: request.headers.accept });
    const route = routes[pathname];
    if (route) route(request, response);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** The served-HTML fetches of `path` (frost's own `Accept`, not the tab's navigation). */
    servedFetches: (path: string) => seen.filter((entry) => entry.path === path && entry.accept === SERVED_ACCEPT),
    pageLoads: (path: string) => seen.filter((entry) => entry.path === path && entry.accept !== SERVED_ACCEPT),
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
const { go } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const jsState = () => page.getByTestId('seo-js-state');
const field = (id: string) => page.locator(`[data-testid="seo-js-field"][data-field="${id}"]`);
const issueIds = () => page.locator('[data-testid="seo-js-issues"] [data-testid="seo-issue"]').evaluateAll((items) => items.map((item) => `${item.getAttribute('data-rule-id')}:${item.getAttribute('data-severity')}`));

/** Loads `url`, opens the JavaScript panel and waits for its audit, and for the comparison to leave `pending`. */
async function openJavascript(url: string): Promise<void> {
  await go(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'javascript') await railItem('javascript').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'javascript');
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(jsState()).not.toHaveAttribute('data-state', 'pending', { timeout: SERVED_WAIT });
}

test.beforeAll(async () => {
  site = await startSite({
    '/injected': html(INJECTED),
    '/static': html(STATIC),
    '/huge': HUGE,
    '/deep': DEEP,
    '/set-cookie': html(STATIC, { 'Set-Cookie': 'frost_session=secret-value; Path=/; SameSite=Lax' }),
    '/after-cookie': html(STATIC),
    '/ua': html(STATIC),
  });
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test('js-injected-title-canonical-links', async () => {
  const url = `${site.origin}/injected`;
  await openJavascript(url);
  await expect(jsState()).toHaveAttribute('data-state', 'ready');
  await expect(jsState()).toHaveAttribute('data-js-verdict', 'heavily');
  await expect(field('title')).toHaveAttribute('data-status', 'changed');
  await expect(field('title').getByTestId('seo-js-served-value')).toContainText('Loading the app');
  await expect(field('title').getByTestId('seo-js-rendered-value')).toContainText('The rendered title of a JavaScript app');
  await expect(field('canonical')).toHaveAttribute('data-status', 'only-rendered');
  await expect(field('h1')).toHaveAttribute('data-status', 'only-rendered');
  await expect(page.getByTestId('seo-js-links-added')).toHaveAttribute('data-total', '3');
  await expect(page.getByTestId('seo-js-links-added').getByTestId('seo-js-item')).toHaveCount(3);
  await expect.poll(issueIds).toEqual(expect.arrayContaining(['js-canonical-changed:warning', 'js-title-changed:info', 'js-links-added:info', 'js-content-added:info']));
  // Sites can see the request; the panel says so.
  await expect(page.getByTestId('seo-js-disclosure')).toContainText('The site can see these requests');
  // One served fetch for the document, however many times it was analysed.
  expect(site.servedFetches('/injected')).toHaveLength(1);
  // Page text stays text.
  expect(await page.getByTestId('seo-javascript').evaluate((root) => ({ a: root.querySelectorAll('a').length, script: root.querySelectorAll('script').length }))).toEqual({ a: 0, script: 0 });
});

test('js-identical-page', async () => {
  await openJavascript(`${site.origin}/static`);
  await expect(jsState()).toHaveAttribute('data-state', 'identical');
  await expect(page.getByTestId('seo-js-verdict')).toHaveText('JS-independent');
  await expect(page.locator('[data-testid="seo-js-field"]:not([data-status="same"])')).toHaveCount(0);
  await expect(page.locator('[data-testid="seo-js-issues"] [data-testid="seo-issue"]')).toHaveCount(0);
  // A reload is a new document: the served HTML is fetched again.
  const before = site.servedFetches('/static').length;
  await page.getByTestId('reload').click();
  await expect.poll(() => site.servedFetches('/static').length, { timeout: SERVED_WAIT }).toBeGreaterThan(before);
});

test('served-html-is-bounded', async () => {
  test.setTimeout(120_000);
  // 50 MB: the fetch reads about 5 MB and the comparison says it is partial.
  await openJavascript(`${site.origin}/huge`);
  await expect(jsState()).toHaveAttribute('data-state', /ready|identical/);
  await expect(page.getByTestId('seo-js-partial')).toBeVisible();
  await expect(page.getByTestId('seo-js-fetch')).toContainText('(cut)');
  // A partial page checks no rule.
  await expect(page.locator('[data-testid="seo-js-issues"] [data-testid="seo-issue"]')).toHaveCount(0);
  // Deep nesting: parsed up to the cap (partial) or given up on (unavailable), never a hang.
  await openJavascript(`${site.origin}/deep`);
  await expect(jsState()).toHaveAttribute('data-state', /ready|identical|unavailable/);
  if ((await jsState().getAttribute('data-state')) !== 'unavailable') await expect(page.getByTestId('seo-js-partial')).toBeVisible();
  else await expect(jsState()).toHaveAttribute('data-reason', /parse-timeout|parse-failed/);
  // The app stays responsive: main answers at once, and the next page is audited and compared.
  const started = Date.now();
  expect(await app.evaluate(() => 1 + 1)).toBe(2);
  expect(Date.now() - started).toBeLessThan(2_000);
  await openJavascript(`${site.origin}/static`);
  await expect(jsState()).toHaveAttribute('data-state', 'identical');
});

test('served-fetch-sends-no-cookies', async () => {
  await openJavascript(`${site.origin}/set-cookie`);
  await openJavascript(`${site.origin}/after-cookie`);
  // The tab's own navigation carries the cookie; frost's served fetch does not.
  expect(site.pageLoads('/after-cookie').some((entry) => entry.cookie?.includes('frost_session=secret-value'))).toBe(true);
  await expect.poll(() => site.servedFetches('/after-cookie').length).toBeGreaterThan(0);
  for (const entry of [...site.servedFetches('/after-cookie'), ...site.servedFetches('/set-cookie')]) expect(entry.cookie).toBeUndefined();
});

/** Sets a profile through the editor bar, as the user does, and closes the bar. */
async function applyProfile(options: { device?: string; userAgent?: string }): Promise<void> {
  if (!(await page.getByTestId('render-profile-bar').isVisible())) await page.getByTestId('render-profile-toggle').click();
  const bar = page.getByTestId('render-profile-bar');
  await expect(bar).toBeVisible();
  if (options.device) await bar.getByTestId('render-device').selectOption(options.device);
  if (options.userAgent) await bar.getByTestId('render-user-agent').selectOption(options.userAgent);
  await bar.getByTestId('render-apply').click();
  await page.getByTestId('render-profile-close').click();
  await expect(bar).toBeHidden();
}

test('served-fetch-uses-profile-user-agent', async () => {
  const url = `${site.origin}/ua`;
  await openJavascript(url);
  // frost's own user agent first.
  expect(site.servedFetches('/ua').at(-1)?.userAgent).not.toContain('Googlebot');
  await expect(page.getByTestId('seo-js-user-agent')).toContainText('frost’s own user agent');
  await applyProfile({ userAgent: 'googlebot-smartphone' });
  const before = site.servedFetches('/ua').length;
  await page.getByTestId('seo-js-refetch').click();
  await expect.poll(() => site.servedFetches('/ua').length, { timeout: SERVED_WAIT }).toBeGreaterThan(before);
  expect(site.servedFetches('/ua').at(-1)?.userAgent).toContain('Googlebot');
  await expect(jsState()).not.toHaveAttribute('data-state', 'pending', { timeout: SERVED_WAIT });
  await expect(page.getByTestId('seo-js-user-agent')).toContainText('Googlebot', { timeout: SERVED_WAIT });
});
