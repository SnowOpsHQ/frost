// Spec: specs/browser-session-db.spec.ts (CLEAR_BROWSING_DATA), specs/browser.spec.ts (BROWSE_PARTITION)
// Acceptance: specs/browser-session-db.feature.md (Clear browsing data)
import { dialog, session } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import type { FakeBrowserWindow, FakeSession } from '../../test/electron-fake';
import { clearBrowseStorage, confirmClearBrowsingData, createClearBrowsingData, type ClearBrowsingDataParts } from '../clear-browsing-data';

vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());

/** Parts that record the order they ran in; `confirm` answers `confirmed`. */
function fakeParts(confirmed: boolean) {
  const order: string[] = [];
  const parts = {
    confirm: vi.fn(async () => {
      order.push('confirm');
      return confirmed;
    }),
    forgetPermissionDecisions: vi.fn(() => {
      order.push('forget');
    }),
    clearStoredData: vi.fn(async () => {
      order.push('stored');
    }),
    clearBrowseStorage: vi.fn(async () => {
      order.push('storage');
    }),
    forgetSeoCaches: vi.fn(() => {
      order.push('seo');
    }),
    log: vi.fn<(message: string) => void>(),
  } satisfies ClearBrowsingDataParts;
  return { parts, order };
}

describe('clear browsing data', () => {
  test('clear-asks-first', async () => {
    const { parts, order } = fakeParts(false);
    await expect(createClearBrowsingData(parts)()).resolves.toBe(false);
    expect(order).toEqual(['confirm']);
    // A confirmation that fails is no confirmation.
    parts.confirm.mockRejectedValueOnce(new Error('no window'));
    await expect(createClearBrowsingData(parts)()).resolves.toBe(false);
    expect(order).toEqual(['confirm']);
    expect(parts.forgetPermissionDecisions).not.toHaveBeenCalled();
  });

  test('clear-clears-everything', async () => {
    const { parts, order } = fakeParts(true);
    const clear = createClearBrowsingData(parts);
    await expect(clear()).resolves.toBe(true);
    // The SEO auditor's robots.txt cache and recorded responses go too (seo-indexability.feature.md).
    expect(order).toEqual(['confirm', 'forget', 'stored', 'storage', 'seo']);
    expect(parts.log).not.toHaveBeenCalled();
    // A second request while one runs is the same run (one dialog), and a later one asks again.
    const [first, second] = [clear(), clear()];
    expect(second).toBe(first);
    await first;
    expect(parts.confirm).toHaveBeenCalledTimes(2);
  });

  test('clear-goes-on-after-a-failure', async () => {
    const { parts, order } = fakeParts(true);
    parts.forgetPermissionDecisions.mockImplementationOnce(() => {
      throw new Error('broker gone');
    });
    parts.clearStoredData.mockRejectedValueOnce(new Error('disk I/O error'));
    await expect(createClearBrowsingData(parts)()).resolves.toBe(true);
    expect(order).toEqual(['confirm', 'storage', 'seo']);
    expect(parts.clearBrowseStorage).toHaveBeenCalledOnce();
    expect(parts.log).toHaveBeenCalledTimes(2);
    expect(parts.log.mock.calls.map(([message]) => message).join('\n')).toMatch(/broker gone[\s\S]*disk I\/O error/);
  });

  test('clear-dialog-options', async () => {
    const showMessageBox = vi.mocked(dialog.showMessageBox);
    const parent = { id: 1 } as unknown as FakeBrowserWindow;
    showMessageBox.mockResolvedValueOnce({ response: CLEAR_BROWSING_DATA.confirmIndex, checkboxChecked: false });
    await expect(confirmClearBrowsingData(parent as never)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenLastCalledWith(parent, { ...CLEAR_BROWSING_DATA.dialog, buttons: [...CLEAR_BROWSING_DATA.dialog.buttons] });
    // Cancel (the default and cancel answer) does not confirm; nor does any other answer.
    for (const response of [CLEAR_BROWSING_DATA.dialog.cancelId, 7]) {
      showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
      await expect(confirmClearBrowsingData(parent as never)).resolves.toBe(false);
    }
    // No window: an app-modal box.
    showMessageBox.mockResolvedValueOnce({ response: CLEAR_BROWSING_DATA.confirmIndex, checkboxChecked: false });
    await expect(confirmClearBrowsingData(null)).resolves.toBe(true);
    expect(showMessageBox.mock.lastCall).toEqual([{ ...CLEAR_BROWSING_DATA.dialog, buttons: [...CLEAR_BROWSING_DATA.dialog.buttons] }]);
    expect(CLEAR_BROWSING_DATA.dialog.buttons[CLEAR_BROWSING_DATA.confirmIndex]).toBe('Clear Browsing Data');
    expect(CLEAR_BROWSING_DATA.dialog.defaultId).toBe(CLEAR_BROWSING_DATA.dialog.cancelId);
  });

  test('clear-browse-storage', async () => {
    const browse = session.fromPartition(BROWSE_PARTITION) as unknown as FakeSession;
    const app = session.defaultSession as unknown as FakeSession;
    await clearBrowseStorage();
    expect(browse.clearStorageData).toHaveBeenCalledOnce();
    expect(browse.clearCache).toHaveBeenCalledOnce();
    expect(browse.clearStorageData.mock.invocationCallOrder[0]!).toBeLessThan(browse.clearCache.mock.invocationCallOrder[0]!);
    expect(app.clearStorageData).not.toHaveBeenCalled();
    expect(app.clearCache).not.toHaveBeenCalled();
  });
});
