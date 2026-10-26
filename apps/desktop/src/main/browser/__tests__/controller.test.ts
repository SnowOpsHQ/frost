// Spec: specs/browser.spec.ts (BrowserStateSchema, APP_WINDOW_TITLE) · Acceptance: specs/browser-chrome.feature.md (Controller)
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { APP_WINDOW_TITLE, BrowserStateSchema, SEARCH_URL_TEMPLATE } from '@app/specs/browser.spec';
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
  close = vi.fn();
  isDestroyed = () => false;
  readonly navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
}

class FakeTabView {
  readonly webContents = new FakeTabContents();
  setBounds = vi.fn();
  setVisible = vi.fn();
}

class FakeHostWindow extends EventEmitter {
  size: [number, number] = [1280, 800];
  title = '';
  readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  getContentSize = () => [...this.size];
  setTitle = vi.fn((title: string) => {
    this.title = title;
  });
  isDestroyed = () => false;
}

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;

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
  controller = createBrowserController({
    createView: () => {
      const created = new FakeTabView();
      views.push(created);
      return created as unknown as TabView;
    },
  });
  controller.attach(win as unknown as HostWindow);
});

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
    controller.navigate('   ');
    expect(views).toHaveLength(0);

    controller.navigate('example.com');
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

    // An aborted watch is released (resolves with the current state) and not kept around.
    const abort = new AbortController();
    const aborted = controller.watch(controller.getState().version, abort.signal);
    abort.abort();
    await expect(aborted).resolves.toEqual(controller.getState());
    const preAborted = controller.watch(controller.getState().version, abort.signal);
    await expect(preAborted).resolves.toEqual(controller.getState());
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
