import path from 'node:path';
import { BrowserWindow } from 'electron';
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
 * Loads the renderer into `win`: the Vite dev server under `electron-forge start`, the bundled
 * index.html otherwise. Phase 0 Task 4 replaces the file load with the privileged `app://` scheme.
 */
export function loadRenderer(win: BrowserWindow): Promise<void> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  }
  return win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}
