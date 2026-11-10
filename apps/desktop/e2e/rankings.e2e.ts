// Specs: specs/rankings.spec.ts (RANK_CSV_COLUMNS, RANK_VIEW_TEXT), specs/ai-destinations.spec.ts
// (AI_SEARCH_DESTINATIONS, aiDestinationUrl, openDestinationMessage), specs/serp-selector-pack.spec.ts
// (the e2e seams), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH)
// Acceptance: specs/rankings.feature.md (End to end), specs/serp-panels.feature.md (End to end,
// rankings.e2e.ts), specs/projects.feature.md (Bulk add). Plan phase-10 Task 11.
// View model: apps/desktop/src/renderer/rankings-view.ts (trendPoints, the trend's label).
// Loopback only: the synthetic engine and the result domains map to 127.0.0.1, the AI destinations,
// Google and every other name to `~NOTFOUND` (rank-fixtures.ts). Saved searches use the bundled pack's real engines, so no
// run is started here: the run disclosure, pacing and challenge stop are unit-tested.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AI_SEARCH_DESTINATIONS, aiDestinationUrl, openDestinationMessage } from '@app/specs/ai-destinations.spec';
import { RANK_CSV_COLUMNS, RANK_VIEW_TEXT, type RankPoint } from '@app/specs/rankings.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { trendPoints } from '../src/renderer/rankings-view';
import { COMPETITOR_HOST, NEW_HOST, OTHER_HOST, PACK_VERSION, SEARCH_HOST, SITE_HOST, startRankEngine } from './rank-fixtures';

const READ_WAIT = 20_000;
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;
const PROJECT = 'Leaf house';
const QUERY = 'green tea';
/** A query a spreadsheet would read as a formula: the CSV must guard it. */
const FORMULA_QUERY = '=SUM(1,2)';
const TAG = 'teas';

// The scenarios build on each other (one project, its readings and searches): in order, one after another.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let app: ElectronApplication;
let page: Page;
let engine: Awaited<ReturnType<typeof startRankEngine>>;
const h = chromeHelpers(
  () => app,
  () => page,
);

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const serpPanel = () => page.getByTestId('serp-panel');
const changes = () => page.getByTestId('changes');
const captureButton = () => page.getByTestId('changes-capture');
const sheet = () => page.getByTestId('projects-view');
const rows = () => page.getByTestId('rankings-row');
const searchUrl = (query: string, extra = '') => `${engine.origin}/search?q=${encodeURIComponent(query).replace(/%20/g, '+')}${extra}`;
/**
 * Requests on the fixture server's port for any host but the synthetic engine's. (The result domains are
 * mapped to loopback so nothing of theirs reaches the network, but nothing listens on their ports: a
 * request for one fails there and is not counted here.)
 */
const offEngineRequests = () => engine.seen.filter((entry) => entry.host !== SEARCH_HOST);

/** Opens the sidebar on `panel` (if it is not open on it already). */
async function openPanel(panel: 'serp' | 'changes'): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Installs the test pack through "Check for selector updates" unless it is in use already. */
async function ensurePack(): Promise<void> {
  await openPanel('serp');
  const status = page.getByTestId('serp-pack-status');
  if ((await status.getAttribute('data-version')) === String(PACK_VERSION)) return;
  await page.getByTestId('serp-pack-update').click();
  await expect(status).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: READ_WAIT });
}

/** Waits, in the SERP panel, for the reading of `query` whose site result is at `sitePosition`. */
async function waitForReading(query: string, sitePosition: string): Promise<void> {
  await openPanel('serp');
  await expect(serpPanel()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-query')).toHaveText(query, { timeout: READ_WAIT });
  const site = page.locator(`[data-testid="serp-ownership-row"][data-domain="${SITE_HOST}"]`);
  await expect(site.getByTestId('serp-ownership-positions')).toHaveText(sitePosition, { timeout: READ_WAIT });
}

/** Waits, in the Changes panel, for the settled audit of `url` (Capture now enabled). */
async function waitForAudit(url: string): Promise<void> {
  await openPanel('changes');
  await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${url}⁩`, { timeout: AUDIT_WAIT });
  await expect(changes()).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
  await expect(captureButton()).toBeEnabled({ timeout: AUDIT_WAIT });
}

/** Loads the result page of `query`; resolves once both its audit and its reading (the site at `sitePosition`) are in. */
async function loadSearch(query: string, sitePosition: string): Promise<string> {
  const url = searchUrl(query);
  await h.go(url);
  await waitForAudit(url);
  await waitForReading(query, sitePosition);
  return url;
}

/** Captures the tab's page into the project from the Changes panel; waits for `outcome`. */
async function captureIntoProject(outcome: string): Promise<void> {
  await openPanel('changes');
  await expect(captureButton()).toBeEnabled({ timeout: AUDIT_WAIT });
  await page.getByTestId('changes-project').selectOption({ label: PROJECT });
  await expect(page.getByTestId('changes-project').locator('option:checked')).toHaveText(PROJECT);
  await captureButton().click();
  await expect(page.getByTestId('changes-capture-status')).toHaveAttribute('data-outcome', outcome, { timeout: AUDIT_WAIT });
}

/** Opens the Projects sheet on the project (from the Changes panel), in `view`. */
async function openProject(view: 'overview' | 'rankings' | 'compare' | 'settings'): Promise<void> {
  if ((await sheet().count()) === 0) {
    await openPanel('changes');
    await page.getByTestId('changes-open-projects').click();
    await expect(sheet()).toBeVisible();
  }
  await page.locator('[data-testid="projects-item"]').filter({ hasText: PROJECT }).getByTestId('projects-item-open').click();
  await expect(page.getByTestId('projects-name')).toHaveText(PROJECT);
  await page.getByTestId(`projects-view-${view}`).click();
  await expect(page.getByTestId('projects-detail')).toHaveAttribute('data-view', view);
}

async function closeSheet(): Promise<void> {
  if ((await sheet().count()) === 0) return;
  await page.getByTestId('projects-close').click();
  await expect(sheet()).toHaveCount(0);
}

const rowOf = (query: string) => rows().filter({ has: page.getByTestId('rankings-row-open').filter({ hasText: query }) });

test.beforeAll(async () => {
  engine = await startRankEngine();
  ({ app, page } = await launchApp(engine.args));
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await engine?.close();
});

test('rankings-two-captures-show-change', async () => {
  await ensurePack();
  // The synthetic result page: the site is third (the site's ad above never counts).
  const url = await loadSearch(QUERY, '3');
  expect(engine.requestsFor(QUERY)).toBeGreaterThanOrEqual(1);
  // A project with the site and a competitor (Settings).
  await openPanel('changes');
  await page.getByTestId('changes-open-projects').click();
  await expect(sheet()).toBeVisible();
  await page.getByTestId('projects-create-name').fill(PROJECT);
  await page.getByTestId('projects-create').click();
  await expect(page.getByTestId('projects-name')).toHaveText(PROJECT);
  await page.getByTestId('projects-view-settings').click();
  await page.getByTestId('projects-site-input').fill(SITE_HOST);
  await expect(page.getByTestId('projects-site-subdomains')).toBeChecked();
  await page.getByTestId('projects-site-save').click();
  await expect(page.getByTestId('projects-site-clear')).toBeVisible();
  await expect(page.getByTestId('projects-site-input')).toHaveValue(SITE_HOST);
  await page.getByTestId('projects-competitor-input').fill(COMPETITOR_HOST);
  await page.getByTestId('projects-competitor-add').click();
  await expect(page.getByTestId('projects-competitor')).toHaveAttribute('data-domain', COMPETITOR_HOST);
  await closeSheet();

  // Captured into the project.
  await captureIntoProject('first');
  // Reloaded, the engine answers a new order: the site is second. Captured again.
  const before = await changes().getAttribute('data-audit-at');
  await page.getByTestId('reload').click();
  await expect(changes()).not.toHaveAttribute('data-audit-at', before ?? '', { timeout: AUDIT_WAIT });
  await waitForAudit(url);
  await waitForReading(QUERY, '2');
  await captureIntoProject('new');

  // Rankings: position 3 → 2, change +1, two trend points, the competitor's column.
  await openProject('rankings');
  await expect(rows()).toHaveCount(1, { timeout: READ_WAIT });
  const row = rowOf(QUERY);
  await expect(row).toHaveAttribute('data-outcome', 'ranked');
  await expect(row.getByTestId('rankings-position')).toHaveText('2');
  await expect(row.locator('.rankings-change')).toHaveText('+1');
  await expect(row.locator('.rankings-change')).toHaveAttribute('data-direction', 'up');
  const trend = row.getByTestId('rankings-trend');
  // The label the view model builds for a series ranked 3, then 2.
  const ranked = (readingId: string, position: number): RankPoint => ({ readingId, at: 0, outcome: 'ranked', position, url: null, organicRead: 4, page: 1, alsoIn: [] });
  await expect(trend).toHaveAttribute('aria-label', trendPoints([ranked('a', 3), ranked('b', 2)]).label);
  expect(((await trend.locator('polyline').getAttribute('points')) ?? '').trim().split(/\s+/)).toHaveLength(2);
  await expect(page.locator(`[data-testid="rankings-table"] thead th[data-competitor="${COMPETITOR_HOST}"]`)).toHaveText(COMPETITOR_HOST);
  await expect(row.locator(`[data-competitor="${COMPETITOR_HOST}"]`)).toHaveText('1');
  // Its series: both readings, newest first.
  await row.getByTestId('rankings-row-open').click();
  await expect(page.getByTestId('rankings-series-point')).toHaveCount(2, { timeout: READ_WAIT });
  await expect(page.getByTestId('rankings-series-point').locator('td.rankings-number')).toHaveText(['2', '3']);
  await expect(page.getByTestId('rankings-series-point').first().locator('.rankings-url')).toContainText(`https://${SITE_HOST}/`);
  // Nothing went anywhere but the synthetic engine.
  expect(offEngineRequests()).toEqual([]);
});

test('rankings-compare-two-dates', async () => {
  await openProject('compare');
  // It opens on the search, A on its older reading and B on its newer.
  await expect(page.getByTestId('compare-search-a').locator('option:checked')).toHaveText(new RegExp(QUERY));
  await expect(page.getByTestId('compare-date-a').locator('option')).toHaveCount(2, { timeout: READ_WAIT });
  await expect(page.getByTestId('compare-date-b').locator('option')).toHaveCount(2);
  expect(await page.getByTestId('compare-date-a').inputValue()).not.toBe(await page.getByTestId('compare-date-b').inputValue());
  await expect(page.getByTestId('compare-run')).toBeEnabled({ timeout: READ_WAIT });
  await page.getByTestId('compare-run').click();
  const domain = (host: string) => page.locator(`[data-testid="compare-row"][data-domain="${host}"]`);
  // The site moved up, the competitor stayed first, a new domain came in, another went down.
  await expect(domain(SITE_HOST)).toHaveAttribute('data-movement', 'up', { timeout: READ_WAIT });
  await expect(domain(SITE_HOST)).toHaveAttribute('data-role', 'site');
  await expect(domain(COMPETITOR_HOST)).toHaveAttribute('data-movement', 'same');
  await expect(domain(COMPETITOR_HOST)).toHaveAttribute('data-role', 'competitor');
  await expect(domain(NEW_HOST)).toHaveAttribute('data-movement', 'new');
  await expect(domain(OTHER_HOST)).toHaveAttribute('data-movement', 'down');
  await expect(page.getByTestId('compare-row')).toHaveCount(4);
  expect(offEngineRequests()).toEqual([]);
});

test('rankings-copy-csv', async () => {
  // A second search, whose query a spreadsheet would read as a formula, captured once.
  await closeSheet();
  await loadSearch(FORMULA_QUERY, '3');
  await captureIntoProject('first');
  await openProject('rankings');
  await expect(rows()).toHaveCount(2, { timeout: READ_WAIT });
  // Copy CSV: main writes its own clipboard.
  await app.evaluate(({ clipboard }) => clipboard.writeText('before'));
  await expect(page.getByTestId('rankings-export-kind')).toHaveValue('table');
  await page.getByTestId('rankings-copy-csv').click();
  await expect(page.getByTestId('projects-status')).toHaveText(RANK_VIEW_TEXT.copied.replace('{n}', '2'), { timeout: READ_WAIT });
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('before');
  const text = await app.evaluate(({ clipboard }) => clipboard.readText());
  // CRLF lines with a final CRLF: the header, then one line per search (the newest observed first).
  expect(text.endsWith('\r\n')).toBe(true);
  const lines = text.slice(0, -2).split('\r\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe([...RANK_CSV_COLUMNS, COMPETITOR_HOST].join(','));
  // The formula is guarded (a leading ') and quoted (it holds a comma).
  expect(lines[1]!.startsWith(`"'${FORMULA_QUERY}",`)).toBe(true);
  // The other search's numbers stay numbers: position 2, change 1, best 2, the competitor 1.
  const cells = lines[2]!.split(',');
  const at = (column: (typeof RANK_CSV_COLUMNS)[number]) => cells[RANK_CSV_COLUMNS.indexOf(column)];
  expect(cells).toHaveLength(RANK_CSV_COLUMNS.length + 1);
  expect(at('Search')).toBe(QUERY);
  expect(at('Outcome')).toBe('ranked');
  expect(at('Position')).toBe('2');
  expect(at('Change')).toBe('1');
  expect(at('Best')).toBe('2');
  expect(at('URL')).toBe(`https://${SITE_HOST}/`);
  expect(cells.at(-1)).toBe('1');
  expect(offEngineRequests()).toEqual([]);
});

test('projects-bulk-add-with-tags', async () => {
  const requests = engine.seen.length;
  const tabs = await h.browseContents();
  await openProject('overview');
  await page.getByTestId('projects-bulk-open').click();
  await expect(page.getByTestId('projects-bulk')).toBeVisible();
  // Three lines × two devices, one locale, one tag: six searches.
  await page.getByTestId('projects-bulk-text').fill('sencha\nmatcha\noolong');
  await page.getByTestId('projects-bulk-country').fill('us');
  await page.getByTestId('projects-bulk-language').fill('en');
  await expect(page.getByTestId('projects-bulk-device-desktop')).toBeChecked();
  await page.getByTestId('projects-bulk-device-mobile').check();
  await page.getByTestId('projects-bulk-tags').fill(TAG);
  await page.getByTestId('projects-bulk-submit').click();
  const outcomes = page.getByTestId('projects-bulk-outcome');
  await expect(outcomes).toHaveCount(3, { timeout: READ_WAIT });
  for (let index = 0; index < 3; index++) await expect(outcomes.nth(index)).toHaveAttribute('data-outcome', 'added');
  await page.getByTestId('projects-bulk-close').click();
  // Six saved searches, each with the tag.
  const queries = page.getByTestId('projects-query');
  await expect(queries).toHaveCount(6, { timeout: READ_WAIT });
  for (let index = 0; index < 6; index++) await expect(queries.nth(index).getByTestId('projects-query-tags')).toContainText(TAG);
  // Rankings: the saved searches first, then the two observed ones; filtered by the tag, the six only.
  await page.getByTestId('projects-view-rankings').click();
  await expect(rows()).toHaveCount(8, { timeout: READ_WAIT });
  await page.getByTestId('rankings-tag').selectOption(TAG);
  await expect(rows()).toHaveCount(6, { timeout: READ_WAIT });
  for (let index = 0; index < 6; index++) {
    await expect(rows().nth(index)).toHaveAttribute('data-outcome', 'none');
    await expect(rows().nth(index).locator('.rankings-tag')).toHaveText([TAG]);
  }
  await expect(rowOf(QUERY)).toHaveCount(0);
  // Saved only: the fixture server saw no request, and no tab opened.
  expect(engine.seen.length).toBe(requests);
  expect(await h.browseContents()).toEqual(tabs);
  await page.getByTestId('rankings-tag').selectOption('');
  await expect(rows()).toHaveCount(8, { timeout: READ_WAIT });
  await closeSheet();
});

test('serp-editor-applies-country-and-language', async () => {
  // Page 3 of a search in one locale.
  const start = searchUrl(QUERY, '&gl=us&hl=en&start=20');
  await h.go(start);
  await openPanel('serp');
  await expect(serpPanel()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-page')).toHaveText('3', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-gl')).toHaveText('us');
  // Edit search: the synthetic engine offers country and language, by the pack's names.
  await page.getByTestId('serp-edit-open').click();
  await expect(page.getByTestId('serp-editor')).toBeVisible();
  await page.getByTestId('serp-edit-field-gl').selectOption('de');
  await page.getByTestId('serp-edit-field-hl').selectOption('de');
  await page.getByTestId('serp-edit-apply').click();
  // The tab loads the same path with the query, gl and hl only: page 1 again.
  const edited = `${engine.origin}/search?q=${encodeURIComponent(QUERY)}&gl=de&hl=de`;
  await h.contentsIdAt(edited);
  await expect(page.getByTestId('serp-editor')).toHaveCount(0);
  await expect(page.getByTestId('serp-param-gl')).toHaveText('de', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-hl')).toHaveText('de');
  await expect(page.getByTestId('serp-param-page')).toHaveText('1');
  // The browser's load and the audit's own fetch of the served HTML: both in before the next scenario counts requests.
  const editedPath = edited.slice(engine.origin.length);
  await waitForAudit(edited);
  await expect.poll(() => engine.seen.filter((entry) => entry.url === editedPath).length, { timeout: AUDIT_WAIT }).toBe(2);
  expect(offEngineRequests()).toEqual([]);
});

test('serp-open-in-perplexity', async () => {
  const perplexity = AI_SEARCH_DESTINATIONS.find((destination) => destination.id === 'perplexity')!;
  const built = aiDestinationUrl(perplexity, QUERY)!;
  expect(new URL(built).hostname).toBe('www.perplexity.ai');
  await openPanel('serp');
  await expect(serpPanel()).toHaveAttribute('data-state', 'ready', { timeout: READ_WAIT });
  await expect(page.getByTestId('serp-param-query')).toHaveText(QUERY);
  const active = await h.activeTab().getAttribute('data-tab-id');
  const requests = engine.seen.length;
  await expect(h.strip()).toHaveCount(1);
  await page.getByTestId('serp-open-in-perplexity').click();
  // A new background tab whose address is the built URL; the result page stays in front.
  await expect(page.getByTestId('serp-open-in-flash')).toHaveText(openDestinationMessage(perplexity, { status: 'opened', tabId: 0 }), { timeout: READ_WAIT });
  await expect(h.strip()).toHaveCount(2);
  await expect(h.activeTab()).toHaveAttribute('data-tab-id', active ?? '');
  const id = await h.contentsIdAt(built);
  // Nothing loads: the host does not resolve, so the tab ends on its load error.
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id), { timeout: READ_WAIT }).toBe(false);
  await expect(page.locator('[data-testid="tab-item"][data-active="false"] .tab-icon-alert')).toHaveCount(1, { timeout: READ_WAIT });
  // Nothing reached the fixture server, and nothing left loopback.
  expect(engine.seen.length).toBe(requests);
  expect(offEngineRequests()).toEqual([]);
});
