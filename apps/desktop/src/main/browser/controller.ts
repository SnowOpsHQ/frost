import type { SavedSession } from '@app/db';
import type { BrowserService, SeoService } from '@app/ipc-contract';
import { copyValueOf, filterLinks, formatJson, linksCsv, pageUrls } from '@app/seo-core';
import { APP_WINDOW_TITLE, MAX_TABS, WINDOW_TITLE_SEPARATOR, type BrowserState, type Notice, type NoticeKind } from '@app/specs/browser.spec';
import type { PaletteReturnFocus } from '@app/specs/command-palette.spec';
import { FULLSCREEN_BANNER_HEIGHT, type PermissionDecision } from '@app/specs/permissions.spec';
import type { PageCommand } from '@app/specs/page-commands.spec';
import type { RenderProfile } from '@app/specs/render-profile.spec';
import { isWebUrl, parseWebUrl } from '@app/specs/web-url.spec';
import { displayUrl, resolveAddressInput } from './address';
import { createFullscreen } from './fullscreen';
import { createPageCommands } from './page-commands';
import { pageTitle } from './page-title';
import { createTabRenderProfiles, type RenderProfileOptions } from './render-profile';
import { withAuditProfiles } from './render-profile-audits';
import { createSessionSync, restoredStrip, type SessionSink } from './session-sync';
import { createTabA11y, type A11yRunner } from '../seo/a11y-runs';
import { createTabAudits, type TabAuditsOptions } from '../seo/auditor';
import { withKnown } from '../seo/context-source';
import { createTabHighlights, type HighlightPainter } from '../seo/highlights';
import { createTabSpeed, type TabSpeedOptions } from '../seo/vitals-tabs';
import { matchPageShortcut, matchSidebarShortcut, matchTabShortcut, type KeyInput, type TabShortcut } from './shortcuts';
import { createStateWatch } from './state-watch';
import { wireTabView, type TabContextMenuRequest } from './tab-events';
import { aliveContents, capTitle, clampPageBounds, createTab, emptyTabState, noop, sameTabState, showsPage, zoomOf, type HostWindow, type PageState, type StripState, type Tab, type TabView } from './tab-model';
import { createTabPrompts, type TabPermissions } from './tab-permissions';

// Main-process owner of all browser state (spec `browser-chrome.feature.md` and `tabs.feature.md`,
// Controller). Only Electron *types* are imported: the view factory and the window are injected, so
// this runs under Vitest with plain fakes. Its parts: the tab model (`tab-model.ts`), each tab
// view's events (`tab-events.ts`), HTML fullscreen (`fullscreen.ts`), the session database's side
// (`session-sync.ts`), state versioning and `watch` (`state-watch.ts`), the permission broker's
// side (`tab-permissions.ts`), the page commands (`page-commands.ts`) and the SEO auditor
// (`../seo/auditor.ts`); this file holds the strip and its commands.
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

export { clampPageBounds, type HostWindow, type TabView } from './tab-model';
export type { SessionSink } from './session-sync';
export type { TabContextMenuRequest } from './tab-events';
export type { TabPermissions } from './tab-permissions';

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
  /**
   * Runs a page command on the active tab (spec `page-commands.feature.md`): reload, hard reload,
   * stop (only while loading and not fullscreen), back / forward, zoom in / out / reset. No-ops
   * without a page.
   */
  runPageCommand(command: PageCommand): void;
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
  /** Forgets every render-profile pin in memory (Clear Browsing Data; `render-profile.feature.md`). */
  forgetRenderProfilePins(): void;
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
  /**
   * Asks the chrome to toggle the SEO sidebar (its menu item and reserved shortcut,
   * `seo-sidebar.feature.md`): bumps `toggleSidebarSeq`. A no-op without a window.
   */
  toggleSidebar(): void;
  /**
   * Asks the chrome to open (or close) the command palette (its menu item and reserved shortcut,
   * `command-palette.feature.md`): records where focus was (`page` when the active tab's shown page
   * has it, else `chrome`), focuses the chrome and bumps `commandPalette.seq`. A no-op without a
   * window or while the active tab is in HTML fullscreen.
   */
  openCommandPalette(): void;
  /**
   * The tabs' SEO audits, highlight overlays and copy commands, as the `seo.*` procedures see them
   * (`seo-sidebar.feature.md`, Auditor; `seo-panels.feature.md`).
   */
  readonly seo: SeoService;
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
  /**
   * Shows the page context menu for a tab's `context-menu` event (`page-commands.feature.md`):
   * main builds it from the params and pops it up on `window`. Without it there is none.
   */
  readonly contextMenu?: (request: TabContextMenuRequest) => void;
  /**
   * The SEO auditor's extractor (`runExtractor` in `../seo/extract.ts`) and timings: the active
   * tab is audited after each load and SPA route change. Without it no tab is ever audited (every
   * page's audit stays `pending`).
   */
  readonly seo?: TabAuditsOptions;
  /**
   * Draws or removes the SEO highlight overlay in a tab's page and waits for it to end
   * (`runHighlight` / `watchHighlight` in `../seo/highlight.ts`). Without it `seo.setHighlight` is a
   * no-op answering `false`.
   */
  readonly highlight?: HighlightPainter;
  /**
   * The page-speed collector and its analysis (`runVitals` in `../seo/vitals.ts`, the worker's
   * `analyseSpeed`): `seo.measureSpeed` measures the active tab (`seo-speed.feature.md`). Without it
   * every measurement stays `pending`.
   */
  readonly speed?: TabSpeedOptions;
  /**
   * Runs the accessibility check in a tab's page (`runAccessibilityCheck` in `../seo/a11y.ts`,
   * Task 6). Without it `seo.runAccessibility` is a no-op answering `false`.
   */
  readonly accessibility?: A11yRunner;
  /**
   * The system clipboard (Electron's `clipboard`, in main): "Copy as CSV" and "Copy URL" write
   * through it, so the chrome never needs clipboard access. Without it they copy nothing.
   */
  readonly clipboard?: { writeText(text: string): void };
  /**
   * The menu's Clear Browsing Data… (`createClearBrowsingData` in `../clear-browsing-data.ts`: it
   * asks first): `browser.clearBrowsingData` from the command palette runs it. Without it, a no-op.
   */
  readonly clearBrowsingData?: () => void;
  /**
   * Per-tab render profiles (`render-profile.feature.md`): the tab debugger factory, the site pins and
   * the app's Chromium version. Without it `browser.setRenderProfile` is a no-op answering `false`.
   */
  readonly renderProfiles?: RenderProfileOptions;
}

/** Whether `audit` is the one the panel rendered (`SeoAuditRef`: its URL and when it was taken). */
function sameAudit(audit: { readonly url: string; readonly takenAt: number }, shown: { readonly url: string; readonly takenAt: number }): boolean {
  return audit.url === shown.url && audit.takenAt === shown.takenAt;
}

export function createBrowserController(options: BrowserControllerOptions): BrowserController {
  let nextTabId = 1;
  const strip: StripState = { tabs: [], activeTabId: null, win: null, attached: null, pageBounds: null };
  let focusAddressBarSeq = 0;
  let toggleSidebarSeq = 0;
  // The command palette (`command-palette.spec.ts`): main asks the chrome to open it, like the sidebar.
  let paletteSeq = 0;
  let paletteReturnFocus: PaletteReturnFocus = 'chrome';
  let notice: Notice | null = null;
  /** A window was attached once: the restore point has passed. */
  let everAttached = false;
  const platform = options.platform ?? process.platform;

  const snapshot = (): BrowserState => ({
    version: stateWatch.version(),
    tabs: strip.tabs.map((tab) => ({ ...tab.state, error: tab.state.error && { ...tab.state.error }, permissionPrompt: prompts.promptFor(tab.id), auditVersion: audits.version(tab.id) + a11y.version(tab.id), highlight: tab.highlight, renderProfile: renderProfiles.state(tab) })),
    activeTabId: strip.activeTabId,
    focusAddressBarSeq,
    toggleSidebarSeq,
    commandPalette: { seq: paletteSeq, returnFocus: paletteReturnFocus },
    notice: notice && { ...notice },
  });
  const stateWatch = createStateWatch(snapshot);

  const activeTab = (): Tab | undefined => strip.tabs.find((tab) => tab.id === strip.activeTabId);
  const hasWindow = (): boolean => strip.win !== null && !strip.win.isDestroyed();
  const sessionSync = createSessionSync(options.session, strip, hasWindow);

  const updateWindowTitle = (): void => {
    const win = strip.win;
    if (!win || win.isDestroyed()) return;
    const tab = activeTab();
    const title = tab && tab.state.url !== '' ? tab.state.title || tab.state.url : '';
    win.setTitle(title === '' ? APP_WINDOW_TITLE : `${capTitle(title)}${WINDOW_TITLE_SEPARATOR}${APP_WINDOW_TITLE}`);
  };

  const changed = (): void => {
    stateWatch.bump();
    updateWindowTitle();
    sessionSync.save();
    stateWatch.wake();
  };

  // A prompt appeared, was answered or timed out (denials the controller causes are reported by
  // the operation that caused them).
  const prompts = createTabPrompts(options.permissions, changed);

  // The SEO auditor audits only the active tab of an attached window. The accessibility check's
  // answer for the tab's document (Task 6) travels in the page's context, beside what main collects:
  // an input known at once, in the first analysis and the final one alike (`withKnown`).
  // Every audit records the render profile its run's extraction started under, kept with that run
  // (`render-profile.feature.md`, Recorded with audits).
  const auditProfiles =
    options.seo &&
    withAuditProfiles(options.seo, (contents) => {
      const tab = strip.tabs.find((t) => t.view !== null && aliveContents(t.view) === contents);
      return tab ? renderProfiles.auditProfile(tab) : null;
    });
  const seoOptions: TabAuditsOptions | undefined = auditProfiles && {
    ...auditProfiles.options,
    context: (contents) => {
      const base = options.seo!.context?.(contents);
      const tab = strip.tabs.find((t) => t.view !== null && aliveContents(t.view) === contents);
      const answer = tab ? a11y.resultFor(tab, contents.getURL()) : null;
      if (answer === null) return base ?? { now: () => ({ context: undefined, final: true }), later: null };
      return withKnown(base, { accessibility: answer });
    },
  };
  const audits = createTabAudits(seoOptions, {
    isActive: (tab) => hasWindow() && tab.id === strip.activeTabId,
    isOpen: (tab) => strip.tabs.includes(tab),
    changed,
  });

  // Live page-speed measurements, of the active tab only (dropped with each new document).
  const speeds = createTabSpeed(options.speed, {
    isActive: (tab) => hasWindow() && tab.id === strip.activeTabId,
    isOpen: (tab) => strip.tabs.includes(tab),
  });

  // The accessibility check (Task 6), on request for the active tab; an answer re-scores the audit
  // (at once, keeping the audit on screen, or when the tab is next shown).
  const a11y = createTabA11y({
    runner: options.accessibility,
    isActive: (tab) => hasWindow() && tab.id === strip.activeTabId,
    isOpen: (tab) => strip.tabs.includes(tab),
    changed,
    answered: (tab) => {
      if (hasWindow() && tab.id === strip.activeTabId) audits.rerun(tab, true);
      else audits.schedule(tab, 'load');
    },
  });

  // The SEO highlight overlay, on the active tab only (it goes when the page changes or the tab is left).
  const highlights = createTabHighlights({
    painter: options.highlight,
    isActive: (tab) => hasWindow() && tab.id === strip.activeTabId,
    changed,
  });

  // Render profiles (`render-profile.feature.md`): each tab's own, applied through its own debugger; a
  // change of the frame or the device fit lays the active tab's view out again.
  const renderProfiles = createTabRenderProfiles(options.renderProfiles, {
    changed: () => {
      const tab = activeTab();
      if (tab) applyBounds(tab);
      changed();
    },
    pageArea: () => (strip.pageBounds !== null && hasWindow() ? clampPageBounds(strip.pageBounds, strip.win!.getContentSize() as [number, number]) : null),
  });

  /**
   * Loads `url` in `tab`'s `view`, the tab's render profile for it put into effect first, so the
   * first request already carries it.
   */
  const loadInTab = (tab: Tab, view: TabView, url: string): void => {
    renderProfiles.beforeLoad(tab, url);
    view.webContents.loadURL(url).catch(() => {
      // Failures surface through `did-fail-load` / the tab state.
    });
  };

  /** Appends an empty tab and makes it active (the caller syncs the window and bumps the version). */
  const openEmptyTab = (): number => {
    const tab = createTab(nextTabId++);
    const left = activeTab();
    if (left) highlights.deactivated(left);
    strip.tabs.push(tab);
    strip.activeTabId = tab.id;
    return tab.id;
  };

  const raiseNotice = (kind: NoticeKind): void => {
    notice = { seq: (notice?.seq ?? 0) + 1, kind };
    changed();
  };

  /**
   * Lays `tab`'s view over the page area; in HTML fullscreen over the whole content area, below
   * the chrome's notice banner while it shows (`FULLSCREEN_BANNER_HEIGHT`).
   */
  const applyBounds = (tab: Tab): void => {
    const win = strip.win;
    if (!tab.view || !win) return;
    const [width = 0, height = 0] = win.getContentSize();
    if (tab.fullscreen) {
      const top = tab.fullscreen === 'notice' ? Math.min(FULLSCREEN_BANNER_HEIGHT, height) : 0;
      tab.view.setBounds({ x: 0, y: top, width, height: height - top });
    } else if (strip.pageBounds !== null) {
      tab.view.setBounds(renderProfiles.viewBounds(tab, clampPageBounds(strip.pageBounds, [width, height])));
    }
  };

  const fullscreen = createFullscreen({ strip, applyBounds, changed });

  const detach = (view: TabView): void => {
    if (strip.attached === view) strip.attached = null;
    const win = strip.win;
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
    tab.exitRequested = false;
    // Its WebContents is going: nothing will leave HTML fullscreen, so the window leaves OS fullscreen.
    if (fullscreen.clear(tab)) fullscreen.leaveWindowFullscreen();
    prompts.deny(tab);
    audits.forget(tab);
    speeds.forget(tab);
    a11y.forget(tab);
    highlights.dropped(tab);
    renderProfiles.released(tab);
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
    tab.state = emptyTabState(tab.id, tab.documentSeq);
    changed();
  };

  /** `tab`'s view if its WebContents is still alive; a destroyed one is dropped, never used. */
  const liveView = (tab: Tab): TabView | null => {
    if (tab.view && !aliveContents(tab.view)) dropView(tab);
    return tab.view;
  };

  /** Loads a restored tab's saved URL the first time it is shown. */
  const loadRestored = (tab: Tab): void => {
    if (!tab.restored || tab.view || !hasWindow()) return;
    const { url } = tab.restored;
    const view = ensureView(tab);
    if (view) loadInTab(tab, view, url);
  };

  /** Makes the window show exactly the active tab's view (none for an empty tab, or behind a panel). */
  const syncAttached = (): void => {
    const tab = activeTab();
    if (tab) loadRestored(tab);
    const live = tab ? liveView(tab) : null;
    const want = tab && showsPage(tab) ? live : null;
    if (strip.attached === want) return;
    const shown = strip.attached;
    const hidden = shown ? strip.tabs.find((t) => t.view === shown) : undefined;
    if (shown) detach(shown);
    // A fullscreen page that is no longer shown leaves fullscreen.
    if (hidden) fullscreen.leave(hidden);
    // Page speed: when a document was first shown and hidden (`seo-speed.feature.md`, Background tabs).
    if (hidden) speeds.hidden(hidden);
    const win = strip.win;
    if (!want || !tab || !win || win.isDestroyed()) return;
    win.contentView.addChildView(want);
    strip.attached = want;
    speeds.shown(tab);
    applyBounds(tab);
    want.setVisible(true);
    // Chromium completes a hidden page's exit only once it is shown: ask again (once settled).
    if (tab.exitRequested) fullscreen.schedulePageExits();
  };

  /** Asks the chrome to focus its address bar (it watches `focusAddressBarSeq`). */
  const requestAddressFocus = (): void => {
    focusAddressBarSeq += 1;
    const win = strip.win;
    if (win && !win.isDestroyed()) win.webContents.focus();
  };

  /**
   * After a switch: focus the active tab's page, the chrome for a tab showing a panel (its buttons
   * are there), or the address bar for an empty tab.
   */
  const focusActive = (): void => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    const win = strip.win;
    if (!view) requestAddressFocus();
    else if (tab && showsPage(tab)) view.webContents.focus();
    else if (win && !win.isDestroyed()) win.webContents.focus();
  };

  /** Re-reads `tab`'s state from its WebContents; bumps the version only on a real change. */
  const refresh = (tab: Tab): void => {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    // An error or crash panel replaced the page: its overlay went with it.
    if (!showsPage(tab)) {
      highlights.dropped(tab);
      a11y.dropped(tab);
    }
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
      zoom: zoomOf(contents),
      documentSeq: tab.documentSeq,
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
    if (!hasWindow()) return null;
    const view = options.createView();
    tab.view = view;
    tab.unlisten = wireTabView(tab, view, {
      isOpen: (t) => strip.tabs.includes(t),
      window: () => strip.win,
      refresh,
      changed,
      denyPrompts: prompts.deny,
      fullscreen,
      applyBounds,
      session: options.session,
      stopLoading: (t) => pageCommands.stopLoading(t),
      takeShortcut,
      removeTab,
      contextMenu: options.contextMenu,
      pageSettled: (t, kind) => {
        if (kind === 'in-page') {
          highlights.navigatedInPage(t);
          a11y.navigatedInPage(t);
        }
        audits.schedule(t, kind);
      },
      pageCommitted: (t) => {
        highlights.dropped(t);
        a11y.dropped(t);
        audits.navigated(t);
        speeds.navigated(t);
      },
    });
    const unlistenEvents = tab.unlisten;
    const unlistenProfile = renderProfiles.wire(tab, view);
    tab.unlisten = () => {
      unlistenEvents();
      unlistenProfile();
    };
    // Sized now, so a background tab (a popup) lays its page out at the page area's size.
    applyBounds(tab);
    syncAttached();
    return view;
  };

  const pageCommands = createPageCommands({ strip, activeTab, liveView, ensureView, refresh });
  const runPageCommand = pageCommands.run;

  openEmptyTab();

  const closeAll = (): void => {
    // Each view is released before its WebContents closes, so its `destroyed` event finds nothing.
    for (const tab of strip.tabs) closeView(tab);
    strip.tabs = [];
    strip.activeTabId = null;
    strip.attached = null;
  };

  const activateTab = (tabId: number): boolean => {
    const tab = strip.tabs.find((t) => t.id === tabId);
    if (!tab || !hasWindow()) return false;
    if (tab.id === strip.activeTabId) return true;
    // The tab left behind loses its overlay.
    const left = activeTab();
    if (left) highlights.deactivated(left);
    strip.activeTabId = tab.id;
    syncAttached();
    focusActive();
    audits.activated(tab);
    changed();
    return true;
  };

  /** Closes the tab (no window check: also for a page that closed itself). */
  function removeTab(tabId: number): boolean {
    const index = strip.tabs.findIndex((t) => t.id === tabId);
    const tab = strip.tabs[index];
    if (!tab) return false;
    closeView(tab);
    strip.tabs.splice(index, 1);
    if (strip.tabs.length === 0) {
      // The window never goes tab-less: a fresh empty tab takes the last one's place.
      openEmptyTab();
      requestAddressFocus();
    } else if (tab.id === strip.activeTabId) {
      // The right neighbour (now at `index`), else the left one.
      const next = strip.tabs[index] ?? strip.tabs[index - 1];
      strip.activeTabId = next ? next.id : null;
      syncAttached();
      focusActive();
      if (next) audits.activated(next);
    }
    changed();
    return true;
  }

  const closeTab = (tabId: number): boolean => hasWindow() && removeTab(tabId);

  const newTab = (): number | null => {
    if (!hasWindow()) {
      // Never a hidden tab: open the window (which starts with one empty tab) instead.
      options.openWindow?.();
      return hasWindow() ? strip.activeTabId : null;
    }
    if (strip.tabs.length >= MAX_TABS) {
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
    const tab = Number.isInteger(index) ? strip.tabs[index] : undefined;
    return tab ? activateTab(tab.id) : false;
  };

  /** Activates the tab `step` places from the active one, wrapping; a no-op with one tab. */
  const cycle = (step: 1 | -1): boolean => {
    const { tabs } = strip;
    const index = tabs.findIndex((t) => t.id === strip.activeTabId);
    if (index < 0 || tabs.length < 2) return false;
    return activateTabAt((index + step + tabs.length) % tabs.length);
  };

  /** Whether `tab` was opened, directly or through other popups, by the tab `ancestorId`. */
  const descendsFrom = (tab: Tab | undefined, ancestorId: number): boolean => {
    let openerId = tab?.openerId ?? null;
    while (openerId !== null) {
      if (openerId === ancestorId) return true;
      const id: number = openerId;
      openerId = strip.tabs.find((t) => t.id === id)?.openerId ?? null;
    }
    return false;
  };

  /** The open tab whose live view's WebContents is `contents`. */
  const tabOfContents = (contents: unknown): Tab | undefined => strip.tabs.find((tab) => tab.view !== null && aliveContents(tab.view) === contents);

  const downloadBlocked = (contents: unknown): void => {
    const tab = tabOfContents(contents);
    const live = tab?.view ? aliveContents(tab.view) : undefined;
    if (tab && live && tab.openerId !== null && live.getURL() === '') removeTab(tab.id);
    raiseNotice('download-blocked');
  };

  const isFullscreen = (tabId: number): boolean => strip.tabs.some((tab) => tab.id === tabId && tab.fullscreen !== null);

  const tabIdOf = (contents: unknown): number | null => {
    if (contents === null || contents === undefined) return null;
    return tabOfContents(contents)?.id ?? null;
  };

  /** Answers the active tab's prompt; any other id (another tab's, stale, unknown) is a no-op. */
  const answerPermission = (promptId: string, decision: PermissionDecision): boolean => {
    const tab = activeTab();
    if (!tab || !hasWindow()) return false;
    return prompts.answer(tab.id, promptId, decision);
  };

  const openTabFromPage = (opener: unknown, url: string): number | null => {
    if (!hasWindow() || !isWebUrl(url)) return null;
    const openerTab = strip.tabs.find((tab) => tab.view !== null && aliveContents(tab.view) === opener);
    // A tab the page opens renders as its opener does (`render-profile.feature.md`, Popups).
    return openerTab ? openTabRightOf(openerTab, url, true) : null;
  };

  /**
   * A link from the SEO sidebar or the palette: opened in a background tab right of the active tab (as
   * its popup would be). It starts with the active tab's own render profile only with `inherit` (a
   * page of the audited site); a tool, help page, robots.txt or sitemap does not.
   */
  const openBackgroundTab = (url: string, inherit = false): number | null => {
    const parsed = parseWebUrl(url);
    const opener = activeTab();
    if (!hasWindow() || !parsed || !opener) return null;
    return openTabRightOf(opener, parsed.href, inherit);
  };

  /**
   * Opens the `http(s)` `url` in a new background tab right of `openerTab`, after the tabs it opened;
   * with `inherit` it starts with the opener's own render profile.
   */
  const openTabRightOf = (openerTab: Tab, url: string, inherit: boolean): number | null => {
    const index = strip.tabs.indexOf(openerTab);
    if (index < 0) return null;
    if (strip.tabs.length >= MAX_TABS) {
      raiseNotice('tab-limit');
      return null;
    }
    // Right of the opener, after the run of tabs it opened and their own popups (its descendants).
    let at = index + 1;
    while (descendsFrom(strip.tabs[at], openerTab.id)) at += 1;
    const tab = createTab(nextTabId++, openerTab.id);
    strip.tabs.splice(at, 0, tab);
    // It starts with the opener's own render profile, in effect before its first request.
    if (inherit) renderProfiles.inherit(openerTab, tab);
    const view = ensureView(tab);
    // No opener link, referrer or POST body: the new tab loads the URL on its own.
    if (view) loadInTab(tab, view, url);
    changed();
    return tab.id;
  };

  const focusAddressBar = (): void => {
    if (!hasWindow()) return;
    requestAddressFocus();
    changed();
  };

  const toggleSidebar = (): void => {
    if (!hasWindow()) return;
    toggleSidebarSeq += 1;
    changed();
  };

  /** The active tab's view, if it is attached and shows its page (never a panel or an empty tab). */
  const shownView = (): TabView | null => {
    const tab = activeTab();
    const view = tab ? liveView(tab) : null;
    return tab && view && showsPage(tab) && strip.attached === view ? view : null;
  };

  const openCommandPalette = (): void => {
    const win = strip.win;
    if (!win || win.isDestroyed()) return;
    // A fullscreen page covers the whole window, the palette too: nothing opens.
    if (activeTab()?.fullscreen) return;
    paletteReturnFocus = shownView()?.webContents.isFocused() === true ? 'page' : 'chrome';
    paletteSeq += 1;
    win.webContents.focus();
    changed();
  };

  /** Focus back to the page the palette was opened from (`browser.focusPage`). */
  const focusPage = (): boolean => {
    const view = hasWindow() ? shownView() : null;
    if (!view) return false;
    view.webContents.focus();
    return true;
  };

  const runShortcut = (shortcut: TabShortcut): void => {
    switch (shortcut.command) {
      case 'new-tab':
        newTab();
        return;
      case 'close-tab':
        if (strip.activeTabId !== null) closeTab(strip.activeTabId);
        return;
      case 'focus-address-bar':
        focusAddressBar();
        return;
      case 'select-tab':
        activateTabAt(shortcut.index);
        return;
      case 'select-last-tab':
        activateTabAt(strip.tabs.length - 1);
        return;
      case 'next-tab':
        cycle(1);
        return;
      case 'previous-tab':
        cycle(-1);
        return;
      case 'command-palette':
        openCommandPalette();
    }
  };

  /**
   * `before-input-event` of a tab's or the chrome's WebContents: a reserved tab or page shortcut
   * is consumed (`preventDefault` keeps it from the page and from the menu accelerator, so it runs
   * once) and run on key-down; every other key passes through.
   */
  function takeShortcut(event: { preventDefault(): void }, input: KeyInput): void {
    const shortcut = matchTabShortcut(input, platform);
    const page = shortcut ? null : matchPageShortcut(input, platform);
    const sidebar = !shortcut && !page && matchSidebarShortcut(input, platform);
    if (!shortcut && !page && !sidebar) return;
    event.preventDefault();
    if (input.type !== 'keyDown') return;
    if (shortcut) runShortcut(shortcut);
    else if (page) runPageCommand(page);
    else toggleSidebar();
  }

  const restoreSession = (saved: SavedSession): void => {
    const [only] = strip.tabs;
    if (everAttached || strip.tabs.length !== 1 || only?.view !== null || only.state.url !== '') return;
    const restored = restoredStrip(saved, () => createTab(nextTabId++));
    if (!restored) return;
    strip.tabs = restored.tabs;
    strip.activeTabId = restored.activeTabId;
    changed();
  };

  return {
    restoreSession,

    attach(target) {
      if (strip.win === target) return;
      if (strip.win !== null) {
        // Another window took over (Phase 1 shows one window): start it on a fresh empty tab.
        closeAll();
        openEmptyTab();
        changed();
      }
      strip.win = target;
      everAttached = true;
      // What this window starts with is not a change: only later changes are saved.
      sessionSync.resume();
      target.webContents.on('before-input-event', takeShortcut);
      // The chrome page's own <title> must not replace `<page title> — frost`.
      target.on('page-title-updated', (event) => event.preventDefault());
      // The content size changes without the chrome reporting a new page area (a fullscreen view
      // fills the window): lay the shown view out again.
      const relayout = (): void => {
        const tab = activeTab();
        if (strip.win === target && tab) applyBounds(tab);
      };
      target.on('resize', relayout);
      // A window fullscreen transition ended: pending page exits wait for the window to settle.
      const transitioned = (): void => {
        relayout();
        if (strip.win === target) fullscreen.schedulePageExits();
      };
      target.on('enter-full-screen', transitioned);
      target.on('leave-full-screen', transitioned);
      // Closing: a last change of the strip is saved; the tear-down and the empty tab left behind
      // are not. A window closed as it started (a macOS window reopened on an empty tab) saves
      // nothing, so the session saved before it is kept.
      target.once('close', () => {
        if (strip.win !== target) return;
        sessionSync.save();
        sessionSync.pause();
      });
      target.once('closed', () => {
        if (strip.win !== target) return;
        fullscreen.cancelPageExits();
        closeAll();
        strip.win = null;
        strip.pageBounds = null;
        strip.attached = null;
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
      loadInTab(tab, view, resolved.url);
      view.webContents.focus();
      return true;
    },

    newTab,

    closeTab,

    activateTab,

    closeActiveTab: () => strip.activeTabId !== null && closeTab(strip.activeTabId),

    activateTabAt,

    activateLastTab: () => activateTabAt(strip.tabs.length - 1),

    activateNextTab: () => cycle(1),

    activatePreviousTab: () => cycle(-1),

    focusAddressBar,

    toggleSidebar,

    openCommandPalette,

    focusPage,

    clearBrowsingData: () => options.clearBrowsingData?.(),

    openBackgroundTab,

    seo: {
      getAudit: (tabId) => {
        const tab = strip.tabs.find((t) => t.id === tabId);
        const response = audits.response(tab);
        // A ready audit carries the tab's accessibility run (Task 6) and the render profile it ran under.
        return tab && response.status === 'ready' ? { ...response, accessibilityRun: a11y.state(tab), renderProfile: auditProfiles?.profileOf(response.audit) ?? null } : response;
      },
      measureSpeed: (tabId) => speeds.measure(strip.tabs.find((tab) => tab.id === tabId)),
      setHighlight: (tabId, mode) => {
        const tab = strip.tabs.find((t) => t.id === tabId);
        return tab !== undefined && highlights.set(tab, mode);
      },
      // All three copy only what the tab's ready audit holds, through main's clipboard, and only from
      // the audit the panel shows (`SeoAuditRefSchema`).
      copyLinksCsv: (tabId, shown, filter) => {
        const response = audits.response(strip.tabs.find((tab) => tab.id === tabId));
        if (!options.clipboard || response.status !== 'ready' || !sameAudit(response.audit, shown)) return null;
        const rows = filterLinks(response.audit.page.linkList, filter);
        options.clipboard.writeText(linksCsv(rows));
        return rows.length;
      },
      copyUrl: (tabId, shown, url) => {
        const response = audits.response(strip.tabs.find((tab) => tab.id === tabId));
        if (!options.clipboard || response.status !== 'ready' || !sameAudit(response.audit, shown) || !pageUrls(response.audit.page).has(url)) return false;
        options.clipboard.writeText(url);
        return true;
      },
      copySchemaJson: (tabId, shown, index) => {
        const response = audits.response(strip.tabs.find((tab) => tab.id === tabId));
        if (!options.clipboard || response.status !== 'ready' || !sameAudit(response.audit, shown)) return false;
        const block = response.audit.schema.blocks.find((b) => b.index === index);
        if (!block || block.text === '') return false;
        options.clipboard.writeText(block.status === 'valid' ? formatJson(block.text).text : block.text);
        return true;
      },
      // The command palette's copies (`command-palette.feature.md`): one allowlisted value, same checks.
      copyValue: (tabId, shown, key) => {
        const response = audits.response(strip.tabs.find((tab) => tab.id === tabId));
        if (!options.clipboard || response.status !== 'ready' || !sameAudit(response.audit, shown)) return false;
        const value = copyValueOf(response.audit, key);
        if (value === null) return false;
        options.clipboard.writeText(value);
        return true;
      },
      // The accessibility check runs on request, for the active tab only (Task 6).
      runAccessibility: (tabId) => {
        const tab = activeTab();
        return tab !== undefined && tab.id === tabId && hasWindow() && a11y.start(tab);
      },
      // Only the active tab is ever audited (`RERUN_ACTIVE_TAB_ONLY`).
      rerun: (tabId) => {
        const tab = activeTab();
        return tab !== undefined && tab.id === tabId && hasWindow() && audits.rerun(tab);
      },
    },

    openTabFromPage,

    // Render profiles (`render-profile.feature.md`): any open tab, from the chrome only.
    setRenderProfile: (tabId: number, profile: RenderProfile, pin?: boolean) => {
      const tab = strip.tabs.find((t) => t.id === tabId);
      return tab !== undefined && hasWindow() && renderProfiles.set(tab, profile, pin);
    },
    clearRenderProfile: (tabId: number) => {
      const tab = strip.tabs.find((t) => t.id === tabId);
      return tab !== undefined && hasWindow() && renderProfiles.clear(tab);
    },
    forgetRenderProfilePins: () => renderProfiles.forgetPins(),

    notify: raiseNotice,

    tabIdOf,

    isFullscreen,

    answerPermission,

    downloadBlocked,

    back: pageCommands.back,

    forward: pageCommands.forward,

    reload: () => pageCommands.reload(),

    runPageCommand,

    stop() {
      const tab = activeTab();
      const view = tab ? liveView(tab) : null;
      view?.webContents.stop();
    },

    setPageBounds(bounds) {
      strip.pageBounds = { ...bounds };
      const tab = activeTab();
      if (tab) applyBounds(tab);
    },

    getState: snapshot,

    watch: (sinceVersion, signal) => stateWatch.watch(sinceVersion, signal),

    pendingWatches: () => stateWatch.pending(),
  };
}
