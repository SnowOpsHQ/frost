import type { BrowserWindow, WebContentsView } from 'electron';
import type { SavedSession } from '@app/db';
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
import { FULLSCREEN_BANNER_HEIGHT, FULLSCREEN_EXIT_KEY, FULLSCREEN_NOTICE_MS, type PermissionDecision } from '@app/specs/permissions.spec';
import { displayUrl, resolveAddressInput } from './address';
import { isWebUrl } from './guard';
import { pageTitle } from './page-title';
import type { PermissionBroker } from './permissions';
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
//
// Session (spec `browser-session-db.feature.md`): the tab strip saved at the last launch replaces
// the initial empty tab before the first window is attached; only the active restored tab loads
// at once, the others when first activated. While a window is attached, every change of the strip
// (each tab's URL and title, the active tab) is handed to the session sink, and committed pages
// are recorded as visits.

/** A tab's page view (`createTabView()`); it is attached to the window's `contentView`. */
export type TabView = WebContentsView;
/** The parts of the app window the controller uses. */
export type HostWindow = Pick<
  BrowserWindow,
  'contentView' | 'webContents' | 'getContentSize' | 'setTitle' | 'on' | 'once' | 'isDestroyed' | 'isFullScreen' | 'setFullScreen'
>;

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
  /**
   * The id of the open tab whose (live) page view's WebContents is `contents`, else `null`: the
   * permission handlers attribute a request to its tab with it (`permissions.feature.md`).
   */
  tabIdOf(contents: unknown): number | null;
  /** Whether the tab is in HTML fullscreen (its new permission requests are denied). */
  isFullscreen(tabId: number): boolean;
  /**
   * A download from `contents` was cancelled (spec `browse-guard.feature.md`): raises the
   * `download-blocked` notice, and closes the tab of `contents` if it is a popup tab that has
   * committed nothing (a `target=_blank` link to a file would otherwise leave an empty tab).
   */
  downloadBlocked(contents: unknown): void;
  /**
   * Replaces the initial empty tab with the saved strip (`browser-session-db.feature.md`,
   * Restore): non-`http(s)` URLs are skipped, at most `MAX_TABS` tabs, none left → one empty tab.
   * Only before the first window is attached; a no-op afterwards.
   */
  restoreSession(saved: SavedSession): void;
}

/** Where the controller hands what the session database keeps (`browser-session-db.feature.md`). */
export interface SessionSink {
  /** The tab strip changed (only while a window is attached). */
  saveSession(session: SavedSession): void;
  /** A main-frame `http(s)` page committed at `url`. */
  recordVisit(url: string): void;
  /** The page at `url` (no error page) reported `title`. */
  updateVisitTitle(url: string, title: string): void;
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
  /**
   * The permission broker whose prompts the tabs show (`permissions.feature.md`). The controller
   * reports each tab's head prompt in its state, answers only the active tab's, and denies a tab's
   * pending prompts when its document goes (close, destroyed, cross-document commit, failed load,
   * crash). Without it no tab ever has a prompt.
   */
  readonly permissions?: TabPermissions;
  /** Receives the tab strip and visits to persist; without it nothing is saved. */
  readonly session?: SessionSink;
}

/** What the controller uses of the permission broker. */
export type TabPermissions = Pick<PermissionBroker, 'promptFor' | 'answer' | 'denyTab' | 'subscribe'>;

/** A tab's own state; its `permissionPrompt` comes from the broker when the state is read. */
type PageState = Omit<TabState, 'permissionPrompt'>;
type FullscreenMode = NonNullable<TabState['fullscreen']>;

/**
 * The isolated world main leaves HTML fullscreen from (`document.exitFullscreen()`): the page's own
 * scripts cannot replace the DOM methods seen there.
 */
const FULLSCREEN_EXIT_WORLD_ID = 1_001;
const EXIT_FULLSCREEN_SCRIPT = 'document.exitFullscreen().catch(() => undefined)';

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
  /** The page stopped responding (`unresponsive`) and has not responded since. */
  unresponsive: boolean;
  /**
   * HTML fullscreen (`enter-html-full-screen`): `notice` while the chrome's fullscreen banner shows
   * above the view, then `full` (the view covers the whole window); `null` when not fullscreen.
   */
  fullscreen: FullscreenMode | null;
  /** Ends the `notice` phase. */
  fullscreenTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tab whose page opened this one (popup placement), if any. */
  readonly openerId: number | null;
  /**
   * A restored tab's saved URL and title: loaded when the tab is first shown, and reported as its
   * state until its view commits something (a load in flight has no URL yet).
   */
  restored: { readonly url: string; readonly title: string } | null;
  state: PageState;
}

/**
 * WebContents events after which a tab's state is re-read (plus `did-start-loading`, `did-navigate`,
 * `did-fail-load` and `render-process-gone`, below).
 */
const STATE_EVENTS = ['did-stop-loading', 'did-navigate-in-page', 'page-title-updated'] as const;

function emptyTabState(id: number): PageState {
  return { id, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, fullscreen: null };
}

function sameError(a: LoadError | null, b: LoadError | null): boolean {
  return a === b || (a !== null && b !== null && a.code === b.code && a.description === b.description && a.url === b.url);
}

function sameTabState(a: PageState, b: PageState): boolean {
  return (
    a.url === b.url &&
    a.title === b.title &&
    a.loading === b.loading &&
    a.canGoBack === b.canGoBack &&
    a.canGoForward === b.canGoForward &&
    a.crashed === b.crashed &&
    a.unresponsive === b.unresponsive &&
    a.fullscreen === b.fullscreen &&
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
  const permissions = options.permissions;
  const session = options.session;
  /** A window was attached once: the restore point has passed. */
  let everAttached = false;
  /** The window is closing: its final strip is saved, and nothing after it until the next attach. */
  let sessionPaused = false;
  /** The strip last handed to `session` (serialized), to save only real changes. */
  let lastSavedSession = '';

  const snapshot = (): BrowserState => ({
    version,
    tabs: tabs.map((tab) => ({ ...tab.state, error: tab.state.error && { ...tab.state.error }, permissionPrompt: permissions?.promptFor(tab.id) ?? null })),
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

  /** The strip as saved: each tab's URL and title, in order, and the active tab's index. */
  const sessionSnapshot = (): SavedSession => ({
    tabs: tabs.map((tab) => ({ url: tab.state.url, title: tab.state.title })),
    activeIndex: Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId)),
  });

  /**
   * Hands the strip to the session sink if it changed since the last save (or since the window
   * was attached), while a window shows it.
   */
  const saveSession = (): void => {
    if (!session || sessionPaused || !hasWindow()) return;
    const snapshot = sessionSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSavedSession) return;
    lastSavedSession = serialized;
    session.saveSession(snapshot);
  };

  const changed = (): void => {
    version += 1;
    updateWindowTitle();
    saveSession();
    for (const wake of [...waiters.keys()]) wake();
  };

  /** A new empty tab, not yet in the strip. */
  const createTab = (openerId: number | null = null): Tab => {
    const id = nextTabId++;
    return {
      id,
      view: null,
      unlisten: noop,
      crashed: false,
      error: null,
      unresponsive: false,
      fullscreen: null,
      fullscreenTimer: undefined,
      openerId,
      restored: null,
      state: emptyTabState(id),
    };
  };

  /** Appends an empty tab and makes it active (the caller syncs the window and bumps the version). */
  const openEmptyTab = (): number => {
    const tab = createTab();
    tabs.push(tab);
    activeTabId = tab.id;
    return tab.id;
  };

  // A prompt appeared, was answered or timed out. Denials the controller itself causes are muted:
  // the operation that caused them reports its own change once it is complete.
  let muted = false;
  permissions?.subscribe(() => {
    if (!muted) changed();
  });

  /** Denies `tab`'s pending prompts (its document is going); answers whether it had any. */
  const denyPrompts = (tab: Tab): boolean => {
    if (!permissions || permissions.promptFor(tab.id) === null) return false;
    muted = true;
    try {
      permissions.denyTab(tab.id);
    } finally {
      muted = false;
    }
    return true;
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
    tab.restored = null;
    tab.crashed = false;
    tab.error = null;
    tab.unresponsive = false;
    // Its WebContents is going: nothing will leave HTML fullscreen, so the window leaves OS fullscreen.
    if (clearFullscreen(tab)) leaveWindowFullscreen();
    denyPrompts(tab);
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

  /**
   * Lays `tab`'s view over the page area; in HTML fullscreen over the whole content area, below
   * the chrome's notice banner while it shows (`FULLSCREEN_BANNER_HEIGHT`).
   */
  const applyBounds = (tab: Tab): void => {
    if (!tab.view || !win) return;
    const [width = 0, height = 0] = win.getContentSize();
    if (tab.fullscreen) {
      const top = tab.fullscreen === 'notice' ? Math.min(FULLSCREEN_BANNER_HEIGHT, height) : 0;
      tab.view.setBounds({ x: 0, y: top, width, height: height - top });
    } else if (pageBounds !== null) {
      tab.view.setBounds(clampPageBounds(pageBounds, [width, height]));
    }
  };

  /** Reports a change of `tab.fullscreen` in its state. */
  const reportFullscreen = (tab: Tab): void => {
    if (tab.state.fullscreen === tab.fullscreen) return;
    tab.state = { ...tab.state, fullscreen: tab.fullscreen };
    changed();
  };

  /** Forgets `tab`'s HTML fullscreen (no bounds or state update); answers whether it had one. */
  function clearFullscreen(tab: Tab): boolean {
    clearTimeout(tab.fullscreenTimer);
    tab.fullscreenTimer = undefined;
    const was = tab.fullscreen !== null;
    tab.fullscreen = null;
    return was;
  }

  /** Takes the window out of OS fullscreen (which Electron entered for a page). */
  function leaveWindowFullscreen(): void {
    if (win && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false);
  }

  /** `tab` entered (`notice` first, then `full`) or left HTML fullscreen. */
  const setFullscreen = (tab: Tab, mode: FullscreenMode | null): void => {
    clearFullscreen(tab);
    tab.fullscreen = mode;
    if (mode === 'notice') {
      tab.fullscreenTimer = setTimeout(() => {
        if (tab.fullscreen === 'notice' && tabs.includes(tab)) setFullscreen(tab, 'full');
      }, FULLSCREEN_NOTICE_MS);
    }
    applyBounds(tab);
    reportFullscreen(tab);
  };

  /** Asks `tab`'s page to leave HTML fullscreen, from an isolated world the page cannot tamper with. */
  const exitHtmlFullscreen = (tab: Tab): void => {
    const contents = tab.view ? aliveContents(tab.view) : undefined;
    contents?.executeJavaScriptInIsolatedWorld(FULLSCREEN_EXIT_WORLD_ID, [{ code: EXIT_FULLSCREEN_SCRIPT }]).catch(() => {
      // The page is gone or navigating; nothing is fullscreen any more.
    });
  };

  /** `tab` stops being shown while fullscreen: its page leaves fullscreen, and the window too. */
  const leaveFullscreen = (tab: Tab): void => {
    if (tab.fullscreen === null) return;
    exitHtmlFullscreen(tab);
    clearFullscreen(tab);
    leaveWindowFullscreen();
    applyBounds(tab);
    reportFullscreen(tab);
  };

  /** Loads a restored tab's saved URL the first time it is shown. */
  const loadRestored = (tab: Tab): void => {
    if (!tab.restored || tab.view || !hasWindow()) return;
    const { url } = tab.restored;
    ensureView(tab)?.webContents.loadURL(url).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
  };

  /** Makes the window show exactly the active tab's view (none for an empty tab, or behind a panel). */
  const syncAttached = (): void => {
    const tab = activeTab();
    if (tab) loadRestored(tab);
    const live = tab ? liveView(tab) : null;
    const want = tab && showsPage(tab) ? live : null;
    if (attached === want) return;
    const hidden = attached ? tabs.find((t) => t.view === attached) : undefined;
    if (attached) detach(attached);
    // A fullscreen page that is no longer shown leaves fullscreen.
    if (hidden) leaveFullscreen(hidden);
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
    // A restored tab's first load has no URL until it commits: it keeps showing what was saved.
    const shown = url === '' ? tab.restored : null;
    const next: PageState = {
      id: tab.id,
      url: shown ? shown.url : displayUrl(url),
      title: shown ? shown.title : pageTitle(contents.getTitle(), url),
      loading: !tab.crashed && contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: tab.error && { ...tab.error },
      crashed: tab.crashed,
      unresponsive: tab.unresponsive,
      fullscreen: tab.fullscreen,
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
    // Visits (`browser-session-db.feature.md`): main-frame `http(s)` commits; a page's title
    // updates its visit, never an error page's.
    const recordVisit = (url: unknown): void => {
      if (typeof url === 'string' && isWebUrl(url)) session?.recordVisit(url);
    };
    listen('did-navigate-in-page', (_event: unknown, url: unknown, isMainFrame: unknown) => {
      if (isMainFrame === true) recordVisit(url);
    });
    listen('page-title-updated', () => {
      const url = view.webContents.getURL();
      if (session && tab.error === null && !tab.crashed && tab.state.title !== '' && isWebUrl(url)) session.updateVisitTitle(url, tab.state.title);
    });
    listen('did-start-loading', () => {
      tab.crashed = false;
      refresh(tab);
    });
    // A main-frame page committed (Electron emits `did-navigate` only for non-error pages): the
    // old document's permission prompts are denied, and the new one is not fullscreen.
    listen('did-navigate', (_event: unknown, url: unknown) => {
      // Loading what was open at the last launch (its saved URL) is not a new visit.
      const restoring = tab.restored !== null && url === tab.restored.url;
      tab.error = null;
      tab.restored = null;
      if (denyPrompts(tab)) changed();
      if (clearFullscreen(tab)) applyBounds(tab);
      refresh(tab);
      if (!restoring) recordVisit(url);
    });
    // Main-frame load failures show the error panel; `ERR_ABORTED` (a dropped navigation, a stop,
    // a download) and subframe failures do not.
    listen('did-fail-load', (_event: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (isMainFrame && Number.isInteger(code) && code < 0 && !(IGNORED_LOAD_ERROR_CODES as readonly number[]).includes(code)) {
        tab.error = { code, description: String(description), url: displayUrl(String(validatedUrl)) };
        tab.restored = null;
        // An error page replaces the document that asked.
        if (denyPrompts(tab)) changed();
      }
      refresh(tab);
    });
    listen('render-process-gone', () => {
      tab.crashed = true;
      tab.unresponsive = false;
      if (denyPrompts(tab)) changed();
      refresh(tab);
    });
    // HTML fullscreen (granted without a prompt, `permissions.spec.ts`): the window goes
    // fullscreen; the chrome's notice banner shows first, then the page's view covers it all.
    listen('enter-html-full-screen', () => setFullscreen(tab, 'notice'));
    listen('leave-html-full-screen', () => setFullscreen(tab, null));
    // Esc always leaves fullscreen: taken before the page can see (and swallow) it.
    listen('before-input-event', (event: { preventDefault(): void }, input: KeyInput) => {
      if (tab.fullscreen === null || input.key !== FULLSCREEN_EXIT_KEY) return;
      event.preventDefault();
      if (input.type === 'keyDown') exitHtmlFullscreen(tab);
    });
    // A hang is the tab's own state: the status bar reports it while the tab is shown.
    listen('unresponsive', () => {
      tab.unresponsive = true;
      refresh(tab);
    });
    listen('responsive', () => {
      tab.unresponsive = false;
      refresh(tab);
    });
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

  /** Whether `tab` was opened, directly or through other popups, by the tab `ancestorId`. */
  const descendsFrom = (tab: Tab | undefined, ancestorId: number): boolean => {
    let openerId = tab?.openerId ?? null;
    while (openerId !== null) {
      if (openerId === ancestorId) return true;
      const id: number = openerId;
      openerId = tabs.find((t) => t.id === id)?.openerId ?? null;
    }
    return false;
  };

  const downloadBlocked = (contents: unknown): void => {
    const tab = tabs.find((t) => t.view !== null && aliveContents(t.view) === contents);
    const live = tab?.view ? aliveContents(tab.view) : undefined;
    if (tab && live && tab.openerId !== null && live.getURL() === '') removeTab(tab.id);
    raiseNotice('download-blocked');
  };

  const isFullscreen = (tabId: number): boolean => tabs.some((tab) => tab.id === tabId && tab.fullscreen !== null);

  const tabIdOf = (contents: unknown): number | null => {
    if (contents === null || contents === undefined) return null;
    return tabs.find((tab) => tab.view !== null && aliveContents(tab.view) === contents)?.id ?? null;
  };

  /** Answers the active tab's prompt; any other id (another tab's, stale, unknown) is a no-op. */
  const answerPermission = (promptId: string, decision: PermissionDecision): boolean => {
    const tab = activeTab();
    if (!tab || !permissions || !hasWindow()) return false;
    return permissions.answer(tab.id, promptId, decision);
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
    // Right of the opener, after the run of tabs it opened and their own popups (its descendants).
    let at = index + 1;
    while (descendsFrom(tabs[at], openerTab.id)) at += 1;
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
      // A restored tab whose first load never committed (aborted) has no entry to reload: load
      // its saved URL again.
      if (tab.restored && view.webContents.getURL() === '') {
        view.webContents.loadURL(tab.restored.url).catch(() => {
          // Failures surface through `did-fail-load` / the tab state.
        });
      } else {
        view.webContents.reload();
      }
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

  const restoreSession = (saved: SavedSession): void => {
    if (everAttached || tabs.length !== 1 || tabs[0]?.view !== null || tabs[0]?.state.url !== '') return;
    const restored: Tab[] = [];
    let activeIndex = -1;
    saved.tabs.forEach((entry, index) => {
      const raw = typeof entry.url === 'string' ? entry.url : null;
      // Defence in depth: the database already dropped these (and stripped userinfo).
      if (raw === null || (raw !== '' && !isWebUrl(raw)) || restored.length >= MAX_TABS) return;
      const url = raw === '' ? '' : displayUrl(raw);
      // The saved active tab, else (skipped) the next kept tab to its right.
      if (activeIndex < 0 && index >= saved.activeIndex) activeIndex = restored.length;
      const tab = createTab();
      const title = typeof entry.title === 'string' ? entry.title : '';
      if (url !== '') {
        tab.restored = { url, title };
        tab.state = { ...tab.state, url, title };
      }
      restored.push(tab);
    });
    if (restored.length === 0) return;
    tabs = restored;
    activeTabId = (restored[activeIndex] ?? restored[restored.length - 1])!.id;
    changed();
  };

  return {
    restoreSession,

    attach(target) {
      if (win === target) return;
      if (win !== null) {
        // Another window took over (Phase 1 shows one window): start it on a fresh empty tab.
        closeAll();
        openEmptyTab();
        changed();
      }
      win = target;
      everAttached = true;
      sessionPaused = false;
      // What this window starts with is not a change: only later changes are saved.
      lastSavedSession = JSON.stringify(sessionSnapshot());
      target.webContents.on('before-input-event', takeShortcut);
      // The chrome page's own <title> must not replace `<page title> — frost`.
      target.on('page-title-updated', (event) => event.preventDefault());
      // The content size changes without the chrome reporting a new page area (a fullscreen view
      // fills the window): lay the shown view out again.
      const relayout = (): void => {
        const tab = activeTab();
        if (win === target && tab) applyBounds(tab);
      };
      target.on('resize', relayout);
      target.on('enter-full-screen', relayout);
      target.on('leave-full-screen', relayout);
      // Closing: a last change of the strip is saved; the tear-down and the empty tab left behind
      // are not. A window closed as it started (a macOS window reopened on an empty tab) saves
      // nothing, so the session saved before it is kept.
      target.once('close', () => {
        if (win !== target) return;
        saveSession();
        sessionPaused = true;
      });
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
      // A restored active tab loads now (the chrome's first state already lists every tab).
      syncAttached();
    },

    navigate(input) {
      const resolved = resolveAddressInput(input);
      const tab = activeTab();
      if (resolved === null || !tab) return false;
      const view = ensureView(tab);
      if (!view) return false;
      // What the user typed replaces a restored tab's saved URL (as shown, and for Reload).
      tab.restored = null;
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

    tabIdOf,

    isFullscreen,

    answerPermission,

    downloadBlocked,

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
