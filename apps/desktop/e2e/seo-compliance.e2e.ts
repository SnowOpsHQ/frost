// Specs: specs/seo-compliance.spec.ts (COMPLIANCE_RULE_SPECS, SECURITY_VERDICT_LABELS, A11Y_TIMEOUT_MS, A11Y_LIMITS,
// A11Y_WORLD_ID), specs/seo-compliance.schema.ts, specs/browser.spec.ts (BROWSE_PARTITION)
// Acceptance: specs/seo-compliance.feature.md (End to end); review focus measurement-runs-isolated
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { A11Y_LIMITS, A11Y_TIMEOUT_MS, SECURITY_VERDICT_LABELS } from '@app/specs/seo-compliance.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { selfSignedCertificate } from './tls';

const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 10_000;
/** A run's answer, scored: the time cap, the re-audit, and a margin. */
const RUN_WAIT = A11Y_TIMEOUT_MS + AUDIT_WAIT;

/** Every security header, well configured. */
const SECURE_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=()',
};

const html = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;

/** A page with the four problems the check must find: an image without alt, low-contrast text, an unlabelled field, an empty button. */
const A11Y_BODY = `<main><h1>Loopback shop</h1><img src="/pixel.png" width="40" height="40">
  <p class="faint">This text has far too little contrast to read comfortably.</p>
  <form><input type="text" name="q"></form><button></button></main>`;
const A11Y_STYLE = '<style>.faint { color: #c4c4c4; background: #ffffff; }</style>';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

type Route = (request: IncomingMessage, response: ServerResponse) => void;
const page200 = (body: string, headers: Record<string, string> = {}, head = ''): Route => (_request, response) =>
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(html('A loopback page for the Compliance panel', body, head));

/** A loopback server (http, or https with a self-signed certificate the browse session is told to trust) answering `routes` by path. */
async function serve(routes: Record<string, Route>, tls = false): Promise<string> {
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    if (pathname === '/pixel.png') return void response.writeHead(200, { 'Content-Type': 'image/png' }).end(PIXEL);
    if (pathname === '/robots.txt') return void response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    const route = routes[pathname];
    if (route) route(request, response);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  };
  const server: Server = tls ? createHttpsServer(selfSignedCertificate(), handler) : createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `${tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let app: ElectronApplication;
let page: Page;
const servers: Server[] = [];
const { go, run, contentsIdAt, browseContents, closeAllTabs } = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const verdict = () => page.getByTestId('seo-security-verdict');
const securityIssues = () => page.locator('[data-testid="seo-security-issues"] [data-testid="seo-issue"]').evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));
const headerRow = (name: string) => page.locator(`[data-testid="seo-security-header"][data-name="${name}"]`);
const a11yState = () => page.getByTestId('seo-a11y-state');
const ruleIds = (impact: string) => page.locator(`[data-testid="seo-a11y-group"][data-impact="${impact}"] [data-testid="seo-a11y-rule"]`).evaluateAll((items) => items.map((item) => item.getAttribute('data-rule-id')));

/** Loads `url`, opens Compliance and waits for the audit of `url`. */
async function compliance(url: string): Promise<number> {
  await go(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'compliance') await railItem('compliance').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'compliance');
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(verdict()).toBeVisible({ timeout: AUDIT_WAIT });
  return contentsIdAt(url);
}

/** Starts the check and waits until it reports `state`. */
async function runCheck(state: string | RegExp = 'results', timeout = RUN_WAIT): Promise<void> {
  await page.getByTestId('seo-a11y-run').click();
  await expect(a11yState()).toHaveAttribute('data-state', state, { timeout });
}

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  // The suite's https servers use a fresh self-signed certificate: the browse session trusts it for
  // 127.0.0.1 only, for this suite's own app (Chromium decides everywhere else).
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).setCertificateVerifyProc((request, callback) => callback(request.hostname === '127.0.0.1' ? 0 : -3));
  }, BROWSE_PARTITION);
});

test.afterAll(async () => {
  await app?.evaluate(({ session }, partition) => session.fromPartition(partition).setCertificateVerifyProc(null), BROWSE_PARTITION).catch(() => undefined);
  await closeApp(app);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('secure-page-is-clean-e2e', async () => {
  const origin = await serve({ '/': page200('<main><h1>Secure</h1><img src="/pixel.png" alt="A pixel"></main>', SECURE_HEADERS) }, true);
  await compliance(`${origin}/`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'secure');
  await expect(page.getByTestId('seo-security-verdict-label')).toHaveText(SECURITY_VERDICT_LABELS.secure);
  expect(await securityIssues()).toEqual([]);
  for (const name of ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
    await expect(headerRow(name), name).toHaveAttribute('data-state', 'good');
  }
  await expect(headerRow('strict-transport-security')).toContainText('max-age=31536000; includeSubDomains');
  await expect(headerRow('strict-transport-security').getByTestId('seo-security-header-note')).toHaveText('max-age 1 year · includeSubDomains');
  await expect(page.getByTestId('seo-mixed-none')).toHaveText('Every subresource the page asks for is https.');
  await expect(page.getByTestId('seo-security-signal-https')).toHaveAttribute('data-tone', 'ok');
  await expect(railItem('compliance')).toHaveAttribute('data-status', 'pass');
  // Nothing ran the accessibility check on its own.
  await expect(a11yState()).toHaveAttribute('data-state', 'idle');
});

test('missing-headers-show-issues-e2e', async () => {
  const origin = await serve({ '/': page200('<main><h1>Bare</h1></main>') }, true);
  await compliance(`${origin}/`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'attention');
  expect((await securityIssues()).sort()).toEqual(['clickjacking-unprotected', 'csp-missing', 'hsts-missing', 'nosniff-missing', 'referrer-policy-missing']);
  for (const name of ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
    await expect(headerRow(name), name).toHaveAttribute('data-state', 'missing');
  }
  await expect(railItem('compliance')).toHaveAttribute('data-status', 'warn');
  // Weak values are flagged as such.
  const weak = await serve(
    { '/': page200('<main><h1>Weak</h1></main>', { 'Strict-Transport-Security': 'max-age=600', 'Content-Security-Policy': "script-src 'self' 'unsafe-inline'", 'Referrer-Policy': 'unsafe-url', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' }) },
    true,
  );
  await compliance(`${weak}/`);
  expect((await securityIssues()).sort()).toEqual(['csp-unsafe-inline', 'hsts-short-max-age', 'referrer-policy-unsafe']);
  for (const name of ['strict-transport-security', 'content-security-policy', 'referrer-policy']) await expect(headerRow(name), name).toHaveAttribute('data-state', 'weak');
  // A plain-http page from this computer: local, no HTTPS error, HSTS not applicable.
  const local = await serve({ '/': page200('<main><h1>Local</h1></main>') });
  await compliance(`${local}/`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'local');
  expect(await securityIssues()).not.toContain('https-missing');
  await expect(headerRow('strict-transport-security')).toHaveAttribute('data-state', 'not-applicable');
});

/** A page asking for http subresources of another computer (and one of this computer, which is not mixed content). */
const MIXED_BODY = `<main><h1>Mixed</h1>
    <script src="http://mixed.invalid/app.js"></script>
    <link rel="stylesheet" href="http://mixed.invalid/site.css">
    <iframe src="http://mixed.invalid/frame" title="A frame"></iframe>
    <audio src="http://mixed.invalid/sound.mp3" preload="none"></audio>
    <img src="http://127.0.0.1:9/local.png" alt="From this computer: not mixed content"></main>`;

test('mixed-content-is-detected-e2e', async () => {
  const origin = await serve({ '/': page200(MIXED_BODY, SECURE_HEADERS) }, true);
  await compliance(`${origin}/`);
  // Chromium blocks the active ones; the snapshot still reports them all.
  await expect(verdict()).toHaveAttribute('data-verdict', 'insecure');
  expect(await securityIssues()).toEqual(['mixed-content-active', 'mixed-content-passive']);
  const rows = await page.getByTestId('seo-mixed-row').evaluateAll((items) => items.map((item) => [item.getAttribute('data-kind'), item.getAttribute('data-active'), item.querySelector('[data-testid="seo-mixed-url"]')?.textContent]));
  expect(rows).toEqual([
    ['script', 'true', 'http://mixed.invalid/app.js'],
    ['stylesheet', 'true', 'http://mixed.invalid/site.css'],
    ['frame', 'true', 'http://mixed.invalid/frame'],
    ['media', 'false', 'http://mixed.invalid/sound.mp3'],
  ]);
  await expect(railItem('compliance')).toHaveAttribute('data-status', 'error');
  // The page-derived URLs are text, never links.
  expect(await sidebar().evaluate((root) => root.querySelectorAll('a, img, script, [style]').length)).toBe(0);
});

test('mixed-content-upgraded-by-csp-e2e', async () => {
  // The same page, with a policy that has upgrade-insecure-requests: browsers fetch them over https.
  const origin = await serve({ '/': page200(MIXED_BODY, { ...SECURE_HEADERS, 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'; upgrade-insecure-requests" }) }, true);
  await compliance(`${origin}/`);
  await expect(verdict()).toHaveAttribute('data-verdict', 'secure');
  expect(await securityIssues()).toEqual([]);
  const rows = await page.getByTestId('seo-mixed-row').evaluateAll((items) => items.map((item) => [item.getAttribute('data-kind'), item.getAttribute('data-upgraded')]));
  expect(rows).toEqual([
    ['script', 'true'],
    ['stylesheet', 'true'],
    ['frame', 'true'],
    ['media', 'true'],
  ]);
  await expect(page.getByTestId('seo-mixed-note')).toContainText('upgrade-insecure-requests');
  await expect(page.getByTestId('seo-security-signal-mixed')).toHaveAttribute('data-tone', 'ok');
  await expect(railItem('compliance')).toHaveAttribute('data-status', 'pass');
});

test('accessibility-check-reports-violations-e2e', async () => {
  const origin = await serve({ '/shop': page200(A11Y_BODY, {}, A11Y_STYLE) });
  const url = `${origin}/shop`;
  const id = await compliance(url);
  const scoreBefore = await (async () => {
    await railItem('overview').click();
    const value = Number(await page.getByTestId('seo-score').textContent());
    await railItem('compliance').click();
    return value;
  })();
  await page.getByTestId('seo-a11y-run').click();
  // Progress while it runs (it may also finish before the first frame).
  await expect(a11yState()).toHaveAttribute('data-state', /running|scoring|results/);
  await expect(a11yState()).toHaveAttribute('data-state', 'results', { timeout: RUN_WAIT });
  expect(await ruleIds('critical')).toEqual(expect.arrayContaining(['image-alt', 'label', 'button-name']));
  expect(await ruleIds('serious')).toEqual(expect.arrayContaining(['color-contrast']));
  await expect(page.getByTestId('seo-a11y-count-critical')).not.toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('seo-a11y-totals')).toContainText('rules passed');
  // A rule opens to its help, help URL (text) and elements (selector text and failure summary).
  const imageAlt = page.locator('[data-testid="seo-a11y-rule"][data-rule-id="image-alt"]');
  await imageAlt.getByTestId('seo-a11y-rule-toggle').click();
  await expect(imageAlt.getByTestId('seo-a11y-selector').first()).toHaveText('img');
  await expect(imageAlt.getByTestId('seo-a11y-node').first()).toContainText('alt attribute');
  const helpUrl = (await imageAlt.getByTestId('seo-a11y-help-url').textContent()) ?? '';
  expect(helpUrl).toMatch(/^https:\/\/.*image-alt/);
  // "Open in new tab" opens it in a background tab (hermetic: the browse session answers https locally).
  await app.evaluate(({ session }, partition) => {
    session.fromPartition(partition).protocol.handle('https', () => new Response('<!doctype html><title>stub help</title>', { headers: { 'Content-Type': 'text/html' } }));
  }, BROWSE_PARTITION);
  try {
    await imageAlt.getByTestId('seo-a11y-open-help').click();
    await expect.poll(async () => (await browseContents()).some((c) => c.url === helpUrl)).toBe(true);
  } finally {
    await app.evaluate(({ session }, partition) => session.fromPartition(partition).protocol.unhandle('https'), BROWSE_PARTITION);
  }
  // Scored: critical and serious count (once each), and Overview lists them.
  await railItem('overview').click();
  await expect.poll(async () => Number(await page.getByTestId('seo-score').textContent()), { timeout: AUDIT_WAIT }).toBeLessThan(scoreBefore);
  // The issue list settles (the re-scored audit, then its final one): open every issue, then find both rows.
  await expect(async () => {
    const showAll = page.getByTestId('seo-show-all');
    if ((await showAll.getAttribute('aria-expanded')) !== 'true') await showAll.click({ timeout: 2_000 });
    await expect(page.locator('[data-testid="seo-issue"][data-rule-id="a11y-critical"]')).toHaveCount(1, { timeout: 1_000 });
    await expect(page.locator('[data-testid="seo-issue"][data-rule-id="a11y-serious"]')).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: AUDIT_WAIT });
  await expect(railItem('compliance')).toHaveAttribute('data-status', 'warn');
  // The tab still shows its page, unchanged.
  expect(await run(id, 'document.querySelectorAll("button").length')).toBe(1);
  await closeAllTabs();
});

test('measurement-runs-isolated-e2e', async () => {
  const origin = await serve({
    '/plain': page200(A11Y_BODY, {}, A11Y_STYLE),
    // The page fights back in its main world: overridden DOM methods, a fake `axe` of its own.
    '/hostile': page200(
      A11Y_BODY,
      {},
      `${A11Y_STYLE}<script>
        Element.prototype.matches = function () { return false; };
        Element.prototype.querySelectorAll = function () { return []; };
        Document.prototype.querySelectorAll = function () { return []; };
        document.querySelectorAll = function () { return []; };
        window.getComputedStyle = function () { throw new Error('no styles for you'); };
        window.axe = { run: function () { return Promise.resolve({ violations: [] }); }, pageOwned: true };
      </script>`,
    ),
  });
  // A plain page: after the run, the main world has no `axe`, and the DOM is as it was.
  const plain = await compliance(`${origin}/plain`);
  const before = await run(plain, 'document.documentElement.outerHTML');
  await runCheck();
  expect(await run(plain, 'typeof window.axe')).toBe('undefined');
  expect(await run(plain, 'Object.keys(window).filter((k) => /axe/i.test(k)).length')).toBe(0);
  expect(await run(plain, 'document.documentElement.outerHTML')).toBe(before);
  // The hostile page's overrides and its fake `axe` change nothing in the check's own world.
  const hostile = await compliance(`${origin}/hostile`);
  await runCheck();
  expect(await ruleIds('critical')).toEqual(expect.arrayContaining(['image-alt', 'label', 'button-name']));
  // Its own `axe` is still its own: frost's was never put in the main world.
  expect(await run(hostile, 'window.axe.pageOwned === true && typeof window.axe.version')).toBe('undefined');
});

test('huge-dom-run-stays-bounded-e2e', async () => {
  const many = Array.from({ length: 6_000 }, (_, i) => `<p class="faint">Row ${i}<img src="/pixel.png"><input type="text"><button></button></p>`).join('');
  const origin = await serve({ '/huge': page200(`<main><h1>Huge</h1>${many}</main>`, {}, A11Y_STYLE), '/next': page200('<main><h1>Next</h1></main>') });
  await compliance(`${origin}/huge`);
  const started = Date.now();
  await page.getByTestId('seo-a11y-run').click();
  await expect(a11yState()).toHaveAttribute('data-state', /running|scoring|results|timed-out/);
  // The app stays responsive while the page works: main answers, the chrome switches panels.
  const mainLatency = Date.now();
  await app.evaluate(() => 1);
  expect(Date.now() - mainLatency).toBeLessThan(2_000);
  await railItem('overview').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await railItem('compliance').click();
  // Bounded: an answer within the cap (every list capped), or "timed out" at it.
  await expect(a11yState()).toHaveAttribute('data-state', /results|timed-out/, { timeout: RUN_WAIT });
  expect(Date.now() - started).toBeLessThan(RUN_WAIT);
  if ((await a11yState().getAttribute('data-state')) === 'results') {
    const nodes = await page.locator('[data-testid="seo-a11y-rule"]').evaluateAll((items) => items.length);
    expect(nodes).toBeLessThanOrEqual(A11Y_LIMITS.maxRules);
    const imageAlt = page.locator('[data-testid="seo-a11y-rule"][data-rule-id="image-alt"]');
    await expect(imageAlt.getByTestId('seo-a11y-rule-count')).toHaveText('6,000');
    await imageAlt.getByTestId('seo-a11y-rule-toggle').click();
    expect(await imageAlt.getByTestId('seo-a11y-node').count()).toBeLessThanOrEqual(A11Y_LIMITS.maxNodesPerRule);
  }
  // A run in progress is cancelled by navigation: the next page starts idle, and back on the huge
  // page (a new document) the old run's answer never lands, however long it takes.
  await compliance(`${origin}/huge`);
  await page.getByTestId('seo-a11y-run').click();
  await expect(a11yState()).toHaveAttribute('data-state', /running|scoring|results|timed-out/);
  await compliance(`${origin}/next`);
  await expect(a11yState()).toHaveAttribute('data-state', 'idle');
  await compliance(`${origin}/huge`);
  await expect(a11yState()).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(A11Y_TIMEOUT_MS + 1_000);
  await expect(a11yState()).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('seo-a11y-results')).toHaveCount(0);
});
