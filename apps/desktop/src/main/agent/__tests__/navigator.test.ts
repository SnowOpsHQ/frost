// Spec: specs/agent-page-tools.spec.ts (NAVIGATE_SETTLE_TIMEOUT_MS, PAGE_TITLE_MAX_CHARS)
// Acceptance: specs/agent-page-tools.feature.md (Scenarios: the navigator)
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NAVIGATE_SETTLE_TIMEOUT_MS } from '@app/specs/agent-page-tools.spec';
import { createTabNavigator, type NavigableContents, type TabNavigation } from '../tools';

const TAB = 3;

afterEach(() => {
  vi.useRealTimers();
});

/** A tab WebContents that emits Electron's navigation events in the order Electron 45 does. */
class FakeContents extends EventEmitter implements NavigableContents {
  url = 'https://example.com/start';
  title = 'Start';
  destroyed = false;
  loading = false;
  getURL = () => this.url;
  isLoading = () => this.loading;
  getTitle = () => this.title;
  isDestroyed = () => this.destroyed;

  /** A main-frame navigation starting (`did-start-navigation`). */
  start(url: string, { isMainFrame = true, isSameDocument = false } = {}): void {
    this.emit('did-start-navigation', { url, isMainFrame, isSameDocument });
  }
  /** A server redirect: `true` if a listener cancelled it. */
  redirect(url: string, isMainFrame = true): boolean {
    let prevented = false;
    this.emit('will-redirect', { url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented;
  }
  commit(url: string, status = 200, title = 'Loaded'): void {
    this.url = url;
    this.title = title;
    this.emit('did-navigate', {}, url, status, 'OK');
  }
  stop(): void {
    this.loading = false;
    this.emit('did-stop-loading', {});
  }
  /** The page's own same-document move (`history.pushState`, a fragment link). */
  inPage(url: string): void {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: true });
    this.url = url;
    this.emit('did-navigate-in-page', {}, url, true);
  }
  listening(): number {
    return this.eventNames().reduce((sum, name) => sum + this.listenerCount(name), 0);
  }
}

function setup({ active = TAB, navigate = true, contents = new FakeContents() as FakeContents | null } = {}) {
  const browser = { getState: () => ({ activeTabId: active }), navigate: vi.fn(() => navigate) };
  const navigator = createTabNavigator({ browser, contentsOf: (tabId) => (tabId === TAB ? contents : null) });
  return { browser, contents: contents!, navigator };
}

const signal = () => new AbortController().signal;

describe('the tab navigator', () => {
  test('navigator-uses-controller', async () => {
    const { browser, navigator } = setup();
    // A URL the address bar would rewrite or search for is refused; so is a tab not shown.
    expect(await navigator(TAB, 'https://example.com:0/', { signal: signal() })).toEqual({ status: 'refused' });
    expect(await navigator(TAB, 'HTTPS://EXAMPLE.com/', { signal: signal() })).toEqual({ status: 'refused' });
    expect(await navigator(TAB, 'file:///etc/passwd', { signal: signal() })).toEqual({ status: 'refused' });
    expect(browser.navigate).not.toHaveBeenCalled();
    const hidden = setup({ active: 99 });
    expect(await hidden.navigator(TAB, 'https://example.com/a', { signal: signal() })).toEqual({ status: 'not-shown' });
    expect(hidden.browser.navigate).not.toHaveBeenCalled();
    // The controller refused to start it.
    const refused = setup({ navigate: false });
    expect(await refused.navigator(TAB, 'https://example.com/a', { signal: signal() })).toEqual({ status: 'refused' });
    expect(refused.contents.listening()).toBe(0);
  });

  test('navigator-settles', async () => {
    const { browser, contents, navigator } = setup();
    const pending = navigator(TAB, 'https://example.com/a', { signal: signal() });
    expect(browser.navigate).toHaveBeenCalledWith('https://example.com/a');
    // A stop before ours started is the previous load's.
    contents.stop();
    contents.start('https://example.com/a');
    contents.commit('https://example.com/a', 201, 'A page');
    contents.stop();
    expect(await pending).toEqual({ status: 'done', url: 'https://example.com/a', title: 'A page', httpStatus: 201, settled: true, blockedRedirectTo: null });
    expect(contents.listening()).toBe(0);

    vi.useFakeTimers();
    const slow = setup();
    let answer: TabNavigation | null = null;
    void slow.navigator(TAB, 'https://example.com/slow', { signal: signal() }).then((value) => (answer = value));
    slow.contents.start('https://example.com/slow');
    slow.contents.commit('https://example.com/slow');
    await vi.advanceTimersByTimeAsync(NAVIGATE_SETTLE_TIMEOUT_MS - 1);
    expect(answer).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toMatchObject({ status: 'done', settled: false, url: 'https://example.com/slow' });
    expect(slow.contents.listening()).toBe(0);
  });

  test('navigator-blocks-off-origin-redirect', async () => {
    const { contents, navigator } = setup();
    // Before ours starts, a redirect of the previous load is none of its business.
    const pending = navigator(TAB, 'https://example.com/go', { signal: signal(), allowedOrigin: 'https://example.com' });
    expect(contents.redirect('https://elsewhere.example/')).toBe(false);
    contents.start('https://example.com/go');
    // A subframe's redirect and a same-origin hop are allowed; an off-origin main-frame hop is not.
    expect(contents.redirect('https://ads.example/frame', false)).toBe(false);
    expect(contents.redirect('https://example.com/next')).toBe(false);
    expect(contents.redirect('https://evil.example/landing')).toBe(true);
    contents.stop();
    expect(await pending).toEqual({ status: 'done', url: 'https://example.com/start', title: 'Start', httpStatus: null, settled: true, blockedRedirectTo: 'https://evil.example' });
    // The watch ended with this navigation: a later one's redirect is not touched.
    expect(contents.listening()).toBe(0);
    expect(contents.redirect('https://evil.example/landing')).toBe(false);

    // Another main-frame navigation replacing ours ends the watch too.
    const second = setup();
    const replaced = second.navigator(TAB, 'https://example.com/go', { signal: signal(), allowedOrigin: 'https://example.com' });
    second.contents.start('https://example.com/go');
    second.contents.start('https://typed.example/');
    expect(second.contents.redirect('https://evil.example/')).toBe(false);
    expect(await replaced).toMatchObject({ status: 'done', blockedRedirectTo: null });
  });

  test('navigator-follows-redirect-approved', async () => {
    const { contents, navigator } = setup();
    const pending = navigator(TAB, 'https://example.com/go', { signal: signal() });
    contents.start('https://example.com/go');
    expect(contents.redirect('https://landing.example/')).toBe(false);
    contents.commit('https://landing.example/', 200, 'Landing');
    contents.stop();
    expect(await pending).toEqual({ status: 'done', url: 'https://landing.example/', title: 'Landing', httpStatus: 200, settled: true, blockedRedirectTo: null });
  });

  test('navigator-abort', async () => {
    const stop = new AbortController();
    const { contents, navigator } = setup();
    const pending = navigator(TAB, 'https://example.com/go', { signal: stop.signal, allowedOrigin: 'https://example.com' });
    contents.start('https://example.com/go');
    stop.abort();
    expect(await pending).toEqual({ status: 'aborted' });
    // The navigation is still in flight: its redirect watch stays until it ends.
    expect(contents.redirect('https://evil.example/')).toBe(true);
    contents.stop();
    expect(contents.listening()).toBe(0);
    // Aborted before anything: nothing navigates.
    const early = setup();
    expect(await early.navigator(TAB, 'https://example.com/a', { signal: stop.signal })).toEqual({ status: 'aborted' });
    expect(early.browser.navigate).not.toHaveBeenCalled();
  });

  test('navigator-empty-tab', async () => {
    // The tab has no page yet: the navigation creates its WebContents. Electron 45 fires the start
    // inside `loadURL` (before the watch can attach); a later start for `href` is ours too. Either
    // way the watch is armed.
    for (const order of ['start-inside-navigate', 'start-after'] as const) {
      const created = new FakeContents();
      let current: FakeContents | null = null;
      const browser = {
        getState: () => ({ activeTabId: TAB }),
        navigate: vi.fn((url: string) => {
          current = created;
          created.loading = true;
          if (order === 'start-inside-navigate') created.start(url);
          return true;
        }),
      };
      const navigator = createTabNavigator({ browser, contentsOf: () => current });
      const pending = navigator(TAB, 'https://example.com/a', { signal: signal(), allowedOrigin: 'https://example.com' });
      if (order === 'start-after') created.start('https://example.com/a');
      expect(created.redirect('https://evil.example/'), order).toBe(true);
      created.stop();
      expect(await pending, order).toMatchObject({ status: 'done', blockedRedirectTo: 'https://evil.example' });
      expect(created.listening(), order).toBe(0);
    }
  });

  test('navigator-old-page-in-page-moves', async () => {
    // While ours (cross-document) is pending, the old page's pushState is not ours: the watch stays.
    const { contents, navigator, browser } = setup();
    browser.navigate.mockImplementation(((url: string) => {
      contents.loading = true;
      contents.start(url);
      return true;
    }) as never);
    const pending = navigator(TAB, 'https://example.com/go', { signal: signal(), allowedOrigin: 'https://example.com' });
    contents.inPage('https://example.com/start#moved');
    contents.inPage('https://example.com/pushed');
    // The old page's own load activity stops while ours is still loading: not ours either.
    contents.emit('did-stop-loading', {});
    expect(contents.redirect('https://evil.example/')).toBe(true);
    contents.stop();
    expect(await pending).toMatchObject({ status: 'done', blockedRedirectTo: 'https://evil.example' });
  });

  test('navigator-fragment-only', async () => {
    // Only the fragment changes: a same-document navigation, settled at its in-page move (no timeout).
    vi.useFakeTimers();
    const { contents, navigator, browser } = setup();
    browser.navigate.mockImplementation(((url: string) => {
      contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: true });
      return true;
    }) as never);
    let answer: TabNavigation | null = null;
    void navigator(TAB, 'https://example.com/start#section', { signal: signal(), allowedOrigin: 'https://example.com' }).then((value) => (answer = value));
    contents.url = 'https://example.com/start#section';
    contents.emit('did-navigate-in-page', {}, contents.url, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toMatchObject({ status: 'done', settled: true, url: 'https://example.com/start#section' });
    expect(contents.listening()).toBe(0);
  });
});
