// Spec: specs/seo-content.spec.ts (CLEAR_CONTENT_NOTES)
// Acceptance: specs/seo-content.feature.md (Copy: clear-all-notes-asks-first)
import { dialog } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { CLEAR_CONTENT_NOTES } from '@app/specs/seo-content.spec';
import type { FakeBrowserWindow } from '../../../test/electron-fake';
import { confirmClearContentNotes } from '../content-notes-dialog';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

describe('delete all notes dialog', () => {
  test('clear-all-notes-dialog', async () => {
    const showMessageBox = vi.mocked(dialog.showMessageBox);
    const parent = { id: 1 } as unknown as FakeBrowserWindow;
    const options = { ...CLEAR_CONTENT_NOTES.dialog, buttons: [...CLEAR_CONTENT_NOTES.dialog.buttons] };
    showMessageBox.mockResolvedValueOnce({ response: CLEAR_CONTENT_NOTES.confirmIndex, checkboxChecked: false });
    await expect(confirmClearContentNotes(parent as never)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenLastCalledWith(parent, options);
    for (const response of [CLEAR_CONTENT_NOTES.dialog.cancelId, 5]) {
      showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
      await expect(confirmClearContentNotes(null)).resolves.toBe(false);
    }
    expect(showMessageBox.mock.lastCall).toEqual([options]);
    // Cancel is the default.
    expect(CLEAR_CONTENT_NOTES.dialog.defaultId).toBe(CLEAR_CONTENT_NOTES.dialog.cancelId);
  });
});
