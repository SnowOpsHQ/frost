// Specs: specs/data-sources.spec.ts (LEGAL_GATE_NOTE, LEGAL_GATES_E2E_SWITCH, DATA_API_E2E_SWITCH,
// DATA_PROVIDERS, DATA_PROVIDER_LABELS, DATA_SOURCES_SETTINGS_TEXT, DATA_SPEND_NOTE, DATA_CHECK_TEXT),
// specs/data-sources.schema.ts (DataApiE2eSeamSchema), specs/account-settings.spec.ts (SETTINGS_MENU),
// specs/ai-answers.spec.ts (AI_ANSWERS_VIEW_TEXT)
// Acceptance: specs/data-sources.feature.md (End to end: data-sources-gated-off-in-the-real-app,
// data-sources-key-set-never-shown, data-sources-check-via-api-joins-the-series,
// data-sources-usage-counts-each-search). Plan phase-12 Task 11.
// Loopback only: every data provider is `fake-data-api.ts` through the unpackaged seam; saved searches
// are never visited (the check asks the fake SerpApi, not a search engine).
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import {
  DATA_API_E2E_SWITCH,
  DATA_CHECK_TEXT,
  DATA_PROVIDER_LABELS,
  DATA_PROVIDERS,
  DATA_SOURCES_SETTINGS_TEXT,
  DATA_SPEND_NOTE,
  LEGAL_GATE_NOTE,
  LEGAL_GATES_E2E_SWITCH,
  type DataProvider,
} from '@app/specs/data-sources.spec';
import { APP_DIR, closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { startFakeDataApi, type FakeDataApi } from './fake-data-api';

/** Linux only: a stand-in OS keychain, so keys can be stored under Playwright (see the file). */
const FAKE_KEYCHAIN = path.join(APP_DIR, 'e2e', 'fake-keychain.cjs');
const WAIT = 20_000;
/** The project's site (a public-looking name; it is never resolved: only the fake's JSON names it). */
const SITE = 'leafhouse-frost-e2e.net';
const QUERIES = ['sencha', 'matcha', 'oolong'] as const;
/** Where the fake SerpApi ranks the site for each query (1-based). */
const SITE_POSITION: Readonly<Record<(typeof QUERIES)[number], number>> = { sencha: 1, matcha: 2, oolong: 3 };

// Each describe launches its own app; the scenarios of the open-gates one build on each other.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let app: ElectronApplication | undefined;
let page: Page;
const h = chromeHelpers(
  () => app!,
  () => page,
);

const settings = () => page.getByTestId('settings-view');
const row = (provider: DataProvider) => page.locator(`[data-testid="data-source"][data-provider="${provider}"]`);
const sheet = () => page.getByTestId('projects-view');
const rankRows = () => page.getByTestId('rankings-row');
const rankRowOf = (query: string) => rankRows().filter({ has: page.getByTestId('rankings-row-open').filter({ hasText: query }) });

/** A procedure answered by main, from the chrome page (to check main agrees with what the view shows). */
async function ipc(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: name, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

/** Runs a palette command by its id (typed `query` first). */
async function palette(actionId: string, query: string): Promise<void> {
  await h.press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill(query);
  await page.locator(`[data-testid="command-palette-option"][data-action="${actionId}"]`).click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
}

/** Opens Settings on Data sources, once main's views are read. */
async function openDataSources(): Promise<void> {
  if ((await settings().count()) === 0) await h.menu(SETTINGS_MENU.id);
  await expect(settings()).toBeVisible();
  await page.getByTestId('settings-nav-data-sources').click();
  await expect(page.getByTestId('data-sources-section')).toBeVisible({ timeout: WAIT });
  await expect(row('serpapi')).toBeVisible();
}

async function closeSettings(): Promise<void> {
  if ((await settings().count()) === 0) return;
  await page.getByTestId('settings-close').click();
  await expect(settings()).toHaveCount(0);
}

/** Creates a project (with `site` set, if given) and the saved searches `queries` (Google, us/en, desktop); answers its id. */
async function createProjectWithSearches(name: string, queries: readonly string[], site: string | null): Promise<string> {
  await palette('projects.open', 'open projects');
  await expect(sheet()).toBeVisible();
  await page.getByTestId('projects-create-name').fill(name);
  await page.getByTestId('projects-create').click();
  await expect(page.getByTestId('projects-name')).toHaveText(name);
  const projectId = (await page.getByTestId('projects-detail').getAttribute('data-project'))!;
  expect(projectId).toBeTruthy();
  // The site, so the rank table has a position to show.
  if (site !== null) {
    await page.getByTestId('projects-view-settings').click();
    await page.getByTestId('projects-site-input').fill(site);
    await page.getByTestId('projects-site-save').click();
    await expect(page.getByTestId('projects-site-clear')).toBeVisible({ timeout: WAIT });
  }
  // The saved searches (bulk add: saved only, nothing is visited).
  await page.getByTestId('projects-view-overview').click();
  await page.getByTestId('projects-bulk-open').click();
  await expect(page.getByTestId('projects-bulk')).toBeVisible();
  await page.getByTestId('projects-bulk-text').fill(queries.join('\n'));
  await page.getByTestId('projects-bulk-engine').selectOption('google');
  await page.getByTestId('projects-bulk-country').fill('us');
  await page.getByTestId('projects-bulk-language').fill('en');
  await expect(page.getByTestId('projects-bulk-device-desktop')).toBeChecked();
  await expect(page.getByTestId('projects-bulk-device-mobile')).not.toBeChecked();
  await page.getByTestId('projects-bulk-submit').click();
  const outcomes = page.getByTestId('projects-bulk-outcome');
  await expect(outcomes).toHaveCount(queries.length, { timeout: WAIT });
  for (let index = 0; index < queries.length; index++) await expect(outcomes.nth(index)).toHaveAttribute('data-outcome', 'added');
  await page.getByTestId('projects-bulk-close').click();
  await expect(page.getByTestId('projects-query')).toHaveCount(queries.length, { timeout: WAIT });
  return projectId;
}

/** Every file under `dir` (recursively) whose bytes contain `needle`, as paths relative to `dir`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  const bytes = Buffer.from(needle, 'utf8');
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    try {
      if ((await stat(file)).size > 64 * 1024 * 1024) continue;
      if ((await readFile(file)).includes(bytes)) found.push(path.relative(dir, file));
    } catch {
      // Gone (a temporary file) or locked: nothing to read.
    }
  }
  return found;
}

test.describe('as shipped (legal gates closed)', () => {
  test.beforeAll(async () => {
    // The real app's configuration: no gates switch, no data API seam, no stand-in keychain.
    ({ app, page } = await launchApp());
    await page.waitForLoadState('domcontentloaded');
    await h.chromeCaughtUp();
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
  });

  test('data-sources-gated-off-in-the-real-app', async () => {
    // Settings › Data sources: every row is disabled with the legal note; nothing can be saved.
    await openDataSources();
    await expect(page.getByTestId('data-source')).toHaveCount(DATA_PROVIDERS.length);
    for (const provider of DATA_PROVIDERS) {
      await expect(row(provider)).toHaveAttribute('data-disabled', 'true');
      await expect(row(provider).getByTestId('data-source-reason')).toHaveText(LEGAL_GATE_NOTE);
      for (const input of await row(provider).getByTestId('data-source-input').all()) await expect(input).toBeDisabled();
      await expect(row(provider).getByTestId('data-source-save')).toHaveAttribute('aria-disabled', 'true');
      await expect(row(provider).getByTestId('data-source-key-state')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.noKey);
    }
    await expect(page.getByTestId('data-sources-serp-provider')).toBeDisabled();
    // Main agrees: no provider is available.
    const status = (await ipc('query', 'dataSources.status')) as { providers: Record<DataProvider, { available: boolean }> };
    for (const provider of DATA_PROVIDERS) expect(status.providers[provider].available).toBe(false);
    await closeSettings();

    // A project with saved searches: main refuses a check, and the Rankings view has no "Check via API".
    const projectId = await createProjectWithSearches('Gated teas', ['genmaicha'], null);
    expect(await ipc('query', 'dataSources.checkPlan', { projectId })).toEqual({ status: 'refused', reason: 'unavailable' });
    await page.getByTestId('projects-view-rankings').click();
    await expect(page.getByTestId('projects-detail')).toHaveAttribute('data-view', 'rankings');
    await expect(rankRows()).toHaveCount(1, { timeout: WAIT });
    await expect(page.getByTestId('rankings-copy-csv')).toBeEnabled();
    await expect(page.getByTestId('rankings-api-check')).toHaveCount(0);
    await expect(page.getByTestId('rankings-api-check-reason')).toHaveCount(0);
    // The palette offers no "Check searches via …" either.
    await h.press('chrome', 'K', ['mod']);
    await page.getByTestId('command-palette-input').fill('check searches via');
    await expect(page.getByTestId('command-palette-option').filter({ hasText: 'Check searches via' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await page.getByTestId('projects-close').click();
    await expect(sheet()).toHaveCount(0);

    // The AI answers view: its run is disabled with the note, and each API engine says why.
    await palette('ai-answers.ask', 'ask ai engines');
    await expect(page.getByTestId('ai-answers-view')).toBeVisible();
    await page.getByTestId('ai-answers-query').fill('Is sencha a green tea?');
    await expect(page.getByTestId('ai-answers-ask')).toBeDisabled({ timeout: WAIT });
    await expect(page.getByTestId('ai-answers-ask-note')).toHaveText(LEGAL_GATE_NOTE);
    for (const engine of ['perplexity', 'chatgpt'] as const) await expect(page.getByTestId(`ai-answers-engine-note-${engine}`)).toHaveText(LEGAL_GATE_NOTE);
    expect(await ipc('mutation', 'aiAnswers.run', { query: 'Is sencha a green tea?' })).toMatchObject({ status: 'refused', reason: 'unavailable' });
  });
});

test.describe('gates open (unpackaged switch), against the fake data API', () => {
  let fake: FakeDataApi;
  let projectId: string;
  /** What the app wrote to stdout and stderr (its log lines). */
  const output: string[] = [];
  const SERPAPI_KEY = `e2e-serpapi-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const SERPER_KEY = `e2e-serper-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    fake = await startFakeDataApi();
    for (const query of QUERIES) {
      const position = SITE_POSITION[query];
      const others = [`https://www.example.com/${query}`, `https://blog.example.org/${query}-notes`, `https://tea.example.net/${query}`];
      const links = [...others.slice(0, position - 1), `https://www.${SITE}/${query}`, ...others.slice(position - 1)];
      fake.organic.set(
        query,
        links.map((link, index) => ({ link, title: `${query} result ${index + 1}` })),
      );
    }
    ({ app, page } = await launchApp([`--${LEGAL_GATES_E2E_SWITCH}=serpapi,serper`, `--${DATA_API_E2E_SWITCH}=${fake.seamFile}`], { mainPreload: [FAKE_KEYCHAIN] }));
    for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
    await page.waitForLoadState('domcontentloaded');
    await h.chromeCaughtUp();
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
    await fake?.close();
  });

  test('data-sources-key-set-never-shown', async () => {
    await openDataSources();
    await expect(page.getByTestId('data-sources-spend-note')).toHaveText(DATA_SPEND_NOTE);
    // The open gates' rows are live; the others stay gated.
    for (const provider of ['serpapi', 'serper'] as const) {
      await expect(row(provider)).toHaveAttribute('data-disabled', 'false');
      await expect(row(provider).getByTestId('data-source-key-state')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.noKey);
    }
    for (const provider of ['dataforseo', 'perplexity', 'openai-search'] as const) await expect(row(provider).getByTestId('data-source-reason')).toHaveText(LEGAL_GATE_NOTE);

    // Pasted, saved: the field is emptied, main stores it, and the row says "Key set".
    for (const [provider, key] of [
      ['serpapi', SERPAPI_KEY],
      ['serper', SERPER_KEY],
    ] as const) {
      const input = row(provider).getByTestId('data-source-input');
      await input.fill(key);
      await row(provider).getByTestId('data-source-save').click();
      await expect(input).toHaveValue('');
      await expect(row(provider).getByTestId('data-source-message')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.setKeyResults.stored, { timeout: WAIT });
      await expect(row(provider)).toHaveAttribute('data-has-key', 'true');
      await expect(row(provider).getByTestId('data-source-key-state')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.keySet);
      await expect(input).toHaveAttribute('placeholder', DATA_SOURCES_SETTINGS_TEXT.replacePlaceholder);
    }
    // Never shown again: not in the page, not in any field, not in main's view.
    const status = (await ipc('query', 'dataSources.status')) as { protection: string; providers: Record<DataProvider, { hasKey: boolean; available: boolean }> };
    expect(status.protection).toBe('os');
    expect(status.providers.serpapi).toMatchObject({ hasKey: true, available: true });
    expect(status.providers.serper).toMatchObject({ hasKey: true, available: true });
    expect(JSON.stringify(status)).not.toContain(SERPAPI_KEY);
    for (const input of await page.getByTestId('data-source-input').all()) await expect(input).toHaveValue('');
    for (const key of [SERPAPI_KEY, SERPER_KEY]) expect(await page.content()).not.toContain(key);
    expect(fake.requests).toEqual([]);

    // Two vendors offered, none chosen: the user chooses SerpApi.
    const select = page.getByTestId('data-sources-serp-provider');
    await expect(select).toBeEnabled();
    await expect(select).toHaveValue('');
    await expect(select.locator('option:not([disabled])')).toHaveText([DATA_PROVIDER_LABELS.serpapi, DATA_PROVIDER_LABELS.serper]);
    await select.selectOption('serpapi');
    await expect(select).toHaveValue('serpapi', { timeout: WAIT });
    expect(await ipc('query', 'dataSources.serpProvider')).toMatchObject({ provider: 'serpapi' });
    await expect(row('serpapi').getByTestId('data-source-usage')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.usage(0, 0));
    await closeSettings();
  });

  test('data-sources-check-via-api-joins-the-series', async () => {
    projectId = await createProjectWithSearches('Leaf house', QUERIES, SITE);
    await page.getByTestId('projects-view-rankings').click();
    await expect(page.getByTestId('projects-detail')).toHaveAttribute('data-view', 'rankings');
    // The saved searches' rows, not checked yet.
    await expect(rankRows()).toHaveCount(QUERIES.length, { timeout: WAIT });
    const keys = new Map<string, string>();
    for (const query of QUERIES) {
      await expect(rankRowOf(query)).toHaveAttribute('data-outcome', 'none');
      keys.set(query, (await rankRowOf(query).getAttribute('data-key'))!);
    }

    // "Check via API" asks first: the count, the vendor and the cost note; nothing is sent yet.
    const button = page.getByTestId('rankings-api-check');
    await expect(button).toHaveText(DATA_CHECK_TEXT.button, { timeout: WAIT });
    await expect(button).toBeEnabled({ timeout: WAIT });
    await button.click();
    const confirm = page.getByTestId('rankings-api-check-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(DATA_CHECK_TEXT.confirm(QUERIES.length, DATA_PROVIDER_LABELS.serpapi));
    await expect(confirm).toContainText(DATA_SPEND_NOTE);
    expect(fake.requests).toEqual([]);
    await page.getByTestId('rankings-api-check-send').click();
    await expect(page.getByTestId('projects-status')).toHaveText(DATA_CHECK_TEXT.done(QUERIES.length, QUERIES.length, DATA_PROVIDER_LABELS.serpapi), { timeout: WAIT * 2 });
    await expect(confirm).toHaveCount(0);

    // One SerpApi request per saved search, each with the key, the search's own fields, and nothing else sent.
    const sent = fake.requestsTo('serpapi');
    expect(sent).toHaveLength(QUERIES.length);
    expect(sent.map((request) => request.query.get('q')).sort()).toEqual([...QUERIES].sort());
    for (const request of sent) {
      expect(request.method).toBe('GET');
      expect(request.pathname).toBe('/search.json');
      expect(request.query.get('api_key')).toBe(SERPAPI_KEY);
      expect(request.query.getAll('api_key')).toHaveLength(1);
      expect(Object.fromEntries([...request.query].filter(([name]) => name !== 'q' && name !== 'api_key'))).toEqual({ engine: 'google', gl: 'us', hl: 'en', google_domain: 'google.com', device: 'desktop' });
    }
    expect(fake.requests).toHaveLength(QUERIES.length);
    expect(fake.refused).toEqual([]);

    // Phase 10's table: each reading is in its saved search's row (no new row), ranked where the
    // vendor put the site, and marked SerpApi.
    await expect(rankRows()).toHaveCount(QUERIES.length, { timeout: WAIT });
    for (const query of QUERIES) {
      const queryRow = rankRowOf(query);
      await expect(queryRow).toHaveAttribute('data-key', keys.get(query)!);
      await expect(queryRow).toHaveAttribute('data-outcome', 'ranked', { timeout: WAIT });
      await expect(queryRow.getByTestId('rankings-position')).toContainText(String(SITE_POSITION[query]));
      await expect(queryRow.getByTestId('rankings-source')).toHaveText(DATA_CHECK_TEXT.sourceApi(DATA_PROVIDER_LABELS.serpapi));
    }
    // A search's series holds the API point, its source named.
    await rankRowOf('matcha').getByTestId('rankings-row-open').click();
    const points = page.getByTestId('rankings-series-point');
    await expect(points).toHaveCount(1, { timeout: WAIT });
    await expect(points.first().locator('td.rankings-number')).toHaveText(String(SITE_POSITION.matcha));
    await expect(points.first().getByTestId('rankings-series-source')).toHaveText(DATA_CHECK_TEXT.sourceApi(DATA_PROVIDER_LABELS.serpapi));
    await expect(points.first().locator('.rankings-url')).toContainText(`https://www.${SITE}/matcha`);
    await page.getByTestId('rankings-series-close').click();
    await page.getByTestId('projects-close').click();
    await expect(sheet()).toHaveCount(0);
  });

  test('data-sources-usage-counts-each-search', async () => {
    // One request per search, counted for SerpApi only.
    await openDataSources();
    await expect(row('serpapi').getByTestId('data-source-usage')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.usage(QUERIES.length, 0), { timeout: WAIT });
    await expect(row('serper').getByTestId('data-source-usage')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.usage(0, 0));
    const usage = (await ipc('query', 'dataSources.usage')) as { providers: Record<DataProvider, { thisMonth: number }> };
    expect(usage.providers.serpapi.thisMonth).toBe(QUERIES.length);
    expect(usage.providers.serper.thisMonth).toBe(0);
    await closeSettings();

    // The key reached the vendor (in its query, as SerpApi takes it) and nothing else: the app's log
    // names the key-less URL only, and no page, answer or file of the profile holds the key.
    const log = output.join('');
    expect(log).toContain('data api: serpapi GET https://serpapi.com/search.json 200');
    for (const key of [SERPAPI_KEY, SERPER_KEY]) {
      expect(log).not.toContain(key);
      expect(await page.content()).not.toContain(key);
      expect(JSON.stringify(await ipc('query', 'dataSources.checkPlan', { projectId }))).not.toContain(key);
    }
    expect(log).not.toContain('api_key');
    const userData = await app!.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    // The readings are on disk by now (the table showed them); WAL and all.
    for (const key of [SERPAPI_KEY, SERPER_KEY]) expect(await filesContaining(userData, key)).toEqual([]);
  });
});
