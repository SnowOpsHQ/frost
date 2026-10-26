import type { BrowserWindow, WebContentsView } from 'electron';
import type { BrowserService } from '@app/ipc-contract';
import {
  APP_WINDOW_TITLE,
  MAX_PENDING_WATCHES,
  MAX_TABS,
  WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH,
  WINDOW_TITLE_SEPARATOR,
  type BrowserState,
  type Notice,
  type PageBounds,
  type TabState,
} from '@app/specs/browser.spec';
import { displayUrl, resolveAddressInput } from './address';
import { pageTitle } from './page-title';

// Main-process owner of all browser state (spec `browser-chrome.feature.md` and `tabs.feature.md`,
// Controller). Only Electron *types* are imported: the view factory and the window are injected, so
// this runs under Vitest with plain fakes.
//
// Only the active tab's view is ever attached to the window's `contentView`; other tabs' views stay
// alive (each keeps its own page and history) but detached.

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
  /** Focuses the chrome and asks it to focus the address bar (Cmd/Ctrl+L): bumps `focusAddressBarSeq`. */
  focusAddressBar(): void;
}

export interface BrowserControllerOptions {
  /** The allowlisted tab-view factory (`createTabView` in `window.ts`). */
  readonly createView: () => TabView;
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
  state: TabState;
}

/** WebContents events after which a tab's state is re-read (plus `did-start-loading` and `render-process-gone`, below). */
const STATE_EVENTS = ['did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'did-fail-load', 'page-title-updated'] as const;

function emptyTabState(id: number): TabState {
  return { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
}

function sameTabState(a: TabState, b: TabState): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward
  );
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

  /** Appends an empty tab and makes it active (the caller syncs the window and bumps the version). */
  const openEmptyTab = (): number => {
    const id = nextTabId++;
    tabs.push({ id, view: null, unlisten: noop, crashed: false, state: emptyTabState(id) });
    activeTabId = id;
    return id;
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
    if (view) detach(view);
    return view;
  };

  /** Closes `tab`'s page for good: released, and its WebContents closed (no leak). */
  const closeView = (tab: Tab): void => {
    const view = releaseView(tab);
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  };

  /** Forgets `tab`'s view (its WebContents is gone): off the window, and the tab is empty again. */
  const dropView = (tab: Tab): void => {
    if (!releaseView(tab)) return;
    tab.state = emptyTabState(tab.id);
    changed();
  };

  /** `tab`'s view if its WebContents is still alive; a destroyed one is dropped, never used. */
  const liveView = (tab: Tab): TabView | null => {
    if (tab.view && tab.view.webContents.isDestroyed()) dropView(tab);
    return tab.view;
  };

  const applyBounds = (tab: Tab): void => {
    if (!tab.view || !win || pageBounds === null) return;
    const [width = 0, height = 0] = win.getContentSize();
    tab.view.setBounds(clampPageBounds(pageBounds, [width, height]));
  };

  /** Makes the window show exactly the active tab's view (none for an empty tab). */
  const syncAttached = (): void => {
    const tab = activeTab();
    const want = tab ? liveView(tab) : null;
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

  /** After a switch: focus the active tab's page, or the address bar for an empty tab. */
  const focusActive = (): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    if (view) view.webContents.focus();
    else requestAddressFocus();
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
    };
    if (sameTabState(tab.state, next)) return;
    tab.state = next;
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
    const listeners: [string, () => void][] = [];
    const listen = (event: string, listener: () => void): void => {
      const guarded = (): void => {
        if (owns()) listener();
      };
      emitter.on(event, guarded);
      listeners.push([event, guarded]);
    };
    for (const event of STATE_EVENTS) listen(event, () => refresh(tab));
    listen('did-start-loading', () => {
      tab.crashed = false;
      refresh(tab);
    });
    listen('render-process-gone', () => {
      tab.crashed = true;
      refresh(tab);
    });
    listen('destroyed', () => dropView(tab));
    tab.unlisten = () => {
      for (const [event, listener] of listeners) emitter.off(event, listener);
    };
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
    if (!tab) return false;
    if (tab.id === activeTabId) return true;
    activeTabId = tab.id;
    syncAttached();
    focusActive();
    changed();
    return true;
  };

  const closeTab = (tabId: number): boolean => {
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
  };

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

    newTab() {
      if (tabs.length >= MAX_TABS) {
        notice = { seq: (notice?.seq ?? 0) + 1, kind: 'tab-limit' };
        changed();
        return null;
      }
      const id = openEmptyTab();
      syncAttached();
      requestAddressFocus();
      changed();
      return id;
    },

    closeTab,

    activateTab,

    closeActiveTab: () => activeTabId !== null && closeTab(activeTabId),

    activateTabAt(index) {
      const tab = Number.isInteger(index) ? tabs[index] : undefined;
      return tab ? activateTab(tab.id) : false;
    },

    activateLastTab() {
      const tab = tabs.at(-1);
      return tab ? activateTab(tab.id) : false;
    },

    focusAddressBar() {
      requestAddressFocus();
      changed();
    },

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

    reload() {
      withActiveContents((contents) => contents.reload());
    },

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
