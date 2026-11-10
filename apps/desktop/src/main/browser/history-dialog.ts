import { dialog, type BaseWindow } from 'electron';
import {
  CLEAR_HISTORY,
  CLEAR_HISTORY_RANGE,
  clearHistoryRangeMessage,
  CONFIRM_HISTORY_RETENTION,
  confirmHistoryRetentionText,
  type HistoryClearRange,
  type HistoryRetention,
} from '@app/specs/browser-polish.spec';

// "Clear all history" asks first (spec `browser-polish.spec.ts`, `CLEAR_HISTORY`; acceptance
// `browser-polish.feature.md`, History view): a native message box main shows, parented to `parent`
// (with none, an app-modal box). Only `CLEAR_HISTORY.confirmIndex` confirms; Cancel is the default.

export async function confirmClearHistory(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...CLEAR_HISTORY.dialog, buttons: [...CLEAR_HISTORY.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_HISTORY.confirmIndex;
}

/**
 * Clear by range asks first too (Phase 11 Task 10; `CLEAR_HISTORY_RANGE`, its message naming the
 * range, its detail stating that history keeps one entry per page). Cancel is the default.
 */
export async function confirmClearHistoryRange(parent: BaseWindow | null, range: HistoryClearRange): Promise<boolean> {
  const options = { ...CLEAR_HISTORY_RANGE.dialog, message: clearHistoryRangeMessage(range), buttons: [...CLEAR_HISTORY_RANGE.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_HISTORY_RANGE.confirmIndex;
}

/**
 * A retention change that would delete visits asks first (Phase 11 Task 10; `CONFIRM_HISTORY_RETENTION`,
 * naming the new retention). Cancel is the default.
 */
export async function confirmHistoryRetention(parent: BaseWindow | null, stored: { readonly retention: HistoryRetention }, next: { readonly retention: HistoryRetention }): Promise<boolean> {
  const { message, detail } = confirmHistoryRetentionText(stored, next);
  const { type, buttons, defaultId, cancelId, noLink } = CONFIRM_HISTORY_RETENTION.dialog;
  const options = { type, message, detail, buttons: [...buttons], defaultId, cancelId, noLink };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CONFIRM_HISTORY_RETENTION.confirmIndex;
}
