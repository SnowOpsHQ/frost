import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog } from 'electron';
import type { ChangeIntelRepository } from '@app/db';
import type { RankingsService } from '@app/ipc-contract';
import { RANK_CSV_SAVE_DIALOG, type RankCsvKind } from '@app/specs/rankings.spec';
import { createRankingsService } from './rankings';

// Main's own save dialog for the rank CSV, and the rankings service over Electron (Phase 10 Task 5;
// Decision 14; acceptance `rankings.feature.md`, Export). As chat export's (`main/agent/dialogs.ts`
// `chooseExportPath`): a native save dialog parented to the window that asked (else the focused one,
// else any open one; with none, app-modal), titled `RANK_CSV_SAVE_DIALOG.title[kind]`, a CSV filter and
// overwrite confirmation, offering the name main chose in the Downloads folder. The renderer never names
// a path: the file is only ever the one picked here. Copy CSV writes main's clipboard. Main `index.ts`
// creates the service with one line.

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

/** The file the user chose for the rank CSV (an absolute path), or `null` (cancelled). */
export async function chooseRankCsvPath(windowId: number | null, defaultName: string, kind: RankCsvKind): Promise<string | null> {
  const options = {
    title: RANK_CSV_SAVE_DIALOG.title[kind],
    buttonLabel: RANK_CSV_SAVE_DIALOG.buttonLabel,
    defaultPath: inDownloads(defaultName),
    filters: [{ name: RANK_CSV_SAVE_DIALOG.filterName, extensions: [...RANK_CSV_SAVE_DIALOG.extensions] }],
    properties: ['createDirectory' as const, 'showOverwriteConfirmation' as const],
  };
  const parent = parentWindow(windowId);
  const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  return canceled || typeof filePath !== 'string' || filePath === '' || !path.isAbsolute(filePath) ? null : filePath;
}

/** The rankings service main hands the `rankings.*` procedures: its clipboard, its save dialog, owner-only files. */
export function createMainRankings({ store, log }: { readonly store: ChangeIntelRepository; readonly log: (message: string) => void }): RankingsService {
  return createRankingsService({ store, clipboard, chooseCsvPath: chooseRankCsvPath, log });
}
