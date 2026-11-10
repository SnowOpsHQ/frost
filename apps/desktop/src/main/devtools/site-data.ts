import path from 'node:path';
import { app, BrowserWindow, dialog, session, type BaseWindow } from 'electron';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { CLEAR_SITE_DATA, NETWORK_EXPORT_DIALOG, type NetworkExportFormat } from '@app/specs/devtools.spec';
import { writePrivateFile } from '../private-file';
import type { NetworkExportIo } from './network-export';

// "Clear this site's data" (spec `devtools.spec.ts`, `CLEAR_SITE_DATA`; acceptance
// `devtools.feature.md`, Storage): main's own confirmation and the clearing, on the browse
// partition only (never the app's session).

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

/** Clears `origin`'s cookies (its whole registrable domain, as Chromium does), storage and cache from the browse partition. */
export async function clearBrowseOrigin(origin: string): Promise<void> {
  await session.fromPartition(BROWSE_PARTITION).clearData({ origins: [origin], dataTypes: [...CLEAR_SITE_DATA.dataTypes] });
}

/** The browse partition's cookies for `url`. */
export function browseCookies(url: string): Promise<Electron.Cookie[]> {
  return session.fromPartition(BROWSE_PARTITION).cookies.get({ url });
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
