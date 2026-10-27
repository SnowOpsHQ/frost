// Spec: specs/command-palette.spec.ts (COMMAND_PALETTE_SHORTCUT, PALETTE_RETURN_FOCUS, COPY_VALUE_KEYS),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['command-palette']), specs/browser.spec.ts (BrowserState.commandPalette)
// Acceptance: specs/command-palette.feature.md (Shortcut and controller)
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { copyValueOf } from '@app/seo-core';
import { BrowserStateSchema } from '@app/specs/browser.spec';
import { COPY_VALUE_KEYS } from '@app/specs/command-palette.spec';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../../seo/analyse';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let clipboard: { writeText: ReturnType<typeof vi.fn<(text: string) => void>> };
let clearBrowsingData: ReturnType<typeof vi.fn<() => void>>;

function create(options: { clear?: boolean } = {}) {
  views = [];
  win = new FakeHostWindow();
  clipboard = { writeText: vi.fn<(text: string) => void>() };
  clearBrowsingData = vi.fn<() => void>();
  controller = createBrowserController({
    createView: () => {
      const view = new FakeTabView();
      views.push(view);
      return view as unknown as TabView;
    },
    platform: 'linux',
    seo: { extract: async (contents) => rawSnapshot((contents as unknown as { url: string }).url), analyse: async (raw) => analyseSnapshot(raw) },
    clipboard,
    ...(options.clear === false ? {} : { clearBrowsingData }),
  });
  controller.attach(win as unknown as HostWindow);
}

beforeEach(() => create());
afterEach(() => {
  vi.useRealTimers();
});

/** A `before-input-event` key as Electron reports it (Linux: Mod = Control). */
function key(name: string, mods: { control?: boolean; shift?: boolean; meta?: boolean; alt?: boolean } = {}, type = 'keyDown') {
  return { type, key: name, code: `Key${name.toUpperCase()}`, control: false, meta: false, shift: false, alt: false, ...mods };
}

const palette = () => controller.getState().commandPalette;

function loadPage(url = 'https://example.com/') {
  controller.navigate(url);
  const contents = views.at(-1)!.contents;
  commit(contents, url, 'Example');
  return contents;
}

describe('command palette (controller)', () => {
  test('palette-shortcut-is-reserved', () => {
    expect(palette()).toEqual({ seq: 0, returnFocus: 'chrome' });
    expect(BrowserStateSchema.parse(controller.getState())).toEqual(controller.getState());
    const chrome = win.webContents as unknown as EventEmitter;

    // From the chrome (an empty tab: nothing else could have focus).
    const down = fakeEvent();
    chrome.emit('before-input-event', down, key('k', { control: true }));
    expect(down.defaultPrevented).toBe(true);
    expect(palette()).toEqual({ seq: 1, returnFocus: 'chrome' });
    const up = fakeEvent();
    chrome.emit('before-input-event', up, key('k', { control: true }, 'keyUp'));
    expect(up.defaultPrevented).toBe(true);
    expect(palette().seq).toBe(1);

    // From a page that has focus: consumed before the page sees it; focus comes back to the page later.
    const contents = loadPage();
    contents.focused = true;
    win.webContents.focus.mockClear();
    const fromPage = fakeEvent();
    (contents as unknown as EventEmitter).emit('before-input-event', fromPage, key('k', { control: true }));
    expect(fromPage.defaultPrevented).toBe(true);
    expect(palette()).toEqual({ seq: 2, returnFocus: 'page' });
    // The chrome takes focus so the palette's search box can.
    expect(win.webContents.focus).toHaveBeenCalled();

    // The page shown but the chrome focused (the address bar): back to the chrome.
    contents.focused = false;
    const version = controller.getState().version;
    controller.openCommandPalette();
    expect(palette()).toEqual({ seq: 3, returnFocus: 'chrome' });
    expect(controller.getState().version).toBe(version + 1);

    // Not ours: K alone, with Shift or Alt, the other modifier.
    for (const input of [key('k'), key('k', { control: true, shift: true }), key('k', { control: true, alt: true }), key('k', { meta: true })]) {
      const event = fakeEvent();
      chrome.emit('before-input-event', event, input);
      expect(event.defaultPrevented, JSON.stringify(input)).toBe(false);
    }
    expect(palette().seq).toBe(3);
  });

  test('palette-not-opened-in-fullscreen', () => {
    const contents = loadPage();
    contents.emit('enter-html-full-screen');
    expect(controller.getState().tabs[0]!.fullscreen).not.toBeNull();
    const event = fakeEvent();
    (contents as unknown as EventEmitter).emit('before-input-event', event, key('k', { control: true }));
    expect(event.defaultPrevented).toBe(true);
    controller.openCommandPalette();
    expect(palette().seq).toBe(0);
  });

  test('focus-page-focuses-the-shown-page', () => {
    // An empty tab: nothing to focus.
    expect(controller.focusPage()).toBe(false);
    const contents = loadPage();
    contents.focus.mockClear();
    expect(controller.focusPage()).toBe(true);
    expect(contents.focus).toHaveBeenCalledTimes(1);
    // An error panel replaces the page: its view is detached.
    contents.emit('did-fail-load', fakeEvent(), -102, 'ERR_CONNECTION_REFUSED', contents.url, true);
    contents.focus.mockClear();
    expect(controller.focusPage()).toBe(false);
    expect(contents.focus).not.toHaveBeenCalled();
    // No window.
    win.emit('closed');
    expect(controller.focusPage()).toBe(false);
  });

  test('page-command-and-clear-data-run-like-the-menu', () => {
    const contents = loadPage();
    controller.runPageCommand('zoom-in');
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(controller.getState().tabs[0]!.zoom).toBe(1.1);
    controller.clearBrowsingData();
    expect(clearBrowsingData).toHaveBeenCalledTimes(1);
    // Without the injected action it is a no-op.
    create({ clear: false });
    expect(() => controller.clearBrowsingData()).not.toThrow();
  });

  test('copy-value-only-from-the-shown-audit', async () => {
    vi.useFakeTimers();
    create();
    const url = 'https://example.com/a';
    const contents = loadPage(url);
    contents.emit('did-finish-load');
    const tabId = controller.getState().activeTabId!;
    const shown = { url, takenAt: rawSnapshot(url).extractedAt };
    // Pending: nothing.
    expect(controller.seo.copyValue(tabId, shown, 'title')).toBe(false);
    await vi.advanceTimersByTimeAsync(AUDIT_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);
    const response = controller.seo.getAudit(tabId);
    expect(response.status).toBe('ready');
    if (response.status !== 'ready') return;
    for (const key of COPY_VALUE_KEYS) {
      const value = copyValueOf(response.audit, key);
      expect(controller.seo.copyValue(tabId, shown, key), key).toBe(value !== null);
      if (value !== null) expect(clipboard.writeText).toHaveBeenLastCalledWith(value);
    }
    expect(clipboard.writeText).toHaveBeenCalledWith('A well titled page about something useful');
    const calls = clipboard.writeText.mock.calls.length;
    // Another audit than the one shown, another tab: nothing.
    expect(controller.seo.copyValue(tabId, { ...shown, takenAt: shown.takenAt + 1 }, 'title')).toBe(false);
    expect(controller.seo.copyValue(tabId, { ...shown, url: 'https://example.com/b' }, 'title')).toBe(false);
    expect(controller.seo.copyValue(999, shown, 'title')).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledTimes(calls);
  });
});
