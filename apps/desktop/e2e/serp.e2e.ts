// Specs: specs/serp-selector-pack.spec.ts (SERP_E2E_PACK_URL_SWITCH, SERP_E2E_PACK_KEY_SWITCH, PACK_UPDATE_MESSAGES,
// packSignatureUrl), specs/serp-service.spec.ts (SERP_OUTLINE_KEY, SERP_NOT_SERP_MESSAGE), specs/serp.spec.ts
// (SERP_WORLD_ID, SERP_UNREADABLE_MESSAGES), specs/intent-classifier.spec.ts (INTENT_E2E_FAKE_SWITCH,
// INTENT_LABEL_NAMES), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH)
// Acceptance: specs/serp-panels.feature.md (End to end)
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { INTENT_E2E_FAKE_SWITCH, INTENT_LABEL_NAMES } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH, packSignatureUrl } from '@app/specs/serp-selector-pack.spec';
import { SERP_NOT_SERP_MESSAGE, SERP_OUTLINE_KEY } from '@app/specs/serp-service.spec';
import { SERP_UNREADABLE_MESSAGES, SERP_WORLD_ID } from '@app/specs/serp.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** The synthetic search engine's public-looking name (`--host-resolver-rules`, `--frost-e2e-public-hosts`). */
const SEARCH_HOST = 'search.frost-e2e.net';
const PACK_PATH = '/serp-selectors.json';
/** Above the bundled pack's version, so the test pack installs. */
const PACK_VERSION = 1000;
const READ_WAIT = 20_000;

/** frost's own minimal result page markup (no real engine's): ads, a snippet, organic results and related questions. */
function resultPage(query: string): string {
  const q = query.replace(/[<>&"]/g, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${q} · frost test search</title></head><body>
<form action="/search"><input name="q" value="${q}"></form>
<div id="ads"><div class="ad"><a href="https://teashop.example/buy"><h3>Buy tea online</h3></a></div></div>
<main id="results">
  <div class="snippet"><a href="https://brewguide.example/what"><h3>What green tea is</h3></a><p>Green tea is tea made from leaves that are not oxidised.</p></div>
  <div class="result"><a href="https://brewguide.example/guide"><h3>A guide to green tea</h3></a></div>
  <div class="result"><a href="https://leafhouse.example/"><h3>Leaf house</h3></a></div>
  <div class="questions"><div class="q">Is green tea good for you?</div><div class="q">How long should green tea brew?</div></div>
  <div class="result"><a href="https://brewguide.example/more"><h3>More about brewing</h3></a></div>
</main></body></html>`;
}

/** A result page whose results area is not there (the pack cannot read it). */
const UNREADABLE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A new layout</title></head><body><section id="something-else"><p>Results moved somewhere the selectors do not look.</p></section></body></html>';

/** The test pack: one engine on the synthetic host (frost's own selectors for the markup above). */
function testPack(): string {
  const pack = {
    format: 1,
    version: PACK_VERSION,
    published: '2026-10-28',
    engines: [
      {
        id: 'frost-e2e',
        label: 'Frost test search',
        hosts: [SEARCH_HOST],
        paths: ['/search'],
        params: { query: ['q'], gl: ['gl'], hl: ['hl'], page: { param: 'start', kind: 'offset', perPage: 10, offsetBase: 0 } },
        layout: {
          results: '#results',
          blocks: [
            { type: 'ad', container: '#ads', item: '.ad', link: 'a[href]', title: 'h3' },
            { type: 'featured-snippet', container: '#results .snippet', link: 'a[href]', title: 'h3' },
            { type: 'people-also-ask', container: '#results .questions', item: '.q' },
            { type: 'organic', container: '#results', item: '.result', link: 'a[href]', title: 'h3', required: true },
          ],
        },
      },
    ],
  };
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/** An ephemeral Ed25519 key (SPKI base64, as `--frost-e2e-serp-pack-key` takes it), and the pack signed with it. */
function signedTestPack(): { spki: string; bytes: Buffer; signature: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(testPack(), 'utf8');
  return { spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}

type Seen = { host: string; path: string; userAgent: string };

async function startEngine(pack: { bytes: Buffer; signature: string }) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = (request.headers.host ?? '').split(':')[0]!;
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({ host, path: url.pathname, userAgent: request.headers['user-agent'] ?? '' });
    const send = (status: number, type: string, body: string | Buffer) => response.writeHead(status, { 'Content-Type': type }).end(body);
    if (url.pathname === PACK_PATH) return send(200, 'application/json', pack.bytes);
    if (url.pathname === packSignatureUrl(PACK_PATH)) return send(200, 'text/plain', pack.signature);
    if (url.pathname === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
    if (url.pathname === '/search') return send(200, 'text/html; charset=utf-8', url.searchParams.get('layout') === 'new' ? UNREADABLE_PAGE : resultPage(url.searchParams.get('q') ?? ''));
    if (url.pathname === '/about') return send(200, 'text/html; charset=utf-8', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About this test search</title></head><body><h1>About</h1><p>Not a result page.</p></body></html>');
    return send(404, 'text/plain', 'not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${SEARCH_HOST}:${port}`,
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
let engine: Awaited<ReturnType<typeof startEngine>>;
const h = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const panelState = () => page.getByTestId('serp-panel');
const searchUrl = (query: string, extra = '') => `${engine.origin}/search?q=${encodeURIComponent(query).replace(/%20/g, '+')}${extra}`;
const packRequests = () => engine.seen.filter((entry) => entry.path === PACK_PATH || entry.path === packSignatureUrl(PACK_PATH));
const crawlerRequests = () => engine.seen.filter((entry) => /googlebot|bingbot|gptbot|claudebot|perplexitybot/i.test(entry.userAgent));

/** Opens the sidebar on `panel` (if it is not open on it already). */
async function openPanel(panel: 'serp' | 'visibility'): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `url` in the active tab; resolves its WebContents id once it has loaded. */
async function load(url: string): Promise<number> {
  await h.go(url);
  const id = await h.contentsIdAt(url);
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
  return id;
}

/** Installs the test pack through "Check for selector updates" unless it is in use already. */
async function ensurePack(): Promise<void> {
  await openPanel('serp');
  const status = page.getByTestId('serp-pack-status');
  if ((await status.getAttribute('data-version')) === String(PACK_VERSION)) return;
  await page.getByTestId('serp-pack-update').click();
  await expect(status).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: READ_WAIT });
}

/** Runs `code` in the tab's isolated SERP world (where the outlines live). */
const inSerpWorld = (id: number, code: string) =>
  app.evaluate(({ webContents }, { id, code, world }) => webContents.fromId(id)!.executeJavaScriptInIsolatedWorld(world, [{ code }]) as Promise<unknown>, { id, code, world: SERP_WORLD_ID });

test.beforeAll(async () => {
  const pack = signedTestPack();
  engine = await startEngine(pack);
  ({ app, page } = await launchApp([
    `--host-resolver-rules=MAP ${SEARCH_HOST} 127.0.0.1`,
    `--${E2E_PUBLIC_HOSTS_SWITCH}=${SEARCH_HOST}`,
    `--${SERP_E2E_PACK_URL_SWITCH}=${engine.origin}${PACK_PATH}`,
    `--${SERP_E2E_PACK_KEY_SWITCH}=${pack.spki}`,
    `--${INTENT_E2E_FAKE_SWITCH}`,
  ]));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await engine?.close();
});

test.beforeEach(async () => {
  await h.closeAllTabs();
});

test('serp-nothing-before-action', async () => {
  // With the bundled pack, the synthetic engine is no result page: nothing is read, nothing requested.
  await load(searchUrl('green tea', '&gl=uk&hl=en'));
  await openPanel('serp');
  await expect(page.getByTestId('serp-state')).toHaveAttribute('data-state', 'not-serp', { timeout: READ_WAIT });
  await openPanel('visibility');
  await expect(page.getByTestId('visibility-disclosure')).toBeVisible();
  await openPanel('serp');
  await expect(page.getByTestId('serp-pack-status')).toHaveAttribute('data-source', 'bundled');
  expect(packRequests()).toEqual([]);
  expect(crawlerRequests()).toEqual([]);
});

test('serp-pack-update-installs', async () => {
  await load(searchUrl('green tea', '&gl=uk&hl=en'));
  await openPanel('serp');
  expect(packRequests()).toEqual([]);
  await page.getByTestId('serp-pack-update').click();
  await expect(page.getByTestId('serp-pack-status')).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-pack-status')).toHaveAttribute('data-source', 'remote');
  await expect(page.getByTestId('serp-pack-outcome')).toHaveText(PACK_UPDATE_MESSAGES.installed);
  // The pack and its signature, once each, only now.
  expect(packRequests().map((entry) => entry.path).sort()).toEqual([PACK_PATH, packSignatureUrl(PACK_PATH)].sort());
  // The active tab is read again with the new pack at once.
  await expect(panelState()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  // A second check finds nothing newer.
  await page.getByTestId('serp-pack-update').click();
  await expect(page.getByTestId('serp-pack-outcome')).toHaveText(PACK_UPDATE_MESSAGES['not-newer'], { timeout: READ_WAIT });
  expect(crawlerRequests()).toEqual([]);
});

test('serp-composition-and-ownership', async () => {
  await ensurePack();
  await load(searchUrl('green tea'));
  await openPanel('serp');
  await expect(panelState()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  // The composition: a bar with its text equivalent, and a count per type.
  await expect(page.getByTestId('serp-composition-bar')).toHaveAttribute('aria-label', '7 results: Organic result 3, Ad 1, Featured snippet 1, Related questions 2');
  const counts = await page.getByTestId('serp-composition-count').evaluateAll((items) => items.map((item) => [item.getAttribute('data-type'), item.getAttribute('data-count')]));
  expect(counts).toEqual([
    ['organic', '3'],
    ['ad', '1'],
    ['featured-snippet', '1'],
    ['people-also-ask', '2'],
  ]);
  // Who owns page 1: organic results only (the ad and the snippet are not counted).
  await expect(page.getByTestId('serp-ownership')).toContainText('Who owns page 1');
  const rows = page.getByTestId('serp-ownership-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-domain', 'brewguide.example');
  await expect(rows.nth(0).getByTestId('serp-ownership-count')).toHaveText('2');
  await expect(rows.nth(0).getByTestId('serp-ownership-share')).toHaveText('67%');
  await expect(rows.nth(0).getByTestId('serp-ownership-positions')).toHaveText('1, 3');
  await expect(rows.nth(1)).toHaveAttribute('data-domain', 'leafhouse.example');
  await expect(rows.nth(1).getByTestId('serp-ownership-share')).toHaveText('33%');
  await expect(page.getByTestId('serp-ownership-note')).toHaveCount(0);
  // The results in page order.
  const results = await page.getByTestId('serp-result').evaluateAll((items) => items.map((item) => item.getAttribute('data-type')));
  expect(results).toEqual(['ad', 'featured-snippet', 'organic', 'organic', 'people-also-ask', 'people-also-ask', 'organic']);
  // The tables are real table markup with header cells.
  await expect(page.getByTestId('serp-ownership-table').locator('thead th')).toHaveCount(4);
  await expect(page.getByTestId('serp-ownership-table').locator('tbody th[scope="row"]')).toHaveCount(2);
});

test('serp-params-per-tab', async () => {
  await ensurePack();
  await load(searchUrl('green tea', '&gl=uk&hl=en'));
  await openPanel('serp');
  await expect(page.getByTestId('serp-param-gl')).toHaveText('uk', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-hl')).toHaveText('en');
  await expect(page.getByTestId('serp-param-engine')).toHaveText('Frost test search');
  await expect(page.getByTestId('serp-param-query')).toHaveText('green tea');
  await expect(page.getByTestId('serp-param-device')).toHaveText('Desktop');
  await expect(page.getByTestId('serp-param-page')).toHaveText('1');
  await h.menu('new-tab');
  await expect(h.strip()).toHaveCount(2);
  await load(searchUrl('green tea', '&gl=de&hl=de&start=10'));
  await expect(page.getByTestId('serp-param-gl')).toHaveText('de', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-hl')).toHaveText('de');
  await expect(page.getByTestId('serp-param-page')).toHaveText('2');
  // Back to the first tab: its own parameters.
  await h.strip().nth(0).click();
  await expect(page.getByTestId('serp-param-gl')).toHaveText('uk', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-hl')).toHaveText('en');
  await expect(page.getByTestId('serp-param-page')).toHaveText('1');
  await h.strip().nth(1).click();
  await expect(page.getByTestId('serp-param-gl')).toHaveText('de', { timeout: READ_WAIT });
});

test('serp-outlines-isolated', async () => {
  await ensurePack();
  const id = await load(searchUrl('green tea'));
  await openPanel('serp');
  await expect(panelState()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  // What the page's main world has before the outlines.
  const globals = (await h.run(id, 'Object.getOwnPropertyNames(window).sort()')) as string[];
  const children = (await h.run(id, 'document.documentElement.children.length')) as number;
  await page.getByTestId('serp-outlines').click();
  await expect(page.getByTestId('serp-outlines')).toHaveAttribute('aria-pressed', 'true');
  // Drawn in the SERP world: one box per organic result and ad, one per feature block.
  await expect.poll(() => inSerpWorld(id, `(() => { const s = globalThis[${JSON.stringify(SERP_OUTLINE_KEY)}]; return s ? s.boxes() : null; })()`), { timeout: READ_WAIT }).toBe(6);
  // The main world sees no new global and nothing of the overlay but its host element, whose root is closed.
  expect(((await h.run(id, 'Object.getOwnPropertyNames(window).sort()')) as string[]).filter((name) => !globals.includes(name))).toEqual([]);
  expect(await h.run(id, `typeof window[${JSON.stringify(SERP_OUTLINE_KEY)}]`)).toBe('undefined');
  const host = (await h.run(
    id,
    `(() => { const extra = [...document.documentElement.children].slice(${children}); return extra.map((el) => ({ shadow: el.shadowRoot === null, children: el.childElementCount, text: el.textContent })); })()`,
  )) as { shadow: boolean; children: number; text: string }[];
  expect(host.length).toBeLessThanOrEqual(1);
  for (const el of host) expect(el).toEqual({ shadow: true, children: 0, text: '' });
  // The page's text is untouched: no label is in its DOM.
  expect(await h.run(id, 'document.body.innerText.includes("Organic 1")')).toBe(false);
  // A navigation removes them, and the toggle is off.
  const next = await load(searchUrl('black tea'));
  await expect(panelState()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-outlines')).toHaveAttribute('aria-pressed', 'false');
  expect(await inSerpWorld(next, `(() => { const s = globalThis[${JSON.stringify(SERP_OUTLINE_KEY)}]; return s ? s.boxes() : null; })()`)).toBeNull();
  expect(await h.run(next, `document.documentElement.children.length`)).toBe(children);
  // Leaving the panel turns them off too.
  await page.getByTestId('serp-outlines').click();
  await expect(page.getByTestId('serp-outlines')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => inSerpWorld(next, `(() => { const s = globalThis[${JSON.stringify(SERP_OUTLINE_KEY)}]; return s ? s.boxes() : null; })()`), { timeout: READ_WAIT }).toBe(6);
  await railItem('overview').click();
  await expect.poll(() => inSerpWorld(next, `(() => { const s = globalThis[${JSON.stringify(SERP_OUTLINE_KEY)}]; return s ? s.boxes() : null; })()`), { timeout: READ_WAIT }).toBeNull();
  await openPanel('serp');
  await expect(page.getByTestId('serp-outlines')).toHaveAttribute('aria-pressed', 'false');
});

test('serp-unreadable-layout', async () => {
  await ensurePack();
  await load(searchUrl('green tea', '&layout=new'));
  await openPanel('serp');
  await expect(page.getByTestId('serp-state')).toHaveAttribute('data-state', 'unreadable', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-state')).toHaveAttribute('data-reason', 'no-container');
  await expect(page.getByTestId('serp-state-title')).toHaveText('Couldn’t read this layout');
  await expect(page.getByTestId('serp-state-message')).toHaveText(SERP_UNREADABLE_MESSAGES['no-container']);
  // The search parameters are still shown, and the update check is offered.
  await expect(page.getByTestId('serp-param-query')).toHaveText('green tea');
  await expect(page.getByTestId('serp-pack-update')).toBeEnabled();
  // Nothing is guessed: no composition.
  await expect(page.getByTestId('serp-composition')).toHaveCount(0);
});

test('serp-not-a-result-page', async () => {
  await ensurePack();
  await load(`${engine.origin}/about`);
  await openPanel('serp');
  await expect(page.getByTestId('serp-state')).toHaveAttribute('data-state', 'not-serp', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-state-title')).toHaveText(SERP_NOT_SERP_MESSAGE);
  await expect(page.getByTestId('serp-params')).toHaveCount(0);
});

test('serp-intent-fake', async () => {
  await ensurePack();
  await load(searchUrl('buy green tea'));
  await openPanel('serp');
  await expect(panelState()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  // The real utility process, running the deterministic fake engine.
  await expect(page.getByTestId('serp-intent')).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-intent-label')).toHaveText(INTENT_LABEL_NAMES.transactional);
  await expect(page.getByTestId('serp-intent-confidence')).toHaveText(/^\d{1,3}%$/);
  // The Visibility panel's query box classifies any typed query, locally.
  await openPanel('visibility');
  await page.getByTestId('visibility-query-input').fill('how to brew green tea');
  await page.getByTestId('visibility-classify').click();
  await expect(page.getByTestId('visibility-intent-result')).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('visibility-intent-label')).toHaveText(INTENT_LABEL_NAMES.informational);
  await expect(page.getByTestId('visibility-intent-confidence')).toHaveText(/^\d{1,3}%$/);
  expect(crawlerRequests()).toEqual([]);
});
