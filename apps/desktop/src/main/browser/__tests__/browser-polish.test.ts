// Spec: specs/browser-polish.spec.ts (SEARCH_ENGINES, FIND_*, CLOSED_TABS_MAX, CLOSED_TAB_HISTORY_MAX, CLEAR_HISTORY,
// contextMenuSearchLabel), specs/browser-polish.schema.ts (FindStateSchema, BrowserState fields),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['find-in-page' | 'reopen-closed-tab'])
// Acceptance: specs/browser-polish.feature.md (Find in page, Reopen closed tab, History view, Search engines)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BrowserStateSchema, MAX_TABS, SEARCH_URL_TEMPLATE } from '@app/specs/browser.spec';
import {
  CLOSED_TAB_HISTORY_MAX,
  CLOSED_TABS_MAX,
  contextMenuSearchLabel,
  DEFAULT_SEARCH_ENGINE,
  findCountLabel,
  FIND_NO_MATCHES,
  SEARCH_ENGINE_IDS,
  SEARCH_ENGINES,
  searchEngineUrl,
} from '@app/specs/browser-polish.spec';
import { CONTEXT_MENU_SEARCH_LABEL } from '@app/specs/page-commands.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { parseSearchPrefix, resolveAddressInput } from '../address';
import { contextMenuTemplate, type ContextMenuParamsInput } from '../context-menu';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import { createClosedTabStack, keptHistory, type ClosedTab } from '../history-closed-tabs';
import { createHistoryService, createSearchEngineSetting } from '../history-service';
import type { ProfileDebugger } from '../render-profile-debugger';
import { createRenderProfilePins } from '../render-profile-pins';
import { createTab } from '../tab-model';

const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile' };

/** A tab's WebContents with the find and navigation-history APIs Electron has. */
class PolishContents extends FakeTabContents {
  private requests = 0;
  entries: { url: string; title: string }[] = [];
  activeIndex = 0;
  findInPage = vi.fn((_text: string, _options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }) => ++this.requests);
  stopFindInPage = vi.fn();
  restore = vi.fn(async (_options: { entries: { url: string; title: string }[]; index?: number }) => {});
  constructor() {
    super();
    Object.assign(this.navigationHistory, { getAllEntries: () => this.entries, getActiveIndex: () => this.activeIndex, restore: this.restore });
  }
  /** Reports a `found-in-page` answer for the latest request (or `requestId`). */
  found(matches: number, active: number, requestId = this.requests) {
    this.emit('found-in-page', fakeEvent(), { requestId, matches, activeMatchOrdinal: active, finalUpdate: true });
  }
}
class PolishView extends FakeTabView {
  override readonly contents = new PolishContents();
}

class FakeDebugger implements ProfileDebugger {
  constructor(readonly detached: (reason: string) => void) {}
  send = vi.fn(async () => {});
  sendTopLevel = vi.fn(async () => {});
  detach = vi.fn();
  isAttached = () => true;
  dispose = vi.fn();
}

let views: PolishView[];
let win: FakeHostWindow;
let controller: BrowserController;
let engine: (typeof SEARCH_ENGINE_IDS)[number];

beforeEach(() => {
  views = [];
  win = new FakeHostWindow();
  engine = DEFAULT_SEARCH_ENGINE;
  controller = createBrowserController({
    createView: () => {
      const created = new PolishView();
      views.push(created);
      return created as unknown as TabView;
    },
    platform: 'linux',
    searchEngine: () => engine,
    renderProfiles: { pins: createRenderProfilePins({ save: () => {}, remove: () => {} }), chromeVersion: '140.0.0.0', debuggerFor: (_c, detached) => new FakeDebugger(detached) },
  });
  controller.attach(win as unknown as HostWindow);
  controller.setPageBounds({ x: 0, y: 90, width: 1000, height: 700 });
});

const key = (name: string, mods: { control?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}, type = 'keyDown') => ({
  type,
  key: name,
  code: `Key${name.toUpperCase()}`,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const state = () => controller.getState();
const activeId = () => state().activeTabId!;

/** The active tab showing `url`, committed. */
function open(url: string, title = 'Page'): PolishContents {
  controller.navigate(url);
  const contents = views.at(-1)!.contents;
  contents.emit('did-start-navigation', fakeEvent({ url, isMainFrame: true, isSameDocument: false }));
  commit(contents, url, title);
  return contents;
}
/** Presses a key in `target`'s `before-input-event`; answers whether it was consumed. */
function press(target: PolishContents | 'chrome', input: ReturnType<typeof key>): boolean {
  const event = fakeEvent();
  const emitter = target === 'chrome' ? win.webContents : target;
  emitter.emit('before-input-event', event, input);
  return event.defaultPrevented;
}

describe('search engines', () => {
  test('engine-table-is-https-only', () => {
    expect(SEARCH_ENGINES.map((e) => e.id)).toEqual(['google', 'bing', 'duckduckgo']);
    expect(DEFAULT_SEARCH_ENGINE).toBe('google');
    expect(new Set(SEARCH_ENGINES.map((e) => e.prefix)).size).toBe(SEARCH_ENGINES.length);
    for (const e of SEARCH_ENGINES) {
      expect(e.prefix).toMatch(/^[a-z]$/);
      expect(e.template.split('{q}')).toHaveLength(2);
      const url = new URL(e.template.replace('{q}', 'x'));
      expect(url.protocol).toBe('https:');
      expect(url.port).toBe('');
      expect(url.username + url.password + url.hash).toBe('');
      // `{q}` is only ever in the query string.
      expect(e.template.indexOf('{q}')).toBeGreaterThan(e.template.indexOf('?'));
    }
    // The old single template is the default engine's.
    expect(SEARCH_URL_TEMPLATE).toBe(SEARCH_ENGINES[0].template);
  });

  test('engine-url-encodes-query', () => {
    for (const id of SEARCH_ENGINE_IDS) {
      const url = new URL(searchEngineUrl(id, 'a&b=c #d/évil?.com'));
      expect(url.host).toBe(new URL(SEARCH_ENGINES.find((e) => e.id === id)!.template.replace('{q}', '')).host);
      expect(url.searchParams.get('q')).toBe('a&b=c #d/évil?.com');
      expect(url.hash).toBe('');
    }
  });

  test('prefix-picks-engine', () => {
    expect(parseSearchPrefix('d test')).toEqual({ engine: 'duckduckgo', query: 'test' });
    expect(parseSearchPrefix('  b   two words ')).toEqual({ engine: 'bing', query: 'two words' });
    expect(parseSearchPrefix('g example.com')).toEqual({ engine: 'google', query: 'example.com' });
    for (const none of ['d', 'd ', 'dtest', 'D test', 'x test', 'dd test', '']) expect(parseSearchPrefix(none), none).toBeNull();
    expect(resolveAddressInput('d test')).toEqual({ kind: 'search', url: 'https://duckduckgo.com/?q=test' });
    expect(resolveAddressInput('b example.com')).toEqual({ kind: 'search', url: 'https://www.bing.com/search?q=example.com' });
    // The chosen engine for everything else; URLs are still URLs.
    expect(resolveAddressInput('green tea', 'bing')).toEqual({ kind: 'search', url: 'https://www.bing.com/search?q=green%20tea' });
    expect(resolveAddressInput('example.com', 'duckduckgo')).toEqual({ kind: 'url', url: 'https://example.com/' });
    expect(resolveAddressInput('x test', 'duckduckgo')).toEqual({ kind: 'search', url: 'https://duckduckgo.com/?q=x%20test' });
  });

  test('prefix-never-navigates', () => {
    for (const input of ['javascript:alert(1)', 'd javascript:alert(1)', 'g file:///etc/passwd', 'b data:text/html,<b>x</b>', 'app://app/', 'd app://app/', 'chrome://settings', 'd about:blank']) {
      for (const id of SEARCH_ENGINE_IDS) {
        const resolved = resolveAddressInput(input, id)!;
        expect(resolved.kind, input).toBe('search');
        const url = new URL(resolved.url);
        expect(url.protocol).toBe('https:');
        expect(SEARCH_ENGINES.map((e) => new URL(e.template.replace('{q}', '')).host)).toContain(url.host);
      }
    }
    // The controller searches with the engine in use.
    engine = 'duckduckgo';
    controller.navigate('javascript:alert(1)');
    expect(views[0]!.contents.loadURL).toHaveBeenLastCalledWith(`https://duckduckgo.com/?q=${encodeURIComponent('javascript:alert(1)')}`);
    expect(state().searchEngine).toBe('duckduckgo');
  });

  // A lone surrogate (a page selection, typed or pasted text) would make `encodeURIComponent` throw:
  // it becomes U+FFFD first (`browser-polish.feature.md`, Search engines).
  test('search-url-tolerates-lone-surrogates', () => {
    for (const id of SEARCH_ENGINE_IDS) {
      expect(new URL(searchEngineUrl(id, 'a\uD800b')).searchParams.get('q')).toBe('a\uFFFDb');
      expect(new URL(searchEngineUrl(id, '\uDC00')).searchParams.get('q')).toBe('\uFFFD');
    }
    expect(resolveAddressInput('d a\uD800b')).toEqual({ kind: 'search', url: 'https://duckduckgo.com/?q=a%EF%BF%BDb' });
    expect(resolveAddressInput('a\uD800 b', 'bing')).toEqual({ kind: 'search', url: 'https://www.bing.com/search?q=a%EF%BF%BD%20b' });
    // A well-formed pair is kept as it is.
    expect(new URL(searchEngineUrl('google', 'tea \u{1F375}')).searchParams.get('q')).toBe('tea \u{1F375}');
    // The context menu's search item, from a selection with a lone surrogate.
    const openInNewTab = vi.fn();
    const commands = { back: vi.fn(), forward: vi.fn(), reload: vi.fn(), openInNewTab, copyText: vi.fn(), edit: vi.fn() };
    const params: ContextMenuParamsInput = {
      linkURL: '',
      srcURL: '',
      mediaType: 'none',
      isEditable: false,
      selectionText: 'a\uD800b',
      editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false },
    };
    for (const id of SEARCH_ENGINE_IDS) {
      const item = contextMenuTemplate(params, { canGoBack: false, canGoForward: false }, commands, id).find((i) => i.id === 'context-search')!;
      expect(item.label).toContain('a\uFFFDb');
      item.click!(undefined as never, undefined as never, undefined as never);
      expect(openInNewTab).toHaveBeenLastCalledWith(searchEngineUrl(id, 'a\uFFFDb'));
    }
  });

  test('context-menu-uses-engine', () => {
    expect(contextMenuSearchLabel('google')).toBe(CONTEXT_MENU_SEARCH_LABEL);
    const params: ContextMenuParamsInput = {
      linkURL: '',
      srcURL: '',
      mediaType: 'none',
      isEditable: false,
      selectionText: 'tea',
      editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false },
    };
    const openInNewTab = vi.fn();
    const commands = { back: vi.fn(), forward: vi.fn(), reload: vi.fn(), openInNewTab, copyText: vi.fn(), edit: vi.fn() };
    const item = contextMenuTemplate(params, { canGoBack: false, canGoForward: false }, commands, 'duckduckgo').find((i) => i.id === 'context-search')!;
    expect(item.label).toBe('Search DuckDuckGo for “tea”');
    item.click!(undefined as never, undefined as never, undefined as never);
    expect(openInNewTab).toHaveBeenCalledWith('https://duckduckgo.com/?q=tea');
  });

  test('settings-service-uses-choice', async () => {
    let stored: string = 'bing';
    const changed = vi.fn();
    const store = { searchEngine: vi.fn(async () => stored as never), setSearchEngine: vi.fn(async (id: string) => ((stored = id), true)) };
    const setting = createSearchEngineSetting({ store, changed });
    expect(setting.searchEngine()).toBe(DEFAULT_SEARCH_ENGINE);
    await setting.load();
    expect(setting.searchEngine()).toBe('bing');
    expect(await setting.setSearchEngine('duckduckgo')).toBe(true);
    expect(setting.searchEngine()).toBe('duckduckgo');
    expect(changed).toHaveBeenCalledOnce();
    expect(await setting.setSearchEngine('evil' as never)).toBe(false);
    store.setSearchEngine.mockRejectedValueOnce(new Error('disk full'));
    expect(await setting.setSearchEngine('google')).toBe(false);
    expect(setting.searchEngine()).toBe('duckduckgo');
  });
});

describe('find in page', () => {
  test('find-count-label', () => {
    expect(findCountLabel({ text: '', matches: 0, active: 0 })).toBe('');
    expect(findCountLabel({ text: 'tea', matches: 0, active: 0 })).toBe(FIND_NO_MATCHES);
    expect(findCountLabel({ text: 'tea', matches: 3, active: 1 })).toBe('1 of 3');
  });

  test('find-shortcut-opens-bar', () => {
    // An empty tab: consumed, but no bar.
    expect(press('chrome', key('f', { control: true }))).toBe(true);
    expect(state().find).toBeNull();
    const page = open('https://a.example/');
    win.webContents.focus.mockClear();
    // From the page itself (a page can't block it): consumed before the page sees it.
    expect(press(page, key('f', { control: true }))).toBe(true);
    expect(press(page, key('f', { control: true }, 'keyUp'))).toBe(true);
    const find = state().find!;
    expect(find).toMatchObject({ tabId: activeId(), text: '', matches: 0, active: 0, matchCase: false });
    expect(win.webContents.focus).toHaveBeenCalledOnce();
    expect(BrowserStateSchema.parse(state())).toEqual(state());
    // Again: the bar is asked to take focus once more.
    press(page, key('f', { control: true }));
    expect(state().find!.focusSeq).toBeGreaterThan(find.focusSeq);
    // Mod+Shift+F, Alt+Mod+F, Meta+F on Linux: not ours.
    expect(press(page, key('f', { control: true, alt: true }))).toBe(false);
    expect(press(page, key('f', { meta: true }))).toBe(false);
  });

  test('find-search-runs-find-in-page', () => {
    const page = open('https://a.example/');
    const id = activeId();
    expect(controller.find.search(id, 'tea', false)).toBe(false);
    controller.find.open();
    expect(controller.find.search(id, 'tea', false)).toBe(true);
    expect(page.findInPage).toHaveBeenLastCalledWith('tea', { findNext: true, forward: true, matchCase: false });
    page.found(3, 1);
    expect(state().find).toMatchObject({ text: 'tea', matches: 3, active: 1 });
    expect(findCountLabel(state().find!)).toBe('1 of 3');
    controller.find.search(id, 'Tea', true);
    expect(page.findInPage).toHaveBeenLastCalledWith('Tea', { findNext: true, forward: true, matchCase: true });
    // Empty text stops the find (findInPage refuses empty text).
    const calls = page.findInPage.mock.calls.length;
    controller.find.search(id, '', false);
    expect(page.findInPage.mock.calls.length).toBe(calls);
    expect(page.stopFindInPage).toHaveBeenLastCalledWith('clearSelection');
    expect(state().find).toMatchObject({ text: '', matches: 0 });
    // Unknown tab ids: no-ops.
    expect(controller.find.search(999, 'x', false)).toBe(false);
  });

  test('find-results-follow-latest-request', () => {
    const page = open('https://a.example/');
    const id = activeId();
    controller.find.open();
    controller.find.search(id, 'te', false);
    const old = page.findInPage.mock.results.at(-1)!.value as number;
    controller.find.search(id, 'tea', false);
    // A late answer for the older request is ignored.
    page.found(9, 2, old);
    expect(state().find).toMatchObject({ matches: 0, active: 0 });
    page.found(3, 1);
    expect(state().find).toMatchObject({ matches: 3, active: 1 });
    // "Unchanged" (-1) keeps what was known.
    page.emit('found-in-page', fakeEvent(), { requestId: page.findInPage.mock.results.at(-1)!.value, matches: -1, activeMatchOrdinal: 2, finalUpdate: true });
    expect(state().find).toMatchObject({ matches: 3, active: 2 });
  });

  test('find-step-shortcut-only-while-open', () => {
    const page = open('https://a.example/');
    // Closed bar: a page keeps Ctrl+G.
    expect(press(page, key('g', { control: true }))).toBe(false);
    controller.find.open();
    controller.find.search(activeId(), 'tea', false);
    page.found(3, 1);
    expect(press(page, key('g', { control: true }))).toBe(true);
    expect(page.findInPage).toHaveBeenLastCalledWith('tea', { findNext: false, forward: true, matchCase: false });
    expect(press('chrome', key('g', { control: true, shift: true }))).toBe(true);
    expect(page.findInPage).toHaveBeenLastCalledWith('tea', { findNext: false, forward: false, matchCase: false });
    // The count stays until the answer.
    expect(state().find).toMatchObject({ matches: 3, active: 1 });
    page.found(3, 3);
    expect(state().find).toMatchObject({ active: 3 });
    expect(controller.stepFind(true)).toBe(true);
    expect(controller.find.step(999, true)).toBe(false);
  });

  test('find-close-clears-selection', () => {
    const page = open('https://a.example/');
    const id = activeId();
    expect(controller.find.close(id)).toBe(false);
    controller.find.open();
    controller.find.search(id, 'tea', false);
    page.focus.mockClear();
    expect(controller.find.close(id)).toBe(true);
    expect(page.stopFindInPage).toHaveBeenLastCalledWith('clearSelection');
    expect(state().find).toBeNull();
    expect(page.focus).toHaveBeenCalled();
    // Reopened: the text is kept and found again.
    controller.find.open();
    expect(state().find).toMatchObject({ text: 'tea' });
    expect(page.findInPage).toHaveBeenLastCalledWith('tea', { findNext: true, forward: true, matchCase: false });
  });

  test('find-is-per-tab', () => {
    open('https://a.example/');
    const first = activeId();
    controller.find.open();
    controller.find.search(first, 'tea', true);
    controller.newTab();
    open('https://b.example/');
    expect(state().find).toBeNull();
    controller.activateTab(first);
    expect(state().find).toMatchObject({ tabId: first, text: 'tea', matchCase: true });
  });

  test('find-closes-on-navigation', () => {
    const page = open('https://a.example/');
    controller.find.open();
    controller.find.search(activeId(), 'tea', false);
    // An in-page (SPA) navigation keeps it.
    page.url = 'https://a.example/#b';
    page.emit('did-navigate-in-page', fakeEvent(), page.url, true);
    expect(state().find).not.toBeNull();
    // A new document closes it.
    commit(page, 'https://a.example/next', 'Next');
    expect(state().find).toBeNull();
  });
});

describe('reopen closed tab', () => {
  test('closed-tab-stack-caps-and-clears', () => {
    const stack = createClosedTabStack();
    const entry = (i: number): ClosedTab => ({ index: 0, url: `https://t${i}.example/`, title: '', entries: [], activeIndex: 0, profileOf: createTab(i + 1) });
    for (let i = 0; i < CLOSED_TABS_MAX + 5; i++) stack.push(entry(i));
    expect(stack.size()).toBe(CLOSED_TABS_MAX);
    expect(stack.peek()!.url).toBe(`https://t${CLOSED_TABS_MAX + 4}.example/`);
    expect(stack.pop()!.url).toBe(`https://t${CLOSED_TABS_MAX + 4}.example/`);
    expect(stack.clear()).toBe(true);
    expect(stack.clear()).toBe(false);
    expect(stack.pop()).toBeUndefined();

    // In the controller: only tabs that showed a page; the count is in the state; forgetting empties it.
    controller.newTab();
    controller.closeTab(activeId());
    expect(state().closedTabCount).toBe(0);
    open('https://a.example/');
    controller.newTab();
    open('https://b.example/');
    controller.closeTab(activeId());
    expect(state().closedTabCount).toBe(1);
    controller.forgetClosedTabs();
    expect(state().closedTabCount).toBe(0);
    expect(controller.reopenClosedTab()).toBeNull();
  });

  test('keeps-a-window-of-history', () => {
    const contents = new PolishContents();
    contents.entries = Array.from({ length: CLOSED_TAB_HISTORY_MAX + 30 }, (_, i) => ({ url: i === 3 ? 'chrome://x' : `https://user:pw@h.example/${i}`, title: `T${i}` }));
    contents.activeIndex = 70;
    const kept = keptHistory(contents as unknown as TabView['webContents'])!;
    expect(kept.entries).toHaveLength(CLOSED_TAB_HISTORY_MAX);
    expect(kept.entries[kept.activeIndex]).toEqual({ url: 'https://h.example/70', title: 'T70' });
    // Userinfo and non-web entries never kept.
    expect(kept.entries.every((e) => e.url.startsWith('https://h.example/'))).toBe(true);
    contents.activeIndex = 3;
    expect(keptHistory(contents as unknown as TabView['webContents'])).toBeNull();
  });

  test('reopen-restores-url-history-and-profile', async () => {
    open('https://a.example/');
    controller.newTab();
    const page = open('https://b.example/2', 'B two');
    const closedId = activeId();
    page.entries = [
      { url: 'https://b.example/1', title: 'B one' },
      { url: 'https://b.example/2', title: 'B two' },
      { url: 'https://b.example/3', title: 'B three' },
    ];
    page.activeIndex = 1;
    expect(controller.setRenderProfile(closedId, PHONE, false)).toBe(true);
    controller.activateTab(state().tabs[0]!.id);
    controller.closeTab(closedId);
    expect(state().tabs).toHaveLength(1);
    // Mod+Shift+T from the chrome (a held key reopens one tab).
    expect(press('chrome', { ...key('t', { control: true, shift: true }), key: 'T' })).toBe(true);
    expect(press('chrome', { ...key('t', { control: true, shift: true }), key: 'T', isAutoRepeat: true } as never)).toBe(true);
    await settle();
    const tabs = state().tabs;
    expect(tabs).toHaveLength(2);
    const reopened = tabs[1]!;
    expect(state().activeTabId).toBe(reopened.id);
    // Shown as what it was while it loads.
    expect(reopened).toMatchObject({ url: 'https://b.example/2', title: 'B two' });
    const contents = views.at(-1)!.contents;
    expect(contents.restore).toHaveBeenCalledWith({ entries: page.entries, index: 1 });
    expect(contents.loadURL).not.toHaveBeenCalled();
    // Its own render profile, in effect before the first request.
    expect(reopened.renderProfile).toMatchObject({ profile: PHONE, source: 'tab' });
    expect(state().closedTabCount).toBe(0);
  });

  test('reopen-after-page-close', () => {
    const page = open('https://a.example/', 'A');
    controller.newTab();
    // The page closed itself: its WebContents (and history) are gone; its URL is kept.
    page.entries = [{ url: 'https://a.example/', title: 'A' }];
    controller.activateTab(state().tabs[0]!.id);
    page.destroy();
    expect(state().closedTabCount).toBe(1);
    expect(controller.reopenClosedTab()).not.toBeNull();
    const contents = views.at(-1)!.contents;
    expect(contents.loadURL).toHaveBeenCalledWith('https://a.example/');
    expect(contents.restore).not.toHaveBeenCalled();
  });

  test('reopen-respects-tab-limit', () => {
    open('https://a.example/');
    controller.newTab();
    open('https://b.example/');
    controller.closeTab(activeId());
    for (let i = state().tabs.length; i < MAX_TABS; i++) controller.newTab();
    expect(controller.reopenClosedTab()).toBeNull();
    expect(state().notice?.kind).toBe('tab-limit');
    expect(state().closedTabCount).toBe(1);
  });
});

describe('history view', () => {
  test('history-menu-and-palette', () => {
    const before = state().historyViewSeq!;
    controller.showHistory();
    expect(state().historyViewSeq).toBe(before + 1);
    expect(win.webContents.focus).toHaveBeenCalled();
    // Mod+Y is not reserved (a page's text field keeps Ctrl+Y).
    const page = open('https://a.example/');
    expect(press(page, key('y', { control: true }))).toBe(false);
  });

  test('history-clear-all-confirms', async () => {
    const writer = { flush: vi.fn(async () => {}), deleteVisit: vi.fn(async () => true), clearHistory: vi.fn(async () => {}) };
    const tabs = { reopenClosedTab: vi.fn(() => null), showHistory: vi.fn(), forgetClosedTabs: vi.fn() };
    let answer = false;
    const confirmClearAll = vi.fn(async () => answer);
    const history = { list: vi.fn(async () => ({ visits: [], next: null })), jumpBackIn: vi.fn(async () => ({ mostVisited: [], recent: [] })) };
    const service = createHistoryService({ history, writer, tabs, confirmClearAll });
    // Cancelled: nothing cleared.
    expect(await service.clearAll()).toBe(false);
    expect(writer.clearHistory).not.toHaveBeenCalled();
    expect(tabs.forgetClosedTabs).not.toHaveBeenCalled();
    // Confirmed: visits and the closed-tab stack; two requests at once ask once.
    answer = true;
    const [a, b] = await Promise.all([service.clearAll(), service.clearAll()]);
    expect([a, b]).toEqual([true, true]);
    expect(confirmClearAll).toHaveBeenCalledTimes(2);
    expect(writer.clearHistory).toHaveBeenCalledOnce();
    expect(tabs.forgetClosedTabs).toHaveBeenCalledOnce();
    // Reads flush pending visits first; failures answer empty, never reject.
    await service.list('', null);
    expect(writer.flush).toHaveBeenCalled();
    history.list.mockRejectedValueOnce(new Error('closed'));
    expect(await service.list('x', null)).toEqual({ visits: [], next: null });
    // Without a confirmation, nothing is ever cleared.
    expect(await createHistoryService({ history, writer, tabs }).clearAll()).toBe(false);
  });
});
