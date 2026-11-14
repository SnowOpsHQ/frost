// Spec: specs/window-hardening.spec.ts · Acceptance: specs/window-hardening.feature.md
// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md (Loading the renderer)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { ADDRESS_MIN_WIDTH_PX, CHROME_MIN_CONTENT_WIDTH_PX, CHROME_ROW, TAB_MIN_WIDTH_PX } from '@app/specs/tabs.spec';
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

describe('main window', () => {
  // Acceptance: specs/tabs.feature.md (Window)
  test.each(['darwin', 'linux', 'win32'] as const)('menu-bar-auto-hides-off-macos (%s)', (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const win = createMainWindow() as unknown as FakeBrowserWindow;
      expect(win.options.autoHideMenuBar).toBe(platform !== 'darwin');
      expect(win.options.webPreferences).toMatchObject(HARDENED_WEB_PREFERENCES);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  // Acceptance: specs/tabs.feature.md (The chrome row: minimum window width)
  test('window-has-a-minimum-content-width', () => {
    const tokens = readFileSync(fileURLToPath(new URL('../../renderer/tokens.css', import.meta.url)), 'utf8');
    const px = (name: string) => Number(tokens.match(new RegExp(`${name}:\\s*(\\d+)px;`))![1]);
    const [space1, space4, control] = [px('--space-1'), px('--space-4'), px('--h-control')];
    expect([space1, space4, control]).toEqual([4, 12, 34]);
    // Tools and gaps counted from CHROME_ROW: a new tool raises the minimum, or this goes red.
    const tools = CHROME_ROW.filter((id) => id !== 'tab-strip' && id !== 'address').length;
    const gaps = CHROME_ROW.length - 1;
    const row = 2 * space4 + tools * control + gaps * space1 + (TAB_MIN_WIDTH_PX + 2 * space1) + ADDRESS_MIN_WIDTH_PX;
    expect(row).toBe(CHROME_MIN_CONTENT_WIDTH_PX);
    expect(CHROME_MIN_CONTENT_WIDTH_PX).toBe(588);
    // The minimum counts the frame (the fake's is 16px wide): the content's minimum plus it; the height is kept.
    const win = createMainWindow() as unknown as FakeBrowserWindow;
    expect(win.getMinimumSize()).toEqual([CHROME_MIN_CONTENT_WIDTH_PX + 16, 0]);
    expect(win.getMinimumSize()[0] - (win.getSize()[0] - win.getContentSize()[0])).toBe(CHROME_MIN_CONTENT_WIDTH_PX);
  });

  // Acceptance: specs/tabs.feature.md (The chrome row: window controls and dragging stay the OS's)
  test.each(['darwin', 'linux', 'win32'] as const)('window-keeps-native-controls (%s)', (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const options = (createMainWindow() as unknown as FakeBrowserWindow).options as Record<string, unknown>;
      for (const key of ['frame', 'titleBarStyle', 'titleBarOverlay', 'trafficLightPosition']) expect(Object.hasOwn(options, key), key).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
    const renderer = fileURLToPath(new URL('../../renderer/', import.meta.url));
    const sheets = (readdirSync(renderer, { recursive: true }) as string[]).filter((name) => name.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(5);
    const dragging = sheets.filter((name) => /(^|[\s;{-])app-region\s*:/.test(readFileSync(`${renderer}${name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
    expect(dragging).toEqual([]);
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
