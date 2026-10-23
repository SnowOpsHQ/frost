import { app, BrowserWindow, session } from 'electron';
import { registerAppWideGuards, registerSecurity, type SecurityOptions } from './security/register';
import { createMainWindow, loadRenderer } from './window';

// Global backstop: every renderer is sandboxed even if a future WebContents forgets the explicit pref.
app.enableSandbox();

// The Vite dev-server origin is an allowed navigation target only when unpackaged under
// `electron-forge start` (specs/security-policy.spec.ts).
const securityOptions: SecurityOptions = {
  devServerUrl: app.isPackaged ? undefined : MAIN_WINDOW_VITE_DEV_SERVER_URL,
};

// Installed before any WebContents exists, so none is ever left unguarded.
registerAppWideGuards(securityOptions);

function openMainWindow(): void {
  const win = createMainWindow();
  registerSecurity(session.defaultSession, win, securityOptions);
  loadRenderer(win).catch((err: unknown) => {
    console.error('failed to load renderer', err);
    app.quit();
  });
}

void app.whenReady().then(() => {
  openMainWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
