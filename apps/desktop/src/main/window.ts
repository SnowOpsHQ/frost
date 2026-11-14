import path from 'node:path';
import { BrowserWindow, WebContentsView } from 'electron';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { CHROME_MIN_CONTENT_WIDTH_PX } from '@app/specs/tabs.spec';
import { isLocationPartition, LOCATION_WEBRTC_POLICY } from '@app/specs/location-profiles.spec';

/**
 * Creates the app's main window. The four security-critical webPreferences are set explicitly
 * (never left to Electron defaults) per `specs/window-hardening.spec.ts` / design doc §3.
 *
 * They are written as literals, inline in `new BrowserWindow({…})`, so the Electronegativity CI gate
 * can see them (it resolves neither `HARDENED_WEB_PREFERENCES.*` nor `satisfies`; spec
 * `ci-gates.feature.md`). `boot.test.ts` keeps them equal to `HARDENED_WEB_PREFERENCES`.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
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
  keepChromeRowWhole(win);
  return win;
}

/**
 * Keeps the window's content at least `CHROME_MIN_CONTENT_WIDTH_PX` wide, what the chrome row needs to
 * fit whole (`tabs.feature.md`, The chrome row): the minimum size counts the frame, so it is that plus
 * the frame's width (size less content size); the minimum height stays as it is. (A `minWidth` with
 * `useContentSize` would be a content constraint Electron neither reports nor lets a test read.)
 */
function keepChromeRowWhole(win: BrowserWindow): void {
  const [outer = 0] = win.getSize();
  const [inner = 0] = win.getContentSize();
  const [, minHeight = 0] = win.getMinimumSize();
  win.setMinimumSize(CHROME_MIN_CONTENT_WIDTH_PX + Math.max(0, outer - inner), minHeight);
}

/**
 * Creates a tab's page view (spec `TAB_VIEW_WEB_PREFERENCES` in `specs/browser.spec.ts`): the four
 * hardened webPreferences as literals (for Electronegativity, as above), the caller's partition (the
 * browse partition unless it names another browse-class one, `browser.spec.ts`), JavaScript
 * dialogs off, and **no preload**, so browsed content never gets the IPC bridge. The caller picks
 * the partition only, never the preferences. `tab-view.test.ts` keeps the options equal to the
 * spec. The app-wide guard (`security/register.ts`) classifies the new WebContents by its session
 * (the browse-class registry) and applies the browse guard; on a session that is not browse-class
 * it keeps the app pin (fail closed). On a location partition (`frost-location-<id>`) the view's
 * WebContents also gets `LOCATION_WEBRTC_POLICY` before it is returned.
 */
export function createTabView(partition: string = BROWSE_PARTITION): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition,
      // No native alert/confirm/prompt owned by frost with no origin on it (a Phase 1 limit:
      // `browse-guard.feature.md`, JavaScript dialogs).
      disableDialogs: true,
    },
  });
  // A location profile's tab (Phase 12 Task 10b, `location-profiles.spec.ts`): WebRTC may use only
  // proxied UDP. A WebContents setting (no session has it), applied here, before the caller can load
  // anything in the view.
  if (isLocationPartition(partition)) view.webContents.setWebRTCIPHandlingPolicy(LOCATION_WEBRTC_POLICY);
  return view;
}

/**
 * Loads the renderer into `win`: the Vite dev server when `devServerUrl` is given (unpackaged
 * `electron-forge start` only), otherwise the bundled renderer over the privileged `app://` scheme
 * (spec `app-protocol.spec.ts`). Never `file://`.
 */
export function loadRenderer(win: BrowserWindow, opts: { devServerUrl: string | undefined }): Promise<void> {
  return win.loadURL(opts.devServerUrl ?? APP_ENTRY_URL);
}
