// Spec: specs/window-hardening.spec.ts · Acceptance: specs/window-hardening.feature.md
import { describe, expect, test, vi } from 'vitest';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
import type { FakeBrowserWindow } from '../../test/electron-fake';
import { createMainWindow } from '../window';

vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());

describe('main window hardening', () => {
  test('createMainWindow returns a window with hardened webPreferences', () => {
    const win = createMainWindow();
    const wp = win.webContents.getLastWebPreferences();
    expect(wp).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(wp).toMatchObject(HARDENED_WEB_PREFERENCES);
  });

  test.each(Object.entries(HARDENED_WEB_PREFERENCES))('sets %s explicitly', (key, value) => {
    const win = createMainWindow() as unknown as FakeBrowserWindow;
    const webPreferences = win.options.webPreferences ?? {};
    expect(Object.hasOwn(webPreferences, key)).toBe(true);
    expect(webPreferences[key as keyof typeof webPreferences]).toBe(value);
  });
});
