import path from 'node:path';
import { app, BrowserWindow, dialog, type BaseWindow, type Cookie } from 'electron';
import { CLEAR_SITE_DATA, NETWORK_EXPORT_DIALOG, type NetworkExportFormat } from '@app/specs/devtools.spec';
import { browseClassSessionOf } from '../browser/browse-class';
import { writePrivateFile } from '../private-file';
import type { NetworkExportIo } from './network-export';
import type { SiteStorageOptions } from './storage';

// The Storage tab's cookie store and "Clear this site's data" (spec `devtools.spec.ts`,
// `CLEAR_SITE_DATA`; acceptance `devtools.feature.md`, Storage; `browser-chrome.feature.md`,
// devtools-storage-uses-the-tabs-session): main's own confirmation, and the reading and clearing on
// **the tab's own session** (its WebContents' `session`), only when that session is browse-class
// (never the app's session, never a partition lookup).

/**
 * The confirmation: `dialog.showMessageBox` with `CLEAR_SITE_DATA.dialog` and the origin in its
 * detail, parented to `parent` (with none, an app-modal box). Only `CLEAR_SITE_DATA.confirmIndex`
 * confirms; Cancel is the default and the Esc answer.
 */
export async function confirmClearSiteData(parent: BaseWindow | null, origin: string): Promise<boolean> {
  const options = { ...CLEAR_SITE_DATA.dialog, buttons: [...CLEAR_SITE_DATA.dialog.buttons], detail: CLEAR_SITE_DATA.detail(origin) };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_SITE_DATA.confirmIndex;
}

/** A tab's WebContents as far as this module reads it: its session. */
export interface TabSessionHolder {
  readonly session?: unknown;
}

/** The parts of a browse-class session read here. */
interface SiteDataSession {
  readonly cookies: { get(filter: { url: string }): Promise<Cookie[]> };
  clearData(options: { origins: string[]; dataTypes: string[] }): Promise<void>;
}

/** `contents`' own session when it is browse-class; throws otherwise (the Storage tab then shows nothing, clears nothing). */
function tabSession(contents: TabSessionHolder | null | undefined): SiteDataSession {
  const found = browseClassSessionOf(contents);
  if (!found) throw new Error('not a browse-class tab');
  return found as unknown as SiteDataSession;
}

/** Clears `origin`'s cookies (its whole registrable domain, as Chromium does), storage and cache from the tab's own (browse-class) session. */
export async function clearBrowseOrigin(contents: TabSessionHolder | null | undefined, origin: string): Promise<void> {
  await tabSession(contents).clearData({ origins: [origin], dataTypes: [...CLEAR_SITE_DATA.dataTypes] });
}

/** The tab's own (browse-class) session's cookies for `url`. */
export function browseCookies(contents: TabSessionHolder | null | undefined, url: string): Promise<Cookie[]> {
  try {
    return tabSession(contents).cookies.get({ url });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The Storage tab's cookie reads and clearing for WebContents `contentsId`, found with `contentsOf`
 * (main: its open tabs' WebContents), and its store (its browse-class session) for keying a clear in flight.
 */
export function tabSiteData(contentsOf: (contentsId: number) => TabSessionHolder | null | undefined): Pick<SiteStorageOptions, 'cookies' | 'clearOrigin' | 'storeOf'> {
  return {
    storeOf: (contentsId) => browseClassSessionOf(contentsOf(contentsId)),
    cookies: (url, contentsId) => browseCookies(contentsOf(contentsId), url),
    clearOrigin: (origin, contentsId) => clearBrowseOrigin(contentsOf(contentsId), origin),
  };
}

/**
 * The network export's save dialog (Phase 11 Task 4, Decision 5; the `agent/dialogs.ts` pattern):
 * offered in the Downloads folder, one filter for the format, overwrite confirmed; parented to the
 * window that asked (`windowId`, the IPC sender's; else app-modal), as Export Diagnostics' is.
 * `null` when the user cancelled. The chrome never names a path.
 */
export async function chooseNetworkExportPath(defaultName: string, format: NetworkExportFormat, windowId: number | null): Promise<string | null> {
  let defaultPath = defaultName;
  try {
    defaultPath = path.join(app.getPath('downloads'), defaultName);
  } catch {
    // No Downloads folder: the bare name.
  }
  const options = {
    title: NETWORK_EXPORT_DIALOG.title,
    defaultPath,
    filters: [{ name: NETWORK_EXPORT_DIALOG.filterNames[format], extensions: [NETWORK_EXPORT_DIALOG.extensions[format]] }],
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const],
  };
  const window = windowId === null ? null : BrowserWindow.fromId(windowId);
  const parent = window && !window.isDestroyed() ? window : null;
  const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return canceled || typeof filePath !== 'string' || filePath === '' ? null : filePath;
}

/** The network export's dialog and file write (mode 0600: the log can hold what the user would not share), for the devtools service. */
export const networkExportIo: Omit<NetworkExportIo, 'log' | 'appVersion'> = {
  chooseSavePath: chooseNetworkExportPath,
  writeFile: writePrivateFile,
};
