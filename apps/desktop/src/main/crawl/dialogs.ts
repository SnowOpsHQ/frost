import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import type { CrawlIpcService } from '@app/ipc-contract';
import { CRAWL_CSV_SAVE_DIALOG } from '@app/specs/site-crawl.spec';
import type { CrawlMain } from './index';
import { createCrawlIpcService } from './ipc';

// Main's own save dialog for the site crawl's CSV, and the crawl IPC service over Electron (Phase 12
// Task 7; acceptance `site-crawl.feature.md`, Pages and Site structure: Main). As the rank CSV's
// (`changes/rank-dialogs.ts`): a native save dialog parented to the window that asked (else the focused
// one, else any open one; with none, app-modal), titled `CRAWL_CSV_SAVE_DIALOG.title`, a CSV filter and
// overwrite confirmation, offering main's file name in the Downloads folder. The renderer never names a
// path. Main `index.ts` creates the service with one line.

/** Offered in the Downloads folder (the user may go anywhere from there). */
function inDownloads(name: string): string {
  try {
    return path.join(app.getPath('downloads'), name);
  } catch {
    return name;
  }
}

/** App window `windowId` when it is open, else the focused window, else any open one; `null` with none. */
function parentWindow(windowId: number | null): BrowserWindow | null {
  const asked = windowId === null ? null : BrowserWindow.fromId(windowId);
  if (asked && !asked.isDestroyed()) return asked;
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

/** The file the user chose for the crawl CSV (an absolute path), or `null` (cancelled). */
export async function chooseCrawlCsvPath(windowId: number | null, defaultName: string): Promise<string | null> {
  const options = {
    title: CRAWL_CSV_SAVE_DIALOG.title,
    buttonLabel: CRAWL_CSV_SAVE_DIALOG.buttonLabel,
    defaultPath: inDownloads(defaultName),
    filters: [{ name: CRAWL_CSV_SAVE_DIALOG.filterName, extensions: [...CRAWL_CSV_SAVE_DIALOG.extensions] }],
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const],
  };
  const parent = parentWindow(windowId);
  const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return canceled || typeof filePath !== 'string' || filePath === '' || !path.isAbsolute(filePath) ? null : filePath;
}

/** The crawl IPC service main hands the `crawl.*` procedures: `setupCrawl`'s service, tables and change counter, and main's save dialog. */
export function createMainCrawlIpc(crawl: CrawlMain, log?: (line: string) => void): CrawlIpcService {
  return createCrawlIpcService({ service: crawl.service, repo: crawl.repo, changes: crawl.changes, chooseCsvPath: chooseCrawlCsvPath, ...(log ? { log } : {}) });
}
