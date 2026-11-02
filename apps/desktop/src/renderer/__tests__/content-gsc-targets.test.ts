// @vitest-environment jsdom
// Spec: specs/gsc-targets.spec.ts (GSC_TARGET_SUGGESTIONS, GSC_TARGET_CHECK_DELAY_MS, GSC_TARGETS_COPY), specs/gsc.spec.ts
// (GscStatus, GSC_LIMITS.maxTargetPages), specs/gsc.schema.ts (GscQueriesAnswer, GscTargetPagesAnswer: types only),
// specs/gsc-panel.spec.ts (GSC_READ_DEBOUNCE_MS, GSC_PANEL_DEFAULTS: the panel's range)
// Acceptance: specs/seo-content.feature.md (Search Console targets; "Information, not targets"; the notes generation)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GscQueriesAnswer, GscTargetPagesAnswer, GscTargetPagesQuery } from '@app/specs/gsc.schema';
import { GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import { GSC_TARGET_CHECK_DELAY_MS, GSC_TARGET_SUGGESTIONS, GSC_TARGETS_COPY } from '@app/specs/gsc-targets.spec';
import { GSC_LIMITS, type GscStatus } from '@app/specs/gsc.spec';

/** The faked IPC: `gsc.watch` answers once per mount (or never), the reads and the notes record and answer. */
const fake = vi.hoisted(() => ({
  mount: 0,
  gsc: null as unknown,
  watchNever: false,
  calls: [] as { path: string; input: unknown }[],
  queries: null as unknown,
  pages: null as unknown,
  notes: { query: '', generation: 0 },
}));
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const record = (path: string, answer: (input: unknown) => unknown) => (input?: unknown) => (fake.calls.push({ path, input }), Promise.resolve(answer(input)));
  let answered = -1;
  return {
    actions: {},
    ipc: {
      account: { watch: { query: never }, settingsWatch: { query: never } },
      gsc: {
        watch: {
          query: () => {
            if (fake.watchNever || answered === fake.mount) return never();
            answered = fake.mount;
            return Promise.resolve(fake.gsc);
          },
        },
        status: { query: never },
        performance: { query: record('gsc.performance', never) },
        countries: { query: record('gsc.countries', never) },
        properties: { query: record('gsc.properties', never) },
        topQueries: { query: record('gsc.topQueries', () => fake.queries) },
        targetPages: { query: record('gsc.targetPages', () => fake.pages) },
        inspect: { mutate: record('gsc.inspect', never) },
      },
      content: {
        getNotes: { query: record('content.getNotes', () => ({ query: fake.notes.query, variants: [], generation: fake.notes.generation })) },
        setTarget: { mutate: record('content.setTarget', () => true) },
        saveVariant: { mutate: record('content.saveVariant', () => true) },
        deleteVariant: { mutate: record('content.deleteVariant', () => true) },
      },
    },
  };
});

const SITE = 'https://www.example.com/';
const PAGE = 'https://www.example.com/blog/tea';
const PROPERTY = { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' } as const;
const RANGE = { start: '2026-09-29', end: '2026-10-26' };
const gsc = (changes: Partial<GscStatus> = {}): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });
const QUERY_NAMES = ['green tea', 'how to brew green tea', 'sencha', '<b>matcha</b>', '‮oolong', 'genmaicha', 'hojicha'];
const QUERIES: GscQueriesAnswer = {
  status: 'ok',
  property: PROPERTY,
  scope: 'page',
  range: RANGE,
  rows: QUERY_NAMES.map((query, i) => ({ query, clicks: 700 - 100 * i, impressions: 7_000 - 500 * i, ctr: 0.1, position: 2 + i })),
};
/** `pagesRead` pages for the query, this page at `rank` (`null`: not among them); the top 10 as rows. */
function pagesAnswer(rank: number | null, pagesRead = 120, query = 'green tea'): GscTargetPagesAnswer {
  const rows = Array.from({ length: Math.min(pagesRead, GSC_LIMITS.maxTargetPages) }, (_, i) => ({
    page: rank === i + 1 ? `${PAGE}#brewing` : `${SITE}page-${i + 1}`,
    clicks: 500 - i,
    impressions: 5_000 - i,
    ctr: 0.1,
    position: 1 + i / 10,
  }));
  return { status: 'ok', property: PROPERTY, range: RANGE, query, rows, pagesRead, thisPageRank: rank };
}

let root: Root;
let host: HTMLDivElement;
let gscPrefs: typeof import('../gsc-view').gscPrefs;

/** Mounts the section as the Content panel does (the page's notes and the section under them), on fresh stores. */
async function mount(status: GscStatus | null, url = PAGE, generation = 0): Promise<void> {
  fake.gsc = status;
  fake.watchNever = status === null;
  fake.mount += 1;
  vi.resetModules();
  const { ContentGscTargets } = await import('../components/seo/ContentGscTargets');
  const { useContentNotes } = await import('../hooks/useContentNotes');
  gscPrefs = (await import('../gsc-view')).gscPrefs;
  function Harness() {
    const notes = useContentNotes(url, generation);
    return createElement('div', null, createElement('output', { 'data-testid': 'field' }, notes.query), createElement(ContentGscTargets, { url, notes }));
  }
  await act(async () => {
    root.render(createElement(Harness));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const section = () => host.querySelector<HTMLElement>('[data-testid="gsc-targets"]');
const callsTo = (path: string) => fake.calls.filter((call) => call.path === path).map((call) => call.input);
const suggestions = () => [...host.querySelectorAll<HTMLElement>('[data-testid="gsc-target-suggestion"]')];
const pageRows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="gsc-target-page"]')];
const text = (testId: string) => host.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fake.calls.length = 0;
  fake.queries = QUERIES;
  fake.pages = pagesAnswer(3);
  fake.notes = { query: '', generation: 0 };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Content panel: Search Console targets', () => {
  test('suggestions-only-when-connected', async () => {
    // Unconfigured, not connected (or connecting, or Google refused the connection), not answered yet, or
    // not a web page: nothing is added and nothing is read, even with a saved target query.
    fake.notes = { query: 'green tea', generation: 0 };
    const hidden: [GscStatus | null, string][] = [
      [gsc({ configured: false, connected: false }), PAGE],
      [gsc({ connected: false }), PAGE],
      [gsc({ connected: false, connecting: true }), PAGE],
      [gsc({ connected: false, error: 'auth-expired' }), PAGE],
      [null, PAGE],
      [gsc(), 'about:blank'],
    ];
    for (const [status, url] of hidden) {
      await mount(status, url);
      await wait(GSC_TARGET_CHECK_DELAY_MS + GSC_READ_DEBOUNCE_MS);
      expect(section(), JSON.stringify(status)).toBeNull();
      expect(host.textContent).toBe('green tea');
      expect(callsTo('gsc.topQueries')).toEqual([]);
      expect(callsTo('gsc.targetPages')).toEqual([]);
    }
    // An unavailable answer that means "not connected" hides the section too.
    fake.queries = { status: 'unavailable', reason: 'not-connected' };
    fake.notes = { query: '', generation: 0 };
    await mount(gsc());
    await wait(GSC_READ_DEBOUNCE_MS);
    expect(callsTo('gsc.topQueries')).toHaveLength(1);
    expect(section()).toBeNull();

    // Connected: the page's top queries (page scope, the panel's range, no filter), at most 5, each with "Use as target".
    fake.calls.length = 0;
    fake.queries = QUERIES;
    await mount(gsc(), `${PAGE}#comments`);
    expect(callsTo('gsc.topQueries')).toEqual([]);
    await wait(GSC_READ_DEBOUNCE_MS);
    expect(callsTo('gsc.topQueries')).toEqual([{ url: PAGE, scope: 'page', days: 28 }]);
    expect(section()).not.toBeNull();
    expect(suggestions()).toHaveLength(GSC_TARGET_SUGGESTIONS);
    expect(suggestions().map((row) => row.querySelector('[data-testid="gsc-target-suggestion-query"]')?.textContent)).toEqual(QUERY_NAMES.slice(0, GSC_TARGET_SUGGESTIONS));
    for (const row of suggestions()) expect(row.querySelector('[data-testid="gsc-target-use"]')?.textContent).toBe(GSC_TARGETS_COPY.useAsTarget);
    expect(text('gsc-target-suggestions-note')).toContain('in the last 28 days');
    // Google's text is inert, bidi-isolated text: no element from markup.
    const markup = suggestions()[3]!.querySelector('[data-testid="gsc-target-suggestion-query"]')!;
    expect(markup.tagName).toBe('BDI');
    expect(markup.getAttribute('dir')).toBe('auto');
    expect(markup.querySelector('b')).toBeNull();
    // No target query yet: no check.
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(callsTo('gsc.targetPages')).toEqual([]);
    expect(host.querySelector('[data-testid="gsc-target-pages"]')).toBeNull();
    // The Search Console panel's range is the one read.
    await act(async () => gscPrefs.set({ range: 90 }));
    await wait(GSC_READ_DEBOUNCE_MS);
    expect(callsTo('gsc.topQueries')).toEqual([
      { url: PAGE, scope: 'page', days: 28 },
      { url: PAGE, scope: 'page', days: 90 },
    ]);
    expect(text('gsc-target-suggestions-note')).toContain('in the last 90 days');
    // No queries: Google hides rare ones.
    fake.queries = { ...QUERIES, rows: [] };
    await mount(gsc());
    await wait(GSC_READ_DEBOUNCE_MS);
    expect(text('gsc-target-suggestions-message')).toContain('Google hides rare queries');
  });

  test('use-as-target-calls-setTargetQuery-with-generation', async () => {
    // Main read the notes in generation 3 (the panel's prop is older): every write carries 3.
    fake.notes = { query: '', generation: 3 };
    await mount(gsc(), PAGE, 0);
    await wait(GSC_READ_DEBOUNCE_MS);
    expect(callsTo('content.getNotes')).toEqual([{ url: PAGE }]);
    const first = suggestions()[0]!;
    expect(first.dataset.target).toBe('false');
    await click(first.querySelector('[data-testid="gsc-target-use"]'));
    // Saved at once (not after the notes' delay), with the generation the notes were read in.
    expect(callsTo('content.setTarget')).toEqual([{ url: PAGE, query: 'green tea', generation: 3 }]);
    expect(text('field')).toBe('green tea');
    // The suggestion is now the target: marked, no button.
    expect(suggestions()[0]!.dataset.target).toBe('true');
    expect(suggestions()[0]!.querySelector('[data-testid="gsc-target-use"]')).toBeNull();
    expect(suggestions()[0]!.querySelector('[data-testid="gsc-target-current"]')?.textContent).toBe(GSC_TARGETS_COPY.currentTarget);
    expect(suggestions()[1]!.querySelector('[data-testid="gsc-target-use"]')).not.toBeNull();
    // The check follows the new target once it settled.
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(callsTo('gsc.targetPages')).toEqual([{ url: PAGE, query: 'green tea', days: 28 }]);
    await click(suggestions()[1]!.querySelector('[data-testid="gsc-target-use"]'));
    expect(callsTo('content.setTarget')).toEqual([
      { url: PAGE, query: 'green tea', generation: 3 },
      { url: PAGE, query: 'how to brew green tea', generation: 3 },
    ]);
  });

  test('target-pages-list-marks-this-page', async () => {
    // The saved target query, as typed: main normalises it.
    fake.notes = { query: 'Green Tea', generation: 0 };
    await mount(gsc(), `${PAGE}#top`);
    await wait(GSC_TARGET_CHECK_DELAY_MS - 100);
    expect(callsTo('gsc.targetPages')).toEqual([]);
    await wait(100);
    const asked: GscTargetPagesQuery[] = [{ url: PAGE, query: 'Green Tea', days: 28 }];
    expect(callsTo('gsc.targetPages')).toEqual(asked);
    expect(pageRows()).toHaveLength(GSC_LIMITS.maxTargetPages);
    expect(pageRows().map((row) => row.dataset.thisPage)).toEqual(['false', 'false', 'true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
    const mine = pageRows()[2]!;
    expect(mine.querySelector('[data-testid="gsc-target-this-page"]')?.textContent).toBe(GSC_TARGETS_COPY.thisPage);
    expect(mine.querySelector('[data-testid="gsc-target-page-url"]')?.textContent).toBe(`${PAGE}#brewing`);
    expect(pageRows()[0]!.querySelector('[data-testid="gsc-target-this-page"]')).toBeNull();
    expect(text('gsc-target-pages-summary')).toBe('This page is #3 of the 120 pages Google showed for “green tea” in the last 28 days.');
    // Page URLs are inert text, never links.
    expect(host.querySelector('[data-testid="gsc-target-pages"] a')).toBeNull();
    expect(mine.querySelector('[data-testid="gsc-target-page-url"]')?.tagName).toBe('BDI');
    // Outside the top 10, the place is still said; no row is marked.
    fake.pages = pagesAnswer(37);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(pageRows().every((row) => row.dataset.thisPage === 'false')).toBe(true);
    expect(text('gsc-target-pages-summary')).toBe('This page is #37 of the 120 pages Google showed for “green tea” in the last 28 days.');
    // Not among them.
    fake.pages = pagesAnswer(null, 4);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(pageRows()).toHaveLength(4);
    expect(text('gsc-target-pages-summary')).toBe('This page is not among the 4 pages Google showed for “green tea” in the last 28 days.');
    expect(text('gsc-target-pages-cap')).toBeNull();
    // All 1,000 read: it says frost read only those.
    fake.pages = pagesAnswer(null, 1_000);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(text('gsc-target-pages-cap')).toBe('frost reads the top 1,000 pages.');
    // No pages: `no-data`, Google hides rare queries.
    fake.pages = pagesAnswer(null, 0);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(host.querySelector('[data-testid="gsc-target-pages"]')?.getAttribute('data-state')).toBe('no-data');
    expect(pageRows()).toEqual([]);
    expect(text('gsc-target-pages-message')).toBe('Google reported no pages for “green tea” in the last 28 days. Google hides rare queries.');
    // A reason Google answered is said; the host is named.
    fake.pages = { status: 'unavailable', reason: 'no-property' };
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(text('gsc-target-pages-message')).toBe('None of your Search Console properties covers www.example.com.');
    // Typing a new target reads once, after it settled.
    fake.pages = pagesAnswer(1);
    fake.calls.length = 0;
    fake.notes = { query: '', generation: 0 };
    await mount(gsc(), PAGE);
    await wait(GSC_READ_DEBOUNCE_MS);
    await click(suggestions()[2]!.querySelector('[data-testid="gsc-target-use"]'));
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    expect(callsTo('gsc.targetPages')).toEqual([{ url: PAGE, query: 'sencha', days: 28 }]);
  });

  test('another-page-leads-is-a-fact-not-a-rule', async () => {
    fake.notes = { query: 'green tea', generation: 0 };
    /** Every class and attribute name in the section, and the text of its notes. */
    const shape = () => {
      const classes = new Set<string>();
      const attributes = new Set<string>();
      for (const element of section()!.querySelectorAll('*')) {
        for (const name of element.classList) classes.add(name);
        for (const attribute of element.attributes) attributes.add(attribute.name);
      }
      return { classes: [...classes].sort(), attributes: [...attributes].sort() };
    };
    fake.pages = pagesAnswer(1);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    const leading = shape();
    const leadingRow = pageRows()[0]!.className;
    fake.pages = pagesAnswer(4);
    await mount(gsc(), PAGE);
    await wait(GSC_TARGET_CHECK_DELAY_MS);
    const behind = shape();
    // Another page leading changes nothing but which row is this page: same classes, no tone or colour.
    expect(behind).toEqual(leading);
    expect(pageRows()[0]!.className).toBe(leadingRow);
    expect(pageRows()[3]!.className).toBe(leadingRow);
    for (const attribute of behind.attributes) expect(attribute).not.toMatch(/tone|severity|status|verdict|style/);
    for (const name of behind.classes) expect(name).not.toMatch(/warn|error|fail|bad|danger|caution|good|ok\b|pass/);
    expect(section()!.querySelectorAll('[style]')).toHaveLength(0);
    // The words: a fact, not a target.
    expect(text('gsc-target-pages-facts')).toBe(GSC_TARGETS_COPY.facts);
    expect(text('gsc-target-pages-summary')).toBe('This page is #4 of the 120 pages Google showed for “green tea” in the last 28 days.');
  });
});
