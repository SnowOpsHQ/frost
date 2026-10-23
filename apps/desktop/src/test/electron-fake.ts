import { vi } from 'vitest';
import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';

/**
 * Minimal Node-side stand-in for the `electron` module, for unit tests that run under Vitest
 * (not Electron). Records BrowserWindow constructor options so tests can assert on them.
 * `getLastWebPreferences()` just echoes the constructor options, so effective prefs are asserted
 * against real Electron in the Playwright e2e suite (Task 4).
 *
 * Usage: `vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());`
 */
export class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  static getAllWindows = () => [...FakeBrowserWindow.instances];

  readonly options: BrowserWindowConstructorOptions;
  readonly webContents: { getLastWebPreferences: () => WebPreferences };
  loadURL = vi.fn(async (_url: string) => {});
  loadFile = vi.fn(async (_path: string) => {});
  on = vi.fn();
  once = vi.fn();

  constructor(options: BrowserWindowConstructorOptions = {}) {
    this.options = options;
    this.webContents = { getLastWebPreferences: () => ({ ...options.webPreferences }) };
    FakeBrowserWindow.instances.push(this);
  }
}

export function electronFake() {
  FakeBrowserWindow.instances = [];
  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
  };
  return { app, BrowserWindow: FakeBrowserWindow, default: { app, BrowserWindow: FakeBrowserWindow } };
}
