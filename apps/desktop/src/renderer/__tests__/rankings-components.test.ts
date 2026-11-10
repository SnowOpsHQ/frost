// @vitest-environment jsdom
// Spec: specs/rankings.spec.ts (RANK_VIEW_TEXT, RANKINGS_REFUSAL_MESSAGES), specs/projects.spec.ts (PROJECT_VIEWS,
// PROJECT_REFUSAL_MESSAGES, BULK_ADD_TEXT, PROJECT_SETTINGS_TEXT)
// Acceptance: specs/rankings.feature.md (The views: compare-keeps-picks-on-refresh,
// compare-shares-one-dates-read, compare-drops-a-stale-answer, compare-says-refusals,
// series-close-returns-focus); specs/projects.feature.md (The sheet: projects-run-progress-on-every-view;
// Phase 10 Task 7's star and sort, Settings, tags and Bulk add; Task 8's Due, Check rankings, cadence and blocked run;
// the L1 gate: rank-check-hidden-until-cleared), specs/capture-schedule.spec.ts (RANK_CHECK_AVAILABLE);
// Phase 12 Task 4: specs/projects.feature.md (Checking searches via a data API: rank-point-shows-source,
// api-check-button-follows-main), specs/data-sources.feature.md (Check via API: api-check-says-the-count-first),
// specs/data-sources.spec.ts (DATA_CHECK_TEXT, DATA_CHECK_REFUSAL_MESSAGES, DATA_SPEND_NOTE)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { CADENCE_TEXT, CAPTURE_SCHEDULE_NOTE, RANK_CHECK_AVAILABLE } from '@app/specs/capture-schedule.spec';
import type { TabState } from '@app/specs/browser.spec';
import { BULK_ADD_TEXT, CHECK_RANKINGS_TEXT, DUE_TEXT, PROJECT_REFUSAL_MESSAGES, PROJECT_SETTINGS_TEXT, PROJECT_VIEWS, RUN_BLOCKED_NOTE, RUN_BLOCK_REASON_LABELS, RUN_REFUSAL_MESSAGES, type ProjectSummary } from '@app/specs/projects.spec';
import { RANKINGS_REFUSAL_MESSAGES, RANK_VIEW_TEXT, type RankPoint, type RankTableRow, type ReadingDate, type SearchParamsShape } from '@app/specs/rankings.spec';
import { DATA_CHECK_REFUSAL_MESSAGES, DATA_CHECK_TEXT, DATA_SPEND_NOTE } from '@app/specs/data-sources.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1 = '01920000-0000-7000-8000-0000000000a1';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const params = (query: string): SearchParamsShape => ({ engine: 'google', engineLabel: 'Google', query, gl: null, hl: null, device: 'desktop', page: 1, offset: null, url: `https://www.google.com/search?q=${query}` });
const point = (readingId: string, at: number): RankPoint => ({ readingId, at, outcome: 'ranked', position: 3, url: null, organicRead: 10, page: 1, alsoIn: [] });
const row = (searchKey: string, query: string): RankTableRow => ({ searchKey, params: params(query), filters: {}, saved: null, latest: point(`${query}-2`, 2_000), previous: null, change: null, best: 3, points: [point(`${query}-2`, 2_000)], competitors: {}, capped: false });
const dates = (query: string): ReadingDate[] => [
  { readingId: `${query}-2`, at: 2_000, status: 'ready' },
  { readingId: `${query}-1`, at: 1_000, status: 'ready' },
];
const tableAnswer = (rows: RankTableRow[]) => ({ status: 'ok' as const, rows, truncated: false, retention: { mode: 'forever' as const, value: null }, site: { domain: 'example.com', subdomains: true }, competitors: [], tags: [] });
const comparison = (a: string, b: string) => ({
  status: 'ok' as const,
  comparison: {
    a: { readingId: a, at: 1_000, params: params('tea'), filters: {}, status: 'ready' as const, organicRead: 1, complete: true, features: [] },
    b: { readingId: b, at: 2_000, params: params('tea'), filters: {}, status: 'ready' as const, organicRead: 1, complete: true, features: [] },
    rows: [{ domain: 'example.com', a: { position: 2, url: null }, b: { position: 1, url: null }, movement: 'up' as const, change: 1, role: 'site' as const }],
    features: [],
    site: null,
    truncated: false,
  },
});

const fakes = vi.hoisted(() => ({
  rankings: { table: vi.fn(), series: vi.fn(), readingDates: vi.fn(), compare: vi.fn(), copyCsv: vi.fn(), saveCsv: vi.fn() },
  projects: { list: vi.fn(), get: vi.fn(), runState: vi.fn() },
  workspace: { setFavorite: vi.fn(), setSite: vi.fn(), addCompetitor: vi.fn(), removeCompetitor: vi.fn(), setTags: vi.fn(), addSearches: vi.fn(), setCadence: vi.fn(), setAutoCapture: vi.fn(), checkRankings: vi.fn() },
  // Phase 12 Task 4: main's "Check via API" views (the legal gate closed unless a test says otherwise).
  dataSources: { checkPlan: vi.fn(), checkProjectSearches: vi.fn(), serpProvider: vi.fn() },
}));

/** `rankCheck`: the L1 flag as the sheet reads it (`undefined`: the shipped `RANK_CHECK_AVAILABLE`). */
const flags = vi.hoisted(() => ({ rankCheck: undefined as boolean | undefined }));
vi.mock('../projects-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projects-view')>();
  return { ...actual, rankCheckShown: () => flags.rankCheck ?? actual.rankCheckShown() };
});

vi.mock('../ipc', () => ({
  rankingsActions: fakes.rankings,
  projectsActions: fakes.workspace,
  actions: { focusPage: vi.fn(async () => true), navigate: vi.fn(async () => true) },
  ipc: {
    projects: {
      list: { query: fakes.projects.list },
      get: { query: fakes.projects.get },
      runState: { query: fakes.projects.runState },
      retentionPreview: { query: vi.fn(() => new Promise(() => undefined)) },
      usage: { query: vi.fn(() => new Promise(() => undefined)) },
      purgeLog: { query: vi.fn(() => new Promise(() => undefined)) },
      cancelRun: { mutate: vi.fn(async () => true) },
    },
    dataSources: {
      checkPlan: { query: fakes.dataSources.checkPlan },
      checkProjectSearches: { mutate: fakes.dataSources.checkProjectSearches },
      serpProvider: { query: fakes.dataSources.serpProvider },
    },
  },
}));

const { Compare } = await import('../components/changes/Compare');
const { Rankings } = await import('../components/changes/Rankings');
const { Projects } = await import('../components/changes/Projects');

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => {});
const $ = <T extends Element = HTMLElement>(testId: string) => host.querySelector<T>(`[data-testid="${testId}"]`);
const select = async (testId: string, value: string) => {
  const element = $<HTMLSelectElement>(testId)!;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const click = (testId: string) => act(async () => $<HTMLButtonElement>(testId)!.click());
/** Types `value` into a React-controlled input or text area. */
const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
const all = <T extends Element = HTMLElement>(testId: string) => [...host.querySelectorAll<T>(`[data-testid="${testId}"]`)];

const P2 = '01920000-0000-7000-8000-0000000000a2';
const PAGE = '01920000-0000-7000-8000-0000000000b1';
const COMPETITOR = '01920000-0000-7000-8000-0000000000c1';
const summary = (id: string, name: string, more: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name, unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 1, lastCapturedAt: null, cadence: 'off', autoCapture: false, due: false, ...more });

/** Renders the sheet on `project` (no run under way). */
async function openSheet(project: ProjectSummary, detail: Record<string, unknown> = {}, list: ProjectSummary[] = [project]) {
  fakes.projects.list.mockResolvedValue({ projects: list });
  fakes.projects.get.mockImplementation(async () => ({ project, pages: [], queries: [], competitors: [], ...detail }));
  fakes.projects.runState.mockReturnValue(new Promise(() => undefined));
  const { openProjects } = await import('../components/changes/projects-sheet');
  openProjects({ projectId: project.id });
  await act(async () => root.render(createElement(Projects, { tab: undefined, onClose: vi.fn() })));
  await flush();
}

beforeEach(() => {
  flags.rankCheck = undefined;
  for (const fake of [...Object.values(fakes.rankings), ...Object.values(fakes.projects), ...Object.values(fakes.workspace), ...Object.values(fakes.dataSources)]) fake.mockReset();
  fakes.dataSources.checkPlan.mockResolvedValue({ status: 'refused', reason: 'unavailable' });
  fakes.dataSources.serpProvider.mockResolvedValue({ provider: null, choices: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('rankings components', () => {
  test('compare-shares-one-dates-read', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea'), row(KEY_B, 'coffee')]));
    fakes.rankings.readingDates.mockImplementation(async (_project: string, key: string) => ({ status: 'ok', dates: dates(key === KEY_A ? 'tea' : 'coffee') }));
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 1 })));
    await flush();
    // One search on both sides: one read, A on the second-newest, B on the newest.
    expect(fakes.rankings.readingDates).toHaveBeenCalledTimes(1);
    expect($<HTMLSelectElement>('compare-date-a')!.value).toBe('tea-1');
    expect($<HTMLSelectElement>('compare-date-b')!.value).toBe('tea-2');
    // Another search on B: its own read.
    await select('compare-search-b', KEY_B);
    await flush();
    expect(fakes.rankings.readingDates).toHaveBeenCalledTimes(2);
    expect(fakes.rankings.readingDates).toHaveBeenLastCalledWith(P1, KEY_B);
    expect($<HTMLSelectElement>('compare-date-b')!.value).toBe('coffee-2');
    expect($<HTMLSelectElement>('compare-date-a')!.value).toBe('tea-1');
  });

  test('compare-keeps-picks-on-refresh', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    fakes.rankings.readingDates.mockResolvedValue({ status: 'ok', dates: dates('tea') });
    fakes.rankings.compare.mockImplementation(async (_project: string, a: string, b: string) => comparison(a, b));
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 1 })));
    await flush();
    await select('compare-date-a', 'tea-2');
    await select('compare-date-b', 'tea-1');
    await click('compare-run');
    expect($('compare-result')).not.toBeNull();
    // A run captured: the project is read again. While the dates are read again nothing is lost.
    let answerDates!: (value: unknown) => void;
    fakes.rankings.readingDates.mockReturnValue(new Promise((resolve) => (answerDates = resolve)));
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 2 })));
    expect($<HTMLSelectElement>('compare-date-a')!.value).toBe('tea-2');
    expect($<HTMLSelectElement>('compare-date-b')!.value).toBe('tea-1');
    expect($('compare-result')).not.toBeNull();
    // The new dates (a newer reading) keep the picks that are still there.
    await act(async () => answerDates({ status: 'ok', dates: [{ readingId: 'tea-3', at: 3_000, status: 'ready' }, ...dates('tea')] }));
    expect($<HTMLSelectElement>('compare-date-a')!.value).toBe('tea-2');
    expect($<HTMLSelectElement>('compare-date-b')!.value).toBe('tea-1');
    expect($('compare-result')).not.toBeNull();
  });

  test('compare-drops-a-stale-answer', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    fakes.rankings.readingDates.mockResolvedValue({ status: 'ok', dates: [{ readingId: 'tea-3', at: 3_000, status: 'ready' }, ...dates('tea')] });
    let answer!: (value: unknown) => void;
    fakes.rankings.compare.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 1 })));
    await flush();
    await click('compare-run');
    // The pick changes while the comparison is read: its answer is not shown.
    await select('compare-date-a', 'tea-1');
    await act(async () => answer(comparison('tea-2', 'tea-3')));
    expect($('compare-result')).toBeNull();
  });

  test('compare-says-refusals', async () => {
    fakes.rankings.table.mockResolvedValue({ status: 'refused', reason: 'not-found' });
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 1 })));
    await flush();
    expect($('compare-refused')!.textContent).toBe(RANKINGS_REFUSAL_MESSAGES['not-found']);
    expect(host.textContent).not.toContain('No readings yet');
    // A failed dates read says why, and clears the pick.
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    fakes.rankings.readingDates.mockResolvedValue({ status: 'refused', reason: 'store-failed' });
    await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 2 })));
    await flush();
    expect($('compare-refused')).toBeNull();
    expect($('compare-dates-refused-a')!.textContent).toBe(RANKINGS_REFUSAL_MESSAGES['store-failed']);
    expect($<HTMLButtonElement>('compare-run')!.disabled).toBe(true);
  });

  // spec: specs/rankings.feature.md — Series (a capped series carries the capped hint); Scenario: rank-series-says-when-capped
  test('series-shows-when-capped', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea'), row(KEY_B, 'coffee')]));
    fakes.rankings.series.mockResolvedValue({ status: 'ok', searchKey: KEY_A, points: [point('tea-2', 2_000)], capped: true });
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
    await flush();
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="rankings-row-open"]')[0]!.click());
    await flush();
    expect($('rankings-series-view')!.getAttribute('data-capped')).toBe('true');
    expect($('rankings-series-capped')!.getAttribute('title')).toBe(RANK_VIEW_TEXT.capped);
    expect($('rankings-series-capped')!.textContent).toContain(RANK_VIEW_TEXT.capped);
    // Answered whole: no hint.
    fakes.rankings.series.mockResolvedValue({ status: 'ok', searchKey: KEY_B, points: [point('coffee-2', 2_000)], capped: false });
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="rankings-row-open"]')[1]!.click());
    await flush();
    expect($('rankings-series-view')!.hasAttribute('data-capped')).toBe(false);
    expect($('rankings-series-capped')).toBeNull();
  });

  test('series-close-returns-focus', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea'), row(KEY_B, 'coffee')]));
    fakes.rankings.series.mockResolvedValue({ status: 'ok', searchKey: KEY_B, points: [point('coffee-2', 2_000)], capped: false });
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
    await flush();
    const opener = host.querySelectorAll<HTMLButtonElement>('[data-testid="rankings-row-open"]')[1]!;
    await act(async () => opener.click());
    expect($('rankings-series-view')).not.toBeNull();
    $<HTMLButtonElement>('rankings-series-close')!.focus();
    await click('rankings-series-close');
    expect($('rankings-series-view')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // spec: specs/projects.feature.md — The sheet (Settings); rankings.feature.md — Empty states (rankings-open-settings)
  test('projects-settings-view-sets-site-and-competitors', async () => {
    const project = summary(P1, 'Shop');
    await openSheet(project, { competitors: [{ id: COMPETITOR, domain: 'rival.com' }] });
    // The Rankings view's no-site notice leads to Settings.
    fakes.rankings.table.mockResolvedValue({ ...tableAnswer([]), site: null });
    await click('projects-view-rankings');
    await flush();
    await click('rankings-open-settings');
    await flush();
    expect($('projects-detail')!.dataset.view).toBe('settings');
    // Focus follows to the site input.
    expect(document.activeElement).toBe($('projects-site-input'));
    expect($<HTMLButtonElement>('projects-view-settings')!.getAttribute('aria-selected')).toBe('true');
    // Subdomains on with no site; a refused domain is said and nothing is sent.
    expect($<HTMLInputElement>('projects-site-subdomains')!.checked).toBe(true);
    expect($('projects-site-clear')).toBeNull();
    await type($<HTMLInputElement>('projects-site-input')!, 'localhost');
    await click('projects-site-save');
    expect($('projects-status')!.textContent).toBe(PROJECT_REFUSAL_MESSAGES['invalid-domain']);
    expect(fakes.workspace.setSite).not.toHaveBeenCalled();
    // A valid one goes as its host; main's refusal is said.
    fakes.workspace.setSite.mockResolvedValueOnce({ status: 'refused', reason: 'invalid-domain' });
    await type($<HTMLInputElement>('projects-site-input')!, 'https://WWW.Shop.co.uk/a');
    await act(async () => $<HTMLInputElement>('projects-site-subdomains')!.click());
    await click('projects-site-save');
    expect(fakes.workspace.setSite).toHaveBeenLastCalledWith(P1, 'www.shop.co.uk', false);
    expect($('projects-status')!.textContent).toBe(PROJECT_REFUSAL_MESSAGES['invalid-domain']);
    fakes.workspace.setSite.mockResolvedValueOnce({ status: 'ok', site: { domain: 'www.shop.co.uk', subdomains: false } });
    await click('projects-site-save');
    expect($('projects-status')!.textContent).toBe(PROJECT_SETTINGS_TEXT.siteSaved);
    // Competitors: listed with Remove; one added; the count of the cap.
    expect(all('projects-competitor').map((row) => row.dataset.domain)).toEqual(['rival.com']);
    expect($('projects-competitor-count')!.textContent).toBe('1 of 10');
    fakes.workspace.addCompetitor.mockResolvedValueOnce({ status: 'added', competitor: { id: COMPETITOR, domain: 'rival.com' } });
    await type($<HTMLInputElement>('projects-competitor-input')!, 'shop.Rival.com');
    await click('projects-competitor-add');
    expect(fakes.workspace.addCompetitor).toHaveBeenLastCalledWith(P1, 'shop.rival.com');
    expect($('projects-status')!.textContent).toBe(PROJECT_SETTINGS_TEXT.competitorExists);
    // Remove is disabled while a remove is in flight.
    let answerRemove!: (value: unknown) => void;
    fakes.workspace.removeCompetitor.mockReturnValueOnce(new Promise((resolve) => (answerRemove = resolve)));
    await click('projects-competitor-remove');
    expect(fakes.workspace.removeCompetitor).toHaveBeenLastCalledWith(P1, COMPETITOR);
    expect($<HTMLButtonElement>('projects-competitor-remove')!.disabled).toBe(true);
    await click('projects-competitor-remove');
    expect(fakes.workspace.removeCompetitor).toHaveBeenCalledTimes(1);
    await act(async () => answerRemove({ status: 'refused', reason: 'not-found' }));
    expect($('projects-status')!.textContent).toBe(PROJECT_REFUSAL_MESSAGES['not-found']);
    expect($<HTMLButtonElement>('projects-competitor-remove')!.disabled).toBe(false);
  });

  // spec: specs/projects.feature.md — The sheet (Settings: Unfiled has no site or competitors)
  test('projects-settings-unfiled-offers-nothing', async () => {
    await openSheet(summary(UNFILED_PROJECT_ID, 'Unfiled', { unfiled: true }));
    // Its Rankings view says no site is set, without a way to set one.
    fakes.rankings.table.mockResolvedValue({ ...tableAnswer([]), site: null });
    await click('projects-view-rankings');
    await flush();
    expect($('rankings-no-site')).not.toBeNull();
    expect($('rankings-open-settings')).toBeNull();
    await click('projects-view-settings');
    expect($('projects-settings-unfiled')!.textContent).toBe(PROJECT_SETTINGS_TEXT.unfiled);
    expect($('projects-site-input')).toBeNull();
    expect($('projects-competitor-input')).toBeNull();
  });

  // spec: specs/projects.feature.md — The sheet (Bulk add)
  test('projects-bulk-add-shows-outcomes', async () => {
    await openSheet(summary(P1, 'Shop'));
    await click('projects-bulk-open');
    expect($('projects-bulk')!.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe($('projects-bulk-text'));
    // The shipped flag (L1 not cleared): the note names Capture now only (`rank-check-wording-follows-the-flag` has both).
    expect($('projects-bulk-note')!.textContent).toBe(BULK_ADD_TEXT.noteWithoutRankCheck);
    await type($<HTMLTextAreaElement>('projects-bulk-text')!, 'green tea, black tea\n<b>tea</b>');
    await select('projects-bulk-engine', 'duckduckgo');
    await type(all<HTMLInputElement>('projects-bulk-country')[0]!, 'DE');
    await type(all<HTMLInputElement>('projects-bulk-language')[0]!, 'de');
    await click('projects-bulk-locale-add');
    await act(async () => $<HTMLInputElement>('projects-bulk-device-mobile')!.click());
    await type($<HTMLInputElement>('projects-bulk-tags')!, 'Tea');
    expect($('projects-bulk-summary')!.textContent).toBe('3 queries × 2 locales × 2 devices: 12 searches. The project can hold 50 more.');
    fakes.workspace.addSearches.mockResolvedValueOnce({
      status: 'done',
      lines: [
        { query: 'green tea', outcome: 'added', added: 4 },
        { query: 'black tea', outcome: 'exists', added: 0 },
        { query: '<b>tea</b>', outcome: 'invalid', added: 0 },
      ],
    });
    await click('projects-bulk-submit');
    expect(fakes.workspace.addSearches).toHaveBeenCalledWith(P1, {
      text: 'green tea\nblack tea\n<b>tea</b>',
      engine: 'duckduckgo',
      locales: [{ country: 'de', language: 'de' }, { country: null, language: null }],
      devices: ['desktop', 'mobile'],
      tags: ['tea'],
    });
    expect(all('projects-bulk-outcome').map((row) => [row.dataset.outcome, row.querySelector('bdi')!.textContent])).toEqual([
      ['added', 'green tea'],
      ['exists', 'black tea'],
      ['invalid', '<b>tea</b>'],
    ]);
    // Query text stays text.
    expect(host.querySelector('.projects-bulk-outcomes b')).toBeNull();
    expect($('projects-status')!.textContent).toBe('Added 4 searches from 3 lines.');
    expect($<HTMLTextAreaElement>('projects-bulk-text')!.value).toBe('');
    // A refusal is said; Esc closes the dialog (not the sheet) and focus goes back to Bulk add.
    fakes.workspace.addSearches.mockResolvedValueOnce({ status: 'refused', reason: 'limit' });
    await type($<HTMLTextAreaElement>('projects-bulk-text')!, 'oolong');
    await click('projects-bulk-submit');
    expect($('projects-status')!.textContent).toBe(PROJECT_REFUSAL_MESSAGES.limit);
    await act(async () => $('projects-bulk-text')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flush();
    expect($('projects-bulk')).toBeNull();
    expect($('projects-view')).not.toBeNull();
    expect(document.activeElement).toBe($('projects-bulk-open'));
  });

  // spec: specs/projects.feature.md — The sheet (Star and sort; Tags)
  test('projects-star-sort-and-tags', async () => {
    const unfiled = summary(UNFILED_PROJECT_ID, 'Unfiled', { unfiled: true });
    const shop = summary(P1, 'Shop', { createdAt: 10 });
    const blog = summary(P2, 'Blog', { createdAt: 20, favorite: true });
    await openSheet(shop, { pages: [{ id: PAGE, url: 'https://shop.com/', tags: ['sale'], lastCapturedAt: null, changeCount: null }] }, [unfiled, shop, blog]);
    const names = () => all('projects-item').map((item) => item.querySelector('.projects-item-name')!.textContent);
    // Unfiled, then favorites, then the rest; the sort is view state.
    expect(names()).toEqual(['Unfiled', 'Blog', 'Shop']);
    await select('projects-sort', 'created');
    expect($<HTMLSelectElement>('projects-sort')!.value).toBe('created');
    // spec: specs/projects.feature.md — Star and sort: Unfiled (always first) shows no star.
    const stars = all<HTMLButtonElement>('projects-star');
    expect(stars.map((star) => [star.getAttribute('aria-label'), star.getAttribute('aria-pressed')])).toEqual([
      ['Favorite Blog', 'true'],
      ['Favorite Shop', 'false'],
    ]);
    expect(host.querySelector(`[data-project="${UNFILED_PROJECT_ID}"] [data-testid="projects-star"]`)).toBeNull();
    fakes.workspace.setFavorite.mockResolvedValueOnce({ status: 'ok' });
    fakes.projects.list.mockResolvedValue({ projects: [unfiled, { ...shop, favorite: true }, blog] });
    await act(async () => stars[1]!.click());
    await flush();
    expect(fakes.workspace.setFavorite).toHaveBeenCalledWith(P1, true);
    expect(names()).toEqual(['Unfiled', 'Blog', 'Shop']);
    // Unstarring Blog moves it below Shop; its star gets focus back (a browser drops focus from a
    // moved node, which jsdom does not: the blur below stands in for it).
    let answerFavorite!: (value: unknown) => void;
    fakes.workspace.setFavorite.mockReturnValueOnce(new Promise((resolve) => (answerFavorite = resolve)));
    fakes.projects.list.mockResolvedValue({ projects: [unfiled, { ...shop, favorite: true }, { ...blog, favorite: false }] });
    const blogStar = () => host.querySelector<HTMLButtonElement>(`[data-project="${P2}"] [data-testid="projects-star"]`)!;
    blogStar().focus();
    await act(async () => blogStar().click());
    blogStar().blur();
    expect(document.activeElement).not.toBe(blogStar());
    await act(async () => answerFavorite({ status: 'ok' }));
    await flush();
    expect(fakes.workspace.setFavorite).toHaveBeenLastCalledWith(P2, false);
    expect(names()).toEqual(['Unfiled', 'Shop', 'Blog']);
    expect(blogStar().getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(blogStar());
    // Tags on a page row: shown as text; edited inline; a refused tag is said and nothing is sent.
    expect(all('projects-tag').map((tag) => tag.textContent)).toEqual(['sale']);
    // The button's accessible name starts with its visible text.
    expect($('projects-page-tags-edit')!.textContent).toBe('Edit tags');
    expect($('projects-page-tags-edit')!.getAttribute('aria-label')).toBe('Edit tags for https://shop.com/');
    await click('projects-page-tags-edit');
    const input = $<HTMLInputElement>('projects-tags-input')!;
    expect(input.value).toBe('sale');
    expect(input.getAttribute('aria-label')).toBe('Tags for https://shop.com/');
    await type(input, 'sale, x\u0007y');
    await click('projects-tags-save');
    expect(fakes.workspace.setTags).not.toHaveBeenCalled();
    expect($('projects-tags-editor')!.textContent).toContain(PROJECT_REFUSAL_MESSAGES['invalid-tag']);
    fakes.workspace.setTags.mockResolvedValueOnce({ status: 'ok', tags: ['sale', 'summer'] });
    await type($<HTMLInputElement>('projects-tags-input')!, 'Sale,  Summer ');
    await click('projects-tags-save');
    expect(fakes.workspace.setTags).toHaveBeenCalledWith(P1, 'page', PAGE, ['sale', 'summer']);
    await flush();
    expect($('projects-tags-editor')).toBeNull();
    expect(document.activeElement).toBe($('projects-page-tags-edit'));
    // Esc cancels an edit without closing the sheet.
    await click('projects-page-tags-edit');
    await act(async () => $('projects-tags-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect($('projects-tags-editor')).toBeNull();
    expect($('projects-view')).not.toBeNull();
  });

  test('projects-run-progress-on-every-view', async () => {
    const project = { id: P1, name: 'Shop', unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 1, lastCapturedAt: null };
    fakes.projects.list.mockResolvedValue({ projects: [project] });
    fakes.projects.get.mockResolvedValue({ project, pages: [], queries: [], competitors: [] });
    fakes.projects.runState.mockResolvedValueOnce({ version: 1, runId: P1, projectId: P1, state: 'running', current: 1, total: 2, omitted: 0, screenshot: false, targets: [], blockedReason: null }).mockReturnValue(new Promise(() => undefined));
    fakes.rankings.table.mockReturnValue(new Promise(() => undefined));
    fakes.rankings.readingDates.mockReturnValue(new Promise(() => undefined));
    const { openProjects } = await import('../components/changes/projects-sheet');
    openProjects({ projectId: P1 });
    await act(async () => root.render(createElement(Projects, { tab: undefined, onClose: vi.fn() })));
    await flush();
    expect($('projects-view')!.dataset.running).toBe('true');
    for (const view of PROJECT_VIEWS) {
      await click(`projects-view-${view}`);
      expect($('projects-detail')!.dataset.view).toBe(view);
      expect($('projects-run'), view).not.toBeNull();
      expect($('projects-run-cancel'), view).not.toBeNull();
    }
  });

  // spec: specs/projects.feature.md — The sheet (Due, Check rankings and a blocked run; Settings: the cadence)
  test('projects-due-check-rankings-and-cadence', async () => {
    // As it ships once L1 is cleared (the flag injected); `rank-check-hidden-until-cleared` has the shipped flag.
    flags.rankCheck = true;
    const SEARCH_ID = '01920000-0000-7000-8000-0000000000d1';
    const project = summary(P1, 'Shop', { cadence: 'daily', due: true });
    await openSheet(project, { queries: [{ id: SEARCH_ID, params: params('tea'), url: params('tea').url, lastCapturedAt: null, changeCount: null, tags: [] }] }, [project, summary(P2, 'Other')]);
    // "Due" beside the due project only, described by its note.
    const due = Object.fromEntries(all('projects-item').map((item) => [item.dataset.project, item.querySelector('[data-testid="projects-due"]')]));
    expect(due[P1]!.textContent).toBe(DUE_TEXT.label);
    expect(due[P1]!.getAttribute('title')).toBe(DUE_TEXT.note);
    expect(due[P2]).toBeNull();
    // Check rankings: the saved searches only; a declined disclosure is said.
    fakes.workspace.checkRankings.mockResolvedValueOnce({ status: 'refused', reason: 'declined' });
    await click('projects-check-rankings');
    expect(fakes.workspace.checkRankings).toHaveBeenCalledExactlyOnceWith(P1);
    expect($('projects-status')!.textContent).toBe(RUN_REFUSAL_MESSAGES.declined);
    // Settings: the cadence menu and its note; no automatic switch while it is not offered.
    await click('projects-view-settings');
    expect($<HTMLSelectElement>('projects-cadence')!.value).toBe('daily');
    expect([...$<HTMLSelectElement>('projects-cadence')!.options].map((option) => option.value)).toEqual(['off', 'daily', 'weekly']);
    expect($('projects-cadence-note')!.textContent).toBe(CAPTURE_SCHEDULE_NOTE);
    expect($('projects-auto-capture')).toBeNull();
    fakes.workspace.setCadence.mockResolvedValueOnce({ status: 'refused', reason: 'declined' });
    await select('projects-cadence', 'weekly');
    expect(fakes.workspace.setCadence).toHaveBeenLastCalledWith(P1, 'weekly');
    expect($('projects-status')!.textContent).toBe(CADENCE_TEXT.declined);
    fakes.workspace.setCadence.mockResolvedValueOnce({ status: 'ok' });
    await select('projects-cadence', 'off');
    expect(fakes.workspace.setCadence).toHaveBeenLastCalledWith(P1, 'off');
    expect($('projects-status')!.textContent).toBe(CADENCE_TEXT.saved);
    expect(fakes.workspace.setAutoCapture).not.toHaveBeenCalled();
  });

  // spec: specs/projects.feature.md — Searches in a run (Legal gate L1); Cadence (Legal gate L1); Command palette
  test('rank-check-hidden-until-cleared', async () => {
    // The shipped flag: nothing of "Check rankings" or the cadence / Due notice until the owner's L1 note.
    expect(RANK_CHECK_AVAILABLE).toBe(false);
    const SEARCH_ID = '01920000-0000-7000-8000-0000000000d1';
    // Even a summary that says due (main never sends one while the flag is off) shows no "Due".
    const project = summary(P1, 'Shop', { cadence: 'daily', due: true });
    await openSheet(project, { queries: [{ id: SEARCH_ID, params: params('tea'), url: params('tea').url, lastCapturedAt: null, changeCount: null, tags: [] }] }, [project, summary(P2, 'Other', { due: true })]);
    expect(all('projects-item')).toHaveLength(2);
    expect(all('projects-due')).toEqual([]);
    // Overview: Capture now, no Check rankings.
    expect($('projects-capture')).not.toBeNull();
    expect($('projects-check-rankings')).toBeNull();
    expect(host.textContent).not.toContain(CHECK_RANKINGS_TEXT.button);
    // Settings: the site and competitors, no cadence section.
    await click('projects-view-settings');
    expect($('projects-settings')).not.toBeNull();
    expect($('projects-site-input')).not.toBeNull();
    expect($('projects-cadence')).toBeNull();
    expect($('projects-cadence-note')).toBeNull();
    expect($('projects-auto-capture')).toBeNull();
    expect(host.textContent).not.toContain(CADENCE_TEXT.title);
    expect(fakes.workspace.setCadence).not.toHaveBeenCalled();
    expect(fakes.workspace.checkRankings).not.toHaveBeenCalled();
    // The palette: no "Check rankings now", even with a project opened; "Capture project now" stays.
    const { projectsPaletteSources } = await import('../projects-palette');
    const { createPaletteRegistry } = await import('../palette/registry');
    const registry = createPaletteRegistry();
    registry.register(...projectsPaletteSources({ open: vi.fn(), lastProject: () => P1, startRun: vi.fn(async () => null) }));
    const active = { id: 1, url: 'https://www.example.com/a' } as TabState;
    const ids = registry.resolve({ state: null, tab: active, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } }).map((action) => action.id);
    expect(ids).toContain('projects.capture-now');
    expect(ids).not.toContain('projects.check-rankings');
  });

  // spec: specs/projects.feature.md — The sheet (Bulk add note); rankings.feature.md — Empty states (L1 variants)
  test('rank-check-wording-follows-the-flag', async () => {
    for (const [flag, note, empty] of [
      [undefined, BULK_ADD_TEXT.noteWithoutRankCheck, RANK_VIEW_TEXT.noReadingsWithoutRankCheck],
      [true, BULK_ADD_TEXT.note, RANK_VIEW_TEXT.noReadings],
    ] as const) {
      flags.rankCheck = flag;
      // Rankings and Compare with no readings yet.
      fakes.rankings.table.mockResolvedValue(tableAnswer([]));
      await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
      await flush();
      expect($('rankings-no-readings')!.textContent, String(flag)).toBe(empty);
      await act(async () => root.render(createElement(Compare, { projectId: P1, refreshKey: 1 })));
      await flush();
      expect(host.querySelector('.rankings-notice')!.textContent, String(flag)).toBe(empty);
      await act(async () => root.render(createElement('div')));
      // The Bulk add note.
      await openSheet(summary(P1, 'Shop'));
      await click('projects-bulk-open');
      expect($('projects-bulk-note')!.textContent, String(flag)).toBe(note);
      await act(async () => root.render(createElement('div')));
    }
    expect(RANK_CHECK_AVAILABLE).toBe(false);
  });

  // spec: specs/projects.feature.md — Searches in a run (a blocked run); The sheet (its note)
  test('projects-blocked-run-says-why', async () => {
    const project = summary(P1, 'Shop');
    fakes.projects.list.mockResolvedValue({ projects: [project] });
    fakes.projects.get.mockResolvedValue({ project, pages: [], queries: [], competitors: [] });
    const targets = [
      { kind: 'query', label: '“tea” on Google', outcome: 'blocked', changeCount: null, screenshot: null },
      { kind: 'query', label: '“coffee” on Google', outcome: 'cancelled', changeCount: null, screenshot: null },
    ];
    fakes.projects.runState.mockResolvedValueOnce({ version: 1, runId: P1, projectId: P1, state: 'blocked', current: 1, total: 2, omitted: 0, screenshot: false, targets, blockedReason: 'not-a-result-page' }).mockReturnValue(new Promise(() => undefined));
    const { openProjects } = await import('../components/changes/projects-sheet');
    openProjects({ projectId: P1 });
    await act(async () => root.render(createElement(Projects, { tab: undefined, onClose: vi.fn() })));
    await flush();
    expect($('projects-run')!.dataset.state).toBe('blocked');
    expect($('projects-run-cancel')).toBeNull();
    expect($('projects-run-blocked')!.textContent).toContain(RUN_BLOCK_REASON_LABELS['not-a-result-page']);
    expect($('projects-run-blocked')!.textContent).toContain(RUN_BLOCKED_NOTE);
    expect(all('projects-run-target').map((target) => target.dataset.outcome)).toEqual(['blocked', 'cancelled']);
  });

  test('rank-point-shows-source', async () => {
    // Phase 12 Task 4: each point says where it came from, in the table (the latest) and in the series.
    const api: RankPoint = { ...point('tea-3', 3_000), source: 'serp-api', provider: 'serpapi' };
    const tea = { ...row(KEY_A, 'tea'), latest: api, previous: point('tea-2', 2_000), points: [point('tea-2', 2_000), api] };
    const coffee = row(KEY_B, 'coffee');
    fakes.rankings.table.mockResolvedValue(tableAnswer([tea, coffee]));
    fakes.rankings.series.mockResolvedValue({ status: 'ok', searchKey: KEY_A, points: [point('tea-2', 2_000), api, { ...point('tea-4', 4_000), source: 'serp-api' }], capped: false });
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
    await flush();
    expect(all('rankings-source').map((cell) => cell.textContent)).toEqual(['SerpApi API', DATA_CHECK_TEXT.sourceCapture]);
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[data-testid="rankings-row-open"]')[0]!.click());
    await flush();
    // Newest first: an API point whose vendor is unknown, the SerpApi one, the tab capture.
    expect(all('rankings-series-source').map((cell) => cell.textContent)).toEqual([DATA_CHECK_TEXT.sourceApiUnknown, 'SerpApi API', 'Tab capture']);
  });

  test('api-check-button-follows-main', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    const render = async (plan: unknown) => {
      fakes.dataSources.checkPlan.mockResolvedValue(plan);
      await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: Math.random(), busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
      await flush();
    };
    // The legal gate closed (as shipped), or main unreachable: no button at all.
    await render({ status: 'refused', reason: 'unavailable' });
    expect($('rankings-api-check')).toBeNull();
    await render(null);
    expect($('rankings-api-check')).toBeNull();
    // No key, no vendor chosen, nothing to check: disabled, with the reason in words.
    for (const reason of ['no-key', 'no-provider', 'no-searches'] as const) {
      await render({ status: 'refused', reason });
      expect($<HTMLButtonElement>('rankings-api-check')!.disabled, reason).toBe(true);
      expect($('rankings-api-check-reason')!.textContent, reason).toBe(DATA_CHECK_REFUSAL_MESSAGES[reason]);
    }
    expect(DATA_CHECK_REFUSAL_MESSAGES['no-key']).toBe('Add a key in Settings › Data sources.');
    expect(DATA_CHECK_REFUSAL_MESSAGES['no-provider']).toBe('Choose a provider in Settings › Data sources.');
    // Ready: enabled, and disabled while a capture run is under way.
    await render({ status: 'ready', provider: 'serpapi', requests: 3 });
    expect($<HTMLButtonElement>('rankings-api-check')!.disabled).toBe(false);
    expect($('rankings-api-check-reason')).toBeNull();
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: true, onOpenUrl: vi.fn(), say: vi.fn() })));
    await flush();
    expect($<HTMLButtonElement>('rankings-api-check')!.disabled).toBe(true);
    expect(fakes.dataSources.checkProjectSearches).not.toHaveBeenCalled();
  });

  test('api-check-says-the-count-first', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    fakes.dataSources.checkPlan.mockResolvedValue({ status: 'ready', provider: 'serpapi', requests: 3 });
    fakes.dataSources.checkProjectSearches.mockResolvedValue({ status: 'checked', provider: 'serpapi', results: [] });
    const say = vi.fn();
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say })));
    await flush();
    // The confirm, before anything is sent: the count, the vendor and the cost note. Cancel sends nothing.
    await click('rankings-api-check');
    await flush();
    expect($('rankings-api-check-confirm')!.textContent).toContain('This sends 3 requests to SerpApi.');
    expect($('rankings-api-check-confirm')!.textContent).toContain(DATA_SPEND_NOTE);
    expect($('rankings-api-check-send')!.textContent).toBe('Send 3 requests');
    // Drawn as the app's confirm buttons (never bare text on the notice): Send is the primary action.
    expect([...$('rankings-api-check-send')!.classList]).toEqual(['panel-button', 'panel-button-primary']);
    expect([...$('rankings-api-check-cancel')!.classList]).toEqual(['panel-button']);
    await click('rankings-api-check-cancel');
    expect($('rankings-api-check-confirm')).toBeNull();
    expect(fakes.dataSources.checkProjectSearches).not.toHaveBeenCalled();
    // Send asks for exactly what was shown; the table is read again and the outcome said.
    const reads = fakes.rankings.table.mock.calls.length;
    fakes.dataSources.checkProjectSearches.mockResolvedValue({
      status: 'checked',
      provider: 'serpapi',
      results: [
        { searchId: '01920000-0000-7000-8000-0000000000b1', result: 'stored' },
        { searchId: '01920000-0000-7000-8000-0000000000b2', result: 'stored' },
        { searchId: '01920000-0000-7000-8000-0000000000b3', result: 'failed', outcome: 'vendor-error' },
      ],
    });
    await click('rankings-api-check');
    await flush();
    await click('rankings-api-check-send');
    await flush();
    expect(fakes.dataSources.checkProjectSearches.mock.calls).toEqual([[{ projectId: P1, provider: 'serpapi', requests: 3 }]]);
    expect(say).toHaveBeenLastCalledWith(DATA_CHECK_TEXT.done(2, 3, 'SerpApi'));
    expect(fakes.rankings.table.mock.calls.length).toBeGreaterThan(reads);
    expect($('rankings-api-check-confirm')).toBeNull();
    // Main's plan is read again on the press: refused by then (the key cleared meanwhile), it says why and opens no confirm.
    fakes.dataSources.checkPlan.mockResolvedValue({ status: 'refused', reason: 'no-key' });
    await click('rankings-api-check');
    await flush();
    expect($('rankings-api-check-confirm')).toBeNull();
    expect(say).toHaveBeenLastCalledWith(DATA_CHECK_REFUSAL_MESSAGES['no-key']);
    expect(fakes.dataSources.checkProjectSearches).toHaveBeenCalledTimes(1);
  });

  test('api-check-palette-opens-the-confirm', async () => {
    // The palette's command leaves a request; the Rankings view of that project shows the confirm (never sends).
    const { requestApiCheck } = await import('../data-sources-palette');
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea')]));
    fakes.dataSources.checkPlan.mockResolvedValue({ status: 'ready', provider: 'serpapi', requests: 1 });
    requestApiCheck(P1);
    await act(async () => root.render(createElement(Rankings, { projectId: P1, refreshKey: 1, busy: false, onOpenUrl: vi.fn(), say: vi.fn() })));
    await flush();
    expect($('rankings-api-check-confirm')!.textContent).toContain('This sends 1 request to SerpApi.');
    // While the view is open too; another project's request is not this view's.
    await click('rankings-api-check-cancel');
    requestApiCheck('01920000-0000-7000-8000-0000000000ff');
    await flush();
    expect($('rankings-api-check-confirm')).toBeNull();
    await act(async () => requestApiCheck(P1));
    await flush();
    expect($('rankings-api-check-confirm')).not.toBeNull();
    expect(fakes.dataSources.checkProjectSearches).not.toHaveBeenCalled();
  });
});
