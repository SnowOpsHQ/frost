import { dialog, type BaseWindow } from 'electron';
import { CLEAR_CONTENT_NOTES } from '@app/specs/seo-content.spec';

// "Delete all notes" asks first (spec `seo-content.spec.ts`, `CLEAR_CONTENT_NOTES`; acceptance
// `seo-content.feature.md`): a native message box main shows, parented to `parent` (with none, an
// app-modal box). Only `CLEAR_CONTENT_NOTES.confirmIndex` confirms; Cancel is the default.

export async function confirmClearContentNotes(parent: BaseWindow | null): Promise<boolean> {
  const options = { ...CLEAR_CONTENT_NOTES.dialog, buttons: [...CLEAR_CONTENT_NOTES.dialog.buttons] };
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === CLEAR_CONTENT_NOTES.confirmIndex;
}
