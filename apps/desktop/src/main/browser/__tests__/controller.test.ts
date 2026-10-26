// Spec: specs/browser.spec.ts (BrowserStateSchema, APP_WINDOW_TITLE, MAX_TABS)
// Acceptance: specs/browser-chrome.feature.md (Controller), specs/tabs.feature.md (Controller)
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  APP_WINDOW_TITLE,
  BrowserStateSchema,
  MAX_PENDING_WATCHES,
  MAX_TABS,
  SEARCH_URL_TEMPLATE,
  WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH,
} from '@app/specs/browser.spec';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';

/** A tab's WebContents: tests set the fields, then emit the Electron event that reports them. */
class FakeTabContents extends EventEmitter {
  url = '';
  title = '';
  loading = false;
  back = false;
  forward = false;
  // Like Electron, the URL changes only when a navigation commits (tests emit `did-navigate`).
  loadURL = vi.fn(async (_url: string) => {});
  getURL = () => this.url;
  getTitle = () => this.title;
  isLoading = () => this.loading;
  reload = vi.fn();
  stop = vi.fn();
  focus = vi.fn();
  destroyed = false;
  /** Like Electron's `webContents.close()` (no beforeunload wait): the WebContents is destroyed. */
  close = vi.fn(() => {
    if (!this.destroyed) this.destroy();
  });
  isDestroyed = () => this.destroyed;
  /** What Electron does when the page calls `window.close()`: the WebContents is destroyed. */
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
  readonly navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
}

class FakeTabView {
  /** The view's WebContents, kept for tests after it is destroyed. */
  readonly contents = new FakeTabContents();
  /** Like Electron: a view's `webContents` is gone once it is destroyed (already in `destroyed` listeners). */
  get webContents(): FakeTabContents {
    return (this.contents.destroyed ? undefined : this.contents) as FakeTabContents;
  }
  setBounds = vi.fn();
  setVisible = vi.fn();
}

class FakeHostWindow extends EventEmitter {
  size: [number, number] = [1280, 800];
  title = '';
  /** Like Electron's `View`: tracks its children (adding a child again moves it to the top). */
  readonly contentView = {
    children: [] as unknown[],
    addChildView: vi.fn((child: unknown) => {
      this.contentView.children = [...this.contentView.children.filter((c) => c !== child), child];
    }),
    removeChildView: vi.fn((child: unknown) => {
      this.contentView.children = this.contentView.children.filter((c) => c !== child);
    }),
  };
  /** The chrome's own WebContents. */
  readonly webContents = Object.assign(new EventEmitter(), { focus: vi.fn() });
  getContentSize = () => [...this.size];
  setTitle = vi.fn((title: string) => {
    this.title = title;
  });
  isDestroyed = () => false;
}

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
/** The injected `openWindow` (the app opens and attaches a new window). */
let openWindow: ReturnType<typeof vi.fn<() => void>>;

function view(): FakeTabView {
  const [only] = views;
  if (!only) throw new Error('no view was created');
  return only;
}

/** Navigates and commits `url` with `title` as Electron reports it. */
function commit(contents: FakeTabContents, url: string, title: string, { back = false, forward = false } = {}) {
  contents.loading = true;
  contents.emit('did-start-loading');
  contents.url = url;
  contents.back = back;
  contents.forward = forward;
  contents.emit('did-navigate', fakeEvent(), url, 200, 'OK');
  contents.title = title;
  contents.emit('page-title-updated', fakeEvent(), title, false);
  contents.loading = false;
  contents.emit('did-stop-loading');
}

beforeEach(() => {
  views = [];
  win = new FakeHostWindow();
  openWindow = vi.fn(() => {
    win = new FakeHostWindow();
    controller.attach(win as unknown as HostWindow);
  });
  controller = createBrowserController({
    createView: () => {
      const created = new FakeTabView();
      views.push(created);
      return created as unknown as TabView;
    },
    platform: 'linux',
    openWindow,
  });
  controller.attach(win as unknown as HostWindow);
});

/** A `before-input-event` key as Electron reports it (Linux: Mod = Control). */
function key(keyName: string, mods: { control?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}, type = 'keyDown') {
  const code = /^[a-z]$/.test(keyName) ? `Key${keyName.toUpperCase()}` : /^\d$/.test(keyName) ? `Digit${keyName}` : keyName;
  return { type, key: keyName, code, control: false, meta: false, shift: false, alt: false, ...mods };
}


describe('browser controller', () => {
  test('starts-with-one-empty-tab', () => {
    const state = controller.getState();
    expect(BrowserStateSchema.parse(state)).toEqual(state);
    expect(state.version).toBe(1);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
    expect(views).toHaveLength(0);
    expect(win.contentView.addChildView).not.toHaveBeenCalled();
    expect(win.title).toBe(APP_WINDOW_TITLE);
  });

  test('navigate-loads-resolved-url', () => {
    expect(controller.navigate('   ')).toBe(false);
    expect(views).toHaveLength(0);

    expect(controller.navigate('example.com')).toBe(true);
    expect(views).toHaveLength(1);
    expect(win.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view());
    expect(view().setVisible).toHaveBeenLastCalledWith(true);
    expect(view().webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/');

    controller.navigate('javascript:alert(1)');
    expect(views).toHaveLength(1);
    expect(view().webContents.loadURL).toHaveBeenLastCalledWith(
      SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent('javascript:alert(1)')),
    );
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1);
  });

  test('tracks-webcontents-state', () => {
    controller.navigate('example.com');
    const contents = view().webContents;
    const start = controller.getState().version;

    contents.loading = true;
    contents.emit('did-start-loading');
    expect(controller.getState()).toMatchObject({ version: start + 1, tabs: [{ loading: true }] });

    contents.url = 'https://example.com/';
    contents.emit('did-navigate', fakeEvent(), contents.url, 200, 'OK');
    expect(controller.getState()).toMatchObject({ version: start + 2, tabs: [{ url: 'https://example.com/' }] });

    contents.title = 'Example Domain';
    contents.emit('page-title-updated', fakeEvent(), contents.title, false);
    contents.loading = false;
    contents.emit('did-stop-loading');
    expect(controller.getState()).toMatchObject({ version: start + 4, tabs: [{ title: 'Example Domain', loading: false }] });

    contents.url = 'https://example.com/#x';
    contents.back = true;
    contents.emit('did-navigate-in-page', fakeEvent(), contents.url, true);
    expect(controller.getState()).toMatchObject({ version: start + 5, tabs: [{ url: 'https://example.com/#x', canGoBack: true, canGoForward: false }] });

    // An event that changes nothing does not bump the version.
    contents.emit('did-stop-loading');
    expect(controller.getState().version).toBe(start + 5);
    expect(BrowserStateSchema.safeParse(controller.getState()).success).toBe(true);
  });

  test('sets-window-title', () => {
    controller.navigate('example.com');
    commit(view().webContents, 'https://example.com/', 'Example Domain');
    expect(win.title).toBe('Example Domain — frost');

    // The chrome page's own <title> must not override it.
    const event = fakeEvent();
    win.emit('page-title-updated', event, 'frost', false);
    expect(event.defaultPrevented).toBe(true);

    // A huge page title is cut.
    const long = 'x'.repeat(WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH * 3);
    commit(view().webContents, 'https://example.com/long', long);
    expect(win.title).toBe(`${'x'.repeat(WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH - 1)}… — frost`);
  });

  test('state-url-hides-userinfo', () => {
    controller.navigate('example.com');
    commit(view().webContents, 'https://user:pw@example.com/', '');
    expect(controller.getState().tabs[0]?.url).toBe('https://example.com/');
    expect(win.title).toBe('https://example.com/ — frost');
  });

  test('attach-same-window-twice-is-a-no-op', () => {
    controller.navigate('example.com');
    const version = controller.getState().version;
    controller.attach(win as unknown as HostWindow);
    expect(win.listenerCount('page-title-updated')).toBe(1);
    expect(win.listenerCount('closed')).toBe(1);
    expect(controller.getState().version).toBe(version);
    expect(view().contents.close).not.toHaveBeenCalled();
  });

  test('page-close-closes-tab', () => {
    controller.navigate('example.com');
    const first = view();
    commit(first.webContents, 'https://example.com/', 'Example Domain');
    const before = controller.getState();
    const firstId = before.tabs[0]!.id;

    first.webContents.destroy();
    expect(win.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(first);
    const state = controller.getState();
    expect(state.version).toBeGreaterThan(before.version);
    // The only tab closed: one fresh empty tab (a new id) takes its place.
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.id).not.toBe(firstId);
    expect(state.activeTabId).toBe(state.tabs[0]!.id);
    expect(state.tabs[0]).toMatchObject({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
    expect(win.title).toBe(APP_WINDOW_TITLE);

    // Nothing touches the destroyed WebContents; the next navigation gets a fresh view.
    for (const action of ['back', 'forward', 'reload', 'stop'] as const) controller[action]();
    expect(first.contents.reload).not.toHaveBeenCalled();
    expect(controller.navigate('example.org')).toBe(true);
    expect(views).toHaveLength(2);
    expect(first.contents.loadURL).toHaveBeenCalledTimes(1);
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.org/');
    expect(win.contentView.addChildView).toHaveBeenLastCalledWith(views[1]);
  });

  test('destroyed-contents-count-as-no-view', () => {
    controller.navigate('example.com');
    const first = view();
    // Destroyed without (yet) a `destroyed` event.
    first.contents.destroyed = true;
    expect(controller.navigate('example.org')).toBe(true);
    expect(views).toHaveLength(2);
    expect(first.contents.loadURL).toHaveBeenCalledTimes(1);
  });

  test('renderer-crash-stops-loading', () => {
    controller.navigate('example.com');
    const contents = view().webContents;
    contents.loading = true;
    contents.emit('did-start-loading');
    expect(controller.getState().tabs[0]?.loading).toBe(true);
    // The renderer died mid-load; the WebContents may still report loading.
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(controller.getState().tabs[0]?.loading).toBe(false);
    contents.emit('page-title-updated', fakeEvent(), 'x', false);
    expect(controller.getState().tabs[0]?.loading).toBe(false);
    // A new load clears the crash.
    contents.emit('did-start-loading');
    expect(controller.getState().tabs[0]?.loading).toBe(true);
  });

  test('history-and-reload-act-on-active-tab', () => {
    // Empty tab: nothing to act on, nothing throws.
    for (const action of ['back', 'forward', 'reload', 'stop'] as const) expect(() => controller[action]()).not.toThrow();
    expect(views).toHaveLength(0);

    controller.navigate('example.com');
    const contents = view().webContents;
    commit(contents, 'https://example.com/', 'A');
    controller.back();
    controller.forward();
    expect(contents.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(contents.navigationHistory.goForward).not.toHaveBeenCalled();

    commit(contents, 'https://example.com/b', 'B', { back: true, forward: true });
    controller.back();
    controller.forward();
    expect(contents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(contents.navigationHistory.goForward).toHaveBeenCalledTimes(1);

    controller.reload();
    controller.stop();
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(contents.stop).toHaveBeenCalledTimes(1);
  });

  test('page-bounds-are-clamped', () => {
    // Before the view exists: remembered, then applied on creation.
    controller.setPageBounds({ x: 0.4, y: 48.6, width: 1280.2, height: 720.5 });
    controller.navigate('example.com');
    expect(view().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 49, width: 1280, height: 721 });

    controller.setPageBounds({ x: -20, y: -5, width: 5000, height: 5000 });
    expect(view().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 800 });

    controller.setPageBounds({ x: 2000, y: 900, width: 10, height: 10 });
    expect(view().setBounds).toHaveBeenLastCalledWith({ x: 1280, y: 800, width: 0, height: 0 });

    controller.setPageBounds({ x: 100, y: 50, width: -10, height: 100 });
    expect(view().setBounds).toHaveBeenLastCalledWith({ x: 100, y: 50, width: 0, height: 100 });

    win.size = [800, 600];
    controller.setPageBounds({ x: 0, y: 48, width: 1280, height: 752 });
    expect(view().setBounds).toHaveBeenLastCalledWith({ x: 0, y: 48, width: 800, height: 552 });
  });

  test('watch-resolves-on-change', async () => {
    const { version } = controller.getState();
    await expect(controller.watch(version - 1)).resolves.toMatchObject({ version });

    const pending = controller.watch(version);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.navigate('example.com');
    view().webContents.loading = true;
    view().webContents.emit('did-start-loading');
    await expect(pending).resolves.toMatchObject({ version: version + 1, tabs: [{ loading: true }] });

    expect(controller.pendingWatches()).toBe(0);

    // An aborted watch is released (resolves with the current state) and not kept around.
    const abort = new AbortController();
    const aborted = controller.watch(controller.getState().version, abort.signal);
    expect(controller.pendingWatches()).toBe(1);
    abort.abort();
    expect(controller.pendingWatches()).toBe(0);
    await expect(aborted).resolves.toEqual(controller.getState());
    const preAborted = controller.watch(controller.getState().version, abort.signal);
    expect(controller.pendingWatches()).toBe(0);
    await expect(preAborted).resolves.toEqual(controller.getState());
  });

  test('watch-caps-pending-waiters', async () => {
    const { version } = controller.getState();
    const settled: number[] = [];
    const pending = Array.from({ length: MAX_PENDING_WATCHES }, (_, i) =>
      controller.watch(version).then((state) => {
        settled.push(i);
        return state;
      }),
    );
    expect(controller.pendingWatches()).toBe(MAX_PENDING_WATCHES);
    await Promise.resolve();
    expect(settled).toEqual([]);

    // One more: the oldest resolves at once with the current state.
    const extra = controller.watch(version);
    expect(controller.pendingWatches()).toBe(MAX_PENDING_WATCHES);
    await expect(pending[0]).resolves.toEqual(controller.getState());
    expect(settled).toEqual([0]);

    controller.navigate('example.com');
    view().webContents.loading = true;
    view().webContents.emit('did-start-loading');
    await Promise.all([...pending, extra]);
    expect(controller.pendingWatches()).toBe(0);
  });

  test('watch-clamps-future-version', async () => {
    const { version } = controller.getState();
    const pending = controller.watch(version + 1_000);
    controller.navigate('example.com');
    view().webContents.loading = true;
    view().webContents.emit('did-start-loading');
    await expect(pending).resolves.toMatchObject({ version: version + 1 });
  });

  test('window-close-closes-tab-contents', () => {
    controller.navigate('example.com');
    const contents = view().webContents;
    commit(contents, 'https://example.com/', 'Example Domain');
    const before = controller.getState().version;

    win.emit('closed');
    expect(contents.close).toHaveBeenCalledTimes(1);
    const state = controller.getState();
    expect(state.version).toBeGreaterThan(before);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ url: '', title: '' });

    // A new window (macOS re-activate) starts with a fresh empty tab and a fresh view on navigate.
    const next = new FakeHostWindow();
    controller.attach(next as unknown as HostWindow);
    controller.navigate('example.org');
    expect(views).toHaveLength(2);
    expect(next.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(views[1]);
  });
});

describe('tabs', () => {
  const ids = () => controller.getState().tabs.map((tab) => tab.id);
  const active = () => controller.getState().activeTabId;
  const attached = () => [...win.contentView.children];
  /** Opens a new tab and loads `url` in it; answers the tab id and its view. */
  function openPage(url: string, title = url) {
    const id = controller.newTab();
    if (id === null) throw new Error('newTab refused');
    controller.navigate(url);
    const created = views.at(-1)!;
    commit(created.webContents, url, title);
    return { id, view: created };
  }
  /** Loads `url` in the (empty) first tab; answers its id and view. */
  function loadFirst(url: string, title = url) {
    controller.navigate(url);
    const created = views.at(-1)!;
    commit(created.webContents, url, title);
    return { id: ids()[0]!, view: created };
  }

  test('new-tab-opens-empty-tab-at-end', () => {
    const first = loadFirst('https://a.test/', 'A');
    expect(attached()).toEqual([first.view]);

    const id = controller.newTab();
    expect(id).not.toBeNull();
    expect(ids()).toEqual([first.id, id]);
    expect(active()).toBe(id);
    expect(controller.getState().tabs[1]).toEqual({ id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
    // No view for the empty tab; the previous tab's view is no longer attached.
    expect(views).toHaveLength(1);
    expect(attached()).toEqual([]);
    expect(win.title).toBe(APP_WINDOW_TITLE);
    expect(BrowserStateSchema.safeParse(controller.getState()).success).toBe(true);
  });

  test('new-tab-focuses-address-bar', () => {
    const { focusAddressBarSeq, version } = controller.getState();
    controller.newTab();
    expect(win.webContents.focus).toHaveBeenCalledTimes(1);
    expect(controller.getState().focusAddressBarSeq).toBe(focusAddressBarSeq + 1);
    expect(controller.getState().version).toBeGreaterThan(version);
  });

  test('close-tab-closes-its-contents', () => {
    const first = loadFirst('https://a.test/');
    const second = openPage('https://b.test/');
    expect(attached()).toEqual([second.view]);

    expect(controller.closeTab(second.id)).toBe(true);
    expect(ids()).toEqual([first.id]);
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(second.view);
    expect(second.view.contents.close).toHaveBeenCalledTimes(1);
    expect(first.view.contents.close).not.toHaveBeenCalled();
    expect(attached()).toEqual([first.view]);
  });

  test('close-activates-right-neighbour-else-left', () => {
    const a = loadFirst('https://a.test/');
    const b = openPage('https://b.test/');
    const c = openPage('https://c.test/');

    // Middle tab active → its right neighbour.
    controller.activateTab(b.id);
    controller.closeTab(b.id);
    expect(ids()).toEqual([a.id, c.id]);
    expect(active()).toBe(c.id);
    expect(attached()).toEqual([c.view]);

    // Rightmost tab active → its left neighbour.
    controller.closeTab(c.id);
    expect(active()).toBe(a.id);
    expect(attached()).toEqual([a.view]);
    expect(win.title).toBe('https://a.test/ — frost');
  });

  test('close-inactive-tab-keeps-active', () => {
    const a = loadFirst('https://a.test/');
    const b = openPage('https://b.test/');
    const c = openPage('https://c.test/');
    controller.activateTab(a.id);
    controller.closeTab(b.id);
    expect(ids()).toEqual([a.id, c.id]);
    expect(active()).toBe(a.id);
    expect(attached()).toEqual([a.view]);
    expect(b.view.contents.close).toHaveBeenCalledTimes(1);
  });

  test('close-last-tab-leaves-fresh-empty-tab', () => {
    const only = loadFirst('https://a.test/', 'A');
    const { focusAddressBarSeq } = controller.getState();
    expect(controller.closeTab(only.id)).toBe(true);
    const state = controller.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ url: '', title: '', loading: false });
    expect(state.tabs[0]!.id).not.toBe(only.id);
    expect(state.activeTabId).toBe(state.tabs[0]!.id);
    expect(state.focusAddressBarSeq).toBe(focusAddressBarSeq + 1);
    expect(only.view.contents.close).toHaveBeenCalledTimes(1);
    expect(attached()).toEqual([]);
    expect(win.title).toBe(APP_WINDOW_TITLE);

    // An empty only tab closes the same way.
    const emptyId = state.tabs[0]!.id;
    expect(controller.closeTab(emptyId)).toBe(true);
    expect(ids()).toHaveLength(1);
    expect(ids()[0]).not.toBe(emptyId);
  });

  test('only-active-view-is-attached', () => {
    const a = loadFirst('https://a.test/');
    expect(attached()).toEqual([a.view]);
    const empty = controller.newTab()!;
    expect(attached()).toEqual([]);
    const b = openPage('https://b.test/');
    expect(attached()).toEqual([b.view]);
    controller.activateTab(a.id);
    expect(attached()).toEqual([a.view]);
    controller.activateTab(empty);
    expect(attached()).toEqual([]);
    controller.activateTab(b.id);
    expect(attached()).toEqual([b.view]);
    // The newly attached view gets the page bounds.
    controller.setPageBounds({ x: 0, y: 90, width: 1280, height: 680 });
    controller.activateTab(a.id);
    expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1280, height: 680 });
    expect(attached()).toEqual([a.view]);
    controller.closeTab(a.id);
    // `a` was active and is closed: its right neighbour (the empty tab) shows; nothing attached.
    expect(active()).toBe(empty);
    expect(attached()).toEqual([]);
  });

  test('tabs-keep-their-own-state', () => {
    const a = loadFirst('https://a.test/1', 'A1');
    commit(a.view.webContents, 'https://a.test/2', 'A2', { back: true });
    const b = openPage('https://b.test/', 'B');
    b.view.webContents.loading = true;
    b.view.webContents.emit('did-start-loading');

    const [tabA, tabB] = controller.getState().tabs;
    expect(tabA).toMatchObject({ id: a.id, url: 'https://a.test/2', title: 'A2', canGoBack: true, loading: false });
    expect(tabB).toMatchObject({ id: b.id, url: 'https://b.test/', title: 'B', canGoBack: false, loading: true });

    // A background tab's events update only that tab.
    a.view.webContents.title = 'A2 renamed';
    a.view.webContents.emit('page-title-updated', fakeEvent(), 'A2 renamed', false);
    expect(controller.getState().tabs[0]?.title).toBe('A2 renamed');
    expect(controller.getState().tabs[1]?.title).toBe('B');
    expect(win.title).toBe('B — frost');

    // Navigation commands act on the active tab only.
    b.view.webContents.back = true;
    controller.back();
    controller.reload();
    controller.stop();
    expect(b.view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    expect(a.view.webContents.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(a.view.webContents.reload).not.toHaveBeenCalled();
    expect(a.view.webContents.stop).not.toHaveBeenCalled();
    controller.navigate('c.test');
    expect(b.view.webContents.loadURL).toHaveBeenLastCalledWith('https://c.test/');
    expect(a.view.webContents.loadURL).toHaveBeenCalledTimes(1);

    controller.activateTab(a.id);
    expect(win.title).toBe('A2 renamed — frost');
    controller.back();
    expect(a.view.webContents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
  });

  test('tab-shortcuts-select-by-position', () => {
    const a = loadFirst('https://a.test/');
    const b = openPage('https://b.test/');
    const c = openPage('https://c.test/');
    expect(controller.activateTabAt(0)).toBe(true);
    expect(active()).toBe(a.id);
    expect(controller.activateTabAt(1)).toBe(true);
    expect(active()).toBe(b.id);
    const version = controller.getState().version;
    expect(controller.activateTabAt(3)).toBe(false);
    expect(controller.activateTabAt(-1)).toBe(false);
    expect(active()).toBe(b.id);
    expect(controller.getState().version).toBe(version);
    expect(controller.activateLastTab()).toBe(true);
    expect(active()).toBe(c.id);
    expect(controller.closeActiveTab()).toBe(true);
    expect(ids()).toEqual([a.id, b.id]);
    expect(active()).toBe(b.id);
  });

  test('activate-focuses-page-or-address-bar', () => {
    const a = loadFirst('https://a.test/');
    const empty = controller.newTab()!;
    a.view.webContents.focus.mockClear();
    controller.activateTab(a.id);
    expect(a.view.webContents.focus).toHaveBeenCalledTimes(1);

    win.webContents.focus.mockClear();
    const { focusAddressBarSeq } = controller.getState();
    controller.activateTab(empty);
    expect(win.webContents.focus).toHaveBeenCalledTimes(1);
    expect(controller.getState().focusAddressBarSeq).toBe(focusAddressBarSeq + 1);

    // Activating the active tab changes nothing.
    const { version } = controller.getState();
    expect(controller.activateTab(empty)).toBe(true);
    expect(controller.getState().version).toBe(version);
  });

  test('focus-address-bar-request', () => {
    loadFirst('https://a.test/');
    const { focusAddressBarSeq, version } = controller.getState();
    controller.focusAddressBar();
    controller.focusAddressBar();
    expect(win.webContents.focus).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ focusAddressBarSeq: focusAddressBarSeq + 2, version: version + 2 });
  });

  test('max-tabs-enforced', () => {
    for (let i = 1; i < MAX_TABS; i++) expect(controller.newTab()).not.toBeNull();
    expect(controller.getState().tabs).toHaveLength(MAX_TABS);
    expect(controller.getState().notice).toBeNull();
    const lastId = active();

    expect(controller.newTab()).toBeNull();
    const refused = controller.getState();
    expect(refused.tabs).toHaveLength(MAX_TABS);
    expect(refused.activeTabId).toBe(lastId);
    expect(refused.notice).toMatchObject({ kind: 'tab-limit' });
    expect(BrowserStateSchema.safeParse(refused).success).toBe(true);

    // Each refusal is a new notice.
    expect(controller.newTab()).toBeNull();
    expect(controller.getState().notice?.seq).toBe(refused.notice!.seq + 1);

    controller.closeTab(ids()[0]!);
    expect(controller.newTab()).not.toBeNull();
    expect(controller.getState().tabs).toHaveLength(MAX_TABS);
  });

  test('closed-tab-events-are-ignored', () => {
    const a = loadFirst('https://a.test/', 'A');
    const b = openPage('https://b.test/', 'B');
    controller.closeTab(b.id);
    const before = controller.getState();

    const contents = b.view.contents;
    contents.url = 'https://late.test/';
    contents.title = 'Late';
    contents.loading = true;
    contents.emit('did-start-loading');
    contents.emit('did-navigate', fakeEvent(), contents.url, 200, 'OK');
    contents.emit('did-navigate-in-page', fakeEvent(), contents.url, true);
    contents.emit('page-title-updated', fakeEvent(), 'Late', false);
    contents.emit('did-fail-load', fakeEvent(), -3, 'ERR_ABORTED', contents.url, true);
    contents.emit('did-stop-loading');
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    contents.emit('destroyed');

    expect(controller.getState()).toEqual(before);
    expect(controller.getState().tabs).toEqual([expect.objectContaining({ id: a.id, url: 'https://a.test/', title: 'A' })]);
    expect(attached()).toEqual([a.view]);
    // Our listeners are gone from the closed WebContents.
    for (const event of [
      'did-start-loading',
      'did-navigate',
      'did-navigate-in-page',
      'did-fail-load',
      'page-title-updated',
      'did-stop-loading',
      'render-process-gone',
      'destroyed',
      'before-input-event',
    ]) {
      expect(contents.listenerCount(event), event).toBe(0);
    }
    // A late shortcut from the closed page does nothing either.
    const event = fakeEvent();
    contents.emit('before-input-event', event, key('t', { control: true }));
    expect(controller.getState()).toEqual(before);
  });

  test('unknown-tab-id-is-a-no-op', () => {
    const a = loadFirst('https://a.test/');
    const b = openPage('https://b.test/');
    controller.closeTab(b.id);
    const before = controller.getState();
    for (const id of [b.id, 999, 0, -1, 1.5, Number.NaN]) {
      expect(controller.closeTab(id), String(id)).toBe(false);
      expect(controller.activateTab(id), String(id)).toBe(false);
    }
    expect(controller.getState()).toEqual(before);
    expect(a.view.contents.close).not.toHaveBeenCalled();
  });

  test('background-page-close-closes-its-tab', () => {
    const a = loadFirst('https://a.test/', 'A');
    const b = openPage('https://b.test/', 'B');
    const c = openPage('https://c.test/', 'C');
    controller.activateTab(b.id);
    a.view.webContents.destroy();
    expect(ids()).toEqual([b.id, c.id]);
    expect(active()).toBe(b.id);
    expect(attached()).toEqual([b.view]);
    expect(win.title).toBe('B — frost');
    // The active page closing itself: its right neighbour takes over.
    b.view.webContents.destroy();
    expect(ids()).toEqual([c.id]);
    expect(active()).toBe(c.id);
    expect(attached()).toEqual([c.view]);
  });

  test('next-previous-tab-wraps', () => {
    const only = ids()[0]!;
    const version = controller.getState().version;
    expect(controller.activateNextTab()).toBe(false);
    expect(controller.activatePreviousTab()).toBe(false);
    expect(active()).toBe(only);
    expect(controller.getState().version).toBe(version);

    const second = controller.newTab()!;
    const third = controller.newTab()!;
    expect(controller.activateNextTab()).toBe(true);
    expect(active()).toBe(only);
    expect(controller.activateNextTab()).toBe(true);
    expect(active()).toBe(second);
    expect(controller.activatePreviousTab()).toBe(true);
    expect(active()).toBe(only);
    expect(controller.activatePreviousTab()).toBe(true);
    expect(active()).toBe(third);
  });

  test('page-cannot-block-tab-shortcuts-unit', () => {
    const a = loadFirst('https://a.test/', 'A');
    const send = (target: EventEmitter, input: ReturnType<typeof key>) => {
      const event = fakeEvent();
      target.emit('before-input-event', event, input);
      return event.defaultPrevented;
    };

    // Mod+T from the page: one new tab, the key consumed (down and up), the up runs nothing.
    expect(send(a.view.webContents, key('t', { control: true }))).toBe(true);
    expect(ids()).toHaveLength(2);
    expect(send(a.view.webContents, key('t', { control: true }, 'keyUp'))).toBe(true);
    expect(ids()).toHaveLength(2);

    // From the chrome: Mod+1 selects the first tab; Ctrl+Tab / Ctrl+Shift+Tab cycle.
    expect(send(win.webContents, key('1', { control: true }))).toBe(true);
    expect(active()).toBe(a.id);
    expect(send(a.view.webContents, key('Tab', { control: true }))).toBe(true);
    expect(active()).toBe(ids()[1]);
    expect(send(win.webContents, key('Tab', { control: true, shift: true }))).toBe(true);
    expect(active()).toBe(a.id);

    // Mod+L asks for the address bar; Mod+W closes the active tab.
    const { focusAddressBarSeq } = controller.getState();
    expect(send(a.view.webContents, key('l', { control: true }))).toBe(true);
    expect(controller.getState().focusAddressBarSeq).toBe(focusAddressBarSeq + 1);
    expect(send(a.view.webContents, key('w', { control: true }))).toBe(true);
    expect(ids()).not.toContain(a.id);
    expect(a.view.contents.close).toHaveBeenCalledTimes(1);

    // Ordinary keys and other shortcuts pass through untouched.
    const version = controller.getState().version;
    expect(send(win.webContents, key('a'))).toBe(false);
    expect(send(win.webContents, key('c', { control: true }))).toBe(false);
    expect(send(win.webContents, key('t', { meta: true }))).toBe(false);
    expect(controller.getState().version).toBe(version);
  });

  test('no-window-tab-commands', () => {
    loadFirst('https://a.test/');
    controller.newTab();
    win.emit('closed');
    const before = controller.getState();
    expect(before.tabs).toHaveLength(1);

    // Commands that would only touch hidden tabs change nothing.
    expect(controller.closeTab(before.tabs[0]!.id)).toBe(false);
    expect(controller.activateTab(before.tabs[0]!.id)).toBe(false);
    expect(controller.closeActiveTab()).toBe(false);
    expect(controller.activateTabAt(0)).toBe(false);
    expect(controller.activateLastTab()).toBe(false);
    expect(controller.activateNextTab()).toBe(false);
    expect(controller.activatePreviousTab()).toBe(false);
    controller.focusAddressBar();
    expect(controller.getState()).toEqual(before);
    expect(openWindow).not.toHaveBeenCalled();

    // New Tab opens the window instead, which starts with one empty tab.
    const id = controller.newTab();
    expect(openWindow).toHaveBeenCalledTimes(1);
    const state = controller.getState();
    expect(state.tabs).toHaveLength(1);
    expect(id).toBe(state.tabs[0]!.id);
    expect(state.activeTabId).toBe(id);
  });
});
