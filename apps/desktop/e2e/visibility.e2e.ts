// Specs: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_DISCLOSURE, PROBE_MODELLED_DIRECTIVES_NOTE,
// PROBE_ROBOTS_SERVED_NOTE, PROBE_LIMITS), specs/intent-classifier.spec.ts (INTENT_ENABLE_PROMPT, INTENT_MODEL,
// INTENT_DOWNLOAD_MB), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH)
// Acceptance: specs/serp-panels.feature.md (End to end); review focus probes-are-bounded
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { INTENT_DOWNLOAD_MB, INTENT_ENABLE_PROMPT, INTENT_MODEL } from '@app/specs/intent-classifier.spec';
import { PROBE_AGENTS, PROBE_DISCLOSURE, PROBE_LIMITS, PROBE_MODELLED_DIRECTIVES_NOTE, PROBE_ROBOTS_SERVED_NOTE } from '@app/specs/visibility-probes.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** The probed site's public-looking name (`--host-resolver-rules`, `--frost-e2e-public-hosts`). */
const SITE_HOST = 'probes.frost-e2e.net';
const RUN_WAIT = PROBE_LIMITS.timeoutMs * 2 + 10_000;
/** How long `/slow` keeps a crawler waiting (longer than a probe may wait, so Stop is what ends it). */
const SLOW_MS = PROBE_LIMITS.timeoutMs + 5_000;

const CRAWLER = /googlebot|bingbot|gptbot|claudebot|perplexitybot/i;
const words = (n: number) => Array.from({ length: n }, (_, i) => `leaf${i % 60} brew${i % 7}`).join(' ');
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page frost probes as each crawler."><link rel="canonical" href="/page"></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

type Seen = { path: string; userAgent: string };

async function startSite() {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    const userAgent = request.headers['user-agent'] ?? '';
    seen.push({ path, userAgent });
    if (path === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n');
      return;
    }
    if (path === '/page') {
      // Googlebot alone is told not to index; ClaudeBot gets a much shorter page.
      const short = /claudebot/i.test(userAgent);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'googlebot: noindex' }).end(page('Green tea leaves', words(short ? 12 : 300)));
      return;
    }
    if (path === '/slow') {
      if (!CRAWLER.test(userAgent)) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('A page slow for crawlers', words(200)));
        return;
      }
      const timer = setTimeout(() => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Late', words(200))), SLOW_MS);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${SITE_HOST}:${port}`,
    seen,
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
const h = chromeHelpers(
  () => app,
  () => chrome,
);

const sidebar = () => chrome.getByTestId('seo-sidebar');
const railItem = (panel: string) => chrome.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const crawlerRequests = (path?: string) => site.seen.filter((entry) => CRAWLER.test(entry.userAgent) && (path === undefined || entry.path === path));
const cell = (fact: string, agent: string) => chrome.locator(`[data-testid="visibility-fact"][data-fact="${fact}"] [data-testid="visibility-cell"][data-agent="${agent}"]`);

async function openVisibility(): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) !== 'visibility') await railItem('visibility').click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'visibility');
}

async function load(url: string): Promise<number> {
  await h.go(url);
  const id = await h.contentsIdAt(url);
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
  return id;
}

test.beforeAll(async () => {
  site = await startSite();
  ({ app, page: chrome } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST}`]));
  await chrome.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await h.closeAllTabs();
});

test('visibility-probes-per-agent', async () => {
  await load(`${site.origin}/page`);
  await openVisibility();
  // The disclosure is there before anything runs, and nothing was asked as a crawler.
  await expect(chrome.getByTestId('visibility-disclosure')).toHaveText(PROBE_DISCLOSURE);
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'idle');
  await expect(chrome.getByTestId('visibility-table')).toHaveCount(0);
  expect(crawlerRequests()).toEqual([]);
  await chrome.getByTestId('visibility-run').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'done', { timeout: RUN_WAIT });
  // One column per agent, the browser first.
  const agents = await chrome.getByTestId('visibility-agent').evaluateAll((items) => items.map((item) => item.getAttribute('data-agent')));
  expect(agents).toEqual(PROBE_AGENTS.map((agent) => agent.id));
  // robots.txt disallows GPTBot only; Googlebot alone is told noindex; ClaudeBot's page is smaller.
  await expect(cell('robots', 'gptbot')).toContainText('Disallowed');
  await expect(cell('robots', 'gptbot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('robots', 'bingbot')).toContainText('Allowed');
  await expect(cell('robots', 'bingbot')).toHaveAttribute('data-diff', 'false');
  await expect(cell('noindex', 'googlebot')).toContainText('Yes');
  await expect(cell('noindex', 'googlebot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('noindex', 'browser')).toContainText('No');
  await expect(cell('noindex', 'bingbot')).toHaveAttribute('data-diff', 'false');
  await expect(cell('wordCount', 'claudebot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('status', 'browser')).toHaveText('200');
  // The browser's column is the baseline: never marked.
  await expect(chrome.locator('[data-testid="visibility-cell"][data-agent="browser"][data-diff="true"]')).toHaveCount(0);
  // The notes.
  await expect(chrome.getByTestId('visibility-modelled-note')).toContainText(PROBE_MODELLED_DIRECTIVES_NOTE);
  await expect(chrome.getByTestId('visibility-robots-note')).toHaveText(PROBE_ROBOTS_SERVED_NOTE);
  // Bounded: one request per crawler (the browser's is frost's own user agent), robots.txt from main's cache.
  expect(crawlerRequests('/page')).toHaveLength(PROBE_AGENTS.length - 1);
  expect(crawlerRequests('/robots.txt')).toEqual([]);
});

test('visibility-probes-stop', async () => {
  await load(`${site.origin}/slow`);
  await openVisibility();
  const before = crawlerRequests('/slow').length;
  await chrome.getByTestId('visibility-run').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'running', { timeout: RUN_WAIT });
  await expect(chrome.getByTestId('visibility-stop')).toBeVisible();
  // At most two at once: the crawlers wait on the slow answers.
  await expect.poll(() => crawlerRequests('/slow').length - before).toBeGreaterThan(0);
  expect(crawlerRequests('/slow').length - before).toBeLessThanOrEqual(PROBE_LIMITS.maxConcurrent);
  await chrome.getByTestId('visibility-stop').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'stopped');
  // What was found stays: the browser's own row.
  await expect(cell('status', 'browser')).toHaveText('200');
  await expect(chrome.locator('[data-testid="visibility-fact"][data-fact="status"] [data-testid="visibility-cell"]').filter({ hasText: 'Stopped' })).not.toHaveCount(0);
  await expect(chrome.getByTestId('visibility-run')).toBeVisible();
  // Nothing more is asked after Stop.
  const after = crawlerRequests('/slow').length;
  await chrome.waitForTimeout(1_000);
  expect(crawlerRequests('/slow').length).toBe(after);
});

test('serp-intent-model-missing', async () => {
  await load(`${site.origin}/page`);
  await openVisibility();
  await chrome.getByTestId('visibility-query-input').fill('green tea price');
  await chrome.getByTestId('visibility-classify').click();
  await expect(chrome.getByTestId('visibility-intent-result')).toHaveAttribute('data-state', 'model-missing');
  // What "Enable" downloads is stated before any click: size, host and licence.
  const prompt = chrome.getByTestId('visibility-enable-intent-prompt');
  await expect(prompt).toHaveText(INTENT_ENABLE_PROMPT);
  await expect(prompt).toContainText(`${INTENT_DOWNLOAD_MB} MB`);
  await expect(prompt).toContainText(INTENT_MODEL.host);
  await expect(prompt).toContainText(INTENT_MODEL.licence);
  await expect(chrome.getByTestId('visibility-enable-intent-button')).toHaveText('Enable on-device intent');
});
