import path from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { appRouter, createSenderPolicy } from '@app/ipc-contract';
import { attachIpcHandler } from '@app/ipc-contract/main';
import { createWindowRegistry } from './app-windows';
import { handleAppProtocol, registerAppScheme } from './protocol/register';
import { restrictAppRequests } from './protocol/requests';
import { remoteDebuggingRefusal } from './security/policy';
import { registerAppWideGuards, registerSecurity, type SecurityOptions } from './security/register';
import { createMainWindow, loadRenderer } from './window';

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
const securityOptions: SecurityOptions = { devServerUrl };

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
  loadRenderer(win, { devServerUrl }).catch((err: unknown) => {
    console.error('failed to load renderer', err);
    app.quit();
  });
}

void app.whenReady().then(() => {
  // Only the app's own windows (and their DevTools) may load app:// (APP_REQUEST_FILTER in
  // specs/app-protocol.spec.ts); this owns the session's single onBeforeRequest listener.
  restrictAppRequests(session.defaultSession, windows.isAppWebContents);
  // Main and preload are bundled side by side into .vite/build (CJS); the renderer is in .vite/renderer.
  handleAppProtocol(path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME));
  attachIpcHandler({
    router: appRouter,
    policy: senderPolicy,
    ipcMain,
    fromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
  });
  openMainWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
