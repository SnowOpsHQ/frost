// Spec: specs/browser.spec.ts (BrowserStateSchema, APP_WINDOW_TITLE, MAX_TABS), specs/browse-guard.spec.ts
// Acceptance: specs/browser-chrome.feature.md (Controller), specs/tabs.feature.md (Controller),
// specs/browse-guard.feature.md (Controller)
import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FULLSCREEN_BANNER_HEIGHT, FULLSCREEN_EXIT_SETTLE_MS, FULLSCREEN_NOTICE_MS } from '@app/specs/permissions.spec';
import {
  APP_WINDOW_TITLE,
  BrowserStateSchema,
  MAX_PENDING_WATCHES,
  MAX_TABS,
  SEARCH_URL_TEMPLATE,
  WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH,
} from '@app/specs/browser.spec';
import { commit, FakeHostWindow, FakeTabContents, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';
import { createPermissionBroker, type PermissionBroker } from '../permissions';

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
/** The controller's permission broker (a real one, with its in-memory decision store). */
let broker: PermissionBroker;
/** The injected `openWindow` (the app opens and attaches a new window). */
let openWindow: ReturnType<typeof vi.fn<() => void>>;

function view(): FakeTabView {
  const [only] = views;
  if (!only) throw new Error('no view was created');
  return only;
}

beforeEach(() => {
  views = [];
  win = new FakeHostWindow();
  openWindow = vi.fn(() => {
    win = new FakeHostWindow();
    controller.attach(win as unknown as HostWindow);
  });
  broker = createPermissionBroker();
  controller = createBrowserController({
    permissions: broker,
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
    expect(controller.getState().tabs[1]).toEqual({ id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null });
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
    contents.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', contents.url, true);
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    contents.emit('unresponsive');
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
      'unresponsive',
      'responsive',
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

describe('guards', () => {
  const ids = () => controller.getState().tabs.map((tab) => tab.id);
  const active = () => controller.getState().activeTabId;
  const attached = () => [...win.contentView.children];
  const tabState = (id: number) => controller.getState().tabs.find((tab) => tab.id === id)!;
  /** Loads `url` in the (empty) first tab; answers its id and view. */
  function loadFirst(url: string, title = url) {
    controller.navigate(url);
    const created = views.at(-1)!;
    commit(created.webContents, url, title);
    return { id: ids()[0]!, view: created };
  }
  /** Electron's `did-fail-load` (event, errorCode, errorDescription, validatedURL, isMainFrame). */
  function fail(contents: FakeTabContents, code: number, description: string, url: string, isMainFrame = true) {
    contents.loading = true;
    contents.emit('did-start-loading');
    contents.url = url;
    contents.emit('did-fail-load', fakeEvent(), code, description, url, isMainFrame, 1, 1);
    contents.loading = false;
    contents.emit('did-stop-loading');
  }

  test('load-failure-shows-error', () => {
    const a = loadFirst('https://a.test/', 'A');
    const contents = a.view.webContents;
    expect(tabState(a.id).error).toBeNull();

    // Ignored: a subframe's failure, and ERR_ABORTED (a dropped navigation, a stop, a download).
    const before = controller.getState().version;
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false, 1, 2);
    contents.emit('did-fail-load', fakeEvent(), -3, 'ERR_ABORTED', 'https://a.test/file.zip', true, 1, 1);
    expect(controller.getState().version).toBe(before);
    expect(attached()).toEqual([a.view]);

    contents.back = true;
    fail(contents, -102, 'ERR_CONNECTION_REFUSED', 'http://user:pw@127.0.0.1:9/x');
    expect(tabState(a.id)).toMatchObject({
      error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://127.0.0.1:9/x' },
      crashed: false,
      loading: false,
      canGoBack: true,
    });
    expect(attached()).toEqual([]);
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());

    // The next main-frame commit clears it and shows the page again.
    commit(contents, 'https://a.test/', 'A', { back: true });
    expect(tabState(a.id).error).toBeNull();
    expect(attached()).toEqual([a.view]);
    expect(a.view.setVisible).toHaveBeenLastCalledWith(true);
  });

  test('error-retry-reloads', () => {
    const a = loadFirst('https://a.test/', 'A');
    fail(a.view.webContents, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.test/');
    controller.reload();
    expect(a.view.webContents.reload).toHaveBeenCalledTimes(1);
    // The panel stays while the retry loads (no flash of the blank error page).
    a.view.webContents.loading = true;
    a.view.webContents.emit('did-start-loading');
    expect(tabState(a.id)).toMatchObject({ loading: true, error: { code: -105 } });
    expect(attached()).toEqual([]);
  });

  test('crash-shows-crash-state', () => {
    const a = loadFirst('https://a.test/', 'A');
    const contents = a.view.webContents;
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(tabState(a.id)).toMatchObject({ crashed: true, loading: false, url: 'https://a.test/' });
    expect(attached()).toEqual([]);
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());

    contents.loading = true;
    contents.emit('did-start-loading');
    expect(tabState(a.id)).toMatchObject({ crashed: false, loading: true });
    expect(attached()).toEqual([a.view]);
  });

  test('crash-reload-recovers', () => {
    const a = loadFirst('https://a.test/', 'A');
    a.view.webContents.emit('render-process-gone', fakeEvent(), { reason: 'killed', exitCode: 9 });
    controller.reload();
    expect(a.view.webContents.reload).toHaveBeenCalledTimes(1);

    // The crashed WebContents is gone (no `destroyed` event reached us): a fresh view loads the URL.
    a.view.contents.destroyed = true;
    controller.reload();
    expect(views).toHaveLength(2);
    const fresh = views[1]!;
    expect(fresh.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://a.test/');
    expect(ids()).toEqual([a.id]);
    commit(fresh.webContents, 'https://a.test/', 'A');
    expect(tabState(a.id)).toMatchObject({ crashed: false, error: null, url: 'https://a.test/', title: 'A' });
    expect(attached()).toEqual([fresh]);
  });

  test('popup-opens-background-tab-in-controller', () => {
    const a = loadFirst('https://a.test/', 'A');
    const other = controller.newTab()!;
    controller.activateTab(a.id);
    controller.setPageBounds({ x: 0, y: 90, width: 1280, height: 684 });

    const first = controller.openTabFromPage(a.view.webContents, 'https://a.test/popup-1');
    const second = controller.openTabFromPage(a.view.webContents, 'https://a.test/popup-2');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Right of the opener, in the order opened, before the tab that was already there.
    expect(ids()).toEqual([a.id, first, second, other]);
    expect(active()).toBe(a.id);
    expect(attached()).toEqual([a.view]);
    expect(views).toHaveLength(3);
    const [, v1, v2] = views;
    expect(v1!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://a.test/popup-1');
    expect(v2!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://a.test/popup-2');
    // Laid out at the page area's size while in the background.
    expect(v1!.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1280, height: 684 });
    commit(v1!.webContents, 'https://a.test/popup-1', 'Popup 1');
    expect(tabState(first!)).toMatchObject({ url: 'https://a.test/popup-1', title: 'Popup 1' });
    expect(active()).toBe(a.id);
    expect(BrowserStateSchema.safeParse(controller.getState()).success).toBe(true);

    // A popup's own popup goes right of it.
    const nested = controller.openTabFromPage(v1!.webContents, 'https://a.test/popup-3');
    expect(ids()).toEqual([a.id, first, nested, second, other]);
  });

  test('popup-respects-max-tabs', () => {
    const a = loadFirst('https://a.test/', 'A');
    for (let i = 1; i < MAX_TABS; i++) controller.newTab();
    controller.activateTab(a.id);
    const notice = controller.getState().notice;
    expect(controller.openTabFromPage(a.view.webContents, 'https://a.test/popup')).toBeNull();
    expect(controller.getState().tabs).toHaveLength(MAX_TABS);
    expect(views).toHaveLength(1);
    expect(controller.getState().notice).toEqual({ seq: (notice?.seq ?? 0) + 1, kind: 'tab-limit' });
  });

  test('popup-needs-a-known-opener-and-web-url', () => {
    const a = loadFirst('https://a.test/', 'A');
    const version = controller.getState().version;
    expect(controller.openTabFromPage(new FakeTabContents(), 'https://a.test/x')).toBeNull();
    for (const url of ['about:blank', 'file:///etc/passwd', 'app://app/', 'javascript:1', 'mailto:a@b.c']) {
      expect(controller.openTabFromPage(a.view.webContents, url), url).toBeNull();
    }
    expect(controller.getState().version).toBe(version);
    expect(views).toHaveLength(1);
    // No window: nothing either.
    win.emit('closed');
    const after = controller.getState().version;
    expect(controller.openTabFromPage(a.view.contents, 'https://a.test/x')).toBeNull();
    expect(controller.getState().version).toBe(after);
  });

  test('notify-raises-notice', () => {
    expect(controller.getState().notice).toBeNull();
    const version = controller.getState().version;
    controller.notify('download-blocked');
    expect(controller.getState()).toMatchObject({ version: version + 1, notice: { seq: 1, kind: 'download-blocked' } });
    controller.notify('download-blocked');
    expect(controller.getState().notice).toEqual({ seq: 2, kind: 'download-blocked' });
    expect(BrowserStateSchema.safeParse(controller.getState()).success).toBe(true);
  });

  test('unresponsive-is-per-tab', () => {
    const a = loadFirst('https://a.test/', 'A');
    const b = controller.openTabFromPage(a.view.webContents, 'https://a.test/b')!;
    const bView = views[1]!;
    commit(bView.webContents, 'https://a.test/b', 'B');

    bView.webContents.emit('unresponsive');
    expect(tabState(b).unresponsive).toBe(true);
    expect(tabState(a.id).unresponsive).toBe(false);
    expect(controller.getState().notice).toBeNull();
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
    bView.webContents.emit('responsive');
    expect(tabState(b).unresponsive).toBe(false);

    a.view.webContents.emit('unresponsive');
    expect(tabState(a.id).unresponsive).toBe(true);
    a.view.webContents.emit('render-process-gone', fakeEvent(), { reason: 'killed', exitCode: 9 });
    expect(tabState(a.id)).toMatchObject({ unresponsive: false, crashed: true });
  });

  test('popup-placement-skips-descendants', () => {
    const a = loadFirst('https://a.test/', 'A');
    const p1 = controller.openTabFromPage(a.view.webContents, 'https://a.test/p1')!;
    const p1View = views.at(-1)!;
    const n = controller.openTabFromPage(p1View.webContents, 'https://a.test/n')!;
    const nView = views.at(-1)!;
    const nn = controller.openTabFromPage(nView.webContents, 'https://a.test/nn')!;
    const p2 = controller.openTabFromPage(a.view.webContents, 'https://a.test/p2')!;
    expect(ids()).toEqual([a.id, p1, n, nn, p2]);
  });

  test('popup-download-closes-blank-popup-tab', () => {
    const a = loadFirst('https://a.test/', 'A');
    const blank = controller.openTabFromPage(a.view.webContents, 'https://a.test/file.zip')!;
    const blankView = views.at(-1)!;
    const loaded = controller.openTabFromPage(a.view.webContents, 'https://a.test/page')!;
    const loadedView = views.at(-1)!;
    commit(loadedView.webContents, 'https://a.test/page', 'Page');

    // The popup's navigation turned into a download: nothing committed, so its tab goes.
    controller.downloadBlocked(blankView.webContents);
    expect(ids()).toEqual([a.id, loaded]);
    expect(blankView.contents.close).toHaveBeenCalledTimes(1);
    expect(controller.getState().notice).toMatchObject({ kind: 'download-blocked' });
    expect(active()).toBe(a.id);
    expect(attached()).toEqual([a.view]);

    // A popup with a page, the user's own tab, an unknown WebContents: notice only.
    controller.downloadBlocked(loadedView.webContents);
    controller.downloadBlocked(a.view.webContents);
    controller.downloadBlocked(new FakeTabContents());
    controller.downloadBlocked(null);
    expect(ids()).toEqual([a.id, loaded]);
    expect(controller.getState().notice?.seq).toBe(5);

    // A tab the user opened and typed a file URL into stays (an empty tab), too.
    const own = controller.newTab()!;
    controller.navigate('https://a.test/other.zip');
    controller.downloadBlocked(views.at(-1)!.webContents);
    expect(ids()).toEqual([a.id, loaded, own]);
    expect(blank).not.toBe(own);
  });
});

describe('permissions', () => {
  const ids = () => controller.getState().tabs.map((tab) => tab.id);
  const tabState = (id: number) => controller.getState().tabs.find((tab) => tab.id === id)!;
  const promptOf = (id: number) => tabState(id).permissionPrompt;
  const notifications = (origin: string) => ({ origin, topLevelOrigin: origin, permission: 'notifications' as const });

  /** Opens a tab with a committed page; answers its id and view. */
  function openPage(url: string) {
    if (views.length > 0) controller.newTab();
    controller.navigate(url);
    const created = views.at(-1)!;
    commit(created.webContents, url, url);
    return { id: controller.getState().activeTabId!, view: created };
  }

  test('prompt-in-tab-state', () => {
    const a = openPage('https://a.test/');
    const b = openPage('https://b.test/');
    expect(promptOf(a.id)).toBeNull();
    const before = controller.getState().version;
    broker.request(a.id, notifications('https://a.test'), vi.fn());
    const state = controller.getState();
    expect(state.version).toBe(before + 1);
    expect(promptOf(a.id)).toMatchObject({ origin: 'https://a.test', permission: 'notifications' });
    expect(promptOf(b.id)).toBeNull();
    expect(BrowserStateSchema.parse(state)).toEqual(state);
    // A snapshot is a copy: changing it changes nothing in main.
    state.tabs[0]!.permissionPrompt!.origin = 'https://evil.test';
    expect(promptOf(a.id)?.origin).toBe('https://a.test');
  });

  test('answer-applies-to-active-tab-only', () => {
    const a = openPage('https://a.test/');
    const b = openPage('https://b.test/');
    const answerA = vi.fn();
    const answerB = vi.fn();
    broker.request(a.id, notifications('https://a.test'), answerA);
    broker.request(b.id, notifications('https://b.test'), answerB);
    const idA = promptOf(a.id)!.id;
    const idB = promptOf(b.id)!.id;
    // b is active: a's prompt cannot be answered from the chrome.
    expect(controller.answerPermission(idA, 'allow')).toBe(false);
    expect(answerA).not.toHaveBeenCalled();
    expect(promptOf(a.id)?.id).toBe(idA);
    expect(controller.answerPermission(idB, 'block')).toBe(true);
    expect(answerB).toHaveBeenCalledExactlyOnceWith(false);
    expect(promptOf(b.id)).toBeNull();
    // Single use, and only once its tab is shown.
    expect(controller.answerPermission(idB, 'allow')).toBe(false);
    controller.activateTab(a.id);
    expect(controller.answerPermission(idA, 'allow')).toBe(true);
    expect(answerA).toHaveBeenCalledExactlyOnceWith(true);
  });

  test('tab-id-of-contents', () => {
    const a = openPage('https://a.test/');
    const b = openPage('https://b.test/');
    expect(controller.tabIdOf(a.view.webContents)).toBe(a.id);
    expect(controller.tabIdOf(b.view.webContents)).toBe(b.id);
    expect(controller.tabIdOf(win.webContents)).toBeNull();
    expect(controller.tabIdOf(new FakeTabContents())).toBeNull();
    expect(controller.tabIdOf(null)).toBeNull();
    expect(controller.tabIdOf(undefined)).toBeNull();
    const contents = a.view.contents;
    controller.closeTab(a.id);
    expect(controller.tabIdOf(contents)).toBeNull();
  });

  test('prompts-denied-when-tab-goes', () => {
    const ask = (tabId: number) => {
      const callback = vi.fn();
      broker.request(tabId, notifications('https://a.test'), callback);
      expect(promptOf(tabId)).not.toBeNull();
      return callback;
    };
    const a = openPage('https://a.test/');
    const contents = a.view.webContents;

    // A same-document navigation keeps the prompt.
    const kept = ask(a.id);
    contents.emit('did-navigate-in-page', fakeEvent(), 'https://a.test/#x', true);
    expect(kept).not.toHaveBeenCalled();
    // A cross-document commit denies it.
    commit(contents, 'https://a.test/next', 'Next');
    expect(kept).toHaveBeenCalledExactlyOnceWith(false);
    expect(promptOf(a.id)).toBeNull();

    // A main-frame load failure (an error page replaces the document) denies; a subframe's does not.
    const failed = ask(a.id);
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.test/', false, 1, 2);
    expect(failed).not.toHaveBeenCalled();
    contents.emit('did-fail-load', fakeEvent(), -105, 'ERR_NAME_NOT_RESOLVED', 'https://nowhere.test/', true, 1, 1);
    expect(failed).toHaveBeenCalledExactlyOnceWith(false);
    commit(contents, 'https://a.test/', 'A');

    const crashed = ask(a.id);
    contents.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(crashed).toHaveBeenCalledExactlyOnceWith(false);
    commit(contents, 'https://a.test/', 'A');

    // Closing the tab.
    const b = openPage('https://b.test/');
    const closed = ask(b.id);
    controller.closeTab(b.id);
    expect(closed).toHaveBeenCalledExactlyOnceWith(false);

    // The page closing itself (its WebContents destroyed).
    const c = openPage('https://c.test/');
    const destroyed = ask(c.id);
    c.view.contents.destroy();
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(false);
    expect(ids()).toEqual([a.id]);
    expect(broker.pendingCount()).toBe(0);
    expect(broker.check({ origin: 'https://a.test', topLevelOrigin: 'https://a.test' }, 'notifications')).toBe(false);
  });

  /** Electron's `before-input-event` for a key (Linux). */
  function press(contents: FakeTabContents, keyName: string, type = 'keyDown') {
    const event = fakeEvent();
    contents.emit('before-input-event', event, key(keyName, {}, type));
    return event;
  }

  /** What Electron does when the page enters HTML fullscreen: the window goes OS-fullscreen first. */
  function enterFullscreen(tabView: FakeTabView, size: [number, number] = [1920, 1080]) {
    win.fullScreen = true;
    win.size = size;
    tabView.webContents.emit('enter-html-full-screen');
  }

  test('html-fullscreen-fills-window', () => {
    vi.useFakeTimers();
    try {
      controller.setPageBounds({ x: 0, y: 90, width: 1280, height: 684 });
      const a = openPage('https://a.test/');
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1280, height: 684 });
      expect(tabState(a.id).fullscreen).toBeNull();
      enterFullscreen(a.view);
      // First the notice: the view sits below the chrome's banner.
      expect(tabState(a.id).fullscreen).toBe('notice');
      expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: FULLSCREEN_BANNER_HEIGHT, width: 1920, height: 1080 - FULLSCREEN_BANNER_HEIGHT });
      // The chrome reports its new page area meanwhile: the view keeps its fullscreen bounds.
      controller.setPageBounds({ x: 0, y: 90, width: 1920, height: 964 });
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: FULLSCREEN_BANNER_HEIGHT, width: 1920, height: 1080 - FULLSCREEN_BANNER_HEIGHT });
      vi.advanceTimersByTime(FULLSCREEN_NOTICE_MS - 1);
      expect(tabState(a.id).fullscreen).toBe('notice');
      const before = controller.getState().version;
      vi.advanceTimersByTime(1);
      expect(tabState(a.id).fullscreen).toBe('full');
      expect(controller.getState().version).toBe(before + 1);
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1920, height: 1080 });
      a.view.webContents.emit('leave-html-full-screen');
      expect(tabState(a.id).fullscreen).toBeNull();
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1920, height: 964 });
      // A new document is never fullscreen, and a stale notice timer changes nothing.
      enterFullscreen(a.view);
      commit(a.view.webContents, 'https://a.test/next', 'Next');
      expect(tabState(a.id).fullscreen).toBeNull();
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1920, height: 964 });
      vi.advanceTimersByTime(FULLSCREEN_NOTICE_MS);
      expect(tabState(a.id).fullscreen).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('tab-fullscreen-state', () => {
    const a = openPage('https://a.test/');
    const b = openPage('https://b.test/');
    expect(controller.isFullscreen(a.id)).toBe(false);
    enterFullscreen(b.view);
    expect(controller.isFullscreen(b.id)).toBe(true);
    expect(controller.isFullscreen(a.id)).toBe(false);
    expect(controller.isFullscreen(999)).toBe(false);
    b.view.webContents.emit('leave-html-full-screen');
    expect(controller.isFullscreen(b.id)).toBe(false);
  });

  test('esc-always-leaves-fullscreen', () => {
    vi.useFakeTimers();
    try {
      controller.setPageBounds({ x: 0, y: 90, width: 1280, height: 684 });
      const a = openPage('https://a.test/');
      const contents = a.view.webContents;
      // Not fullscreen: Escape is the page's.
      expect(press(contents, 'Escape').defaultPrevented).toBe(false);
      expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      enterFullscreen(a.view);
      // The page hangs: its exit script never settles, and it never reports leaving fullscreen.
      contents.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise<undefined>(() => {}));
      a.view.setBounds.mockClear();
      const before = controller.getState().version;
      const down = press(contents, 'Escape');
      expect(down.defaultPrevented).toBe(true);
      // Main left fullscreen at once, without the page: state, window and bounds.
      expect(tabState(a.id).fullscreen).toBeNull();
      expect(controller.isFullscreen(a.id)).toBe(false);
      expect(controller.getState().version).toBeGreaterThan(before);
      expect(win.setFullScreen).toHaveBeenLastCalledWith(false);
      expect(win.fullScreen).toBe(false);
      expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1280, height: 684 });
      // Then, once the window settled, the page is asked to leave, from an isolated world.
      expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS);
      expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
      const [worldId, scripts] = contents.executeJavaScriptInIsolatedWorld.mock.calls[0]!;
      expect(worldId).toBeGreaterThan(0);
      expect(scripts.map((script) => script.code).join('')).toContain('document.exitFullscreen()');
      // The key-up is kept from the page as well, and does not exit twice.
      expect(press(contents, 'Escape', 'keyUp').defaultPrevented).toBe(true);
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS);
      expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
      // Other keys still reach the page.
      expect(press(contents, 'a').defaultPrevented).toBe(false);
      // frost stays out of fullscreen though the page never reported leaving.
      expect(tabState(a.id).fullscreen).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('page-exit-waits-for-window-to-settle', () => {
    vi.useFakeTimers();
    try {
      const a = openPage('https://a.test/');
      const b = openPage('https://b.test/');
      const exits = () => b.view.contents.executeJavaScriptInIsolatedWorld.mock.calls.length;
      // macOS: Electron handles Esc first and reports leaving while the window still animates.
      enterFullscreen(b.view);
      b.view.webContents.emit('leave-html-full-screen');
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS * 3);
      expect(exits()).toBe(0);
      // Each window fullscreen event restarts the wait; asked once it has been still that long.
      win.fullScreen = false;
      win.emit('leave-full-screen');
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS - 1);
      win.emit('enter-full-screen');
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS - 1);
      expect(exits()).toBe(0);
      vi.advanceTimersByTime(1);
      expect(exits()).toBe(1);
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS * 3);
      expect(exits()).toBe(1);
      // Shown again after another tab: asked again, after the same wait.
      controller.activateTab(a.id);
      controller.activateTab(b.id);
      expect(exits()).toBe(1);
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS);
      expect(exits()).toBe(2);
      // Fullscreen again: no exit of frost's is pending.
      enterFullscreen(b.view);
      win.fullScreen = false;
      win.emit('leave-full-screen');
      controller.activateTab(a.id);
      expect(exits()).toBe(2);
      // (Switching away left it: asked once settled.)
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS);
      expect(exits()).toBe(3);
      // Nor after a new document commits.
      controller.activateTab(b.id);
      commit(b.view.webContents, 'https://b.test/next', 'Next');
      win.emit('leave-full-screen');
      controller.activateTab(a.id);
      controller.activateTab(b.id);
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS * 3);
      expect(exits()).toBe(3);
      expect(a.view.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('leaving-fullscreen-tab-restores-window', () => {
    vi.useFakeTimers();
    try {
      const a = openPage('https://a.test/');
      const b = openPage('https://b.test/');
      // Switching away from a fullscreen tab.
      enterFullscreen(b.view);
      controller.activateTab(a.id);
      expect(controller.isFullscreen(b.id)).toBe(false);
      expect(win.setFullScreen).toHaveBeenLastCalledWith(false);
      expect(win.fullScreen).toBe(false);
      vi.advanceTimersByTime(FULLSCREEN_EXIT_SETTLE_MS);
      expect(b.view.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
      // Closing a fullscreen tab.
      controller.activateTab(b.id);
      enterFullscreen(b.view);
      controller.closeTab(b.id);
      expect(win.fullScreen).toBe(false);
      expect(win.setFullScreen).toHaveBeenCalledTimes(2);
      // Nothing to restore when no tab was fullscreen.
      controller.closeTab(a.id);
      expect(win.setFullScreen).toHaveBeenCalledTimes(2);
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  test('window-events-reapply-bounds', () => {
    controller.setPageBounds({ x: 0, y: 90, width: 1280, height: 684 });
    const a = openPage('https://a.test/');
    enterFullscreen(a.view, [1280, 800]);
    a.view.setBounds.mockClear();
    // The window's size changes after the page entered fullscreen; no new page-area report.
    for (const event of ['resize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.size = event === 'resize' ? [1600, 900] : event === 'enter-full-screen' ? [1920, 1080] : [1700, 950];
      win.emit(event);
      expect(a.view.setBounds, event).toHaveBeenLastCalledWith({ x: 0, y: FULLSCREEN_BANNER_HEIGHT, width: win.size[0], height: win.size[1] - FULLSCREEN_BANNER_HEIGHT });
    }
    a.view.webContents.emit('leave-html-full-screen');
    win.size = [1000, 700];
    win.emit('resize');
    expect(a.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 90, width: 1000, height: 610 });
  });
});
