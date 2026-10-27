// Specs: specs/seo-checks.spec.ts (LINK_CHECK_LIMITS, HEAD_FALLBACK_STATUSES, SITEMAP_LIMITS, HREFLANG_CHECK_LIMITS,
// CHECKS_VISIBILITY_NOTICE, CHECKS_RULE_SPECS), specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES: broken),
// specs/seo-limits.spec.ts (SEO_WORLD_ID)
// Acceptance: specs/seo-checks.feature.md (End to end); review focus link-checks-are-bounded
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CHECKS_VISIBILITY_NOTICE, SITEMAP_LIMITS, SITEMAP_NAMESPACE } from '@app/specs/seo-checks.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS, SEO_WORLD_ID } from '@app/specs/seo-limits.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/**
 * Public-looking names for the loopback server (`--host-resolver-rules`): a page on them is not
 * private, so its links to 127.0.0.1 must be refused. Each has its own robots.txt.
 */
const SITE_HOST = 'checks.frost-e2e.net';
const BOMB_HOST = 'bombs.frost-e2e.net';
/**
 * A public-looking name that resolves to the loopback server but is not exempted from the bounded
 * fetcher's DNS check (`E2E_PUBLIC_HOSTS_SWITCH` names only the two above): like a public name that
 * points at a private address, it is refused (Phase 2.5 Task 2 review).
 */
const LAN_HOST = 'lan.frost-e2e.net';
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const CHECK_WAIT = 30_000;
/** How long a `/slow/…` answer takes. */
const SLOW_MS = 3_000;

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');
const html = (title: string, head: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page frost runs its link, sitemap and hreflang checks on."><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body><h1>${title}</h1><p>${words(320)}</p>${body}</body></html>`;
const xml = (root: 'urlset' | 'sitemapindex', entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${SITEMAP_NAMESPACE}">${entries.join('')}</${root}>`;
const urlEntry = (loc: string) => `<url><loc>${loc}</loc><lastmod>2026-01-01</lastmod></url>`;
const sitemapEntry = (loc: string) => `<sitemap><loc>${loc}</loc></sitemap>`;

type Seen = { host: string; path: string; method: string; cookie: string | undefined };

async function startSite() {
  const seen: Seen[] = [];
  let port = 0;
  // 60 MB of zeros: about 60 KB compressed.
  const bomb = gzipSync(Buffer.alloc(SITEMAP_LIMITS.maxBytes + 10 * 1024 * 1024));
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = (request.headers.host ?? '').split(':')[0]!;
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    seen.push({ host, path, method: request.method ?? '', cookie: request.headers.cookie });
    const origin = `http://${host}:${port}`;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => response.writeHead(status, { 'Content-Type': type, ...headers }).end(request.method === 'HEAD' ? undefined : body);
    const page = (title: string, head: string, body: string, headers: Record<string, string> = {}) => send(200, 'text/html; charset=utf-8', html(title, head, body), headers);
    if (host === BOMB_HOST) {
      if (path === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nAllow: /\nSitemap: ${origin}/bomb.xml.gz\nSitemap: ${origin}/encoded.xml\n`);
      if (path === '/bomb.xml.gz') return send(200, 'application/gzip', bomb);
      if (path === '/encoded.xml') return send(200, 'application/xml', bomb, { 'Content-Encoding': 'gzip' });
      return page('A page whose sitemaps are gzip bombs', '', '<a href="/">Home</a>');
    }
    switch (path) {
      case '/robots.txt':
        return send(200, 'text/plain', `User-agent: *\nDisallow: /blocked/\n\nSitemap: ${origin}/sitemap_index.xml\n`);
      case '/links':
        return page(
          'A page with links of every kind',
          '',
          `<ul><li><a href="/ok">OK</a></li><li><a href="/redirect">Moved</a></li><li><a href="/missing">Missing</a></li><li><a href="/nohead">No HEAD</a></li><li><a href="/blocked/x">Blocked</a></li><li><a href="mailto:tea@example.com">Mail</a></li></ul>`,
          { 'Set-Cookie': 'session=secret-value; Path=/' },
        );
      case '/cookie-links':
        return page('A page that sets a cookie', '', '<a href="/fresh/a">A</a> <a href="/fresh/b">B</a>', { 'Set-Cookie': 'session=secret-value; Path=/' });
      case '/private-links':
        return page('A public page linking to private addresses', '', `<a href="http://127.0.0.1:${port}/secret">Router</a> <a href="http://localhost:${port}/secret-too">Local</a> <a href="http://${LAN_HOST}:${port}/secret-name">LAN</a> <a href="/ok">OK</a>`);
      case '/slow-links':
        return page('A page whose links answer slowly', '', Array.from({ length: 12 }, (_, i) => `<a href="/slow/${i}">Slow ${i}</a>`).join(' '));
      case '/ok':
        return send(200, 'text/plain', 'ok');
      case '/redirect':
        return send(301, 'text/plain', '', { Location: '/ok' });
      case '/nohead':
        return request.method === 'HEAD' ? send(405, 'text/plain', '', { Allow: 'GET' }) : send(200, 'text/plain', 'x'.repeat(100_000));
      case '/sitemap_index.xml':
        return send(200, 'application/xml', xml('sitemapindex', [sitemapEntry(`${origin}/sitemap-pages.xml`), sitemapEntry(`${origin}/sitemap-posts.xml.gz`)]));
      case '/sitemap-pages.xml':
        return send(200, 'application/xml', xml('urlset', [urlEntry(`${origin}/listed`), urlEntry(`${origin}/links`)]));
      case '/sitemap-posts.xml.gz':
        return send(200, 'application/gzip', gzipSync(xml('urlset', [urlEntry(`${origin}/posts/1`), urlEntry(`${origin}/posts/2`)])));
      case '/listed':
        return page('A page the sitemap lists', '', '<a href="/ok">OK</a>');
      case '/unlisted':
        return page('A page no sitemap lists', '', '<a href="/ok">OK</a>');
      case '/en':
        return page('English page with alternates', `<link rel="alternate" hreflang="en" href="${origin}/en"><link rel="alternate" hreflang="de" href="${origin}/de"><link rel="alternate" hreflang="fr" href="${origin}/fr">`, '');
      case '/de':
        return page('German page that links back', `<link rel="alternate" hreflang="de" href="${origin}/de"><link rel="alternate" hreflang="en" href="${origin}/en">`, '');
      case '/fr':
        return page('French page that does not link back', `<link rel="alternate" hreflang="fr" href="${origin}/fr">`, '');
      default:
        if (path.startsWith('/slow/')) {
          const timer = setTimeout(() => send(200, 'text/plain', 'late'), SLOW_MS);
          response.on('close', () => clearTimeout(timer));
          return;
        }
        return send(404, 'text/plain', 'not here');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    origin: `http://${SITE_HOST}:${port}`,
    bombOrigin: `http://${BOMB_HOST}:${port}`,
    port,
    seen,
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
const { go, contentsIdAt, closeAllTabs } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const row = (path: string) => page.locator('[data-testid="seo-link-row"]', { has: page.getByTestId('seo-link-href').filter({ hasText: new RegExp(`${path.replace(/[/.]/g, '\\$&')}$`) }) });
const issueIds = (scope: string) => page.locator(`${scope} [data-testid="seo-issue"]`).evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));

/** Loads `url`, opens `panel` and waits for the audit of `url`. */
async function audited(url: string, panel: 'links' | 'indexability'): Promise<number> {
  await go(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  return contentsIdAt(url);
}

/** The highlight overlay's mode and labels, read in the SEO isolated world. */
const overlay = (id: number) =>
  app.evaluate(
    ({ webContents }, { id, world }) =>
      webContents.fromId(id)!.executeJavaScriptInIsolatedWorld(world, [{ code: `(() => { const s = globalThis.__frostSeoHighlight; return s ? { mode: s.mode, boxes: s.boxes(), kinds: [...s.root.children].map((b) => b.textContent) } : null; })()` }]) as Promise<{ mode: string; boxes: number; kinds: string[] } | null>,
    { id, world: SEO_WORLD_ID },
  );

/** What the checks asked the server for (not the browser's own page loads). */
const checkRequests = (paths: readonly string[]) => site.seen.filter((entry) => paths.includes(entry.path));

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP ${BOMB_HOST} 127.0.0.1, MAP ${LAN_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST},${BOMB_HOST}`]));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await closeAllTabs();
});

test('link-check-statuses-e2e', async () => {
  const id = await audited(`${site.origin}/links`, 'links');
  await expect(page.getByTestId('seo-link-checks-notice')).toHaveText(CHECKS_VISIBILITY_NOTICE);
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'idle');
  // Nothing is fetched until asked.
  expect(checkRequests(['/ok', '/redirect', '/missing', '/nohead'])).toEqual([]);
  await page.getByTestId('seo-link-checks-start').click();
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  await expect(row('/ok')).toHaveAttribute('data-status', 'ok');
  await expect(row('/redirect')).toHaveAttribute('data-status', 'redirect');
  await expect(row('/missing')).toHaveAttribute('data-status', 'broken');
  await expect(row('/missing').getByTestId('seo-link-status')).toHaveText('404 Broken');
  await expect(row('/nohead')).toHaveAttribute('data-status', 'ok');
  await expect(row('/blocked/x')).toHaveAttribute('data-status', 'blocked');
  await expect(row('tea@example.com')).toHaveAttribute('data-status', 'skipped');
  // HEAD first; 405 → GET. robots.txt's disallowed link is never asked for.
  expect(checkRequests(['/nohead']).map((entry) => entry.method)).toEqual(['HEAD', 'GET']);
  expect(checkRequests(['/ok', '/missing']).map((entry) => entry.method)).toEqual(expect.arrayContaining(['HEAD']));
  expect(checkRequests(['/blocked/x'])).toEqual([]);
  // The finished check re-scores the audit: the broken link is an issue.
  await expect.poll(() => issueIds('[data-testid="seo-links"]'), { timeout: AUDIT_WAIT }).toEqual(expect.arrayContaining(['links-broken']));
  // Broken only.
  await page.getByTestId('seo-links-broken-only').click();
  await expect(page.getByTestId('seo-links-shown')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('seo-link-row')).toHaveCount(1);
  await page.getByTestId('seo-links-broken-only').click();
  // The broken highlight outlines the one broken link.
  await page.getByTestId('seo-highlight-broken').click();
  await expect(page.getByTestId('seo-highlight-broken')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => overlay(id)).toEqual({ mode: 'broken', boxes: 1, kinds: ['broken'] });
  await page.getByTestId('seo-highlight-broken').click();
  await expect.poll(() => overlay(id)).toBeNull();
});

test('link-check-private-refused-e2e', async () => {
  await audited(`${site.origin}/private-links`, 'links');
  await page.getByTestId('seo-link-checks-start').click();
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  await expect(row(`127.0.0.1:${site.port}/secret`)).toHaveAttribute('data-status', 'skipped');
  await expect(row(`127.0.0.1:${site.port}/secret`).getByTestId('seo-link-status')).toHaveText('Skipped: Private address');
  await expect(row(`localhost:${site.port}/secret-too`)).toHaveAttribute('data-status', 'skipped');
  // A public name that resolves to a private address: refused after resolving it, never requested.
  await expect(row(`${LAN_HOST}:${site.port}/secret-name`)).toHaveAttribute('data-status', 'skipped');
  await expect(row('/ok')).toHaveAttribute('data-status', 'ok');
  expect(checkRequests(['/secret', '/secret-too', '/secret-name'])).toEqual([]);
});

test('sitemap-index-e2e', async () => {
  await audited(`${site.origin}/listed`, 'indexability');
  await expect(page.getByTestId('seo-sitemap-checks-notice')).toHaveText(CHECKS_VISIBILITY_NOTICE);
  await page.getByTestId('seo-sitemap-checks-start').click();
  await expect(page.getByTestId('seo-sitemap-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  await expect(page.getByTestId('seo-sitemap-listed')).toHaveAttribute('data-listed', 'true');
  await expect(page.getByTestId('seo-sitemap-files-count')).toHaveText('3');
  await expect(page.getByTestId('seo-sitemap-url-count')).toHaveText('4');
  await expect(page.locator('[data-testid="seo-sitemap-file"][data-type="index"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="seo-sitemap-file"][data-type="urlset"][data-depth="1"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="seo-sitemap-file"][data-error=""]')).toHaveCount(3);

  await audited(`${site.origin}/unlisted`, 'indexability');
  await page.getByTestId('seo-sitemap-checks-start').click();
  await expect(page.getByTestId('seo-sitemap-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  await expect(page.getByTestId('seo-sitemap-listed')).toHaveAttribute('data-listed', 'false');
  await expect.poll(() => issueIds('[data-testid="seo-index-issues"]'), { timeout: AUDIT_WAIT }).toEqual(expect.arrayContaining(['sitemap-page-not-listed']));
});

test('sitemap-gzip-bomb-e2e', async () => {
  await audited(`${site.bombOrigin}/`, 'indexability');
  await page.getByTestId('seo-sitemap-checks-start').click();
  await expect(page.getByTestId('seo-sitemap-checks')).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  // Both bombs stop at the cap: a gzip file inflated in the worker, a gzip-encoded answer cut while it streams.
  await expect(page.locator('[data-testid="seo-sitemap-file"][data-error="too-large"]')).toHaveCount(2);
  await expect.poll(() => issueIds('[data-testid="seo-index-issues"]'), { timeout: AUDIT_WAIT }).toEqual(expect.arrayContaining(['sitemap-unreachable']));
  // The app keeps working: another page audits.
  await audited(`${site.origin}/listed`, 'indexability');
});

test('hreflang-reciprocity-e2e', async () => {
  await audited(`${site.origin}/en`, 'indexability');
  await expect(page.getByTestId('seo-hreflang-checks-notice')).toHaveText(CHECKS_VISIBILITY_NOTICE);
  await page.getByTestId('seo-hreflang-checks-start').click();
  await expect(page.getByTestId('seo-hreflang-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  const rows = page.getByTestId('seo-hreflang-check-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'reciprocal');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'missing-return');
  await expect.poll(() => issueIds('[data-testid="seo-index-issues"]'), { timeout: AUDIT_WAIT }).toEqual(expect.arrayContaining(['hreflang-no-return-link']));
});

test('checks-send-no-cookies-e2e', async () => {
  // The page sets a cookie; a reload proves the browser sends it to the page itself.
  const url = `${site.origin}/cookie-links`;
  await audited(url, 'links');
  await page.getByTestId('reload').click();
  await expect.poll(() => site.seen.filter((entry) => entry.path === '/cookie-links' && entry.cookie?.includes('session=secret-value')).length, { timeout: AUDIT_WAIT }).toBeGreaterThan(0);
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  const before = site.seen.length;
  await page.getByTestId('seo-link-checks-start').click();
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  await railItem('indexability').click();
  await page.getByTestId('seo-sitemap-checks-start').click();
  await expect(page.getByTestId('seo-sitemap-checks')).toHaveAttribute('data-status', 'done', { timeout: CHECK_WAIT });
  const checked = site.seen.slice(before);
  expect(checked.map((entry) => entry.path)).toEqual(expect.arrayContaining(['/fresh/a', '/fresh/b', '/sitemap_index.xml', '/sitemap-pages.xml']));
  for (const entry of checked) expect(entry.cookie, `${entry.method} ${entry.path}`).toBeUndefined();
});

test('link-check-cancel-on-navigation-e2e', async () => {
  await audited(`${site.origin}/slow-links`, 'links');
  await page.getByTestId('seo-link-checks-start').click();
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'running');
  await expect.poll(() => site.seen.filter((entry) => entry.path.startsWith('/slow/')).length).toBeGreaterThan(0);
  // Navigate mid-run: the run is cancelled and its requests aborted, so no more start.
  await audited(`${site.origin}/listed`, 'links');
  await expect(page.getByTestId('seo-link-checks')).toHaveAttribute('data-status', 'idle');
  const asked = site.seen.filter((entry) => entry.path.startsWith('/slow/')).length;
  expect(asked).toBeLessThan(12);
  await page.waitForTimeout(SLOW_MS + 1_500);
  expect(site.seen.filter((entry) => entry.path.startsWith('/slow/')).length).toBe(asked);
});
