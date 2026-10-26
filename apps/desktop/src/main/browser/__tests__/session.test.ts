// Spec: specs/browser-session-db.spec.ts (MAX_RESTORED_TABS), specs/browser.spec.ts (BrowserStateSchema)
// Acceptance: specs/browser-session-db.feature.md (Controller)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SavedSession } from '@app/db';
import { BrowserStateSchema } from '@app/specs/browser.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { createBrowserController, type BrowserController, type HostWindow, type SessionSink, type TabView } from '../controller';

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let sink: { saveSession: ReturnType<typeof vi.fn<SessionSink['saveSession']>>; recordVisit: ReturnType<typeof vi.fn<SessionSink['recordVisit']>>; updateVisitTitle: ReturnType<typeof vi.fn<SessionSink['updateVisitTitle']>> };

beforeEach(() => {
  views = [];
  win = new FakeHostWindow();
  sink = { saveSession: vi.fn(), recordVisit: vi.fn(), updateVisitTitle: vi.fn() };
  controller = createBrowserController({
    createView: () => {
      const created = new FakeTabView();
      views.push(created);
      return created as unknown as TabView;
    },
    platform: 'linux',
    session: sink,
  });
});

const attach = (target: FakeHostWindow = win) => controller.attach(target as unknown as HostWindow);
const state = () => controller.getState();
const urls = () => state().tabs.map((tab) => tab.url);
const activeIndex = () => state().tabs.findIndex((tab) => tab.id === state().activeTabId);
const lastSaved = () => sink.saveSession.mock.calls.at(-1)?.[0];
const attached = () => win.contentView.children;

const saved: SavedSession = {
  tabs: [
    { url: 'https://a.test/', title: 'A' },
    { url: 'https://b.test/b', title: 'B' },
    { url: '', title: '' },
    { url: 'https://c.test/', title: 'C' },
  ],
  activeIndex: 1,
};

describe('session restore', () => {
  test('restore-recreates-tabs', () => {
    controller.restoreSession(saved);
    attach();
    const first = state();
    expect(BrowserStateSchema.safeParse(first).success).toBe(true);
    expect(first.tabs.map((tab) => ({ url: tab.url, title: tab.title }))).toEqual(saved.tabs);
    expect(activeIndex()).toBe(1);
    expect(first.tabs.every((tab) => !tab.loading && !tab.canGoBack && tab.error === null && !tab.crashed)).toBe(true);
    // Only the active tab's view exists, loading its URL, attached.
    expect(views).toHaveLength(1);
    expect(views[0]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://b.test/b');
    expect(attached()).toEqual([views[0]]);

    // A background tab loads when first activated; an empty one stays empty.
    controller.activateTab(first.tabs[3]!.id);
    expect(views).toHaveLength(2);
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://c.test/');
    expect(attached()).toEqual([views[1]]);
    controller.activateTab(first.tabs[2]!.id);
    expect(views).toHaveLength(2);
    expect(attached()).toEqual([]);
    // Activated again, a loaded tab is not loaded twice.
    controller.activateTab(first.tabs[3]!.id);
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledOnce();
    // Closing the active restored tab activates (and loads) its right neighbour... none: the left one.
    controller.closeTab(first.tabs[3]!.id);
    expect(activeIndex()).toBe(2);
    expect(urls()).toEqual(['https://a.test/', 'https://b.test/b', '']);
  });

  test('restore-skips-non-web-urls-in-controller', () => {
    controller.restoreSession({
      tabs: [
        { url: 'file:///etc/passwd', title: 'x' },
        { url: 'https://user:secret@a.test/', title: 'A' },
        { url: 'app://app/', title: 'y' },
        { url: 'javascript:alert(1)', title: 'z' },
      ],
      activeIndex: 2,
    });
    attach();
    // Userinfo is stripped too (defence in depth): never shown, loaded or saved.
    expect(urls()).toEqual(['https://a.test/']);
    expect(activeIndex()).toBe(0);
    expect(views.flatMap((v) => v.webContents.loadURL.mock.calls.map(([url]) => url))).toEqual(['https://a.test/']);
    expect(JSON.stringify(state())).not.toContain('secret');

    const other = createBrowserController({ createView: () => new FakeTabView() as unknown as TabView, platform: 'linux' });
    other.restoreSession({ tabs: [{ url: 'file:///etc/passwd', title: '' }, { url: 'data:text/html,x', title: '' }], activeIndex: 0 });
    other.attach(new FakeHostWindow() as unknown as HostWindow);
    expect(other.getState().tabs.map((tab) => tab.url)).toEqual(['']);
  });

  test('restore-only-before-first-attach', () => {
    attach();
    const before = state();
    controller.restoreSession(saved);
    expect(state()).toEqual(before);
    expect(views).toHaveLength(0);
  });
});

describe('restored loads', () => {
  test('restored-tab-reload-after-aborted-load', () => {
    controller.restoreSession({ tabs: [{ url: 'https://a.test/page', title: 'A' }], activeIndex: 0 });
    attach();
    const contents = views[0]!.webContents;
    expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://a.test/page');
    // The first load is aborted (Stop, a dropped navigation): nothing committed, no error panel.
    contents.loading = true;
    contents.emit('did-start-loading');
    contents.emit('did-fail-load', fakeEvent(), -3, 'ERR_ABORTED', 'https://a.test/page', true, 1, 1);
    contents.loading = false;
    contents.emit('did-stop-loading');
    expect(state().tabs[0]).toMatchObject({ url: 'https://a.test/page', title: 'A', error: null, loading: false });
    // Reload loads the saved URL again (a WebContents reload with no committed entry does nothing).
    controller.reload();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
    expect(contents.loadURL).toHaveBeenLastCalledWith('https://a.test/page');
    // Once a page committed, Reload is a plain reload.
    commit(contents, 'https://a.test/page', 'A');
    controller.reload();
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(contents.loadURL).toHaveBeenCalledTimes(2);
  });

  test('typed-navigation-replaces-restored-url', () => {
    controller.restoreSession({ tabs: [{ url: 'https://a.test/', title: 'A' }], activeIndex: 0 });
    attach();
    const contents = views[0]!.webContents;
    controller.navigate('https://b.test/');
    // The aborted typed load leaves the tab as the user left it; Reload does not go back to A.
    contents.emit('did-fail-load', fakeEvent(), -3, 'ERR_ABORTED', 'https://b.test/', true, 1, 1);
    contents.emit('did-stop-loading');
    expect(state().tabs[0]?.url).toBe('');
    controller.reload();
    expect(contents.loadURL.mock.calls.map(([url]) => url)).toEqual(['https://a.test/', 'https://b.test/']);
  });

  test('restore-load-records-no-visit', () => {
    controller.restoreSession({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }], activeIndex: 0 });
    attach();
    // Loading what was already open is not a visit, at launch or when a background tab is shown.
    commit(views[0]!.webContents, 'https://a.test/', 'A');
    controller.activateTab(state().tabs[1]!.id);
    commit(views[1]!.webContents, 'https://b.test/', 'B');
    expect(sink.recordVisit).not.toHaveBeenCalled();
    // Later navigations in those tabs are.
    commit(views[0]!.webContents, 'https://a.test/next', 'Next');
    commit(views[1]!.webContents, 'https://b.test/', 'B');
    expect(sink.recordVisit.mock.calls).toEqual([['https://a.test/next'], ['https://b.test/']]);
  });
});

describe('session saving', () => {
  test('tab-changes-are-saved', () => {
    attach();
    // What the window starts with is not a change (a reopened macOS window keeps the saved session).
    controller.focusAddressBar();
    expect(sink.saveSession).not.toHaveBeenCalled();
    const calls = () => sink.saveSession.mock.calls.length;

    controller.navigate('https://a.test/');
    commit(views[0]!.webContents, 'https://a.test/', 'A');
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }], activeIndex: 0 });

    const second = controller.newTab()!;
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: '', title: '' }], activeIndex: 1 });
    controller.activateTab(state().tabs[0]!.id);
    expect(lastSaved()?.activeIndex).toBe(0);
    // Loading-state churn without a URL or title change saves nothing new.
    const count = calls();
    views[0]!.webContents.loading = true;
    views[0]!.webContents.emit('did-start-loading');
    views[0]!.webContents.loading = false;
    views[0]!.webContents.emit('did-stop-loading');
    expect(calls()).toBe(count);
    controller.closeTab(second);
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }], activeIndex: 0 });
    // Only url and title per tab are saved.
    for (const [session] of sink.saveSession.mock.calls) {
      expect(Object.keys(session).sort()).toEqual(['activeIndex', 'tabs']);
      for (const tab of session.tabs) expect(Object.keys(tab).sort()).toEqual(['title', 'url']);
    }
  });

  test('error-and-crash-state-not-saved', () => {
    controller.restoreSession({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }], activeIndex: 0 });
    attach();
    const a = views[0]!.webContents;
    commit(a, 'https://a.test/', 'A');
    a.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', 'https://a.test/', true, 1, 1);
    expect(state().tabs[0]!.error).not.toBeNull();
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }], activeIndex: 0 });
    controller.activateTab(state().tabs[1]!.id);
    const b = views[1]!.webContents;
    commit(b, 'https://b.test/', 'B');
    b.emit('render-process-gone', fakeEvent(), { reason: 'crashed', exitCode: 1 });
    expect(state().tabs[1]!.crashed).toBe(true);
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }], activeIndex: 1 });

    // Restored from that, both are ordinary pages that load again.
    const next = createBrowserController({ createView: () => new FakeTabView() as unknown as TabView, platform: 'linux' });
    next.restoreSession(lastSaved()!);
    next.attach(new FakeHostWindow() as unknown as HostWindow);
    expect(next.getState().tabs.map((tab) => ({ error: tab.error, crashed: tab.crashed, url: tab.url }))).toEqual([
      { error: null, crashed: false, url: 'https://a.test/' },
      { error: null, crashed: false, url: 'https://b.test/' },
    ]);
  });

  test('popup-opener-not-saved', () => {
    attach();
    controller.navigate('https://a.test/');
    const opener = views[0]!.webContents;
    commit(opener, 'https://a.test/', 'A');
    controller.openTabFromPage(opener, 'https://a.test/popup');
    commit(views[1]!.webContents, 'https://a.test/popup', 'Popup');
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://a.test/popup', title: 'Popup' }], activeIndex: 0 });

    // Restored, the old popup is a plain tab: the opener's next popup lands right of the opener.
    const restoredViews: FakeTabView[] = [];
    const next = createBrowserController({
      createView: () => {
        const created = new FakeTabView();
        restoredViews.push(created);
        return created as unknown as TabView;
      },
      platform: 'linux',
    });
    next.restoreSession(lastSaved()!);
    next.attach(new FakeHostWindow() as unknown as HostWindow);
    commit(restoredViews[0]!.webContents, 'https://a.test/', 'A');
    const fresh = next.openTabFromPage(restoredViews[0]!.webContents, 'https://a.test/again');
    expect(next.getState().tabs.map((tab) => tab.id)[1]).toBe(fresh);
  });

  test('window-close-keeps-saved-session', () => {
    attach();
    controller.navigate('https://a.test/');
    commit(views[0]!.webContents, 'https://a.test/', 'A');
    controller.newTab();
    const closedStrip = { tabs: [{ url: 'https://a.test/', title: 'A' }, { url: '', title: '' }], activeIndex: 1 };
    // Each change was saved as it happened: closing has nothing new to save.
    expect(lastSaved()).toEqual(closedStrip);
    const saves = sink.saveSession.mock.calls.length;
    win.emit('close', fakeEvent());
    // Tear-down and the empty tab left behind are never saved.
    views[0]!.webContents.destroy();
    win.emit('closed');
    expect(state().tabs).toHaveLength(1);
    expect(sink.saveSession).toHaveBeenCalledTimes(saves);

    // A window reopened from the dock (macOS) starts on one empty tab: closing it untouched, or
    // quitting, keeps the session saved from the window before.
    const reopened = new FakeHostWindow();
    attach(reopened);
    controller.focusAddressBar();
    reopened.emit('close', fakeEvent());
    reopened.emit('closed');
    expect(sink.saveSession).toHaveBeenCalledTimes(saves);
    expect(lastSaved()).toEqual(closedStrip);

    // A new window's tabs are saved again once something happens in it.
    const next = new FakeHostWindow();
    attach(next);
    controller.navigate('https://b.test/');
    commit(views[1]!.webContents, 'https://b.test/', 'B');
    expect(lastSaved()).toEqual({ tabs: [{ url: 'https://b.test/', title: 'B' }], activeIndex: 0 });
    const afterB = sink.saveSession.mock.calls.length;
    // A change made while closing (a page's last title) is still saved, then nothing after it.
    next.title = '';
    views[1]!.webContents.title = 'B (closing)';
    views[1]!.webContents.emit('page-title-updated', fakeEvent(), 'B (closing)', false);
    expect(sink.saveSession).toHaveBeenCalledTimes(afterB + 1);
    next.emit('close', fakeEvent());
    expect(sink.saveSession).toHaveBeenCalledTimes(afterB + 1);
    views[1]!.webContents.title = 'after close';
    views[1]!.webContents.emit('page-title-updated', fakeEvent(), 'after close', false);
    expect(sink.saveSession).toHaveBeenCalledTimes(afterB + 1);
  });
});

describe('visits', () => {
  test('visits-recorded-on-commit', () => {
    attach();
    controller.navigate('https://a.test/');
    const contents = views[0]!.webContents;
    commit(contents, 'https://a.test/', 'Page A');
    expect(sink.recordVisit.mock.calls).toEqual([['https://a.test/']]);
    expect(sink.updateVisitTitle).toHaveBeenLastCalledWith('https://a.test/', 'Page A');

    // Main-frame same-document navigations record; subframe ones do not.
    contents.url = 'https://a.test/#section';
    contents.emit('did-navigate-in-page', fakeEvent(), 'https://a.test/#section', true, 1, 1);
    contents.emit('did-navigate-in-page', fakeEvent(), 'https://ads.test/frame#x', false, 1, 2);
    expect(sink.recordVisit.mock.calls).toEqual([['https://a.test/'], ['https://a.test/#section']]);

    // Non-web commits record nothing.
    contents.url = 'about:blank';
    contents.emit('did-navigate', fakeEvent(), 'about:blank', 200, 'OK');
    expect(sink.recordVisit).toHaveBeenCalledTimes(2);

    // A failed load records nothing, and the error page's title updates no visit.
    sink.updateVisitTitle.mockClear();
    contents.url = 'https://down.test/';
    contents.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', 'https://down.test/', true, 1, 1);
    contents.title = 'down.test';
    contents.emit('page-title-updated', fakeEvent(), 'down.test', false);
    expect(sink.recordVisit).toHaveBeenCalledTimes(2);
    expect(sink.updateVisitTitle).not.toHaveBeenCalled();
  });
});
