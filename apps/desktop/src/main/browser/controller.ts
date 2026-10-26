import type { BrowserWindow, WebContentsView } from 'electron';
import type { BrowserService } from '@app/ipc-contract';
import {
  APP_WINDOW_TITLE,
  MAX_PENDING_WATCHES,
  MAX_TABS,
  WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH,
  WINDOW_TITLE_SEPARATOR,
  type BrowserState,
  type LoadError,
  type Notice,
  type NoticeKind,
  type PageBounds,
  type TabState,
} from '@app/specs/browser.spec';
import { IGNORED_LOAD_ERROR_CODES } from '@app/specs/browse-guard.spec';
import { displayUrl, resolveAddressInput } from './address';
import { isWebUrl } from './guard';
import { pageTitle } from './page-title';
import { matchTabShortcut, type KeyInput, type TabShortcut } from './shortcuts';

// Main-process owner of all browser state (spec `browser-chrome.feature.md` and `tabs.feature.md`,
// Controller). Only Electron *types* are imported: the view factory and the window are injected, so
// this runs under Vitest with plain fakes.
//
// Only the active tab's view is ever attached to the window's `contentView`, and only while it shows
// a page: a tab whose last load failed or whose renderer crashed shows the chrome's error / crash
// panel instead (`browse-guard.feature.md`), so its view is detached. Other tabs' views stay alive
// (each keeps its own page and history) but detached. Tab commands need a window: without one
// (macOS, after the last window closed) they change nothing, and New Tab asks the app to open one.

/** A tab's page view (`createTabView()`); it is attached to the window's `contentView`. */
export type TabView = WebContentsView;
/** The parts of the app window the controller uses. */
export type HostWindow = Pick<BrowserWindow, 'contentView' | 'webContents' | 'getContentSize' | 'setTitle' | 'on' | 'once' | 'isDestroyed'>;

export interface BrowserController extends BrowserService {
  /**
   * Shows this controller's tabs in `win` (one window in Phase 1). The controller starts with one
   * empty tab; when the window closes its tabs' WebContents are closed and one empty tab remains.
   * Attaching the same window again is a no-op.
   */
  attach(win: HostWindow): void;
  /** How many `watch` calls are waiting (at most `MAX_PENDING_WATCHES`). */
  pendingWatches(): number;
  /** Closes the active tab (Cmd/Ctrl+W). */
  closeActiveTab(): boolean;
  /** Activates the tab at `index` in strip order (Cmd/Ctrl+1…8); `false` past the end. */
  activateTabAt(index: number): boolean;
  /** Activates the last tab (Cmd/Ctrl+9). */
  activateLastTab(): boolean;
  /** Activates the next tab, wrapping (Ctrl+Tab). */
  activateNextTab(): boolean;
  /** Activates the previous tab, wrapping (Ctrl+Shift+Tab). */
  activatePreviousTab(): boolean;
  /** Focuses the chrome and asks it to focus the address bar (Cmd/Ctrl+L): bumps `focusAddressBarSeq`. */
  focusAddressBar(): void;
  /**
   * A gesture-backed popup from the page in `opener` (spec `browse-guard.feature.md`): opens `url`
   * (`http(s)` only) in a new background tab right of the opener's tab, after the tabs it already
   * opened. Answers the new tab's id, or `null` (opener is no tab's WebContents, not a web URL, no
   * window, or `MAX_TABS`, which raises the `tab-limit` notice).
   */
  openTabFromPage(opener: unknown, url: string): number | null;
  /** Raises a status-bar notice (a new `seq`). */
  notify(kind: NoticeKind): void;
}

export interface BrowserControllerOptions {
  /** The allowlisted tab-view factory (`createTabView` in `window.ts`). */
  readonly createView: () => TabView;
  /** Whose shortcut modifier applies (Cmd on macOS, Ctrl elsewhere); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Opens (and attaches) the app window: New Tab with no window open calls it instead of adding a
   * tab nobody can see. Without it, New Tab with no window is a no-op.
   */
  readonly openWindow?: () => void;
}

interface Tab {
  readonly id: number;
  /**
   * Created on the first navigation; an empty tab has none (nothing to show or guard). Dropped
   * again when its WebContents is destroyed (the page called `window.close()`).
   */
  view: TabView | null;
  /** Removes this controller's listeners from `view`'s WebContents (a no-op without a view). */
  unlisten: () => void;
  /** The renderer died (`render-process-gone`); reported as not loading until the next load starts. */
  crashed: boolean;
  /** The last main-frame load failed (`did-fail-load`); cleared by the next main-frame commit. */
  error: LoadError | null;
  /** The tab whose page opened this one (popup placement), if any. */
  readonly openerId: number | null;
  state: TabState;
}

/**
 * WebContents events after which a tab's state is re-read (plus `did-start-loading`, `did-navigate`,
 * `did-fail-load` and `render-process-gone`, below).
 */
const STATE_EVENTS = ['did-stop-loading', 'did-navigate-in-page', 'page-title-updated'] as const;

function emptyTabState(id: number): TabState {
  return { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false };
}

function sameError(a: LoadError | null, b: LoadError | null): boolean {
  return a === b || (a !== null && b !== null && a.code === b.code && a.description === b.description && a.url === b.url);
}

function sameTabState(a: TabState, b: TabState): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.crashed === b.crashed &&
    sameError(a.error, b.error)
  );
}

/** Whether a tab's page view is shown: not while its error or crash panel is. */
function showsPage(tab: { error: LoadError | null; crashed: boolean }): boolean {
  return tab.error === null && !tab.crashed;
}

/** `title` cut to `WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH` characters, the last one an ellipsis. */
function capTitle(title: string): string {
  const chars = [...title];
  if (chars.length <= WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH) return title;
  return `${chars.slice(0, WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH - 1).join('')}…`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Rounds `bounds` to integers and clamps them inside a `width`×`height` content area. */
export function clampPageBounds(bounds: PageBounds, [width, height]: readonly [number, number]): PageBounds {
  const x = clamp(Math.round(bounds.x), 0, width);
  const y = clamp(Math.round(bounds.y), 0, height);
  return {
    x,
    y,
    width: clamp(Math.round(bounds.width), 0, width - x),
    height: clamp(Math.round(bounds.height), 0, height - y),
  };
}

function noop(): void {}

/**
 * `view`'s WebContents while it is alive, else `undefined`. Electron clears `view.webContents` once
 * the contents are destroyed (already inside their `destroyed` listeners), so never read it bare.
 */
function aliveContents(view: TabView): TabView['webContents'] | undefined {
  const contents = view.webContents as TabView['webContents'] | undefined;
  return contents && !contents.isDestroyed() ? contents : undefined;
}

export function createBrowserController(options: BrowserControllerOptions): BrowserController {
  let nextTabId = 1;
  let version = 1;
  let win: HostWindow | null = null;
  let tabs: Tab[] = [];
  let activeTabId: number | null = null;
  let pageBounds: PageBounds | null = null;
  /** The one view attached to the window: the active tab's, or none. */
  let attached: TabView | null = null;
  let focusAddressBarSeq = 0;
  let notice: Notice | null = null;
  /** Pending watches, oldest first: their wake-up check → their early finish. */
  const waiters = new Map<() => void, () => void>();

  const snapshot = (): BrowserState => ({
    version,
    tabs: tabs.map((tab) => ({ ...tab.state })),
    activeTabId,
    focusAddressBarSeq,
    notice: notice && { ...notice },
  });

  const activeTab = (): Tab | undefined => tabs.find((tab) => tab.id === activeTabId);
  const hasWindow = (): boolean => win !== null && !win.isDestroyed();
  const platform = options.platform ?? process.platform;

  const updateWindowTitle = (): void => {
    if (!win || win.isDestroyed()) return;
    const tab = activeTab();
    const title = tab && tab.state.url !== '' ? tab.state.title || tab.state.url : '';
    win.setTitle(title === '' ? APP_WINDOW_TITLE : `${capTitle(title)}${WINDOW_TITLE_SEPARATOR}${APP_WINDOW_TITLE}`);
  };

  const changed = (): void => {
    version += 1;
    updateWindowTitle();
    for (const wake of [...waiters.keys()]) wake();
  };

  /** A new empty tab, not yet in the strip. */
  const createTab = (openerId: number | null = null): Tab => {
    const id = nextTabId++;
    return { id, view: null, unlisten: noop, crashed: false, error: null, openerId, state: emptyTabState(id) };
  };

  /** Appends an empty tab and makes it active (the caller syncs the window and bumps the version). */
  const openEmptyTab = (): number => {
    const tab = createTab();
    tabs.push(tab);
    activeTabId = tab.id;
    return tab.id;
  };

  const raiseNotice = (kind: NoticeKind): void => {
    notice = { seq: (notice?.seq ?? 0) + 1, kind };
    changed();
  };

  const detach = (view: TabView): void => {
    if (attached === view) attached = null;
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(view);
    } catch {
      // Already detached by Electron.
    }
  };

  /**
   * Unhooks and forgets `tab`'s view: its listeners are removed (a closed tab's late events can't
   * reach the controller) and it is detached from the window. Answers the view, if there was one.
   */
  const releaseView = (tab: Tab): TabView | null => {
    const view = tab.view;
    tab.unlisten();
    tab.unlisten = noop;
    tab.view = null;
    tab.crashed = false;
    tab.error = null;
    if (view) detach(view);
    return view;
  };

  /** Closes `tab`'s page for good: released, and its WebContents closed (no leak). */
  const closeView = (tab: Tab): void => {
    const view = releaseView(tab);
    if (view) aliveContents(view)?.close();
  };

  /** Forgets `tab`'s view (its WebContents is gone): off the window, and the tab is empty again. */
  const dropView = (tab: Tab): void => {
    if (!releaseView(tab)) return;
    tab.state = emptyTabState(tab.id);
    changed();
  };

  /** `tab`'s view if its WebContents is still alive; a destroyed one is dropped, never used. */
  const liveView = (tab: Tab): TabView | null => {
    if (tab.view && !aliveContents(tab.view)) dropView(tab);
    return tab.view;
  };

  const applyBounds = (tab: Tab): void => {
    if (!tab.view || !win || pageBounds === null) return;
    const [width = 0, height = 0] = win.getContentSize();
    tab.view.setBounds(clampPageBounds(pageBounds, [width, height]));
  };

  /** Makes the window show exactly the active tab's view (none for an empty tab, or behind a panel). */
  const syncAttached = (): void => {
    const tab = activeTab();
    const live = tab ? liveView(tab) : null;
    const want = tab && showsPage(tab) ? live : null;
    if (attached === want) return;
    if (attached) detach(attached);
    if (!want || !tab || !win || win.isDestroyed()) return;
    win.contentView.addChildView(want);
    attached = want;
    applyBounds(tab);
    want.setVisible(true);
  };

  /** Asks the chrome to focus its address bar (it watches `focusAddressBarSeq`). */
  const requestAddressFocus = (): void => {
    focusAddressBarSeq += 1;
    if (win && !win.isDestroyed()) win.webContents.focus();
  };

  /**
   * After a switch: focus the active tab's page, the chrome for a tab showing a panel (its buttons
   * are there), or the address bar for an empty tab.
   */
  const focusActive = (): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    if (!view) requestAddressFocus();
    else if (tab && showsPage(tab)) view.webContents.focus();
    else if (win && !win.isDestroyed()) win.webContents.focus();
  };

  /** Re-reads `tab`'s state from its WebContents; bumps the version only on a real change. */
  const refresh = (tab: Tab): void => {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const url = contents.getURL();
    const next: TabState = {
      id: tab.id,
      url: displayUrl(url),
      title: pageTitle(contents.getTitle(), url),
      loading: !tab.crashed && contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: tab.error && { ...tab.error },
      crashed: tab.crashed,
    };
    if (sameTabState(tab.state, next)) return;
    tab.state = next;
    // A panel appeared or went away: the view is attached only while it shows a page.
    syncAttached();
    changed();
  };

  const ensureView = (tab: Tab): TabView | null => {
    const live = liveView(tab);
    if (live) return live;
    if (!win || win.isDestroyed()) return null;
    const view = options.createView();
    tab.view = view;
    // Events count only while `view` is still this open tab's: a closed tab's (or a dropped view's)
    // pending or late events are ignored, and its listeners are removed on release as well.
    const owns = (): boolean => tab.view === view && tabs.includes(tab);
    const emitter = view.webContents as unknown as NodeJS.EventEmitter;
    const listeners: [string, (...args: unknown[]) => void][] = [];
    const listen = <A extends unknown[]>(event: string, listener: (...args: A) => void): void => {
      const guarded = (...args: A): void => {
        if (owns()) listener(...args);
      };
      emitter.on(event, guarded);
      listeners.push([event, guarded as (...args: unknown[]) => void]);
    };
    for (const event of STATE_EVENTS) listen(event, () => refresh(tab));
    listen('did-start-loading', () => {
      tab.crashed = false;
      refresh(tab);
    });
    // A main-frame page committed (Electron emits `did-navigate` only for non-error pages).
    listen('did-navigate', () => {
      tab.error = null;
      refresh(tab);
    });
    // Main-frame load failures show the error panel; `ERR_ABORTED` (a dropped navigation, a stop,
    // a download) and subframe failures do not.
    listen('did-fail-load', (_event: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (isMainFrame && Number.isInteger(code) && code < 0 && !(IGNORED_LOAD_ERROR_CODES as readonly number[]).includes(code)) {
        tab.error = { code, description: String(description), url: displayUrl(String(validatedUrl)) };
      }
      refresh(tab);
    });
    listen('render-process-gone', () => {
      tab.crashed = true;
      refresh(tab);
    });
    listen('unresponsive', () => raiseNotice('page-unresponsive'));
    // The page closed itself (`window.close()`): its tab closes like any other.
    listen('destroyed', () => removeTab(tab.id));
    // Reserved tab shortcuts are taken before the page can see (and cancel) them.
    listen('before-input-event', takeShortcut);
    tab.unlisten = () => {
      for (const [event, listener] of listeners) emitter.off(event, listener);
    };
    // Sized now, so a background tab (a popup) lays its page out at the page area's size.
    applyBounds(tab);
    syncAttached();
    return view;
  };

  /** Runs `act` on the active tab's live WebContents, if it has one. */
  const withActiveContents = (act: (contents: TabView['webContents']) => void): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    if (view) act(view.webContents);
  };

  openEmptyTab();

  const closeAll = (): void => {
    // Each view is released before its WebContents closes, so its `destroyed` event finds nothing.
    for (const tab of tabs) closeView(tab);
    tabs = [];
    activeTabId = null;
    attached = null;
  };

  const activateTab = (tabId: number): boolean => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || !hasWindow()) return false;
    if (tab.id === activeTabId) return true;
    activeTabId = tab.id;
    syncAttached();
    focusActive();
    changed();
    return true;
  };

  /** Closes the tab (no window check: also for a page that closed itself). */
  function removeTab(tabId: number): boolean {
    const index = tabs.findIndex((t) => t.id === tabId);
    const tab = tabs[index];
    if (!tab) return false;
    closeView(tab);
    tabs.splice(index, 1);
    if (tabs.length === 0) {
      // The window never goes tab-less: a fresh empty tab takes the last one's place.
      openEmptyTab();
      requestAddressFocus();
    } else if (tab.id === activeTabId) {
      // The right neighbour (now at `index`), else the left one.
      const next = tabs[index] ?? tabs[index - 1];
      activeTabId = next ? next.id : null;
      syncAttached();
      focusActive();
    }
    changed();
    return true;
  }

  const closeTab = (tabId: number): boolean => hasWindow() && removeTab(tabId);

  const newTab = (): number | null => {
    if (!hasWindow()) {
      // Never a hidden tab: open the window (which starts with one empty tab) instead.
      options.openWindow?.();
      return hasWindow() ? activeTabId : null;
    }
    if (tabs.length >= MAX_TABS) {
      raiseNotice('tab-limit');
      return null;
    }
    const id = openEmptyTab();
    syncAttached();
    requestAddressFocus();
    changed();
    return id;
  };

  const activateTabAt = (index: number): boolean => {
    const tab = Number.isInteger(index) ? tabs[index] : undefined;
    return tab ? activateTab(tab.id) : false;
  };

  /** Activates the tab `step` places from the active one, wrapping; a no-op with one tab. */
  const cycle = (step: 1 | -1): boolean => {
    const index = tabs.findIndex((t) => t.id === activeTabId);
    if (index < 0 || tabs.length < 2) return false;
    return activateTabAt((index + step + tabs.length) % tabs.length);
  };

  const openTabFromPage = (opener: unknown, url: string): number | null => {
    if (!hasWindow() || !isWebUrl(url)) return null;
    const index = tabs.findIndex((tab) => tab.view !== null && aliveContents(tab.view) === opener);
    const openerTab = tabs[index];
    if (!openerTab) return null;
    if (tabs.length >= MAX_TABS) {
      raiseNotice('tab-limit');
      return null;
    }
    // Right of the opener, after the run of tabs it already opened.
    let at = index + 1;
    while (tabs[at]?.openerId === openerTab.id) at += 1;
    const tab = createTab(openerTab.id);
    tabs.splice(at, 0, tab);
    const view = ensureView(tab);
    // No opener link, referrer or POST body: the new tab loads the URL on its own.
    view?.webContents.loadURL(url).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
    changed();
    return tab.id;
  };

  /**
   * Reloads the active tab. A crashed (or errored) tab reloads its WebContents, which restarts the
   * renderer; if that WebContents is gone, a fresh view loads the tab's URL instead.
   */
  const reload = (): void => {
    const tab = activeTab();
    if (!tab) return;
    const url = tab.state.url;
    const view = liveView(tab);
    if (view) {
      view.webContents.reload();
      return;
    }
    if (!isWebUrl(url)) return;
    ensureView(tab)?.webContents.loadURL(url).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
  };

  const focusAddressBar = (): void => {
    if (!hasWindow()) return;
    requestAddressFocus();
    changed();
  };

  const runShortcut = (shortcut: TabShortcut): void => {
    switch (shortcut.command) {
      case 'new-tab':
        newTab();
        return;
      case 'close-tab':
        if (activeTabId !== null) closeTab(activeTabId);
        return;
      case 'focus-address-bar':
        focusAddressBar();
        return;
      case 'select-tab':
        activateTabAt(shortcut.index);
        return;
      case 'select-last-tab':
        activateTabAt(tabs.length - 1);
        return;
      case 'next-tab':
        cycle(1);
        return;
      case 'previous-tab':
        cycle(-1);
    }
  };

  /**
   * `before-input-event` of a tab's or the chrome's WebContents: a reserved shortcut is consumed
   * (`preventDefault` keeps it from the page and from the menu accelerator, so it runs once) and
   * run on key-down; every other key passes through.
   */
  function takeShortcut(event: { preventDefault(): void }, input: KeyInput): void {
    const shortcut = matchTabShortcut(input, platform);
    if (!shortcut) return;
    event.preventDefault();
    if (input.type === 'keyDown') runShortcut(shortcut);
  }

  return {
    attach(target) {
      if (win === target) return;
      if (win !== null) {
        // Another window took over (Phase 1 shows one window): start it on a fresh empty tab.
        closeAll();
        openEmptyTab();
        changed();
      }
      win = target;
      target.webContents.on('before-input-event', takeShortcut);
      // The chrome page's own <title> must not replace `<page title> — frost`.
      target.on('page-title-updated', (event) => event.preventDefault());
      target.once('closed', () => {
        if (win !== target) return;
        closeAll();
        win = null;
        pageBounds = null;
        attached = null;
        openEmptyTab();
        changed();
      });
      updateWindowTitle();
    },

    navigate(input) {
      const resolved = resolveAddressInput(input);
      const tab = activeTab();
      if (resolved === null || !tab) return false;
      const view = ensureView(tab);
      if (!view) return false;
      view.webContents.loadURL(resolved.url).catch(() => {
        // Superseded or failed loads surface through `did-fail-load` / the tab state.
      });
      view.webContents.focus();
      return true;
    },

    newTab,

    closeTab,

    activateTab,

    closeActiveTab: () => activeTabId !== null && closeTab(activeTabId),

    activateTabAt,

    activateLastTab: () => activateTabAt(tabs.length - 1),

    activateNextTab: () => cycle(1),

    activatePreviousTab: () => cycle(-1),

    focusAddressBar,

    openTabFromPage,

    notify: raiseNotice,

    back() {
      withActiveContents((contents) => {
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      });
    },

    forward() {
      withActiveContents((contents) => {
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      });
    },

    reload,

    stop() {
      withActiveContents((contents) => contents.stop());
    },

    setPageBounds(bounds) {
      pageBounds = { ...bounds };
      const tab = activeTab();
      if (tab) applyBounds(tab);
    },

    getState: snapshot,

    watch(sinceVersion, signal) {
      // A version from the future is clamped: wait for the next change, not forever.
      const since = Math.min(sinceVersion, version);
      return new Promise((resolve) => {
        if (version > since || signal?.aborted) {
          resolve(snapshot());
          return;
        }
        const finish = (): void => {
          waiters.delete(wake);
          signal?.removeEventListener('abort', finish);
          resolve(snapshot());
        };
        const wake = (): void => {
          if (version > since) finish();
        };
        // At the cap the oldest waiter is answered early with the current state.
        while (waiters.size >= MAX_PENDING_WATCHES) {
          const oldest = waiters.values().next().value;
          if (!oldest) break;
          oldest();
        }
        waiters.set(wake, finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    },

    pendingWatches: () => waiters.size,
  };
}
