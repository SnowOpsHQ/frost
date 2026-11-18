// Spec: specs/window-hardening.spec.ts · Acceptance: specs/window-hardening.feature.md
// Spec: specs/app-protocol.spec.ts · Acceptance: specs/app-protocol.feature.md (Loading the renderer)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { ADDRESS_MIN_WIDTH_PX, CHROME_MIN_CONTENT_WIDTH_PX, CHROME_ROW, TAB_MIN_WIDTH_PX } from '@app/specs/tabs.spec';
import {
  CAPTION_BUTTONS_WIDTH_PX,
  CHROME_ROW_PADDING_PX,
  chromeRowInset,
  TITLE_BAR_OVERLAY_COLOURS,
  TITLE_BAR_OVERLAY_HEIGHT_PX,
  TRAFFIC_LIGHT_POSITION,
  TRAFFIC_LIGHTS_ZONE_PX,
  WINDOW_DRAG_STRIP_PX,
  type TitleBarPlatform,
} from '@app/specs/title-bar.spec';
import { CHROME_ROW_HEIGHT_PX } from '@app/specs/tabs.spec';
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
    expect(CHROME_MIN_CONTENT_WIDTH_PX).toBe(626);
    // The minimum counts the frame (the fake's is 16px wide): the content's minimum plus it; the height is kept.
    // On macOS and Windows the row also gives the window's controls their room (title-bar.spec.ts).
    for (const platform of PLATFORMS)
      onPlatform(platform, () => {
        const win = createMainWindow() as unknown as FakeBrowserWindow;
        const content = CHROME_MIN_CONTENT_WIDTH_PX + chromeRowInset(platform);
        expect(win.getMinimumSize(), platform).toEqual([content + 16, 0]);
        expect(win.getMinimumSize()[0] - (win.getSize()[0] - win.getContentSize()[0]), platform).toBe(content);
      });
  });

  // Acceptance: specs/tabs.feature.md (The chrome row: the row is the window's title bar)
  test('title-bar-insets', () => {
    const tokens = readFileSync(fileURLToPath(new URL('../../renderer/tokens.css', import.meta.url)), 'utf8');
    expect(CHROME_ROW_PADDING_PX).toBe(Number(tokens.match(/--space-4:\s*(\d+)px;/)![1]));
    expect(chromeRowInset('linux')).toBe(0);
    expect(chromeRowInset('darwin')).toBe(TRAFFIC_LIGHTS_ZONE_PX - CHROME_ROW_PADDING_PX);
    expect(chromeRowInset('win32')).toBe(CAPTION_BUTTONS_WIDTH_PX + WINDOW_DRAG_STRIP_PX - CHROME_ROW_PADDING_PX);
    expect(WINDOW_DRAG_STRIP_PX).toBeGreaterThanOrEqual(40);
    // The lights' box: x on both sides of the three 54px lights, y above and below their 16px frames: the row's height.
    expect(TRAFFIC_LIGHTS_ZONE_PX).toBe(2 * TRAFFIC_LIGHT_POSITION.x + 54);
    expect(2 * TRAFFIC_LIGHT_POSITION.y + 16).toBe(CHROME_ROW_HEIGHT_PX);
    expect(TITLE_BAR_OVERLAY_HEIGHT_PX).toBe(CHROME_ROW_HEIGHT_PX);
  });

  // Acceptance: specs/tabs.feature.md (The chrome row: the row is the window's title bar)
  test.each(PLATFORMS)('window-row-is-the-title-bar (%s)', (platform) => {
    onPlatform(platform, () => {
      const options = (createMainWindow() as unknown as FakeBrowserWindow).options as Record<string, unknown>;
      expect(Object.hasOwn(options, 'frame'), 'frame').toBe(false);
      expect(options['title']).toBe('frost');
      expect(options['webPreferences']).toMatchObject(HARDENED_WEB_PREFERENCES);
      const titleBar = Object.fromEntries(['titleBarStyle', 'titleBarOverlay', 'trafficLightPosition'].filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]));
      if (platform === 'darwin') expect(titleBar).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHT_POSITION, titleBarOverlay: true });
      else if (platform === 'win32') expect(titleBar).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: { height: TITLE_BAR_OVERLAY_HEIGHT_PX, ...TITLE_BAR_OVERLAY_COLOURS.light } });
      else expect(titleBar).toEqual({});
    });
  });

  // Acceptance: specs/tabs.feature.md (The chrome row: the row is the window's title bar)
  test.each(PLATFORMS)('title-bar-overlay-follows-the-theme (%s)', async (platform) => {
    const { nativeTheme } = (await import('electron')) as unknown as { nativeTheme: NodeJS.EventEmitter & { shouldUseDarkColors: boolean } };
    nativeTheme.shouldUseDarkColors = true;
    try {
      const win = onPlatform(platform, () => createMainWindow() as unknown as FakeBrowserWindow);
      // Created in the dark: the overlay starts dark.
      if (platform === 'win32') expect((win.options as { titleBarOverlay?: object }).titleBarOverlay).toMatchObject(TITLE_BAR_OVERLAY_COLOURS.dark);
      nativeTheme.shouldUseDarkColors = false;
      nativeTheme.emit('updated');
      nativeTheme.shouldUseDarkColors = true;
      nativeTheme.emit('updated');
      if (platform !== 'win32') return expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
      expect(win.setTitleBarOverlay.mock.calls).toEqual([[TITLE_BAR_OVERLAY_COLOURS.light], [TITLE_BAR_OVERLAY_COLOURS.dark]]);
      // Closed: the theme lets go of the window.
      const closed = win.once.mock.calls.find(([event]) => event === 'closed')?.[1] as (() => void) | undefined;
      expect(closed).toBeTypeOf('function');
      closed!();
      nativeTheme.emit('updated');
      expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(2);
    } finally {
      nativeTheme.shouldUseDarkColors = false;
      nativeTheme.removeAllListeners('updated');
    }
  });
});

const PLATFORMS: readonly TitleBarPlatform[] = ['darwin', 'linux', 'win32'];

/** Runs `body` with `process.platform` reading `platform`. */
function onPlatform<T>(platform: TitleBarPlatform, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

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
