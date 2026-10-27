import { dialog, type BaseWindow } from 'electron';
import { CLEAR_HISTORY } from '@app/specs/browser-polish.spec';

// "Clear all history" asks first (spec `browser-polish.spec.ts`, `CLEAR_HISTORY`; acceptance
// `browser-polish.feature.md`, History view): a native message box main shows, parented to `parent`
// (with none, an app-modal box). Only `CLEAR_HISTORY.confirmIndex` confirms; Cancel is the default.

export async function confirmClearHistory(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...CLEAR_HISTORY.dialog, buttons: [...CLEAR_HISTORY.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_HISTORY.confirmIndex;
}
