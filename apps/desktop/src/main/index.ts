import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, clipboard, ipcMain, net, session, webContents, type WebContents } from 'electron';
import { appRouter, createSenderPolicy } from '@app/ipc-contract';
import { attachIpcHandler } from '@app/ipc-contract/main';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { createWindowRegistry } from './app-windows';
import { contextMenuTemplate } from './browser/context-menu';
import { createBrowserController, type TabContextMenuRequest } from './browser/controller';
import { hardenBrowseSession } from './browser/guard';
import { createBrowsePermissionHandlers, createPermissionBroker, createPersistentDecisionStore } from './browser/permissions';
import { createProfileDebugger } from './browser/render-profile-debugger';
import { createRenderProfilePins } from './browser/render-profile-pins';
import { clearBrowseStorage, confirmClearBrowsingData, createClearBrowsingData } from './clear-browsing-data';
import { installAppMenu, popupContextMenu } from './menu';
import { handleAppProtocol, registerAppScheme } from './protocol/register';
import { restrictAppRequests } from './protocol/requests';
import { runAccessibilityCheck } from './seo/a11y';
import { createAnalyzer } from './seo/analysis';
import { createContentService } from './seo/content-notes';
import { confirmClearContentNotes } from './seo/content-notes-dialog';
import { runExtractor } from './seo/extract';
import { runHighlight, watchHighlight } from './seo/highlight';
import { createResponseRecorder } from './seo/responses';
import { createRobotsFetcher, netHop, pendingRobots, type RobotsFetcher } from './seo/robots-fetch';
import { createBoundedFetcher } from './seo/fetcher';
import { createServedHtml, PENDING_SERVED, type ServedHtml } from './seo/served';
import { profileUserAgent } from '@app/specs/render-profile.spec';
import type { ContextSource } from './seo/auditor';
import { contextSource, knownInput, laterInput } from './seo/context-source';
import { observeMainFrames, observeRequests } from './browser/web-request';
import { createDevtoolsService } from './devtools/service';
import { browseCookies, clearBrowseOrigin, confirmClearSiteData } from './devtools/site-data';
import { nativeWayland, runVitals, withTimeout, type CollectOptions } from './seo/vitals';
import { createShownTimes } from './seo/vitals-shown';
import { SPEED_MEASURE_TIMEOUT_MS } from '@app/specs/seo-speed.spec';
import { remoteDebuggingRefusal } from './security/policy';
import { registerAppWideGuards, registerSecurity, type SecurityOptions } from './security/register';
import { flushBeforeQuit, loadSavedState, openBrowserSessionStore } from './session-store';
import { claimSingleInstance, reopenOnActivate } from './single-instance';
import { createMainWindow, createTabView, loadRenderer } from './window';

// First, before any window exists: a packaged build never runs with remote debugging (CDP would
// expose the trusted app page and its IPC bridge). See PACKAGED_FORBIDDEN_SWITCHES in
// specs/security-policy.spec.ts.
const debugRefusal = remoteDebuggingRefusal({
  isPackaged: app.isPackaged,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
  argv: process.argv,
});
if (debugRefusal !== null) {
  console.error(`frost: ${debugRefusal}`);
  app.exit(1);
} else {
  start();
}

/** Everything else main does, for the one instance that runs (never with a refused switch). */
function start(): void {
  // One frost per profile (specs/browser-session-db.feature.md, Single instance): a second launch
  // on the same `userData` shows this instance's window and quits before it opens anything, so
  // two instances never save over each other's session.
  // A second launch, and (macOS) the dock icon, act only once startup is complete (`started`).
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const windowOptions = { windows: () => BrowserWindow.getAllWindows(), openWindow: () => openMainWindow(), started };
  if (!claimSingleInstance(app, windowOptions)) return;

  // Global backstop: every renderer is sandboxed even if a future WebContents forgets the explicit pref.
  app.enableSandbox();

  // Privileged schemes must be registered before the app is ready.
  registerAppScheme();

  // The Vite dev-server origin is trusted (navigation, IPC sender, renderer source) only when
  // unpackaged under `electron-forge start` (specs/security-policy.spec.ts, ipc-sender.spec.ts).
  const devServerUrl = app.isPackaged ? undefined : MAIN_WINDOW_VITE_DEV_SERVER_URL;

  // The browser-session database (specs/browser-session-db.feature.md): one file in `userData`,
  // opened synchronously here, in main only (a corrupt or unusable file never stops the app). Tab
  // and visit writes are batched; whatever is pending is flushed before the app quits.
  const logSession = (message: string): void => console.warn(`frost: ${message}`);
  const sessionStore = openBrowserSessionStore(app.getPath('userData'), logSession);
  flushBeforeQuit(app, sessionStore);

  // Main owns all browser state; the chrome drives it only through the sender-guarded `browser.*`
  // procedures (specs/browser-chrome.feature.md). Tab views come from the allowlisted factory.
  // New Tab with no window open (macOS) opens the window instead of adding a hidden tab.
  // Tabs' permission requests become per-origin prompts (specs/permissions.feature.md); Blocks are
  // loaded at startup and written through to the session database (an Allow lasts for this run).
  const decisions = createPersistentDecisionStore((decision) => sessionStore.writer.savePermissionDecision(decision));
  const permissions = createPermissionBroker({ store: decisions });
  // A right-click in a tab's page pops up frost's own context menu (specs/page-commands.feature.md),
  // its items bound to that tab's WebContents.
  const showContextMenu = ({ contents, params, window, canGoBack, canGoForward }: TabContextMenuRequest): void => {
    const live = () => !contents.isDestroyed();
    const template = contextMenuTemplate(params, { canGoBack, canGoForward }, {
      back: () => {
        if (live() && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      },
      forward: () => {
        if (live() && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      },
      reload: () => {
        if (live()) contents.reload();
      },
      openInNewTab: (url) => void browser.openTabFromPage(contents, url),
      copyText: (text) => clipboard.writeText(text),
      edit: (command) => {
        if (live()) contents[command]();
      },
    });
    popupContextMenu(template, window as BrowserWindow);
  };
  // The active tab is audited after each load and SPA route change (specs/seo-sidebar.feature.md):
  // the extractor runs in the tab's isolated SEO world, and what it answers is validated and audited
  // in the analysis worker, never on this thread (specs/seo-schema.feature.md). The worker is the
  // Forge Vite main build's `seo-analysis` entry, bundled beside main.cjs (in the ASAR when
  // packaged); it gets no Electron APIs, only the extractor's answer, and a capped heap. The
  // highlight overlay is drawn from the same world (specs/seo-panels.feature.md), and the SEO
  // panels' "Copy" commands write through main's clipboard (the chrome has no clipboard access).
  const analyzer = createAnalyzer({
    spawn: () => new Worker(path.join(__dirname, 'seo-analysis.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } }),
  });
  app.once('will-quit', () => analyzer.dispose());
  // Indexability (specs/seo-indexability.feature.md): each tab's main-frame response is recorded
  // from the browse session's webRequest events (status, redirects, allowlisted headers, capped as
  // they arrive) and committed on the tab's `did-navigate`; robots.txt is fetched by main through
  // the browse session (cookies off, bounded) once the session exists. Both are handed to the
  // analysis worker beside the extractor's answer, where they are validated and read.
  const responses = createResponseRecorder();
  let robots: RobotsFetcher | null = null;
  // Clear Browsing Data… (the menu's, and the command palette's through `browser.clearBrowsingData`).
  let clearBrowsingData: (() => Promise<boolean>) | null = null;
  // Page speed (specs/seo-speed.feature.md): the collector runs in the tab's own isolated speed world
  // (web-vitals and frost's observers, never the main world); its answer is validated and summarised
  // in the analysis worker. The audit takes one measurement beside the snapshot (the health score's
  // performance rules); the Speed panel polls `seo.measureSpeed` for live values.
  // Main owns "when was this document first shown" (frost's background tabs report `visible`), and
  // knows whether paint timing can arrive at all (native Wayland may never report it).
  const shownTimes = createShownTimes();
  const wayland = nativeWayland(process.platform, app.commandLine.getSwitchValue('ozone-platform'), app.commandLine.getSwitchValue('ozone-platform-hint'), process.env);
  const collect = (contents: WebContents, options: Partial<CollectOptions>): Promise<unknown> => runVitals(contents, { ...shownTimes.of(contents.id), ...options, nativeWayland: wayland });
  const measureForAudit = (contents: WebContents): Promise<unknown> =>
    withTimeout(
      collect(contents, {}).catch(() => null),
      SPEED_MEASURE_TIMEOUT_MS,
      null,
    );
  // The audit never waits for a slow input: it is analysed with what is known now (robots.txt still
  // `pending` the first time an origin is seen, no speed measurement yet), and again once every
  // input has settled (seo/context-source.ts).
  const collectContext = (contents: WebContents): ContextSource => {
    const url = contents.getURL();
    return contextSource({
      response: knownInput(responses.responseFor(contents.id, url)),
      robots: robots ? laterInput(robots.get(url), pendingRobots(url), robots.peek(url)) : knownInput(null),
      performance: laterInput(measureForAudit(contents)),
      served: servedInput(contents, url),
    });
  };
  // Served HTML vs the rendered DOM (specs/seo-javascript.feature.md): main fetches the page as
  // served through the shared bounded fetcher (cookies omitted, bounded; the tab's render-profile
  // user agent if it has one in effect), the analysis worker parses it; kept per tab document, URL
  // and user agent (a new document drops it). Set up once the browse session exists (below).
  let served: ServedHtml | null = null;
  const servedUserAgent = (contents: WebContents): string | null => {
    const tabId = browser.tabIdOf(contents);
    const profile = tabId === null ? null : (browser.getState().tabs.find((tab) => tab.id === tabId)?.renderProfile ?? null);
    return profile && profile.status !== 'failed' ? profileUserAgent(profile.profile, process.versions.chrome) : null;
  };
  const servedInput = (contents: WebContents, url: string) => {
    if (!served) return knownInput(null);
    const userAgent = servedUserAgent(contents);
    return laterInput(served.get(contents.id, url, userAgent), PENDING_SERVED, served.peek(contents.id, url, userAgent));
  };

  // The SEO devtools drawer (specs/devtools.feature.md): a subscriber of the browse session's
  // webRequest owner (observers only), each tab's console messages and the Storage tab's reveals;
  // read-only but for "Clear this site's data", which main confirms in its own dialog. The robots.txt
  // verdicts are decided in the analysis worker.
  const tabContents = new Map<number, WebContents>();
  const devtools = createDevtoolsService({
    contentsOf: (tabId) => [...tabContents.values()].find((c) => !c.isDestroyed() && browser.tabIdOf(c) === tabId) ?? null,
    tabIdOf: (contentsId) => browser.tabIdOf(webContents.fromId(contentsId)),
    responses,
    robots: () => robots,
    robotsVerdicts: (job) => analyzer.robotsVerdicts(job),
    cookies: browseCookies,
    confirmClearSiteData: (origin) => confirmClearSiteData(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null, origin),
    clearOrigin: clearBrowseOrigin,
    liveWindow: (id) => BrowserWindow.fromId(id)?.isDestroyed() === false,
    log: logSession,
  });

  app.on('web-contents-created', (_event, contents) => {
    if (!isBrowseContents(contents)) return;
    responses.watch(contents);
    tabContents.set(contents.id, contents);
    devtools.watchContents(contents);
    // The speed collector's observers start at `dom-ready` of the active tab's document, before a
    // page's own scripts can clear the timing buffers for long (seo-speed.feature.md).
    const id = contents.id;
    contents.on('dom-ready', () => {
      const tabId = browser.tabIdOf(contents);
      if (tabId !== null && tabId === browser.getState().activeTabId) void collect(contents, { prime: true }).catch(() => undefined);
    });
    contents.once('destroyed', () => {
      shownTimes.forget(id);
      tabContents.delete(id);
      served?.forget(id);
    });
    // A new document fetches its served HTML afresh (seo-javascript.feature.md).
    contents.on('did-navigate', () => served?.forget(id));
  });
  // Per-tab render profiles (specs/render-profile.feature.md): each tab's own debugger, attached
  // only to a browse-session tab's WebContents and only while it has a profile, sending only the
  // allowlisted CDP methods (browser/render-profile-debugger.ts). "Pin to this site" profiles are
  // kept per origin in the session database (written at once), loaded before any tab loads.
  const renderProfilePins = createRenderProfilePins({
    save: (origin, profile) => sessionStore.writer.saveRenderProfilePin(origin, profile),
    remove: (origin) => sessionStore.writer.deleteRenderProfilePin(origin),
  });
  const renderProfiles = {
    pins: renderProfilePins,
    chromeVersion: process.versions.chrome,
    // createProfileDebugger refuses anything but a browse-session tab's WebContents itself.
    debuggerFor: (contents: WebContents, detached: (reason: string) => void) => createProfileDebugger(contents, detached),
  };
  const browser = createBrowserController({
    createView: createTabView,
    openWindow: () => openMainWindow(),
    permissions,
    session: sessionStore.writer,
    contextMenu: showContextMenu,
    seo: { extract: runExtractor, analyse: (raw, context) => analyzer.analyse(raw, context), context: collectContext },
    highlight: { paint: runHighlight, ended: watchHighlight },
    speed: { measure: collect, analyse: (raw) => analyzer.analyseSpeed(raw), times: shownTimes },
    // The accessibility check (specs/seo-compliance.feature.md): axe-core in the tab's own isolated
    // accessibility world, on request only; its answer is validated in the analysis worker.
    accessibility: runAccessibilityCheck,
    clipboard,
    // The command palette's Clear Browsing Data… (specs/command-palette.feature.md): the menu's own,
    // confirming action, set up once the app is ready (below).
    clearBrowsingData: () => void clearBrowsingData?.(),
    // "Open in" refuses a page from a non-public address (specs/command-palette.feature.md).
    pageAddress: (contents) => responses.addressFor(contents.id),
    renderProfiles,
  });

  // The browse guard turns a tab's gesture-backed popups into background tabs
  // (specs/browse-guard.feature.md); the hooks object is part of the one set of guard options.
  const securityOptions: SecurityOptions = {
    devServerUrl,
    browse: { openTab: (opener, url) => void browser.openTabFromPage(opener, url) },
  };

  // Installed before any WebContents exists, so none is ever left unguarded.
  registerAppWideGuards(securityOptions);

  // IPC is accepted only from the app's own windows (a live set) on an accepted origin; the same
  // registry decides who may load app://.
  const windows = createWindowRegistry();
  const senderPolicy = createSenderPolicy({ knownWindowIds: windows.knownWindowIds, devServerUrl });

  function openMainWindow(): void {
    const win = createMainWindow();
    windows.track(win);
    registerSecurity(session.defaultSession, win, securityOptions);
    browser.attach(win);
    // The devtools drawer's full capture lasts only while an open window has it open.
    const windowId = win.id;
    win.once('closed', () => devtools.setOpen(windowId, false));
    loadRenderer(win, { devServerUrl }).catch((err: unknown) => {
      console.error('failed to load renderer', err);
      app.quit();
    });
  }

  void app.whenReady().then(async () => {
    // Only the app's own windows (and their DevTools) may load app:// (APP_REQUEST_FILTER in
    // specs/app-protocol.spec.ts); this owns the session's single onBeforeRequest listener.
    restrictAppRequests(session.defaultSession, windows.isAppWebContents);
    // Tabs' session: no `app:` handler (protocol.handle below is the default session's), per-origin
    // permission prompts (everything not promptable denied), and every download cancelled with a notice.
    const browseSession = session.fromPartition(BROWSE_PARTITION);
    // The browse session's main-frame observers (the one owner of its onBeforeRedirect /
    // onResponseStarted / onErrorOccurred: browser/web-request.ts) and its robots.txt fetcher.
    observeMainFrames(browseSession, responses);
    // One bounded fetcher for every request made on the user's behalf (specs/fetcher.spec.ts): its
    // per-origin queues are shared by robots.txt and the served HTML.
    const hop = netHop(net, browseSession);
    const fetcher = createBoundedFetcher({ hop });
    robots = createRobotsFetcher({ hop, fetcher });
    served = createServedHtml({ fetcher, parse: (input) => analyzer.parseServed(input) });
    observeRequests(browseSession, devtools.observer);
    hardenBrowseSession(browseSession, {
      onDownloadBlocked: (contents) => browser.downloadBlocked(contents),
      permissions: createBrowsePermissionHandlers({
        broker: permissions,
        tabIdOf: (contents) => browser.tabIdOf(contents),
        isFullscreen: (tabId) => browser.isFullscreen(tabId),
      }),
    });
    // Main and preload are bundled side by side into .vite/build (CJS); the renderer is in .vite/renderer.
    handleAppProtocol(path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME));
    attachIpcHandler({
      router: appRouter,
      policy: senderPolicy,
      ipcMain,
      fromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
      services: {
        browser,
        seo: browser.seo,
        // The JavaScript panel's "Fetch again" (specs/seo-javascript.feature.md): the tab's served HTML
        // for its current URL is forgotten and the tab audited again.
        javascript: {
          refetchServed: (tabId) => {
            const contents = webContents.getAllWebContents().find((c) => !c.isDestroyed() && isBrowseContents(c) && browser.tabIdOf(c) === tabId);
            if (!contents || !served) return false;
            served.drop(contents.id, contents.getURL());
            return browser.seo.rerun(tabId) === true;
          },
        },
        // The Content panel's notes (local, in the session database) and Copy as HTML (specs/seo-content.feature.md).
        content: createContentService({
          notes: sessionStore.contentNotes,
          audit: (tabId) => browser.seo.getAudit(tabId),
          clipboard,
          log: logSession,
          confirmClearAll: () => confirmClearContentNotes(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null),
        }),
        // The SEO devtools drawer (specs/devtools.feature.md).
        devtools,
      },
    });
    // Clear Browsing Data… (specs/browser-session-db.feature.md): asks in a message box parented
    // to the focused window (else the app's), then clears visits, decisions and site storage.
    clearBrowsingData = createClearBrowsingData({
      confirm: () => confirmClearBrowsingData(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null),
      forgetPermissionDecisions: () => permissions.forgetDecisions(),
      clearStoredData: () => sessionStore.writer.clearBrowsingData(),
      clearBrowseStorage,
      // The SEO auditor's robots.txt answers and recorded responses (seo-indexability.feature.md).
      forgetSeoCaches: () => {
        robots?.clear();
        responses.clear();
        served?.clear();
        devtools.clear();
        // Pinned render profiles go with the stored ones (specs/render-profile.feature.md).
        browser.forgetRenderProfilePins();
      },
      // Only when the dialog's checkbox was ticked (specs/seo-content.feature.md).
      clearContentNotes: () => sessionStore.contentNotes.clearAll(),
      log: logSession,
    });
    // Tab shortcuts (Cmd/Ctrl+T, W, L, 1…9) and page commands (reload, back, zoom …) are menu
    // accelerators calling the controller directly (specs/tabs.feature.md, page-commands.feature.md).
    installAppMenu({ ...browser, clearBrowsingData: () => void clearBrowsingData?.() });
    // What the last launch saved, after the sessions are hardened and before any tab or window
    // exists: remembered decisions answer the first requests, and the chrome's first state already
    // has the restored tabs.
    const saved = await loadSavedState(sessionStore, logSession);
    decisions.load(saved.decisions);
    renderProfilePins.load(await sessionStore.repository.loadRenderProfilePins().catch(() => []));
    browser.restoreSession(saved.session);
    openMainWindow();
    markStarted();
  });

  // macOS: re-create a window when the dock icon is clicked and none are open.
  reopenOnActivate(app, windowOptions);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/** Whether `contents` is a tab's (on the browse partition's session); fails closed. */
function isBrowseContents(contents: WebContents): boolean {
  try {
    return contents.session === session.fromPartition(BROWSE_PARTITION);
  } catch {
    return false;
  }
}
