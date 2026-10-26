import type { BrowserWindow, WebContentsView } from 'electron';
import type { BrowserService } from '@app/ipc-contract';
import {
  APP_WINDOW_TITLE,
  MAX_PENDING_WATCHES,
  WINDOW_TITLE_MAX_PAGE_TITLE_LENGTH,
  WINDOW_TITLE_SEPARATOR,
  type BrowserState,
  type PageBounds,
  type TabState,
} from '@app/specs/browser.spec';
import { displayUrl, resolveAddressInput } from './address';

// Main-process owner of all browser state (spec `browser-chrome.feature.md`, Controller). Only
// Electron *types* are imported: the view factory and the window are injected, so this runs under
// Vitest with plain fakes.

/** A tab's page view (`createTabView()`); it is attached to the window's `contentView`. */
export type TabView = WebContentsView;
/** The parts of the app window the controller uses. */
export type HostWindow = Pick<BrowserWindow, 'contentView' | 'getContentSize' | 'setTitle' | 'on' | 'once' | 'isDestroyed'>;

export interface BrowserController extends BrowserService {
  /**
   * Shows this controller's tabs in `win` (one window in Phase 1). The controller starts with one
   * empty tab; when the window closes its tabs' WebContents are closed and one empty tab remains.
   * Attaching the same window again is a no-op.
   */
  attach(win: HostWindow): void;
  /** How many `watch` calls are waiting (at most `MAX_PENDING_WATCHES`). */
  pendingWatches(): number;
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

export function createBrowserController(options: BrowserControllerOptions): BrowserController {
  let nextTabId = 1;
  let version = 1;
  let win: HostWindow | null = null;
  let tabs: Tab[] = [];
  let activeTabId: number | null = null;
  let pageBounds: PageBounds | null = null;
  /** Pending watches, oldest first: their wake-up check → their early finish. */
  const waiters = new Map<() => void, () => void>();

  const snapshot = (): BrowserState => ({
    version,
    tabs: tabs.map((tab) => ({ ...tab.state })),
    activeTabId,
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

  const openEmptyTab = (): void => {
    const id = nextTabId++;
    tabs.push({ id, view: null, crashed: false, state: emptyTabState(id) });
    activeTabId = id;
  };

  /** Forgets `tab`'s view (its WebContents is gone): off the window, and the tab is empty again. */
  const dropView = (tab: Tab): void => {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    tab.crashed = false;
    tab.state = emptyTabState(tab.id);
    if (win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // Already detached by Electron.
      }
    }
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

  /** Re-reads `tab`'s state from its WebContents; bumps the version only on a real change. */
  const refresh = (tab: Tab): void => {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const next: TabState = {
      id: tab.id,
      url: displayUrl(contents.getURL()),
      title: contents.getTitle(),
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
    const contents = view.webContents;
    for (const event of STATE_EVENTS) contents.on(event as 'did-stop-loading', () => refresh(tab));
    contents.on('did-start-loading', () => {
      tab.crashed = false;
      refresh(tab);
    });
    contents.on('render-process-gone', () => {
      tab.crashed = true;
      refresh(tab);
    });
    contents.once('destroyed', () => {
      if (tab.view === view && tabs.includes(tab)) dropView(tab);
    });
    win.contentView.addChildView(view);
    applyBounds(tab);
    view.setVisible(tab.id === activeTabId);
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
    for (const tab of tabs) {
      const contents = tab.view?.webContents;
      // Forget the view first, so its `destroyed` event finds nothing to reset.
      tab.view = null;
      if (contents && !contents.isDestroyed()) contents.close();
    }
    tabs = [];
    activeTabId = null;
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
      view.setVisible(true);
      view.webContents.loadURL(resolved.url).catch(() => {
        // Superseded or failed loads surface through `did-fail-load` / the tab state.
      });
      view.webContents.focus();
      return true;
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
