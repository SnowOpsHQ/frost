import path from 'node:path';
import { BrowserWindow } from 'electron';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';

/**
 * Creates the app's main window. The four security-critical webPreferences are set explicitly
 * (never left to Electron defaults) per `specs/window-hardening.spec.ts` / design doc §3.
 */
export function createMainWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'frost',
    webPreferences: {
      sandbox: HARDENED_WEB_PREFERENCES.sandbox,
      contextIsolation: HARDENED_WEB_PREFERENCES.contextIsolation,
      nodeIntegration: HARDENED_WEB_PREFERENCES.nodeIntegration,
      webSecurity: HARDENED_WEB_PREFERENCES.webSecurity,
      // Main and preload are bundled side by side into .vite/build as CommonJS; `__dirname` relies on
      // that CJS output (Forge 8 emits main as CJS).
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
}

/**
 * Loads the renderer into `win`: the Vite dev server when `devServerUrl` is given (unpackaged
 * `electron-forge start` only), otherwise the bundled renderer over the privileged `app://` scheme
 * (spec `app-protocol.spec.ts`). Never `file://`.
 */
export function loadRenderer(win: BrowserWindow, opts: { devServerUrl: string | undefined }): Promise<void> {
  return win.loadURL(opts.devServerUrl ?? APP_ENTRY_URL);
}
