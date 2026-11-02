// Specs: specs/gsc-inspection.spec.ts (GSC_INSPECTION_COPY, GSC_CANONICAL_MATCH, GSC_INSPECTION_VERDICTS,
// GSC_INDEXING_STATES, GSC_ROBOTS_TXT_STATES, GSC_PAGE_FETCH_STATES, GSC_CRAWLED_AS, GSC_RICH_SEVERITIES,
// GSC_INSPECTION_LINK_HOST, GSC_INSPECTION_RATE), specs/gsc.spec.ts (GSC_ENDPOINT_ENV.inspectionBase)
// Acceptance: specs/gsc-inspection.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  GSC_CANONICAL_MATCH,
  GSC_CRAWLED_AS,
  GSC_INDEXING_STATES,
  GSC_INSPECTION_COPY,
  GSC_INSPECTION_LINK_HOST,
  GSC_INSPECTION_RATE,
  GSC_INSPECTION_VERDICTS,
  GSC_PAGE_FETCH_STATES,
  GSC_RICH_SEVERITIES,
  GSC_ROBOTS_TXT_STATES,
} from '@app/specs/gsc-inspection.spec';
import { accountHelpers, fakeAccountEnv } from './account-helpers';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { fakeInspection, startFakeGoogle, type FakeGoogle } from './fake-google';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

// URL Inspection end to end, on the fake Google (`fake-google.ts`, `FROST_GSC_INSPECTION_BASE` through
// `google.env`): the Indexability card ("Google's view") and the Schema card ("Detected by Google")
// over one shared answer per page, asked for only by a click. One app for the file, connected once
// (never signed in to frost); each test uses a page of its own, so no test reads another's cached answer.

const LAST_CRAWL = '2026-10-20T08:15:30Z';
/** The JSON-LD each page carries (a breadcrumb trail, and a product on `/guide/rich`). */
const BREADCRUMBS = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Guides', item: '/guide/' }] });
const PRODUCT = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Green tea tin' });

function html(title: string, canonical: string, jsonLd: readonly string[]): string {
  const blocks = jsonLd.map((block) => `<script type="application/ld+json">${block}</script>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page Google inspects."><link rel="canonical" href="${canonical}">${blocks}</head><body><h1>${title}</h1><p>Green tea leaves, steamed and rolled.</p></body></html>`;
}

async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const page = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (pathname === '/robots.txt') return void response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    if (pathname === '/guide/rich') return page(html('A tin of green tea', '/guide/rich', [BREADCRUMBS, PRODUCT]));
    if (pathname.startsWith('/guide/')) return page(html(`Guide ${pathname.slice(7)}`, pathname, [BREADCRUMBS]));
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let backend: FakeBackend;
let google: FakeGoogle;
let site: Awaited<ReturnType<typeof startSite>>;
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;
const { go, press, chromeCaughtUp } = chromeHelpers(
  () => app!,
  () => page,
);
const { recordOpenExternal, openedUrls, connectInSettings } = accountHelpers(
  () => app!,
  () => page,
);

const url = (pathname: string) => `${site.origin}${pathname}`;
const railItem = (id: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${id}"]`);
const card = (kind: 'index' | 'rich') => page.locator(`[data-testid="gsc-inspection"][data-kind="${kind}"]`);
const action = (kind: 'index' | 'rich') => card(kind).getByTestId('gsc-inspection-action');
const inspectRequests = () => google.requests.filter((request) => request === 'POST /v1/urlInspection/index:inspect');

/** Opens Settings from the command palette (its `settings.open` action). */
async function openSettings(): Promise<void> {
  await press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill('settings');
  await page.locator('[data-testid="command-palette-option"][data-action="settings.open"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
}

/** Opens `panel` on the tab's ready audit. */
async function openPanel(panel: 'indexability' | 'schema'): Promise<void> {
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `pathname` and waits for its audit (the Overview's dot). */
async function load(pathname: string): Promise<void> {
  await go(url(pathname));
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', new RegExp(url(pathname.split('#')[0]!).replace(/[.?*+^$()[\]{}|\\]/g, '\\$&')), { timeout: 20_000 });
  await expect(railItem('overview')).toHaveAttribute('data-status', /^(pass|warn|error)$/, { timeout: 20_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  backend = await startFakeBackend();
  google = await startFakeGoogle();
  site = await startSite();
  google.sites = [{ siteUrl: `${site.origin}/`, permissionLevel: 'siteOwner' }];
  // Google's answer per page: `/guide/moved` was folded into `/guide/tea`; `/guide/rich` has a product
  // with an error and two warnings beside its breadcrumbs; every other page is the fake's indexed page.
  google.inspection = (inspectionUrl, siteUrl) => {
    const answer = fakeInspection(inspectionUrl, siteUrl) as { inspectionResult: Record<string, Record<string, unknown>> };
    const result = answer.inspectionResult;
    if (inspectionUrl === url('/guide/moved')) {
      result.indexStatusResult = {
        ...result.indexStatusResult,
        verdict: 'NEUTRAL',
        coverageState: 'Duplicate, Google chose different canonical than user',
        googleCanonical: url('/guide/tea'),
        userCanonical: inspectionUrl,
        crawledAs: 'DESKTOP',
        lastCrawlTime: LAST_CRAWL,
      };
    }
    if (inspectionUrl === url('/guide/rich')) {
      result.richResultsResult = {
        verdict: 'FAIL',
        detectedItems: [
          {
            richResultType: 'Product snippets',
            items: [
              {
                name: 'Green tea tin',
                issues: [
                  { issueMessage: 'Missing field "review"', severity: 'WARNING' },
                  { issueMessage: 'Missing field "offers"', severity: 'ERROR' },
                  { issueMessage: 'Missing field "brand"', severity: 'WARNING' },
                ],
              },
            ],
          },
          { richResultType: 'Breadcrumbs', items: [{ name: 'Guides', issues: [] }] },
        ],
      };
    }
    return answer;
  };
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-gsc-inspection-'));
  ({ app, page } = await launchApp([], { userDataDir: profile, env: fakeAccountEnv(backend, google) }));
  await page.waitForLoadState('domcontentloaded');
  await recordOpenExternal();
  await chromeCaughtUp();
  // Connect (Settings' Search Console section, through the stand-in browser).
  await openSettings();
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await connectInSettings();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);
});

test.afterAll(async () => {
  await closeApp(app);
  await backend?.close();
  await google?.close();
  await site?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('inspection-only-on-click', async () => {
  // Loading the page, then showing both cards (and moving between them) asks Google nothing.
  await load('/guide/tea#brewing');
  await openPanel('indexability');
  await expect(card('index')).toHaveAttribute('data-state', 'idle');
  await expect(card('index').getByTestId('gsc-inspection-message')).toHaveText(GSC_INSPECTION_COPY.states.idle.message);
  await expect(action('index')).toHaveText(GSC_INSPECTION_COPY.states.idle.actionLabel);
  await openPanel('schema');
  await expect(card('rich')).toHaveAttribute('data-state', 'idle');
  await openPanel('indexability');
  await expect(card('index')).toHaveAttribute('data-state', 'idle');
  // Loading it again does not either.
  await go(url('/guide/tea#brewing'));
  await expect(card('index')).toHaveAttribute('data-state', 'idle');
  expect(inspectRequests()).toEqual([]);
  expect(google.inspections).toEqual([]);

  // One click: one request, exactly the page (its fragment dropped) and its property.
  await action('index').click();
  await expect(card('index')).toHaveAttribute('data-state', 'ok');
  expect(google.inspections.map((inspection) => inspection.body)).toEqual([{ inspectionUrl: url('/guide/tea'), siteUrl: `${site.origin}/` }]);
  await expect(card('index').getByTestId('gsc-inspection-message')).toHaveText(GSC_INSPECTION_COPY.states.ok.message);
  // The Schema card shows the same answer without asking again.
  await openPanel('schema');
  await expect(card('rich')).toHaveAttribute('data-state', 'ok');
  await expect(card('rich').getByTestId('gsc-inspection-rich-type')).toHaveText(['Breadcrumbs']);
  expect(inspectRequests()).toHaveLength(1);
  // "Inspect again" asks once more.
  await expect(action('rich')).toHaveText(GSC_INSPECTION_COPY.states.ok.actionLabel);
  await action('rich').click();
  await expect.poll(() => inspectRequests().length).toBe(2);
  await expect(card('rich')).toHaveAttribute('data-state', 'ok');
  await expect(card('rich')).toHaveAttribute('data-pending', 'false');
  expect(inspectRequests()).toHaveLength(2);
});

test('inspection-index-and-canonical-card', async () => {
  await load('/guide/moved');
  await openPanel('indexability');
  const status = await railItem('indexability').getAttribute('data-status');
  await action('index').click();
  const index = card('index');
  await expect(index).toHaveAttribute('data-state', 'ok');
  // Google's view of the page, in frost's words.
  await expect(index.getByTestId('gsc-inspection-verdict')).toHaveText(GSC_INSPECTION_VERDICTS.NEUTRAL);
  await expect(index.getByTestId('gsc-inspection-coverage')).toHaveText('Duplicate, Google chose different canonical than user');
  await expect(index.getByTestId('gsc-inspection-indexing')).toHaveText(GSC_INDEXING_STATES.INDEXING_ALLOWED);
  await expect(index.getByTestId('gsc-inspection-robots')).toHaveText(GSC_ROBOTS_TXT_STATES.ALLOWED);
  await expect(index.getByTestId('gsc-inspection-fetch')).toHaveText(GSC_PAGE_FETCH_STATES.SUCCESSFUL);
  await expect(index.getByTestId('gsc-inspection-crawled-as')).toHaveText(GSC_CRAWLED_AS.DESKTOP);
  // The last crawl: relative, then absolute.
  await expect(index.getByTestId('gsc-inspection-last-crawl')).toHaveText(/^.+ \(.*2026.*\)$/);
  // Google's canonical next to the page's (as Google read it) and frost's: Google chose another URL.
  await expect(index.getByTestId('gsc-inspection-google-canonical')).toHaveText(url('/guide/tea'));
  await expect(index.getByTestId('gsc-inspection-user-canonical')).toHaveText(url('/guide/moved'));
  await expect(index.getByTestId('gsc-inspection-user-canonical-match')).toHaveAttribute('data-match', 'google-differs');
  await expect(index.getByTestId('gsc-inspection-user-canonical-match')).toHaveText(GSC_CANONICAL_MATCH['google-differs']);
  await expect(index.getByTestId('gsc-inspection-audit-canonical')).toHaveText(url('/guide/moved'));
  await expect(index.getByTestId('gsc-inspection-audit-canonical-match')).toHaveAttribute('data-match', 'google-differs');
  await expect(index.getByTestId('gsc-inspection-canonical-fact')).toHaveText(GSC_INSPECTION_COPY.text.canonicalFact);
  // A fact, not a rule: the panel's status is what it was.
  if (status === null) await expect(railItem('indexability')).not.toHaveAttribute('data-status', /.*/);
  else await expect(railItem('indexability')).toHaveAttribute('data-status', status);
  // Google's strings are inert, isolated text.
  expect(await index.locator('[data-google-text]').evaluateAll((nodes) => nodes.every((node) => node.tagName === 'BDI' && node.getAttribute('dir') === 'auto' && node.children.length === 0))).toBe(true);

  // "Open in Search Console": main opens its own cached link (on Google's host); the chrome never has it.
  const link = (fakeInspection(url('/guide/moved'), `${site.origin}/`) as { inspectionResult: { inspectionResultLink: string } }).inspectionResult.inspectionResultLink;
  expect(new URL(link).host).toBe(GSC_INSPECTION_LINK_HOST);
  const before = google.requests.length;
  const opened = (await openedUrls()).length;
  await index.getByTestId('gsc-inspection-open').click();
  await expect(index).toContainText(GSC_INSPECTION_COPY.openResults.opened);
  expect((await openedUrls()).slice(opened)).toEqual([link]);
  expect(google.requests.length).toBe(before);
  const chrome = await page.evaluate(() => document.documentElement.outerHTML);
  expect(chrome.includes('search.google.com')).toBe(false);
  expect(await page.locator('a[href*="search.google.com"]').count()).toBe(0);
});

test('inspection-rich-results-in-schema', async () => {
  await load('/guide/rich');
  await openPanel('schema');
  await action('rich').click();
  const rich = card('rich');
  await expect(rich).toHaveAttribute('data-state', 'ok');
  await expect(rich.getByTestId('gsc-inspection-rich-verdict')).toHaveText(GSC_INSPECTION_VERDICTS.FAIL);
  await expect(rich.getByTestId('gsc-inspection-rich-type')).toHaveText(['Product snippets', 'Breadcrumbs']);
  await expect(rich.getByTestId('gsc-inspection-rich-item-name')).toHaveText(['Green tea tin', 'Guides']);
  const product = rich.getByTestId('gsc-inspection-rich-item').first();
  await expect(product).toHaveAttribute('data-issues', '3');
  // The issues by severity: the error first, then the warnings (in Google's order within each).
  const groups = product.getByTestId('gsc-inspection-issue-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute('data-severity', 'ERROR');
  await expect(groups.nth(1)).toHaveAttribute('data-severity', 'WARNING');
  await expect(groups.nth(0)).toContainText(`${GSC_RICH_SEVERITIES.ERROR}`);
  await expect(groups.nth(0).getByTestId('gsc-inspection-issue')).toHaveText(['Missing field "offers"']);
  await expect(groups.nth(1).getByTestId('gsc-inspection-issue')).toHaveText(['Missing field "review"', 'Missing field "brand"']);
  const crumbs = rich.getByTestId('gsc-inspection-rich-item').nth(1);
  await expect(crumbs).toHaveAttribute('data-issues', '0');
  await expect(crumbs).toContainText(GSC_INSPECTION_COPY.text.noIssues);
  // The Indexability card has the same answer, unasked.
  await openPanel('indexability');
  await expect(card('index')).toHaveAttribute('data-state', 'ok');
  expect(google.inspections.filter((inspection) => inspection.body.inspectionUrl === url('/guide/rich'))).toHaveLength(1);
});

test('inspection-quota-message', async () => {
  await load('/guide/limit');
  await openPanel('indexability');
  const index = card('index');
  // frost's own inspection bucket (GSC_INSPECTION_RATE) answers `quota` unsent when empty, and the
  // other tests just spent from it: let it refill to its burst, so each of the three clicks below is sent.
  await page.waitForTimeout((GSC_INSPECTION_RATE.burst / GSC_INSPECTION_RATE.perSecond) * 1_000);
  // Every request reached the fake (a refusal is answered before the fake reads the body).
  const start = inspectRequests().length;
  const asked = () => inspectRequests().length - start;
  try {
    // Google's 429: the quota message and Try again (nothing kept).
    google.inspectionMode = 'quota';
    await action('index').click();
    await expect(index).toHaveAttribute('data-state', 'quota');
    await expect(index.getByTestId('gsc-inspection-message')).toHaveText(GSC_INSPECTION_COPY.states.quota.message);
    await expect(action('index')).toHaveText(GSC_INSPECTION_COPY.states.quota.actionLabel!);
    expect(asked()).toBe(1);
    // An answer frost cannot read: its own message, and Try again again.
    google.inspectionMode = 'garbage';
    await action('index').click();
    await expect(index).toHaveAttribute('data-state', 'invalid');
    await expect(index.getByTestId('gsc-inspection-message')).toHaveText(GSC_INSPECTION_COPY.states.invalid.message);
    expect(asked()).toBe(2);
    // Google answers again: Try again shows the answer.
    google.inspectionMode = null;
    await action('index').click();
    await expect(index).toHaveAttribute('data-state', 'ok');
    expect(asked()).toBe(3);
  } finally {
    google.inspectionMode = null;
  }
});
