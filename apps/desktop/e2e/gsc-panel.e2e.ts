// Specs: specs/gsc-panel.spec.ts (GSC_PANEL_COPY, GSC_PANEL_TEXT, GSC_SCOPE_LABELS), specs/gsc.spec.ts (gscDateRange,
// GSC_LIMITS), specs/seo-sidebar.spec.ts (SEO_PANELS), specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS)
// Acceptance: specs/gsc-panel.feature.md (End to end)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { GSC_PANEL_COPY } from '@app/specs/gsc-panel.spec';
import { GSC_LIMITS, gscDateRange } from '@app/specs/gsc.spec';
import { accountHelpers, fakeAccountEnv } from './account-helpers';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { fakeDateRows, startFakeGoogle, type FakeGoogle } from './fake-google';
import { closeApp, launchApp, startLoopbackServer } from './harness';
import { chromeHelpers } from './helpers';

test.describe.configure({ mode: 'serial' });

let backend: FakeBackend;
let google: FakeGoogle;
let site: { origin: string; close(): Promise<void> };
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;
const { go, press, chromeCaughtUp } = chromeHelpers(
  () => app!,
  () => page,
);
const { recordOpenExternal, call, accountState, signInInSettings, connectInSettings } = accountHelpers(
  () => app!,
  () => page,
);

const PAGE_PATH = '/blog/post';
const pageUrl = () => `${site.origin}${PAGE_PATH}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

const panel = () => page.getByTestId('gsc-panel');
const notice = () => page.getByTestId('gsc-notice');
const settings = () => page.getByTestId('settings-view');
const railItem = (id: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${id}"]`);
const scopeButton = (scope: 'page' | 'property') => page.locator(`[data-testid="gsc-scope"][data-scope="${scope}"]`);
const rangeButton = (days: number) => page.locator(`[data-testid="gsc-range"][data-days="${days}"]`);
/**
 * Every request to the fake Google's OAuth and Search Console endpoints (`GET /` from a local port
 * probe on the test machine is not Google traffic and not frost's).
 */
const googleCalls = () => google.requests.filter((request) => / \/(o\/oauth2\/|token|revoke|webmasters\/)/.test(request));
/** The fake Google's date-dimension reads, in order. */
const dateQueries = () => google.queries.filter((q) => (q.body.dimensions as string[] | undefined)?.[0] === 'date');

/** Opens the sidebar on the Search Console panel (from the rail). */
async function openPanel(): Promise<void> {
  if ((await page.getByTestId('seo-panel').getAttribute('data-panel').catch(() => null)) !== 'search-console') await railItem('search-console').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'search-console');
  await expect(panel()).toBeVisible();
}

test.beforeAll(async () => {
  backend = await startFakeBackend();
  backend.plan = 'free';
  google = await startFakeGoogle();
  site = await startLoopbackServer();
  google.sites = [{ siteUrl: `${site.origin}/`, permissionLevel: 'siteOwner' }];
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-gsc-panel-'));
  ({ app, page } = await launchApp([], { userDataDir: profile, env: fakeAccountEnv(backend, google) }));
  await page.waitForLoadState('domcontentloaded');
  await recordOpenExternal();
  await chromeCaughtUp();
});

test.afterAll(async () => {
  await closeApp(app);
  await backend?.close();
  await google?.close();
  await site?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('gsc-panel-signed-out', async () => {
  await go(pageUrl());
  // The audit is ready (Overview has its dot) …
  await expect(railItem('overview')).toHaveAttribute('data-status', /^(pass|warn|error)$/);
  // … but Search Console has no rules: no dot.
  await expect(railItem('search-console')).not.toHaveAttribute('data-status', /.*/);
  await expect(railItem('search-console').locator('.seo-rail-dot')).toHaveCount(0);
  await openPanel();
  await expect(panel()).toHaveAttribute('data-state', 'signed-out');
  await expect(page.getByTestId('gsc-notice-title')).toHaveText('Search Console is part of frost Pro');
  await expect(page.getByTestId('gsc-notice-message')).toHaveText(GSC_PANEL_COPY['signed-out'].message);
  // No controls without access.
  await expect(page.getByTestId('gsc-scopes')).toHaveCount(0);
  // Sign in opens Settings on Account.
  await expect(page.getByTestId('gsc-action')).toHaveText('Sign in');
  await page.getByTestId('gsc-action').click();
  await expect(settings()).toBeVisible();
  await expect(page.locator('#settings-section-account')).toBeFocused();
  expect(googleCalls()).toEqual([]);
});

test('gsc-panel-free-plan', async () => {
  // Signed in on a free plan (the Settings sheet the panel opened).
  await signInInSettings();
  expect((await accountState()).entitlements.plan).toBe('free');
  await page.getByTestId('settings-close').click();
  await expect(settings()).toHaveCount(0);
  await openPanel();
  await expect(panel()).toHaveAttribute('data-state', 'needs-pro');
  await expect(page.getByTestId('gsc-notice-title')).toHaveText('Search Console is part of frost Pro');
  await expect(page.getByTestId('gsc-notice-message')).toHaveText(GSC_PANEL_COPY['needs-pro'].message);
  await expect(page.getByTestId('gsc-action')).toHaveText('Account settings');
  // Neither the panel nor anything else asked Google.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(googleCalls()).toEqual([]);
});

test('gsc-panel-not-connected', async () => {
  // The plan becomes Pro (the backend's admin grant): the next refresh brings Search Console.
  backend.plan = 'pro';
  expect(await call('mutation', 'account.refresh')).toBe(true);
  await expect.poll(async () => (await accountState()).entitlements.plan).toBe('pro');
  await expect(panel()).toHaveAttribute('data-state', 'not-connected');
  await expect(page.getByTestId('gsc-notice-title')).toHaveText(GSC_PANEL_COPY['not-connected'].title);
  await expect(page.getByTestId('gsc-action')).toHaveText('Connect in Settings');
  expect(google.queries).toEqual([]);
  // Connect opens Settings on Search Console (connecting itself needs the click there).
  await page.getByTestId('gsc-action').click();
  await expect(settings()).toBeVisible();
  await expect(page.locator('#settings-section-search-console')).toBeFocused();
  await expect(page.getByTestId('gsc-connect')).toBeVisible();
});

test('gsc-panel-page-totals-and-chart', async () => {
  await connectInSettings();
  await page.getByTestId('settings-close').click();
  await expect(settings()).toHaveCount(0);
  await openPanel();
  await expect(panel()).toHaveAttribute('data-state', 'data');
  const range = gscDateRange(28, Date.now());
  // The read: this page (its URL-prefix property), the 28-day range, the page filter.
  const read = dateQueries().at(-1)!;
  expect(read.siteUrl).toBe(`${site.origin}/`);
  expect(read.body).toMatchObject({ startDate: range.start, endDate: range.end, dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl() }] }] });
  await expect(scopeButton('page')).toHaveAttribute('aria-pressed', 'true');
  await expect(rangeButton(28)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('gsc-property-site')).toHaveText(`${site.origin}/`);
  // Totals of the fake rows: 10 + 20 + 30 clicks over 100 + 200 + 300 impressions; position weighted (2·100 + 3·200 + 4·300) / 600.
  await expect(page.getByTestId('gsc-total-clicks')).toHaveText('60');
  await expect(page.getByTestId('gsc-total-impressions')).toHaveText('600');
  await expect(page.getByTestId('gsc-total-ctr')).toHaveText('10.0%');
  await expect(page.getByTestId('gsc-total-position')).toHaveText('3.3');
  // The chart: clicks over the range, one line, its table the fake rows.
  const chart = page.getByTestId('gsc-chart');
  await expect(chart).toHaveAttribute('data-metric', 'clicks');
  await expect(chart).toHaveAttribute('data-inverted', 'false');
  await expect(page.getByTestId('gsc-line')).toHaveCount(1);
  await expect(page.getByTestId('gsc-chart-svg')).toHaveAttribute('role', 'img');
  await expect(page.getByTestId('gsc-chart-svg')).toHaveAttribute('aria-label', new RegExp(`^Clicks per day, ${day(range.start)} to ${day(range.end)}: 60 in total;`));
  const fake = fakeDateRows(range.start);
  const rows = page.getByTestId('gsc-chart-row');
  await expect(rows).toHaveCount(fake.length);
  for (const [i, row] of fake.entries()) {
    await expect(rows.nth(i)).toHaveAttribute('data-date', row.keys[0]!);
    await expect(rows.nth(i)).toHaveAttribute('data-value', String(row.clicks));
  }
  await expect(page.getByTestId('gsc-x-tick')).toHaveCount(3);
  await expect(page.getByTestId('gsc-freshness')).toHaveText(`Search Console data lags about two days; range ${day(range.start)} – ${day(range.end)}.`);
  await page.screenshot({ path: '/tmp/frost-gsc-panel.png' }).catch(() => undefined);
});

test('gsc-panel-property-scope', async () => {
  // The property answers ten times the page's figures.
  google.dateRows = (start) => fakeDateRows(start).map((row) => ({ ...row, clicks: row.clicks * 10, impressions: row.impressions * 10 }));
  const before = dateQueries().length;
  await scopeButton('property').click();
  await expect(scopeButton('property')).toHaveAttribute('aria-pressed', 'true');
  await expect(scopeButton('property')).toHaveAttribute('title', `${site.origin}/`);
  await expect(page.getByTestId('gsc-total-clicks')).toHaveText('600');
  await expect(page.getByTestId('gsc-total-impressions')).toHaveText('6,000');
  await expect(page.getByTestId('gsc-property-site')).toHaveText(`${site.origin}/`);
  expect(dateQueries().length).toBe(before + 1);
  expect(dateQueries().at(-1)!.body).not.toHaveProperty('dimensionFilterGroups');
  // Back to this page: main's cached answer, the page's totals again.
  await scopeButton('page').click();
  await expect(page.getByTestId('gsc-total-clicks')).toHaveText('60');
});

test('gsc-panel-range-change', async () => {
  const before = dateQueries().length;
  await rangeButton(7).click();
  await expect(rangeButton(7)).toHaveAttribute('aria-pressed', 'true');
  const range = gscDateRange(7, Date.now());
  await expect.poll(() => dateQueries().length).toBe(before + 1);
  expect(dateQueries().at(-1)!.body).toMatchObject({ startDate: range.start, endDate: range.end });
  await expect(panel()).toHaveAttribute('data-state', 'data');
  await expect(page.getByTestId('gsc-freshness')).toContainText(`${day(range.start)} – ${day(range.end)}`);
  // No polling: nothing more is asked while the panel just shows.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(dateQueries().length).toBe(before + 1);
});

test('gsc-panel-top-queries', async () => {
  const rows = page.getByTestId('gsc-query-row');
  await expect(rows).toHaveCount(GSC_LIMITS.maxTopQueries);
  await expect(page.getByTestId('gsc-query-text').first()).toHaveText('fake query 1');
  await expect(page.getByTestId('gsc-query-clicks').first()).toHaveText('1,000');
  await expect(page.getByTestId('gsc-query-text').nth(1)).toHaveText('fake query 2');
  const read = google.queries.filter((q) => (q.body.dimensions as string[] | undefined)?.[0] === 'query').at(-1)!;
  expect(read.body).toMatchObject({ rowLimit: GSC_LIMITS.maxTopQueries, startDate: gscDateRange(7, Date.now()).start });
});

test('gsc-panel-position-inverted', async () => {
  const before = google.queries.length;
  await page.locator('[data-testid="gsc-tile"][data-metric="position"]').click();
  await expect(page.locator('[data-testid="gsc-tile"][data-metric="position"]')).toHaveAttribute('aria-pressed', 'true');
  const chart = page.getByTestId('gsc-chart');
  await expect(chart).toHaveAttribute('data-metric', 'position');
  await expect(chart).toHaveAttribute('data-inverted', 'true');
  await expect(page.getByTestId('gsc-chart-svg')).toHaveAttribute('aria-label', /lower is better/);
  // The best position's tick is drawn above the worst's.
  const ticks = await page.getByTestId('gsc-y-tick').evaluateAll((nodes) =>
    nodes.map((node) => ({ value: Number(node.getAttribute('data-value')), y: Number(node.querySelector('line')!.getAttribute('y1')) })),
  );
  const best = ticks.reduce((a, b) => (a.value < b.value ? a : b));
  const worst = ticks.reduce((a, b) => (a.value > b.value ? a : b));
  expect(best.y).toBeLessThan(worst.y);
  // Choosing a metric reads nothing.
  expect(google.queries.length).toBe(before);
  await page.locator('[data-testid="gsc-tile"][data-metric="clicks"]').click();
});

test('gsc-panel-no-property-and-not-web', async () => {
  const port = new URL(site.origin).port;
  const other = `http://localhost:${port}/elsewhere`;
  await go(other);
  await expect(panel()).toHaveAttribute('data-state', 'no-property');
  await expect(page.getByTestId('gsc-notice-message')).toHaveText(`None of your Search Console properties covers localhost:${port}.`);
  await expect(page.getByTestId('gsc-scopes')).toHaveCount(0);
  // A new, empty tab: no web page.
  await press('chrome', 'T', ['mod']);
  await expect(panel()).toHaveAttribute('data-state', 'not-a-web-page');
  await expect(page.getByTestId('gsc-notice-message')).toHaveText(GSC_PANEL_COPY['not-a-web-page'].message);
  await press('chrome', 'W', ['mod']);
  await go(pageUrl());
  await expect(panel()).toHaveAttribute('data-state', 'data');
});

test('gsc-panel-palette-whole-property', async () => {
  await railItem('overview').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill('whole property');
  await page.locator('[data-testid="command-palette-option"][data-action="search-console.whole-property"]').click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'search-console');
  await expect(scopeButton('property')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('gsc-total-clicks')).toHaveText('600');
  // The panel's own jump.
  await railItem('overview').click();
  await press('chrome', 'K', ['mod']);
  await page.getByTestId('command-palette-input').fill('search console panel');
  await page.locator('[data-testid="command-palette-option"][data-action="panel.search-console"]').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'search-console');
  await expect(railItem('search-console')).toBeFocused();
});
