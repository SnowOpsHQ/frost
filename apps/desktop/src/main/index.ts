import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow, clipboard, ipcMain, net, session, type WebContents } from 'electron';
import { appRouter, createSenderPolicy } from '@app/ipc-contract';
import { attachIpcHandler } from '@app/ipc-contract/main';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { createWindowRegistry } from './app-windows';
import { contextMenuTemplate } from './browser/context-menu';
import { createBrowserController, type TabContextMenuRequest } from './browser/controller';
import { hardenBrowseSession } from './browser/guard';
import { createBrowsePermissionHandlers, createPermissionBroker, createPersistentDecisionStore } from './browser/permissions';
import { clearBrowseStorage, confirmClearBrowsingData, createClearBrowsingData } from './clear-browsing-data';
import { installAppMenu, popupContextMenu } from './menu';
import { handleAppProtocol, registerAppScheme } from './protocol/register';
import { restrictAppRequests } from './protocol/requests';
import { createAnalyzer } from './seo/analysis';
import { runExtractor } from './seo/extract';
import { runHighlight, watchHighlight } from './seo/highlight';
import { createResponseRecorder } from './seo/responses';
import { createRobotsFetcher, netHop, type RobotsFetcher } from './seo/robots-fetch';
import { observeMainFrames } from './browser/web-request';
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
  const collectContext = async (contents: WebContents) => {
    const url = contents.getURL();
    return { response: responses.responseFor(contents.id, url), robots: robots ? await robots.get(url) : null };
  };
  app.on('web-contents-created', (_event, contents) => {
    if (isBrowseContents(contents)) responses.watch(contents);
  });
  const browser = createBrowserController({
    createView: createTabView,
    openWindow: () => openMainWindow(),
    permissions,
    session: sessionStore.writer,
    contextMenu: showContextMenu,
    seo: { extract: runExtractor, analyse: (raw, context) => analyzer.analyse(raw, context), context: collectContext },
    highlight: { paint: runHighlight, ended: watchHighlight },
    clipboard,
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
    robots = createRobotsFetcher({ hop: netHop(net, browseSession) });
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
      services: { browser, seo: browser.seo },
    });
    // Clear Browsing Data… (specs/browser-session-db.feature.md): asks in a message box parented
    // to the focused window (else the app's), then clears visits, decisions and site storage.
    const clearBrowsingData = createClearBrowsingData({
      confirm: () => confirmClearBrowsingData(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null),
      forgetPermissionDecisions: () => permissions.forgetDecisions(),
      clearStoredData: () => sessionStore.writer.clearBrowsingData(),
      clearBrowseStorage,
      log: logSession,
    });
    // Tab shortcuts (Cmd/Ctrl+T, W, L, 1…9) and page commands (reload, back, zoom …) are menu
    // accelerators calling the controller directly (specs/tabs.feature.md, page-commands.feature.md).
    installAppMenu({ ...browser, clearBrowsingData: () => void clearBrowsingData() });
    // What the last launch saved, after the sessions are hardened and before any tab or window
    // exists: remembered decisions answer the first requests, and the chrome's first state already
    // has the restored tabs.
    const saved = await loadSavedState(sessionStore, logSession);
    decisions.load(saved.decisions);
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
