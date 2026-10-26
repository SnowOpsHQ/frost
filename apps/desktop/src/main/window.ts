import path from 'node:path';
import { BrowserWindow, WebContentsView } from 'electron';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';

/**
 * Creates the app's main window. The four security-critical webPreferences are set explicitly
 * (never left to Electron defaults) per `specs/window-hardening.spec.ts` / design doc §3.
 *
 * They are written as literals, inline in `new BrowserWindow({…})`, so the Electronegativity CI gate
 * can see them (it resolves neither `HARDENED_WEB_PREFERENCES.*` nor `satisfies`; spec
 * `ci-gates.feature.md`). `boot.test.ts` keeps them equal to `HARDENED_WEB_PREFERENCES`.
 */
export function createMainWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'frost',
    // Linux/Windows: the menu bar stays out of the way until Alt (spec `tabs.feature.md`, Window).
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Main and preload are bundled side by side into .vite/build as CommonJS; `__dirname` relies on
      // that CJS output (Forge 8 emits main as CJS).
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
}

/**
 * Creates a tab's page view (spec `TAB_VIEW_WEB_PREFERENCES` in `specs/browser.spec.ts`): the four
 * hardened webPreferences as literals (for Electronegativity, as above), the browse partition, and
 * **no preload**, so browsed content never gets the IPC bridge. `tab-view.test.ts` keeps the
 * options equal to the spec. The app-wide guard (`security/register.ts`) classifies the new
 * WebContents by its session and applies the browse guard.
 */
export function createTabView(): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: BROWSE_PARTITION,
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
