// Specs: specs/site-crawl.spec.ts (CRAWL_CSV_COLUMNS, CRAWL_USER_AGENT_TOKEN, CRAWL_INTERVAL_MS, CRAWL_VIEW_TEXT),
// specs/data-sources.spec.ts (LEGAL_GATES_E2E_SWITCH, LEGAL_GATE_NOTE), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH),
// specs/command-palette.spec.ts (COMMAND_PALETTE_MENU_ID)
// Acceptance: specs/site-crawl.feature.md (End to end; L6, the gate; K-B1), plan docs/plans/phase-12-big-bets.md
// Task 11 (crawl.e2e.ts), Decision 3 (K-B1), Decision 6.
//
// A 50-page loopback site (`crawl-fixtures.ts`) under a public-looking name, crawled from the crawl sheet:
// Pages and Site structure show its pages and outcomes; the run is paused, the app restarted on the same
// profile and the run resumed to its end; the CSV is exported through main's save dialog (answered in main,
// test-only, as agent.e2e.ts answers its dialogs); and the site's own log shows the crawl's politeness
// (K-B1): never more than one fetch call in flight, consecutive fetch-call starts at least the effective
// interval apart (robots.txt's `Crawl-delay`, above the 500 ms the sheet asks for), a redirect's hops
// inside one call. The crawl ships gated (L6): the suite opens the gate with the unpackaged-only
// `--frost-e2e-open-gates=crawl`, and one test shows the shipped state without it.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { COMMAND_PALETTE_MENU_ID } from '@app/specs/command-palette.spec';
import { LEGAL_GATE_NOTE, LEGAL_GATES_E2E_SWITCH } from '@app/specs/data-sources.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { CRAWL_CSV_COLUMNS, CRAWL_INTERVAL_MS, CRAWL_USER_AGENT_TOKEN } from '@app/specs/site-crawl.spec';
import {
  BLOCKED_PATH,
  CRAWL_DELAY_SECONDS,
  CRAWL_HOST,
  CRAWL_ORIGIN,
  CRAWL_PAGE_PATHS,
  MISSING_PATH,
  NOINDEX_PATH,
  ORPHAN_PATH,
  PDF_PATH,
  REDIRECT,
  fetchCallsOf,
  startCrawlSite,
  type FetchCall,
} from './crawl-fixtures';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

/** The crawl runs at 1 s a call (robots.txt's `Crawl-delay`): 51 calls, a restart, and slow CI. */
test.describe.configure({ mode: 'serial', timeout: 300_000 });

/** The effective interval: robots.txt's `Crawl-delay`, above the sheet's 500 ms (`CRAWL_INTERVAL_MS.min`). */
const EFFECTIVE_MS = CRAWL_DELAY_SECONDS * 1_000;
/**
 * How much earlier than the effective interval the site may see the next call start: the app's own
 * spacing is between its request starts, and each arrival at the site lags its start by a little (more
 * on a new connection, more on slow CI). Small enough that a crawl paced at the sheet's 500 ms would fail.
 */
const ARRIVAL_SLACK_MS = 200;
const CRAWL_WAIT = 150_000;

let app: ElectronApplication;
let chrome: Page;
let site: Awaited<ReturnType<typeof startCrawlSite>>;
let scratch = '';
/** The fetch call that was last to start before the pause: if it was still in flight then, its answer was dropped and Resume fetches it again (by design). */
let inFlightAtPause: string | null = null;
const h = chromeHelpers(
  () => app,
  () => chrome,
);

const siteArgs = () => [`--host-resolver-rules=MAP ${CRAWL_HOST} 127.0.0.1:${site.port}`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${CRAWL_HOST}`];
const profileDir = () => path.join(scratch, 'profile');
const sheet = () => chrome.getByTestId('crawl-view');
const run = () => chrome.getByTestId('crawl-run');
const pageRow = (pathname: string) => chrome.getByTestId('crawl-page').filter({ has: chrome.locator(`bdi.crawl-url[title="${CRAWL_ORIGIN}${pathname}"]`) });
const crawlCalls = (): FetchCall[] => fetchCallsOf(site.log, CRAWL_USER_AGENT_TOKEN);

async function launch(gates: boolean): Promise<void> {
  ({ app, page: chrome } = await launchApp([...siteArgs(), ...(gates ? [`--${LEGAL_GATES_E2E_SWITCH}=crawl`] : [])], { userDataDir: profileDir() }));
  await chrome.waitForLoadState('domcontentloaded');
  await h.chromeCaughtUp();
}

/** Opens the crawl sheet from the palette ("Show site crawl"). */
async function openSheet(): Promise<void> {
  await h.menu(COMMAND_PALETTE_MENU_ID);
  await expect(chrome.getByTestId('command-palette')).toBeVisible();
  await chrome.getByTestId('command-palette-input').fill('Show site crawl');
  await expect(chrome.locator('[data-testid="command-palette-option"][aria-selected="true"]')).toHaveAttribute('data-action', 'crawl.show');
  await chrome.getByTestId('command-palette-input').press('Enter');
  await expect(sheet()).toBeVisible();
}

test.beforeAll(async () => {
  site = await startCrawlSite();
  scratch = await mkdtemp(path.join(tmpdir(), 'frost-e2e-crawl-'));
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
});

test('crawl-gate-closed-as-shipped', async () => {
  // Without the e2e switch the build is as shipped (L6 has no owner's note): the sheet disables Start
  // with the gate's note, and main refuses a start sent past the sheet.
  await launch(false);
  try {
    await openSheet();
    await expect(chrome.getByTestId('crawl-start')).toBeDisabled();
    await expect(chrome.getByTestId('crawl-start-note')).toHaveText(LEGAL_GATE_NOTE);
    const answer = await chrome.evaluate(
      (input) => (window as unknown as { frostIpc: { invoke(envelope: unknown): Promise<unknown> } }).frostIpc.invoke({ type: 'mutation', path: 'crawl.start', input }),
      { settings: { startUrl: `${CRAWL_ORIGIN}/`, scope: 'host', include: [], exclude: [], maxPages: 10, intervalMs: CRAWL_INTERVAL_MS.min, sitemaps: false }, projectId: null },
    );
    expect(answer).toEqual({ result: { data: { status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE } } });
    // Nothing was fetched for it.
    expect(crawlCalls()).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('crawl-runs-pauses-across-a-restart-and-resumes', async () => {
  await launch(true);
  await openSheet();
  await expect(chrome.getByTestId('crawl-start')).toBeEnabled();
  await chrome.getByTestId('crawl-start-url').fill(`${CRAWL_ORIGIN}/`);
  await chrome.getByTestId('crawl-scope').selectOption('host');
  // The fastest the sheet offers: robots.txt's Crawl-delay must decide the pacing.
  await chrome.getByTestId('crawl-interval').selectOption(String(CRAWL_INTERVAL_MS.min));
  await expect(chrome.getByTestId('crawl-sitemaps')).toBeChecked();
  await chrome.getByTestId('crawl-start').click();
  await expect(chrome.getByTestId('crawl-status')).toHaveText('Crawl started.');
  await expect(run().getByTestId('crawl-run-state')).toHaveText('Running');

  // Pause part way, then quit.
  await expect.poll(() => crawlCalls().length, { timeout: CRAWL_WAIT }).toBeGreaterThanOrEqual(12);
  await run().getByTestId('crawl-pause').click();
  await expect(run().getByTestId('crawl-run-state')).toHaveText('Paused', { timeout: 30_000 });
  const callsAtPause = crawlCalls().length;
  inFlightAtPause = crawlCalls().at(-1)!.paths[0]!;
  expect(callsAtPause).toBeLessThan(CRAWL_PAGE_PATHS.length);
  await closeApp(app);
  // Nothing more was fetched once paused (the app is gone; the run never resumes by itself).
  expect(crawlCalls()).toHaveLength(callsAtPause);

  // A new app on the same profile: the run is still paused, and only Resume continues it.
  await launch(true);
  await openSheet();
  await expect(run()).toHaveCount(1);
  await expect(run().getByTestId('crawl-run-state')).toHaveText('Paused');
  expect(crawlCalls()).toHaveLength(callsAtPause);
  await run().getByTestId('crawl-resume').click();
  await expect(run().getByTestId('crawl-run-state')).toHaveText('Done', { timeout: CRAWL_WAIT });

  // Every page was fetched across the restart, and once only (Resume never fetched a recorded page again;
  // only a call still in flight at the pause, its answer dropped, may be asked for again), and the
  // disallowed one never.
  const fetched = crawlCalls().map((call) => call.paths[0]!);
  const expectedFetched = [...CRAWL_PAGE_PATHS.filter((p) => p !== BLOCKED_PATH), '/sitemap.xml'];
  expect([...new Set(fetched)].sort()).toEqual([...expectedFetched].sort());
  const twice = fetched.filter((p, i) => fetched.indexOf(p) !== i);
  expect(twice.every((p) => p === inFlightAtPause) && twice.length <= 1, `fetched again: ${twice.join(', ')}`).toBe(true);
  expect(site.log.filter((entry) => entry.path.startsWith('/private/'))).toEqual([]);
});

test('crawl-pages-and-structure-show-the-site', async () => {
  // Pages: all 50 rows on one page, with their outcomes.
  await expect(chrome.getByTestId('crawl-tab-pages')).toHaveAttribute('aria-pressed', 'true');
  await expect(chrome.getByTestId('crawl-range')).toHaveText(`1–${CRAWL_PAGE_PATHS.length} of ${CRAWL_PAGE_PATHS.length}`, { timeout: 30_000 });
  await expect(chrome.getByTestId('crawl-page')).toHaveCount(CRAWL_PAGE_PATHS.length);
  for (const pathname of CRAWL_PAGE_PATHS) await expect(pageRow(pathname), pathname).toHaveCount(1);
  const cells = async (pathname: string) => (await pageRow(pathname).locator('td').allTextContents()).map((text) => text.trim());
  // Status, indexable, depth, … (CRAWL_PAGE_COLUMNS after the URL).
  expect((await cells(MISSING_PATH))[0]).toBe('404');
  expect((await cells(NOINDEX_PATH)).slice(0, 2)).toEqual(['200', 'No']);
  expect((await cells(BLOCKED_PATH))[0]).toBe('blocked-by-robots');
  await expect(pageRow(BLOCKED_PATH).getByTestId('crawl-page-robots')).toHaveText('frost-crawl: blocked · Googlebot: blocked');
  expect((await cells('/about')).slice(0, 2)).toEqual(['200', 'Yes']);
  expect((await cells(PDF_PATH))[0]).toBe('200');
  // The redirect was followed inside its call: one row, for the page asked for.
  await expect(pageRow(REDIRECT.to)).toHaveCount(0);
  test.info().annotations.push({ type: 'rows', description: JSON.stringify(await Promise.all([REDIRECT.from, MISSING_PATH, NOINDEX_PATH, BLOCKED_PATH, PDF_PATH, ORPHAN_PATH, '/'].map(async (p) => [p, await cells(p)]))) });
  // Filtered to the pages not indexable: the noindex page and the 404 among them, the home page not.
  await chrome.getByTestId('crawl-filter-indexable').selectOption('no');
  await expect(pageRow(NOINDEX_PATH)).toHaveCount(1);
  await expect(pageRow('/')).toHaveCount(0);
  await chrome.getByTestId('crawl-filter-indexable').selectOption('');
  await expect(chrome.getByTestId('crawl-page')).toHaveCount(CRAWL_PAGE_PATHS.length);

  // Site structure: the origin at the root, the depth histogram, and the sitemap's orphan.
  await chrome.getByTestId('crawl-tab-structure').click();
  await expect(chrome.getByTestId('crawl-tree')).toBeVisible();
  await expect(chrome.getByTestId('crawl-tree-node').first()).toContainText(CRAWL_HOST);
  await expect(chrome.getByTestId('crawl-depths').locator('.crawl-depth')).not.toHaveCount(0);
  await expect(chrome.getByTestId('crawl-orphans')).toContainText(`${CRAWL_ORIGIN}${ORPHAN_PATH}`);
  // Opening the origin's folder lists the sections.
  await chrome.getByTestId('crawl-tree-toggle').first().click();
  await expect(chrome.getByTestId('crawl-tree')).toContainText('tea/');
  await chrome.getByTestId('crawl-tab-pages').click();
});

test('crawl-exports-csv-through-mains-dialog', async () => {
  const file = path.join(scratch, 'crawl.csv');
  // Main's save dialog, answered in main (test-only), so main's own code path runs; the renderer never names the file.
  await app.evaluate(({ dialog }, chosen) => {
    const holder = dialog as unknown as { showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }> };
    holder.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
  }, file);
  await chrome.getByTestId('crawl-export').click();
  await expect(chrome.getByTestId('crawl-pages-note')).not.toHaveText('', { timeout: 30_000 });
  const lines = (await readFile(file, 'utf8')).split('\r\n').filter((line) => line !== '');
  expect(lines[0]).toBe(CRAWL_CSV_COLUMNS.join(','));
  expect(lines).toHaveLength(CRAWL_PAGE_PATHS.length + 1);
  for (const pathname of CRAWL_PAGE_PATHS) expect(lines.filter((line) => line.startsWith(`${CRAWL_ORIGIN}${pathname},`)), pathname).toHaveLength(1);
  test.info().annotations.push({ type: 'csv note', description: (await chrome.getByTestId('crawl-pages-note').textContent()) ?? '' });
});

test('crawl-is-polite-on-the-wire', async () => {
  // K-B1, from the site's own log: the crawl's fetch calls (pages and the sitemap; robots.txt is the audit
  // lane's), a redirect's hops folded into one call.
  const calls = crawlCalls();
  // Every page but the disallowed one, and the sitemap (plus, at most, the call in flight at the pause, asked again).
  expect(calls.length - (CRAWL_PAGE_PATHS.length - 1 + 1)).toBeGreaterThanOrEqual(0);
  expect(calls.length - (CRAWL_PAGE_PATHS.length - 1 + 1)).toBeLessThanOrEqual(1);
  // A redirect's hops: one call, the second hop at once (not spaced by the interval).
  const redirect = calls.find((call) => call.paths[0] === REDIRECT.from)!;
  expect(redirect.paths).toEqual([REDIRECT.from, REDIRECT.to]);
  const hops = site.log.filter((entry) => entry.userAgent.includes(CRAWL_USER_AGENT_TOKEN) && (entry.path === REDIRECT.from || entry.path === REDIRECT.to));
  expect(hops.map((entry) => entry.path)).toEqual([REDIRECT.from, REDIRECT.to]);
  expect(hops[1]!.start - hops[0]!.end!).toBeLessThan(CRAWL_INTERVAL_MS.min);
  // At most one fetch call in flight (pacing is per host name: this site has one).
  const gaps: number[] = [];
  for (let i = 1; i < calls.length; i++) {
    expect(calls[i]!.start, `${calls[i]!.paths[0]} starts after ${calls[i - 1]!.paths[0]} ended`).toBeGreaterThanOrEqual(calls[i - 1]!.end);
    gaps.push(calls[i]!.start - calls[i - 1]!.start);
  }
  // Consecutive starts at least the effective interval apart (robots.txt's Crawl-delay, not the sheet's 500 ms).
  const sorted = [...gaps].sort((a, b) => a - b);
  test.info().annotations.push({ type: 'spacing (ms)', description: JSON.stringify({ min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1), gaps }) });
  expect(sorted[0]!).toBeGreaterThanOrEqual(EFFECTIVE_MS - ARRIVAL_SLACK_MS);
  expect(sorted[Math.floor(sorted.length / 2)]!).toBeGreaterThanOrEqual(EFFECTIVE_MS - ARRIVAL_SLACK_MS / 4);
  // robots.txt came from main's robots fetcher (the browse user agent, without the crawl's token).
  expect(site.log.filter((entry) => entry.path === '/robots.txt').length).toBeGreaterThanOrEqual(1);
});
