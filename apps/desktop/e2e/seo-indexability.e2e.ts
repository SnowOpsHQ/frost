// Specs: specs/seo-indexability.spec.ts (ROBOTS_FETCH_LIMITS, INDEXABILITY_VERDICT_LABELS), specs/seo-rules.spec.ts
// (indexability and hreflang rules, NOT_INDEXABLE_RULES), specs/seo-snapshot.spec.ts (PageContextSchema)
// Acceptance: specs/seo-indexability.feature.md (End to end); review focus robots-fetch-is-bounded
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { INDEXABILITY_VERDICT_LABELS, ROBOTS_FETCH_LIMITS } from '@app/specs/seo-indexability.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
/** How long after its first audit a page's robots.txt fetch may still settle (its own deadline). */
const ROBOTS_SETTLE_WAIT = ROBOTS_FETCH_LIMITS.timeoutMs + 2_000;

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
const html = (title: string, head: string, body = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page used to check what frost says about whether it can be indexed."><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body><h1>${title}</h1><p>${words(320)}</p>${body}</body></html>`;

type Route = (request: IncomingMessage, response: ServerResponse, origin: string) => void;

/** A loopback site of its own (its own origin, so its robots.txt is fetched afresh): `routes` by path, a log of every request. */
async function startSite(routes: Record<string, Route>) {
  const seen: { path: string; cookie: string | undefined; userAgent: string | undefined }[] = [];
  let origin = '';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    seen.push({ path: pathname, cookie: request.headers.cookie, userAgent: request.headers['user-agent'] });
    const route = routes[pathname];
    if (route) route(request, response, origin);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    seen,
    requestsFor: (path: string) => seen.filter((entry) => entry.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
type Site = Awaited<ReturnType<typeof startSite>>;

const page200 = (head = '', body = '', headers: Record<string, string> = {}): Route => (_request, response, origin) =>
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(html('A loopback page about indexability checks', head.replaceAll('{origin}', origin), body));
const text = (body: string | ((origin: string) => string), status = 200): Route => (_request, response, origin) =>
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(typeof body === 'string' ? body : body(origin));

let app: ElectronApplication;
let page: Page;
const sites: Site[] = [];
const { go, strip, contentsIdAt } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const verdict = () => page.getByTestId('seo-index-verdict');
const issueIds = () => page.locator('[data-testid="seo-index-issues"] [data-testid="seo-issue"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));
const agent = (name: string) => page.locator(`[data-testid="seo-index-robots-agent"][data-agent="${name}"]`);
const sidebarElements = () =>
  sidebar().evaluate((root) => ({ img: root.querySelectorAll('img').length, script: root.querySelectorAll('script').length, a: root.querySelectorAll('a').length, style: root.querySelectorAll('[style]').length }));

async function site(routes: Record<string, Route>): Promise<Site> {
  const started = await startSite(routes);
  sites.push(started);
  return started;
}

/** Loads `url`, opens Indexability and waits for the audit of `shown` (the URL the tab ends at). */
async function audit(url: string, { shown = url, timeout = AUDIT_WAIT, settled = true }: { shown?: string; timeout?: number; settled?: boolean } = {}): Promise<void> {
  await go(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'indexability') await railItem('indexability').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'indexability');
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${shown}⁩`, { timeout });
  await expect(verdict()).toBeVisible({ timeout });
  // The first audit of an origin may come before its robots.txt: wait for the second (unless asked not to).
  if (settled) await expect(page.getByTestId('seo-index-robots-pending')).toHaveCount(0, { timeout: ROBOTS_SETTLE_WAIT });
}

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  for (const started of sites) await started.close();
});

test('indexable-page-e2e', async () => {
  const s = await site({
    '/robots.txt': text((origin) => `User-agent: *\nDisallow: /private/\n\nSitemap: ${origin}/sitemap.xml\n`),
    '/page': page200('<link rel="canonical" href="{origin}/page"><link rel="alternate" hreflang="en" href="{origin}/page"><link rel="alternate" hreflang="x-default" href="{origin}/page">'),
    '/sitemap.xml': text('<urlset></urlset>'),
  });
  const url = `${s.origin}/page`;
  await audit(url);
  await expect(verdict()).toHaveAttribute('data-verdict', 'indexable');
  await expect(page.getByTestId('seo-index-verdict-label')).toHaveText(INDEXABILITY_VERDICT_LABELS.indexable);
  await expect(railItem('indexability')).toHaveAttribute('data-status', 'pass');
  expect(await issueIds()).toEqual([]);
  await expect(page.getByTestId('seo-index-status')).toHaveText('200 OK');
  await expect(page.getByTestId('seo-index-signal-http')).toHaveAttribute('data-tone', 'ok');
  await expect(page.locator('[data-testid="seo-index-header"][data-name="content-type"]')).toContainText('text/html; charset=utf-8');
  await expect(page.getByTestId('seo-index-canonical-state')).toHaveText('Points to this page');
  // robots.txt: fetched, every crawler allowed by the `*` group, the sitemap listed.
  await expect(page.getByTestId('seo-index-robots-outcome')).toContainText('Fetched · 200');
  for (const name of ['Googlebot', 'Bingbot', '*']) await expect(agent(name)).toHaveAttribute('data-allowed', 'true');
  await expect(agent('Googlebot')).toContainText('User-agent: * (fallback)');
  await expect(page.getByTestId('seo-index-sitemap')).toHaveText(new RegExp(`${s.origin}/sitemap.xml`));
  await expect(page.getByTestId('seo-index-hreflang-row')).toHaveCount(2);
  // Open the sitemap: a background tab, the page stays.
  const tabs = await strip().count();
  await page.getByTestId('seo-index-open-sitemap').click();
  await expect(strip()).toHaveCount(tabs + 1);
  await contentsIdAt(`${s.origin}/sitemap.xml`);
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`);
  expect(await sidebarElements()).toEqual({ img: 0, script: 0, a: 0, style: 0 });
});

test('x-robots-noindex-header-e2e', async () => {
  const s = await site({ '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://example.com/s.xml\n'), '/page': page200('<link rel="canonical" href="{origin}/page">', '', { 'X-Robots-Tag': 'noindex, nofollow' }) });
  await audit(`${s.origin}/page`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'not-indexable');
  await expect(page.getByTestId('seo-index-verdict-label')).toHaveText(INDEXABILITY_VERDICT_LABELS['not-indexable']);
  await expect(page.getByTestId('seo-index-reason')).toHaveText(['The X-Robots-Tag header asks not to index it (all crawlers)']);
  expect(await issueIds()).toEqual(expect.arrayContaining(['x-robots-noindex', 'x-robots-nofollow']));
  await expect(page.getByTestId('seo-index-xrobots')).toContainText('noindex, nofollow');
  await expect(page.locator('[data-testid="seo-index-header"][data-name="x-robots-tag"]')).toHaveCount(1);
  await expect(railItem('indexability')).toHaveAttribute('data-status', 'warn');
  // The Overview card says why, and the score is capped.
  await railItem('overview').click();
  await expect(page.getByTestId('seo-band')).toHaveText('Not indexable');
  await expect(page.getByTestId('seo-not-indexable')).toContainText('X-Robots-Tag');
});

test('robots-disallow-e2e', async () => {
  const s = await site({ '/robots.txt': text('# keep crawlers out of drafts\nUser-agent: *\nDisallow: /drafts/\n'), '/drafts/post': page200('<link rel="canonical" href="{origin}/drafts/post">') });
  await audit(`${s.origin}/drafts/post`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'not-indexable');
  await expect(page.getByTestId('seo-index-reason')).toHaveText(['robots.txt blocks Googlebot (line 3: Disallow: /drafts/)']);
  expect(await issueIds()).toEqual(expect.arrayContaining(['robots-txt-blocks-googlebot', 'robots-txt-no-sitemap']));
  await expect(railItem('indexability')).toHaveAttribute('data-status', 'error');
  await expect(agent('Googlebot')).toHaveAttribute('data-allowed', 'false');
  await expect(agent('Googlebot').getByTestId('seo-index-robots-rule')).toHaveText('Line 3 · Disallow: /drafts/');
  // View robots.txt: the file as text.
  await page.getByTestId('seo-index-view-robots').click();
  expect(await page.getByTestId('seo-index-robots-text').evaluate((pre) => pre.textContent)).toBe('# keep crawlers out of drafts\nUser-agent: *\nDisallow: /drafts/\n');
  // Fetched once by main (cached for the origin), with no cookie and frost's usual user agent.
  expect(s.requestsFor('/robots.txt')).toHaveLength(1);
  // Open robots.txt: in a background tab (which loads it once more, as a page).
  const tabs = await strip().count();
  await page.getByTestId('seo-index-open-robots').click();
  await expect(strip()).toHaveCount(tabs + 1);
  await contentsIdAt(`${s.origin}/robots.txt`);
  await expect.poll(() => s.requestsFor('/robots.txt').length).toBe(2);
});

test('redirect-chain-e2e', async () => {
  const s = await site({
    '/robots.txt': text('User-agent: *\nAllow: /\n'),
    '/old': (_request, response) => response.writeHead(301, { Location: '/new' }).end(),
    '/new': page200('<link rel="canonical" href="{origin}/new">'),
  });
  await audit(`${s.origin}/old`, { shown: `${s.origin}/new` });
  await expect(page.getByTestId('seo-index-status')).toHaveText('200 OK');
  await expect(page.getByTestId('seo-index-hop')).toHaveCount(1);
  await expect(page.getByTestId('seo-index-hop')).toContainText('301');
  await expect(page.getByTestId('seo-index-hop')).toContainText(`${s.origin}/old`);
  await expect(page.getByTestId('seo-index-final')).toContainText(`${s.origin}/new`);
  // One redirect is fine; the page is indexable.
  await expect(verdict()).toHaveAttribute('data-verdict', 'indexable');
  expect(await issueIds()).not.toContain('http-redirect-chain');
});

test('not-found-e2e', async () => {
  const s = await site({
    '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://example.com/s.xml\n'),
    '/missing': (_request, response) => response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(html('This page could not be found anywhere here', '')),
  });
  await audit(`${s.origin}/missing`);
  await expect(page.getByTestId('seo-index-status')).toHaveText('404 Not Found');
  await expect(verdict()).toHaveAttribute('data-verdict', 'not-indexable');
  await expect(page.getByTestId('seo-index-reason')).toHaveText(['The server answered HTTP 404']);
  expect(await issueIds()).toContain('http-status-client-error');
  await expect(page.getByTestId('seo-index-signal-http')).toHaveAttribute('data-tone', 'error');
});

test('robots-fetch-is-bounded-e2e', async () => {
  test.setTimeout(120_000);
  // A 3 MB robots.txt: read up to 500 KiB, the rest ignored.
  const big = await site({
    '/robots.txt': (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('User-agent: *\nDisallow: /secret\n');
      for (let i = 0; i < 30; i++) response.write(`# ${'x'.repeat(100_000)}\n`);
      response.end('Disallow: /page\n');
    },
    '/page': page200(),
  });
  await audit(`${big.origin}/page`);
  await expect(page.getByTestId('seo-index-robots-outcome')).toHaveText('Fetched · 200 · 500 KiB (cut at the limit)');
  // The rule past the cap was never read.
  await expect(agent('Googlebot')).toHaveAttribute('data-allowed', 'true');
  await page.getByTestId('seo-index-view-robots').click();
  await expect(page.getByTestId('seo-index-robots-cut')).toContainText('over 500 KiB (512,000 bytes)');

  // A robots.txt that redirects off-origin to a non-web address: never followed.
  const away = await site({ '/robots.txt': (_request, response) => response.writeHead(302, { Location: 'file:///etc/passwd' }).end(), '/page': page200() });
  await audit(`${away.origin}/page`);
  await expect(page.getByTestId('seo-index-robots-outcome')).toHaveText('Redirects to a non-web address · 302');
  for (const name of ['Googlebot', 'Bingbot', '*']) await expect(agent(name)).toHaveAttribute('data-allowed', 'null');
  expect(await issueIds()).toContain('robots-txt-unreachable');
  expect(away.requestsFor('/robots.txt')).toHaveLength(1);

  // One that never answers: the audit does not wait for it. Every other check is ready while the
  // robots.txt card says it is fetching, and the verdict is pending; then it gives up at the deadline.
  const hung: ServerResponse[] = [];
  const slow = await site({ '/robots.txt': (_request, response) => void hung.push(response), '/page': page200() });
  const started = Date.now();
  await audit(`${slow.origin}/page`, { settled: false });
  await expect(page.getByTestId('seo-index-robots-pending')).toBeVisible();
  await expect(page.getByTestId('seo-index-robots-outcome')).toHaveText('Fetching robots.txt…');
  await expect(verdict()).toHaveAttribute('data-verdict', 'pending');
  await expect(page.getByTestId('seo-index-status')).toHaveText('200 OK');
  await railItem('on-page').click();
  await expect(page.getByTestId('seo-fact-url')).toHaveText(`${slow.origin}/page`);
  await railItem('overview').click();
  await expect(page.getByTestId('seo-score')).toBeVisible();
  // All of that before the robots.txt deadline.
  expect(Date.now() - started).toBeLessThan(ROBOTS_FETCH_LIMITS.timeoutMs);
  await railItem('indexability').click();
  await expect(page.getByTestId('seo-index-robots-outcome')).toHaveText('Timed out', { timeout: ROBOTS_SETTLE_WAIT });
  await expect(verdict()).toHaveAttribute('data-verdict', 'indexable');
  expect(await issueIds()).toContain('robots-txt-unreachable');
  for (const response of hung) response.destroy();
});

test('hreflang-errors-e2e', async () => {
  const s = await site({
    '/robots.txt': text('User-agent: *\nAllow: /\nSitemap: https://example.com/s.xml\n'),
    '/page': page200(
      '<link rel="canonical" href="{origin}/page"><link rel="alternate" hreflang="en-UK" href="{origin}/uk/"><link rel="alternate" hreflang="en_US" href="{origin}/us/">' +
        '<link rel="alternate" hreflang="de" href="{origin}/de/"><link rel="alternate" hreflang="DE" href="{origin}/de-2/"><link rel="alternate" hreflang="fr" href="/fr/">',
    ),
  });
  await audit(`${s.origin}/page`);
  expect(await issueIds()).toEqual(expect.arrayContaining(['hreflang-invalid-code', 'hreflang-missing-self', 'hreflang-duplicate', 'hreflang-relative-url', 'hreflang-no-x-default']));
  await expect(railItem('indexability')).toHaveAttribute('data-status', 'error');
  await expect(page.getByTestId('seo-index-hreflang-row')).toHaveCount(5);
  await expect(page.locator('[data-testid="seo-index-hreflang-row"][data-value="en-UK"] [data-flag="invalid"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="seo-index-hreflang-row"][data-value="DE"] [data-flag="duplicate"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="seo-index-hreflang-row"][data-value="fr"] [data-flag="relative"]')).toHaveCount(1);
  // Errors in hreflang alone never make the page "Not indexable".
  await expect(verdict()).toHaveAttribute('data-verdict', 'indexable');
});

test('robots-fetch-sends-no-cookies-e2e', async () => {
  const s = await site({
    '/robots.txt': text('User-agent: *\nAllow: /\n'),
    '/login': (_request, response) => response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=secret-session; Path=/; HttpOnly' }).end(html('Signed in to the loopback site for this check', '')),
    '/page': page200(),
  });
  // The origin sets a cookie, and the page's own requests carry it …
  await go(`${s.origin}/login`);
  await expect
    .poll(() => app.evaluate(({ session }, url) => session.fromPartition('persist:frost-browser').cookies.get({ url }).then((cookies) => cookies.map((c) => c.name)), s.origin))
    .toEqual(['sid']);
  await audit(`${s.origin}/page`);
  expect(s.requestsFor('/page').at(-1)?.cookie).toBe('sid=secret-session');
  // … but main's robots.txt fetch carries none.
  await expect.poll(() => s.requestsFor('/robots.txt').length).toBeGreaterThan(0);
  for (const request of s.requestsFor('/robots.txt')) expect(request.cookie).toBeUndefined();
  await expect(page.getByTestId('seo-index-robots-outcome')).toContainText('Fetched');
});
