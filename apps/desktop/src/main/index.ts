import path from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { appRouter, createSenderPolicy } from '@app/ipc-contract';
import { attachIpcHandler } from '@app/ipc-contract/main';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { createWindowRegistry } from './app-windows';
import { createBrowserController } from './browser/controller';
import { hardenBrowseSession } from './browser/guard';
import { installAppMenu } from './menu';
import { handleAppProtocol, registerAppScheme } from './protocol/register';
import { restrictAppRequests } from './protocol/requests';
import { remoteDebuggingRefusal } from './security/policy';
import { registerAppWideGuards, registerSecurity, type SecurityOptions } from './security/register';
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
}

// Global backstop: every renderer is sandboxed even if a future WebContents forgets the explicit pref.
app.enableSandbox();

// Privileged schemes must be registered before the app is ready.
registerAppScheme();

// The Vite dev-server origin is trusted (navigation, IPC sender, renderer source) only when
// unpackaged under `electron-forge start` (specs/security-policy.spec.ts, ipc-sender.spec.ts).
const devServerUrl = app.isPackaged ? undefined : MAIN_WINDOW_VITE_DEV_SERVER_URL;

// Main owns all browser state; the chrome drives it only through the sender-guarded `browser.*`
// procedures (specs/browser-chrome.feature.md). Tab views come from the allowlisted factory.
// New Tab with no window open (macOS) opens the window instead of adding a hidden tab.
const browser = createBrowserController({ createView: createTabView, openWindow: () => openMainWindow() });

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

void app.whenReady().then(() => {
  // Only the app's own windows (and their DevTools) may load app:// (APP_REQUEST_FILTER in
  // specs/app-protocol.spec.ts); this owns the session's single onBeforeRequest listener.
  restrictAppRequests(session.defaultSession, windows.isAppWebContents);
  // Tabs' session: no `app:` handler (protocol.handle below is the default session's),
  // deny-by-default permissions until Task 4's prompts, and every download cancelled with a notice.
  hardenBrowseSession(session.fromPartition(BROWSE_PARTITION), { onDownloadBlocked: () => browser.notify('download-blocked') });
  // Main and preload are bundled side by side into .vite/build (CJS); the renderer is in .vite/renderer.
  handleAppProtocol(path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME));
  attachIpcHandler({
    router: appRouter,
    policy: senderPolicy,
    ipcMain,
    fromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
    services: { browser },
  });
  // Tab shortcuts (Cmd/Ctrl+T, W, L, 1…9) are menu accelerators calling the controller directly
  // (specs/tabs.feature.md).
  installAppMenu(browser);
  openMainWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
