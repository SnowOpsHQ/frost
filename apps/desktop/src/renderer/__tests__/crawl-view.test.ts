// @vitest-environment jsdom
// Spec: specs/site-crawl.spec.ts (CRAWL_VIEW_TEXT, CRAWL_SCORE_LABEL, CRAWL_PAGE_FLAGS, CRAWL_PAGE_SORTS, CRAWL_PAGE_FILTERS,
// CRAWL_PAGES_LIMITS, CRAWL_RULE_IDS, CRAWL_EXCLUDED_CATEGORIES, CRAWL_EXCLUDED_RULES, CRAWL_REFUSAL_TEXT, CRAWL_INTERVAL_MS,
// CRAWL_LIMITS), specs/site-crawl.schema.ts (CrawlStatusView, CrawlRunView, CrawlPageListRow, CrawlWatchView: types only),
// specs/fetcher.spec.ts (FETCH_DISCLOSURE), specs/data-sources.spec.ts (LEGAL_GATE_NOTE)
// Acceptance: specs/site-crawl.feature.md (Pages and Site structure, Task 7: The crawl sheet, Pages, Site structure,
// Entry points) · plan docs/plans/phase-12-big-bets.md Decision 6 (the score label, the rule-set note, retention per
// run, FETCH_DISCLOSURE), Task 7 (renderer `crawl-view.test.ts`), "As built" (the renderer reads `available` from main)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LEGAL_GATE_NOTE } from '@app/specs/data-sources.spec';
import { FETCH_DISCLOSURE } from '@app/specs/fetcher.spec';
import { SEO_CATEGORY_LABELS } from '@app/specs/seo-rules.spec';
import type { CrawlPageListRow, CrawlPagesAnswer, CrawlRunView, CrawlStatusView, CrawlStructureAnswer, CrawlWatchView } from '@app/specs/site-crawl.schema';
import {
  CRAWL_EXCLUDED_CATEGORIES,
  CRAWL_INTERVAL_MS,
  CRAWL_LIMITS,
  CRAWL_PAGE_FLAGS,
  CRAWL_PAGES_LIMITS,
  CRAWL_REFRESH_MS,
  CRAWL_REFUSAL_TEXT,
  CRAWL_SCORE_LABEL,
  CRAWL_VIEW_TEXT,
  type CrawlServiceAnswer,
} from '@app/specs/site-crawl.spec';
import { crawlPaletteSources } from '../crawl-palette';
import {
  CRAWL_PAGE_COLUMNS,
  answerText,
  crawlFormFor,
  crawlRuleSetNote,
  crawlSiteOf,
  crawlStartInput,
  csvAnswerText,
  depthBars,
  openInTab,
  openTargetOf,
  pageFlagsText,
  pagesQueryWith,
  refreshDelay,
  robotsText,
  pagingOf,
  runCrawlWatch,
  runRowOf,
  runSizeText,
  startControl,
  treeNodeLabel,
  DEFAULT_PAGES_QUERY,
} from '../crawl-view';
import type { PaletteContext } from '../palette/registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN_ID = '01900000-0000-7000-8000-0000000000a1';
const SETTINGS = { startUrl: 'https://example.com/', scope: 'host', include: [], exclude: [], maxPages: 500, intervalMs: 1_000, sitemaps: true } as const;

const run = (changes: Partial<CrawlRunView> = {}): CrawlRunView => ({
  id: RUN_ID,
  projectId: null,
  startUrl: 'https://example.com/',
  settings: { ...SETTINGS, include: [], exclude: [] },
  state: 'paused',
  reason: 'user',
  counts: { pages: 12, queued: 30, refused: 2, failed: 1, bytes: 1_572_864 },
  createdAt: 1,
  updatedAt: 2,
  finishedAt: null,
  ...changes,
});

const view = (changes: Partial<CrawlStatusView> = {}): CrawlStatusView => ({ available: false, activeRunId: null, runs: [run()], ...changes });

const pageRow = (changes: Partial<CrawlPageListRow> = {}): CrawlPageListRow => ({
  url: 'https://example.com/a',
  depth: 1,
  outcome: 'crawled',
  status: 200,
  finalUrl: null,
  contentType: 'text/html',
  title: 'A',
  canonical: null,
  indexable: true,
  robotsCrawl: 'allowed',
  robotsGooglebot: 'allowed',
  wordCount: 400,
  linkTotal: 10,
  linksCut: false,
  score: 88,
  findings: [{ id: 'title-too-short', severity: 'warning' }],
  outlinks: 10,
  bytes: 1_000,
  fetchedAt: 1,
  inlinks: 3,
  ...changes,
});

describe('the crawl view model', () => {
  test('crawl-view-start-form-defaults-to-the-active-tab-site', () => {
    expect(crawlSiteOf('https://www.example.com/blog/post?x=1#top')).toBe('https://www.example.com/');
    expect(crawlSiteOf('http://127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/');
    expect(crawlSiteOf('about:blank')).toBeNull();
    expect(crawlSiteOf('')).toBeNull();
    const form = crawlFormFor('https://www.example.com/blog/post');
    expect(form).toEqual({ startUrl: 'https://www.example.com/', scope: 'host', include: '', exclude: '', maxPages: String(CRAWL_LIMITS.defaultMaxPages), intervalMs: CRAWL_INTERVAL_MS.default, sitemaps: true });
    expect(crawlFormFor(undefined).startUrl).toBe('');
    // The form becomes main's input: prefixes one per line, numbers parsed; main checks it again.
    expect(crawlStartInput({ ...form, include: '/blog\n\n /docs ', exclude: '/blog/tag', maxPages: '200' }, null)).toEqual({
      ok: true,
      input: { settings: { startUrl: 'https://www.example.com/', scope: 'host', include: ['/blog', '/docs'], exclude: ['/blog/tag'], maxPages: 200, intervalMs: 1_000, sitemaps: true }, projectId: null },
    });
    expect(crawlStartInput({ ...form, startUrl: 'ftp://x' }, null)).toMatchObject({ ok: false });
    expect(crawlStartInput({ ...form, maxPages: '0' }, null)).toMatchObject({ ok: false });
    expect(crawlStartInput({ ...form, maxPages: String(CRAWL_LIMITS.maxPagesCap + 1) }, null)).toMatchObject({ ok: false });
    expect(crawlStartInput({ ...form, include: 'blog' }, null)).toMatchObject({ ok: false });
    expect(crawlStartInput({ ...form, include: Array.from({ length: CRAWL_LIMITS.maxPrefixes + 1 }, (_, i) => `/p${i}`).join('\n') }, null)).toMatchObject({ ok: false });
    expect(crawlStartInput(form, RUN_ID)).toMatchObject({ ok: true, input: { projectId: RUN_ID } });
  });

  test('crawl-view-gated-disabled', () => {
    // As shipped, main's view says `available: false`: Start and Resume are disabled, with the gate's note.
    expect(startControl(view())).toEqual({ disabled: true, note: LEGAL_GATE_NOTE });
    const paused = runRowOf(run(), view());
    expect(paused.resume).toEqual({ shown: true, disabled: true, note: LEGAL_GATE_NOTE });
    // Existing runs can still be viewed, exported and deleted (and a paused one cancelled).
    expect(paused.canDelete).toBe(true);
    expect(paused.canExport).toBe(true);
    expect(paused.canCancel).toBe(true);
    // Loading: nothing to start yet, no note.
    expect(startControl(null)).toEqual({ disabled: true, note: null });
  });

  test('crawl-view-injected-open-gate', () => {
    const open = view({ available: true });
    expect(startControl(open)).toEqual({ disabled: false, note: null });
    expect(runRowOf(run(), open).resume).toEqual({ shown: true, disabled: false, note: null });
    // One crawl at a time: a running one disables Start, and shows Pause and Cancel, never Resume.
    const running = view({ available: true, activeRunId: RUN_ID, runs: [run({ state: 'running', reason: null })] });
    expect(startControl(running)).toEqual({ disabled: true, note: CRAWL_REFUSAL_TEXT.busy });
    const row = runRowOf(running.runs[0]!, running);
    expect(row).toMatchObject({ canPause: true, canCancel: true, resume: { shown: false } });
    // Finished runs: no pause, resume or cancel; delete and export stay.
    for (const state of ['done', 'cancelled', 'failed'] as const) {
      expect(runRowOf(run({ state, reason: null }), open)).toMatchObject({ canPause: false, canCancel: false, canDelete: true, canExport: true, resume: { shown: false } });
    }
    // A run whose settings no longer parse is never offered Resume.
    expect(runRowOf(run({ settings: null }), open).resume.shown).toBe(false);
  });

  test('crawl-view-run-size-and-retention-note', () => {
    expect(runSizeText(run().counts)).toBe('12 pages · 1.5 MB fetched');
    expect(runSizeText({ pages: 1, queued: 0, refused: 0, failed: 0, bytes: 900 })).toBe('1 page · 0.9 KB fetched');
    const row = runRowOf(run(), view());
    expect(row.size).toBe('12 pages · 1.5 MB fetched');
    expect(row.progress).toContain('30 queued');
    expect(row.progress).toContain('2 refused');
    expect(row.progress).toContain('1 failed');
    expect(CRAWL_VIEW_TEXT.retentionNote.toLowerCase()).toContain('deleted per run');
    // A slow-down pause says why.
    expect(runRowOf(run({ reason: 'slow-down' }), view()).state).toContain('slow down');
  });

  test('crawl-view-score-label-and-rule-set', () => {
    const score = CRAWL_PAGE_COLUMNS.find((column) => column.id === 'score');
    expect(score?.label).toBe(CRAWL_SCORE_LABEL);
    const note = crawlRuleSetNote();
    // The categories the crawl rule set uses, by their labels; what it leaves out, with reasons.
    expect(note.categories).toContain(SEO_CATEGORY_LABELS.title);
    expect(note.categories).toContain(SEO_CATEGORY_LABELS.schema);
    expect(note.categories).not.toContain(SEO_CATEGORY_LABELS.performance);
    for (const [category, reason] of Object.entries(CRAWL_EXCLUDED_CATEGORIES)) expect(note.excluded).toContainEqual({ label: SEO_CATEGORY_LABELS[category as keyof typeof SEO_CATEGORY_LABELS], reason });
    expect(note.excluded.some((item) => item.label.includes('H1') || item.label.includes('h1'))).toBe(true);
    // Never "health score", anywhere the sheet's words come from.
    const words = JSON.stringify([CRAWL_VIEW_TEXT.ruleSetIntro, CRAWL_VIEW_TEXT.ruleSetTitle, CRAWL_PAGE_COLUMNS, note]).toLowerCase();
    expect(words).not.toContain('health score');
    expect(CRAWL_VIEW_TEXT.ruleSetIntro).toContain(CRAWL_SCORE_LABEL);
  });

  test('crawl-view-page-flags-and-open-in-tab', async () => {
    expect(pageFlagsText(pageRow({ linksCut: true, linkTotal: 3_000 }))).toEqual([CRAWL_PAGE_FLAGS.linksCut]);
    expect(pageFlagsText(pageRow({ wordCount: 12 }))).toEqual([CRAWL_PAGE_FLAGS.clientRendered]);
    expect(pageFlagsText(pageRow({ wordCount: 12, status: 404 }))).toEqual([]);
    expect(CRAWL_PAGE_FLAGS.linksCut).toBe('links cut at 1 000');
    // "Open in tab" uses the address bar's path (`browser.navigate`), after the sheet closes.
    expect(openTargetOf(pageRow())).toBe('https://example.com/a');
    expect(openTargetOf(pageRow({ url: 'javascript:alert(1)' as string }))).toBeNull();
    const calls: string[] = [];
    const navigate = vi.fn(async (url: string) => {
      calls.push(`navigate ${url}`);
      return true;
    });
    expect(await openInTab('https://example.com/a', { close: () => calls.push('close'), navigate })).toBe(true);
    expect(calls).toEqual(['close', 'navigate https://example.com/a']);
    expect(await openInTab('file:///etc/passwd', { close: () => calls.push('close'), navigate })).toBe(false);
    expect(navigate).toHaveBeenCalledOnce();
  });

  test('crawl-view-pages-paging-and-filters', () => {
    expect(DEFAULT_PAGES_QUERY).toEqual({ filter: {}, sort: 'order', direction: 'asc', offset: 0, limit: CRAWL_PAGES_LIMITS.defaultPageSize });
    expect(DEFAULT_PAGES_QUERY.limit).toBeLessThanOrEqual(CRAWL_PAGES_LIMITS.maxPageSize);
    // A filter or sort change goes back to the first page; an empty value drops the filter.
    const later = { ...DEFAULT_PAGES_QUERY, offset: 100 };
    expect(pagesQueryWith(later, { filter: { indexable: 'no' } })).toEqual({ ...DEFAULT_PAGES_QUERY, filter: { indexable: 'no' } });
    expect(pagesQueryWith({ ...later, filter: { indexable: 'no' } }, { filter: { indexable: undefined } }).filter).toEqual({});
    expect(pagesQueryWith(later, { sort: 'score', direction: 'desc' })).toMatchObject({ sort: 'score', direction: 'desc', offset: 0 });
    expect(pagesQueryWith(later, { offset: 150 })).toMatchObject({ offset: 150 });
    expect(pagingOf({ ...DEFAULT_PAGES_QUERY, offset: 50 }, 120)).toEqual({ text: '51–100 of 120', prev: 0, next: 100 });
    expect(pagingOf(DEFAULT_PAGES_QUERY, 30)).toEqual({ text: '1–30 of 30', prev: null, next: null });
    expect(pagingOf({ ...DEFAULT_PAGES_QUERY, offset: 100 }, 120)).toEqual({ text: '101–120 of 120', prev: 50, next: null });
    expect(pagingOf(DEFAULT_PAGES_QUERY, 0).text).toBe('No pages');
  });

  test('crawl-view-robots-verdicts-and-refresh', () => {
    // Decision 6: the crawl's own verdict and Googlebot's, from the same robots.txt.
    expect(CRAWL_PAGE_COLUMNS.map((column) => column.label)).toContain('robots.txt');
    expect(robotsText(pageRow({ robotsCrawl: 'allowed', robotsGooglebot: 'blocked' }))).toBe('frost-crawl: allowed · Googlebot: blocked');
    expect(robotsText(pageRow({ robotsCrawl: 'blocked', robotsGooglebot: 'unknown' }))).toBe('frost-crawl: blocked · Googlebot: unknown');
    // While a run runs, its views read again at most every CRAWL_REFRESH_MS; another run or state at once.
    const mark = { runId: RUN_ID, state: 'running' as const, pages: 10, at: 1_000 };
    expect(refreshDelay(null, mark, 1_000)).toBe(0);
    expect(refreshDelay(mark, { ...mark, pages: 10 }, 9_000)).toBeNull();
    expect(refreshDelay(mark, { ...mark, pages: 11 }, 2_000)).toBe(CRAWL_REFRESH_MS - 1_000);
    expect(refreshDelay(mark, { ...mark, pages: 12 }, 1_000 + CRAWL_REFRESH_MS + 1)).toBe(0);
    expect(refreshDelay(mark, { ...mark, state: 'paused' }, 1_001)).toBe(0);
    expect(refreshDelay(mark, { ...mark, runId: 'other' }, 1_001)).toBe(0);
    // A project covering its subdomains starts with the `site` scope.
    expect(crawlFormFor('https://shop.example.com/', 'site').scope).toBe('site');
  });

  test('crawl-view-structure', () => {
    expect(depthBars([])).toEqual([]);
    expect(depthBars([{ depth: 0, pages: 1 }, { depth: 1, pages: 4 }, { depth: 3, pages: 2 }])).toEqual([
      { depth: 0, pages: 1, percent: 25 },
      { depth: 1, pages: 4, percent: 100 },
      { depth: 3, pages: 2, percent: 50 },
    ]);
    expect(treeNodeLabel({ label: '', pages: 1, prefix: null, url: 'https://example.com/' })).toBe('/ (this folder)');
    expect(treeNodeLabel({ label: 'blog', pages: 5, prefix: 'https://example.com/blog/', url: null })).toBe('blog/');
    expect(treeNodeLabel({ label: 'about', pages: 1, prefix: null, url: 'https://example.com/about' })).toBe('about');
    expect(treeNodeLabel({ label: 'https://example.com', pages: 9, prefix: 'https://example.com/', url: null })).toBe('https://example.com');
  });

  test('crawl-view-progress-long-poll', async () => {
    const seen: number[] = [];
    let live = true;
    const answers: (CrawlWatchView | Error)[] = [
      { version: 1, status: view() },
      new Error('ipc down'),
      // An unchanged version (a timeout, or an evicted poll): rest, never spin.
      { version: 1, status: view() },
      { version: 4, status: view({ activeRunId: RUN_ID }) },
    ];
    const watch = vi.fn(async (since: number) => {
      const next = answers.shift();
      if (next === undefined) {
        live = false;
        return { version: since, status: view() };
      }
      if (next instanceof Error) throw next;
      return next;
    });
    const sleep = vi.fn(async () => undefined);
    await runCrawlWatch({ watch, onView: (v) => seen.push(v.version), isLive: () => live, sleep, retryMs: 1_000 });
    // Each poll passes the last version seen; a failed poll and an unchanged answer each rest, then ask again.
    expect(watch.mock.calls.map(([since]) => since)).toEqual([0, 1, 1, 1, 4]);
    expect(seen).toEqual([1, 4]);
    expect(sleep.mock.calls).toEqual([[1_000], [1_000]]);
    // The sheet closing abandons the poll in flight: its answer is dropped.
    let open = true;
    const late = vi.fn();
    await runCrawlWatch({
      watch: async () => {
        open = false;
        return { version: 9, status: view() };
      },
      onView: late,
      isLive: () => open,
      sleep,
      retryMs: 1_000,
    });
    expect(late).not.toHaveBeenCalled();
  });

  test('crawl-view-answer-texts', () => {
    const refused = (reason: Extract<CrawlServiceAnswer, { status: 'refused' }>['reason'], note?: string): CrawlServiceAnswer => ({ status: 'refused', reason, ...(note ? { note } : {}) });
    expect(answerText(refused('unavailable', LEGAL_GATE_NOTE))).toBe(LEGAL_GATE_NOTE);
    expect(answerText(refused('busy'))).toBe(CRAWL_REFUSAL_TEXT.busy);
    expect(answerText({ status: 'ok' })).toBeNull();
    expect(answerText(null)).toBe(CRAWL_REFUSAL_TEXT['store-failed']);
    expect(csvAnswerText({ status: 'saved', rows: 3 })).toBe('Saved 3 pages as CSV.');
    expect(csvAnswerText({ status: 'cancelled' })).toBeNull();
    expect(csvAnswerText({ status: 'refused', reason: 'write-failed' })).toBe(CRAWL_REFUSAL_TEXT['write-failed']);
  });

  test('crawl-palette-commands', () => {
    const open = vi.fn();
    const sources = crawlPaletteSources({ open });
    const actions = sources.flatMap((source) => (typeof source === 'function' ? [] : [source]));
    expect(actions.map((action) => action.label)).toEqual(['Crawl this site…', 'Show site crawl']);
    const ctx = (url: string) => ({ tab: { url } }) as unknown as PaletteContext;
    const crawlThis = actions[0]!;
    expect(crawlThis.available?.(ctx('https://www.example.com/blog/x'))).toBe(true);
    expect(crawlThis.available?.(ctx(''))).toBe(false);
    void crawlThis.run(ctx('https://www.example.com/blog/x'));
    expect(open).toHaveBeenLastCalledWith({ startUrl: 'https://www.example.com/' });
    void actions[1]!.run(ctx(''));
    expect(open).toHaveBeenLastCalledWith({});
  });
});

// ---- The sheet, rendered with an injected main view -------------------------------------------

const ipcMock = vi.hoisted(() => ({
  status: { current: null as unknown },
  pages: vi.fn(),
  structure: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
  navigate: vi.fn(async (_url: string) => true),
}));
const never = () => new Promise<never>(() => undefined);
vi.mock('../ipc', () => ({
  ipc: {
    crawl: {
      watch: { query: async ({ sinceVersion }: { sinceVersion: number }) => (sinceVersion === 0 ? { version: 1, status: ipcMock.status.current } : never()) },
      pages: { query: (input: unknown) => ipcMock.pages(input) },
      structure: { query: (input: unknown) => ipcMock.structure(input) },
      start: { mutate: (input: unknown) => ipcMock.start(input) },
      resume: { mutate: (input: unknown) => ipcMock.resume(input) },
      pause: { mutate: async () => ({ status: 'ok' }) },
      cancel: { mutate: async () => ({ status: 'ok' }) },
      delete: { mutate: async () => ({ status: 'ok' }) },
      exportCsv: { mutate: async () => ({ status: 'cancelled' }) },
    },
    help: { watch: { query: never } },
    gsc: { watch: { query: never } },
    account: { watch: { query: never }, settingsWatch: { query: never } },
  },
  actions: { focusPage: async () => false, navigate: (url: string) => ipcMock.navigate(url), listProjects: async () => [] },
}));

describe('the crawl sheet', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const pages: CrawlPagesAnswer = { status: 'ok', total: 1, offset: 0, rows: [pageRow({ linksCut: true, linkTotal: 2_000 })] };
    const structure: CrawlStructureAnswer = { status: 'ok', tree: { prefix: null, nodes: [{ label: 'https://example.com', pages: 1, prefix: 'https://example.com/', url: null }], more: 0 }, depths: [{ depth: 1, pages: 1 }], orphans: { urls: ['https://example.com/orphan'], total: 1 } };
    ipcMock.pages.mockReset().mockResolvedValue(pages);
    ipcMock.structure.mockReset().mockResolvedValue(structure);
    ipcMock.start.mockReset().mockResolvedValue({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    ipcMock.resume.mockReset().mockResolvedValue({ status: 'resumed', runId: RUN_ID });
    ipcMock.navigate.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function show(status: CrawlStatusView) {
    ipcMock.status.current = status;
    const { CrawlSheet } = await import('../components/crawl/CrawlSheet');
    const { openCrawl } = await import('../components/crawl/crawl-sheet');
    act(() => root.render(createElement(CrawlSheet, { tab: { id: 1, documentSeq: 1, loading: false, url: 'https://example.com/x' } as never, historySeq: undefined, onOpen: () => undefined })));
    await act(async () => openCrawl({ startUrl: 'https://example.com/' }));
    await act(async () => undefined);
  }
  const q = <T extends Element = HTMLElement>(testId: string) => host.querySelector<T & HTMLElement>(`[data-testid="${testId}"]`);

  test('crawl-sheet-gated-disabled', async () => {
    await show(view());
    expect(q('crawl-view')).not.toBeNull();
    // The disclosure and the rule-set note are on the start form; the score is never called a health score.
    expect(q('crawl-disclosure')!.textContent).toContain(FETCH_DISCLOSURE);
    expect(q('crawl-rule-set')!.textContent).toContain(CRAWL_SCORE_LABEL);
    expect(host.textContent!.toLowerCase()).not.toContain('health score');
    expect(q<HTMLInputElement>('crawl-start-url')!.value).toBe('https://example.com/');
    // Start and Resume disabled, the gate's note beside them.
    expect(q<HTMLButtonElement>('crawl-start')!.disabled).toBe(true);
    expect(q('crawl-start-note')!.textContent).toBe(LEGAL_GATE_NOTE);
    expect(q<HTMLButtonElement>('crawl-resume')!.disabled).toBe(true);
    expect(q('crawl-run')!.textContent).toContain(LEGAL_GATE_NOTE);
    // The run's size and "deleted per run"; viewing, exporting and deleting stay.
    expect(q('crawl-run-size')!.textContent).toBe('12 pages · 1.5 MB fetched');
    expect(q('crawl-retention-note')!.textContent).toBe(CRAWL_VIEW_TEXT.retentionNote);
    expect(q<HTMLButtonElement>('crawl-export')!.disabled).toBe(false);
    expect(q<HTMLButtonElement>('crawl-delete')!.disabled).toBe(false);
    // The run's pages are listed: paged from main, score column labelled, flags marked.
    expect(ipcMock.pages).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, offset: 0, limit: CRAWL_PAGES_LIMITS.defaultPageSize }));
    expect(q('crawl-pages')!.querySelector('thead')!.textContent).toContain(CRAWL_SCORE_LABEL);
    expect(q('crawl-page-flags')!.textContent).toContain(CRAWL_PAGE_FLAGS.linksCut);
    // Both robots.txt verdicts (Decision 6).
    expect(q('crawl-pages')!.querySelector('thead')!.textContent).toContain('robots.txt');
    expect(q('crawl-page-robots')!.textContent).toBe('frost-crawl: allowed · Googlebot: allowed');
    // The rule set's intro is shown outside its details.
    expect(q('crawl-rule-set-intro')!.closest('details')).toBeNull();
    // Open in tab: the sheet closes and the address bar's path opens the page.
    await act(async () => q('crawl-open-in-tab')!.click());
    expect(ipcMock.navigate).toHaveBeenCalledWith('https://example.com/a');
    expect(q('crawl-view')).toBeNull();
    expect(ipcMock.start).not.toHaveBeenCalled();
  });

  test('crawl-sheet-injected-open-view', async () => {
    await show(view({ available: true }));
    expect(q<HTMLButtonElement>('crawl-start')!.disabled).toBe(false);
    expect(q('crawl-start-note')!.textContent).toBe('');
    expect(q<HTMLButtonElement>('crawl-resume')!.disabled).toBe(false);
    await act(async () => q('crawl-resume')!.click());
    expect(ipcMock.resume).toHaveBeenCalledWith({ runId: RUN_ID });
    await act(async () => q('crawl-start')!.click());
    expect(ipcMock.start).toHaveBeenCalledWith({ settings: { startUrl: 'https://example.com/', scope: 'host', include: [], exclude: [], maxPages: 500, intervalMs: 1_000, sitemaps: true }, projectId: null });
    // Main still refuses (it is the authority): its note shows.
    expect(q('crawl-status')!.textContent).toBe(LEGAL_GATE_NOTE);
    // Site structure: the tree, the histogram and the orphans.
    expect(q('crawl-tab-pages')!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => q('crawl-tab-structure')!.click());
    expect(q('crawl-tab-structure')!.getAttribute('aria-pressed')).toBe('true');
    expect(ipcMock.structure).toHaveBeenCalledWith({ runId: RUN_ID, prefix: null });
    expect(q('crawl-tree')!.textContent).toContain('https://example.com');
    expect(q('crawl-depths')!.textContent).toContain('1');
    expect(q('crawl-orphans')!.textContent).toContain('https://example.com/orphan');
  });
});

describe('the crawl sheet among the other sheets', () => {
  test('crawl-and-help-sheets-exclude-each-other', async () => {
    ipcMock.status.current = view();
    ipcMock.pages.mockResolvedValue({ status: 'ok', total: 0, offset: 0, rows: [] });
    const { CrawlSheet } = await import('../components/crawl/CrawlSheet');
    const { SiteCrawlButton } = await import('../components/crawl/SiteCrawlButton');
    const { ShortcutsSheet } = await import('../components/ShortcutsView');
    const { requestHelpSheet } = await import('../help-palette');
    const { openCrawl } = await import('../components/crawl/crawl-sheet');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = { tab: { id: 1, documentSeq: 1, loading: false, url: 'https://example.com/x' } as never, historySeq: undefined, onOpen: () => undefined };
    const project = { id: RUN_ID, unfiled: false, site: { domain: 'shop.example.com', subdomains: true } };
    act(() => root.render(createElement('div', null, createElement(ShortcutsSheet, props), createElement(CrawlSheet, props), createElement(SiteCrawlButton, { project }))));
    const crawl = () => host.querySelector('[data-testid="crawl-view"]');
    const help = () => host.querySelector('[data-testid="shortcuts-view"]');
    await act(async () => openCrawl({}));
    expect(crawl()).not.toBeNull();
    // A Help sheet opening closes the crawl sheet…
    await act(async () => void requestHelpSheet('shortcuts'));
    expect(help()).not.toBeNull();
    expect(crawl()).toBeNull();
    // …and the crawl sheet opening (here from a project's "Site crawl") closes the Help sheet.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="projects-site-crawl"]')!.click());
    await act(async () => undefined);
    expect(crawl()).not.toBeNull();
    expect(help()).toBeNull();
    // The project's site and, as it covers its subdomains, the `site` scope.
    expect(host.querySelector<HTMLInputElement>('[data-testid="crawl-start-url"]')!.value).toBe('https://shop.example.com/');
    expect(host.querySelector<HTMLSelectElement>('[data-testid="crawl-scope"]')!.value).toBe('site');
    act(() => root.unmount());
    host.remove();
  });
});
