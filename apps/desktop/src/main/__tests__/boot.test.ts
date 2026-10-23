// Spec: specs/window-hardening.spec.ts · Acceptance: specs/window-hardening.feature.md
// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md (Loading the renderer)
import { describe, expect, test, vi } from 'vitest';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
import type { FakeBrowserWindow } from '../../test/electron-fake';
import { createMainWindow, loadRenderer } from '../window';

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

  test('sets no webPreferences beyond the hardened set', () => {
    const win = createMainWindow() as unknown as FakeBrowserWindow;
    const keys = Object.keys(win.options.webPreferences ?? {}).sort();
    expect(keys).toEqual([...Object.keys(HARDENED_WEB_PREFERENCES), 'preload'].sort());
  });
});

describe('loading the renderer', () => {
  test('loads-renderer-from-app-scheme', async () => {
    const win = createMainWindow() as unknown as FakeBrowserWindow;
    await loadRenderer(win as never, { devServerUrl: undefined });
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith(APP_ENTRY_URL);
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  test('loads-dev-server-only-when-given', async () => {
    const win = createMainWindow() as unknown as FakeBrowserWindow;
    await loadRenderer(win as never, { devServerUrl: 'http://localhost:5173' });
    expect(win.loadURL).toHaveBeenCalledExactlyOnceWith('http://localhost:5173');
    expect(win.loadFile).not.toHaveBeenCalled();
  });
});
