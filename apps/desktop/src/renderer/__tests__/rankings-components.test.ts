// @vitest-environment jsdom
// Spec: specs/rankings.spec.ts (RANK_VIEW_TEXT, RANKINGS_REFUSAL_MESSAGES), specs/projects.spec.ts (PROJECT_VIEWS)
// Acceptance: specs/rankings.feature.md (The views: compare-keeps-picks-on-refresh,
// compare-shares-one-dates-read, compare-drops-a-stale-answer, compare-says-refusals,
// series-close-returns-focus); specs/projects.feature.md (The sheet: projects-run-progress-on-every-view)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RANKINGS_REFUSAL_MESSAGES, type RankPoint, type RankTableRow, type ReadingDate, type SearchParamsShape } from '@app/specs/rankings.spec';

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
}));

vi.mock('../ipc', () => ({
  rankingsActions: fakes.rankings,
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

beforeEach(() => {
  for (const fake of [...Object.values(fakes.rankings), ...Object.values(fakes.projects)]) fake.mockReset();
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

  test('series-close-returns-focus', async () => {
    fakes.rankings.table.mockResolvedValue(tableAnswer([row(KEY_A, 'tea'), row(KEY_B, 'coffee')]));
    fakes.rankings.series.mockResolvedValue({ status: 'ok', searchKey: KEY_B, points: [point('coffee-2', 2_000)] });
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

  test('projects-run-progress-on-every-view', async () => {
    const project = { id: P1, name: 'Shop', unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 1, lastCapturedAt: null };
    fakes.projects.list.mockResolvedValue({ projects: [project] });
    fakes.projects.get.mockResolvedValue({ project, pages: [], queries: [], competitors: [] });
    fakes.projects.runState.mockResolvedValueOnce({ version: 1, runId: P1, projectId: P1, state: 'running', current: 1, total: 2, omitted: 0, screenshot: false, targets: [] }).mockReturnValue(new Promise(() => undefined));
    fakes.rankings.table.mockReturnValue(new Promise(() => undefined));
    fakes.rankings.readingDates.mockReturnValue(new Promise(() => undefined));
    const { openProjects } = await import('../components/changes/projects-sheet');
    openProjects({ projectId: P1 });
    await act(async () => root.render(createElement(Projects, { tab: undefined, onClose: vi.fn() })));
    await flush();
    expect($('projects-view')!.dataset.running).toBe('true');
    for (const view of ['overview', 'rankings', 'compare']) {
      await click(`projects-view-${view}`);
      expect($('projects-detail')!.dataset.view).toBe(view);
      expect($('projects-run'), view).not.toBeNull();
      expect($('projects-run-cancel'), view).not.toBeNull();
    }
  });
});
