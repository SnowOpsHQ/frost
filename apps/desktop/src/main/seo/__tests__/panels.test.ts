// Spec: specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES, LINKS_CSV_COLUMNS), specs/browser.spec.ts (TabState.highlight,
// OpenBackgroundTabInputSchema), specs/seo-snapshot.spec.ts (LinkFilterSchema)
// Acceptance: specs/seo-panels.feature.md (Controller)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { linksCsv } from '@app/seo-core';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { MAX_TABS } from '@app/specs/tabs.spec';
import type { HighlightMode } from '@app/specs/seo-sidebar.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../../browser/controller';

const A = 'https://example.com/a';
const B = 'https://example.com/b';

/** One overlay script the controller ran: where, which mode, and how to settle it. */
interface Paint {
  readonly contents: FakeTabContents;
  readonly mode: HighlightMode;
  resolve(answer?: unknown): void;
  reject(error: unknown): void;
}

/** One wait for an overlay to end (`watchHighlight`). */
interface Watch {
  readonly contents: FakeTabContents;
  resolve(reason: unknown): void;
}

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let paints: Paint[];
let watches: Watch[];
let clipboard: { writeText: ReturnType<typeof vi.fn<(text: string) => void>> };
/** What each extraction answers for the tab's URL. */
let snapshotOf: (url: string) => unknown;

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  paints = [];
  watches = [];
  clipboard = { writeText: vi.fn<(text: string) => void>() };
  snapshotOf = (url) => rawSnapshot(url);
  win = new FakeHostWindow();
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    // Every extraction answers at once with a snapshot of the tab's URL.
    seo: { extract: async (contents) => snapshotOf((contents as unknown as FakeTabContents).url) },
    highlight: {
      paint: (contents, mode) =>
        new Promise<unknown>((resolve, reject) => {
          paints.push({ contents: contents as unknown as FakeTabContents, mode, resolve: (answer = { mode, boxes: 1 }) => resolve(answer), reject });
        }),
      ended: (contents) =>
        new Promise<unknown>((resolve) => {
          watches.push({ contents: contents as unknown as FakeTabContents, resolve });
        }),
    },
    clipboard,
  });
  controller.attach(win as unknown as HostWindow);
});

afterEach(() => {
  vi.useRealTimers();
});

const activeId = () => controller.getState().activeTabId!;
const tabState = (id = activeId()) => controller.getState().tabs.find((t) => t.id === id)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Loads `url` in the active tab (a new view on its first load). */
function load(url: string, contents?: FakeTabContents): FakeTabContents {
  if (!contents) {
    controller.navigate(url);
    contents = views.at(-1)!.contents;
  }
  commit(contents, url, `Title of ${url}`);
  contents.emit('did-finish-load');
  return contents;
}

/** Loads `url` and waits for its ready audit. */
async function audited(url: string, contents?: FakeTabContents): Promise<FakeTabContents> {
  const loaded = load(url, contents);
  await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
  await flush();
  expect(controller.seo.getAudit(activeId()).status).toBe('ready');
  return loaded;
}

function pushState(contents: FakeTabContents, url: string) {
  contents.url = url;
  contents.emit('did-navigate-in-page', fakeEvent(), url, true, 1, 1);
}

describe('highlight', () => {
  test('highlight-sets-tab-state', async () => {
    expect(tabState().highlight).toBe('off');
    const contents = load(A);
    const version = controller.getState().version;
    expect(controller.seo.setHighlight(activeId(), 'links')).toBe(true);
    expect(paints.map((p) => [p.contents, p.mode])).toEqual([[contents, 'links']]);
    expect(tabState().highlight).toBe('links');
    expect(controller.getState().version).toBeGreaterThan(version);
    paints[0]!.resolve();
    await flush();
    expect(tabState().highlight).toBe('links');
    // Another mode replaces it; off turns it off.
    expect(controller.seo.setHighlight(activeId(), 'headings')).toBe(true);
    expect(tabState().highlight).toBe('headings');
    expect(controller.seo.setHighlight(activeId(), 'off')).toBe(true);
    expect(tabState().highlight).toBe('off');
    expect(paints.map((p) => p.mode)).toEqual(['links', 'headings', 'off']);
  });

  test('highlight-only-on-active-web-page', () => {
    // An empty tab, an unknown tab, a background tab, a non-web page: nothing runs.
    expect(controller.seo.setHighlight(activeId(), 'links')).toBe(false);
    expect(controller.seo.setHighlight(999, 'links')).toBe(false);
    load(A);
    const first = activeId();
    controller.newTab();
    expect(controller.seo.setHighlight(first, 'links')).toBe(false);
    const blank = load('about:blank');
    expect(blank.url).toBe('about:blank');
    expect(controller.seo.setHighlight(activeId(), 'links')).toBe(false);
    expect(paints).toEqual([]);
    expect(tabState(first).highlight).toBe('off');
  });

  test('highlight-failure-turns-off', async () => {
    load(A);
    controller.seo.setHighlight(activeId(), 'links');
    paints[0]!.reject(new Error('page gone'));
    await flush();
    expect(tabState().highlight).toBe('off');
    // The script answered that nothing is drawn (the page took the host away at once).
    controller.seo.setHighlight(activeId(), 'links');
    paints[1]!.resolve({ mode: 'off', boxes: 0 });
    await flush();
    expect(tabState().highlight).toBe('off');
  });

  test('highlight-removed-by-page-turns-off', async () => {
    const contents = load(A);
    controller.seo.setHighlight(activeId(), 'links');
    paints[0]!.resolve();
    await flush();
    // Once drawn, main waits for the overlay to end.
    expect(watches.map((w) => w.contents)).toEqual([contents]);
    const version = controller.getState().version;
    watches[0]!.resolve('removed');
    await flush();
    expect(tabState().highlight).toBe('off');
    expect(controller.getState().version).toBeGreaterThan(version);
    // An end it caused itself (off, replaced, the page going) changes nothing.
    controller.seo.setHighlight(activeId(), 'headings');
    paints[1]!.resolve();
    await flush();
    controller.seo.setHighlight(activeId(), 'links');
    watches[1]!.resolve('removed');
    await flush();
    expect(tabState().highlight).toBe('links');
    paints[2]!.resolve();
    await flush();
    watches[2]!.resolve('replaced');
    await flush();
    expect(tabState().highlight).toBe('links');
  });

  test('highlight-resets-on-navigation', async () => {
    const contents = load(A);
    controller.seo.setHighlight(activeId(), 'links');
    paints[0]!.resolve();
    await flush();
    // A fragment change keeps it (the page is the same).
    pushState(contents, `${A}#part`);
    expect(tabState().highlight).toBe('links');
    // An in-page navigation to another URL: off, and the overlay is removed from the page.
    pushState(contents, `${A}/route`);
    expect(tabState().highlight).toBe('off');
    expect(paints.at(-1)).toMatchObject({ contents, mode: 'off' });

    // A new document: off (the overlay went with the old one; nothing to remove).
    controller.seo.setHighlight(activeId(), 'headings');
    const count = paints.length;
    commit(contents, B, 'B');
    expect(tabState().highlight).toBe('off');
    expect(paints).toHaveLength(count);
  });

  test('highlight-late-paint-after-navigation-is-removed', async () => {
    const contents = load(A);
    controller.seo.setHighlight(activeId(), 'links');
    // The page moved on before the script answered: whatever it drew is removed.
    commit(contents, B, 'B');
    paints[0]!.resolve();
    await flush();
    expect(paints.map((p) => p.mode)).toEqual(['links', 'off']);
    expect(tabState().highlight).toBe('off');
    // A superseded request never removes a newer one's overlay.
    controller.seo.setHighlight(activeId(), 'links');
    controller.seo.setHighlight(activeId(), 'headings');
    paints.at(-2)!.resolve();
    paints.at(-1)!.resolve();
    await flush();
    expect(paints.map((p) => p.mode)).toEqual(['links', 'off', 'links', 'headings']);
    expect(tabState().highlight).toBe('headings');
  });

  test('highlight-resets-on-tab-change', () => {
    const first = load(A);
    const firstId = activeId();
    controller.seo.setHighlight(firstId, 'links');
    controller.newTab();
    expect(tabState(firstId).highlight).toBe('off');
    expect(paints.at(-1)).toMatchObject({ contents: first, mode: 'off' });
    // Back to it: still off until turned on again.
    controller.activateTab(firstId);
    expect(tabState(firstId).highlight).toBe('off');
  });

  test('highlight-resets-on-error-and-crash', () => {
    const contents = load(A);
    controller.seo.setHighlight(activeId(), 'links');
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', B, true);
    expect(tabState().highlight).toBe('off');
    load(A, contents);
    controller.seo.setHighlight(activeId(), 'headings');
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(tabState().highlight).toBe('off');
    // A closed tab's state goes with it.
    expect(controller.seo.setHighlight(activeId(), 'links')).toBe(false);
  });
});

describe('open in a background tab', () => {
  test('open-background-tab', () => {
    load(A);
    const opener = activeId();
    const id = controller.openBackgroundTab('https://other.org/page?x=1');
    expect(id).not.toBeNull();
    const state = controller.getState();
    // Right of the active tab, which stays active.
    expect(state.tabs.map((t) => t.id)).toEqual([opener, id]);
    expect(state.activeTabId).toBe(opener);
    expect(views.at(-1)!.contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://other.org/page?x=1');
    // The next one goes after it (the tabs the active tab opened stay together).
    const second = controller.openBackgroundTab('https://other.org/2');
    expect(controller.getState().tabs.map((t) => t.id)).toEqual([opener, id, second]);
  });

  test('open-background-tab-is-web-only', () => {
    load(A);
    const before = views.length;
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'app://app/', 'mailto:a@example.com', 'not a url', '']) {
      expect(controller.openBackgroundTab(url), url).toBeNull();
    }
    expect(views).toHaveLength(before);
    expect(controller.getState().tabs).toHaveLength(1);
  });

  test('open-background-tab-respects-tab-limit', () => {
    load(A);
    while (controller.getState().tabs.length < MAX_TABS) controller.openBackgroundTab(B);
    expect(controller.openBackgroundTab(B)).toBeNull();
    expect(controller.getState().notice?.kind).toBe('tab-limit');
  });
});

describe('copy', () => {
  const LINKS = [
    { href: 'https://example.com/x', scheme: 'https:', rel: '', text: 'X', kind: 'internal' as const, target: null },
    { href: 'https://other.org/', scheme: 'https:', rel: 'nofollow', text: '=SUM(1)', kind: 'external' as const, target: '_blank' },
  ];

  test('copy-links-csv', async () => {
    snapshotOf = (url) => rawSnapshot(url, { links: LINKS, linkTotal: 2 });
    load(A);
    const shown = { url: A, takenAt: rawSnapshot(A).extractedAt };
    // No ready audit yet: nothing is written.
    expect(controller.seo.copyLinksCsv(activeId(), shown, { type: 'all', rel: 'all', query: '' })).toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    await flush();
    const tabId = activeId();
    // Not the audit on screen (another URL or another run): nothing is written.
    expect(controller.seo.copyLinksCsv(tabId, { ...shown, takenAt: shown.takenAt + 1 }, { type: 'all', rel: 'all', query: '' })).toBeNull();
    expect(controller.seo.copyLinksCsv(tabId, { ...shown, url: B }, { type: 'all', rel: 'all', query: '' })).toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(controller.seo.copyLinksCsv(tabId, shown, { type: 'all', rel: 'all', query: '' })).toBe(2);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(linksCsv(LINKS));
    // The rows the panel's filter shows.
    expect(controller.seo.copyLinksCsv(tabId, shown, { type: 'external', rel: 'nofollow', query: 'other' })).toBe(1);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(linksCsv([LINKS[1]!]));
    // The formula guard is on: page text never reaches a spreadsheet as a formula.
    expect(clipboard.writeText.mock.lastCall![0]).toContain(",'=SUM(1),");
    expect(controller.seo.copyLinksCsv(tabId, shown, { type: 'internal', rel: 'ugc', query: '' })).toBe(0);
    expect(controller.seo.copyLinksCsv(999, shown, { type: 'all', rel: 'all', query: '' })).toBeNull();
  });

  test('copy-url-only-copies-audit-urls', async () => {
    snapshotOf = (url) => rawSnapshot(url, { social: { ...rawSnapshot(url).social, 'twitter:image': ' /t.png ' } });
    await audited(A);
    const id = activeId();
    const shown = { url: A, takenAt: rawSnapshot(A).extractedAt };
    // The fixture's link, image, og:image, the parsed twitter:image and the page URL.
    for (const url of ['https://example.com/other', 'https://example.com/a.png', 'https://example.com/share.png', 'https://example.com/t.png', A]) {
      expect(controller.seo.copyUrl(id, shown, url), url).toBe(true);
      expect(clipboard.writeText).toHaveBeenLastCalledWith(url);
    }
    const calls = clipboard.writeText.mock.calls.length;
    // Anything else, a raw tag value, or another audit than the one on screen.
    for (const url of ['https://evil.example/', 'javascript:alert(1)', `${A}?x`, ' /t.png ', '/t.png']) expect(controller.seo.copyUrl(id, shown, url), url).toBe(false);
    expect(controller.seo.copyUrl(id, { ...shown, takenAt: 1 }, A)).toBe(false);
    expect(controller.seo.copyUrl(999, shown, A)).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(calls);
  });
});
