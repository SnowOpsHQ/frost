// Spec: specs/command-palette.spec.ts (COMMAND_PALETTE_SHORTCUT, PALETTE_RETURN_FOCUS, COPY_VALUE_KEYS),
// specs/tabs.spec.ts (RESERVED_TAB_SHORTCUTS['command-palette']), specs/browser.spec.ts (BrowserState.commandPalette)
// Acceptance: specs/command-palette.feature.md (Shortcut and controller)
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { copyValueOf } from '@app/seo-core';
import { BrowserStateSchema } from '@app/specs/browser.spec';
import { COPY_VALUE_KEYS, OPEN_IN_TEMPLATES } from '@app/specs/command-palette.spec';
import { openInUrl } from '@app/specs/open-in.spec';
import { MAX_TABS } from '@app/specs/tabs.spec';
import { AUDIT_DEBOUNCE_MS } from '@app/specs/seo-limits.spec';
import { commit, FakeHostWindow, FakeTabView } from '../../../test/controller-fakes';
import { fakeEvent } from '../../../test/electron-fake';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../../seo/analyse';
import { createResponseRecorder } from '../../seo/responses';
import { createBrowserController, type BrowserController, type HostWindow, type TabView } from '../controller';

let views: FakeTabView[];
let win: FakeHostWindow;
let controller: BrowserController;
let clipboard: { writeText: ReturnType<typeof vi.fn<(text: string) => void>> };
let clearBrowsingData: ReturnType<typeof vi.fn<() => void>>;
/** The address each tab's document came from, as the response recorder would answer (by WebContents). */
let addresses: Map<unknown, string | null>;

function create(options: { clear?: boolean } = {}) {
  addresses = new Map();
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
    pageAddress: (contents) => addresses.get(contents) ?? null,
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

  test('palette-shortcut-ignores-auto-repeat', () => {
    const chrome = win.webContents as unknown as EventEmitter;
    chrome.emit('before-input-event', fakeEvent(), key('k', { control: true }));
    expect(palette().seq).toBe(1);
    // Held down: the repeats are consumed (the page never gets them) and change nothing.
    for (let i = 0; i < 3; i++) {
      const repeat = fakeEvent();
      chrome.emit('before-input-event', repeat, { ...key('k', { control: true }), isAutoRepeat: true });
      expect(repeat.defaultPrevented).toBe(true);
    }
    expect(palette().seq).toBe(1);
    chrome.emit('before-input-event', fakeEvent(), key('k', { control: true }, 'keyUp'));
    chrome.emit('before-input-event', fakeEvent(), { ...key('k', { control: true }), isAutoRepeat: false });
    expect(palette().seq).toBe(2);
  });

  test('open-tool-builds-from-the-table-and-the-active-tab', () => {
    // No page.
    expect(controller.openTool('rich-results')).toEqual({ status: 'refused', reason: 'no-page' });
    const page = 'https://www.example.com/guide?x=1';
    const contents = loadPage(page);
    addresses.set(contents, '93.184.216.34');
    const before = controller.getState().tabs.length;
    for (const template of OPEN_IN_TEMPLATES) {
      const result = controller.openTool(template.id);
      expect(result.status, template.id).toBe('opened');
      const opened = views.at(-1)!.contents;
      expect(opened.loadURL).toHaveBeenLastCalledWith(openInUrl(template, page));
      // A background tab: the page's tab stays active.
      expect(controller.getState().activeTabId).toBe(controller.getState().tabs[0]!.id);
    }
    expect(controller.getState().tabs.length).toBe(before + OPEN_IN_TEMPLATES.length);

    // A non-public name: refused, nothing opened.
    create();
    const local = loadPage('http://printer.local/status');
    addresses.set(local, null);
    expect(controller.openTool('rich-results')).toEqual({ status: 'refused', reason: 'not-public' });
    expect(controller.getState().tabs).toHaveLength(1);

    // The tab limit.
    create();
    loadPage(page);
    for (let i = controller.getState().tabs.length; i < MAX_TABS; i++) controller.openBackgroundTab(`https://www.example.com/${i}`);
    expect(controller.openTool('rich-results')).toEqual({ status: 'refused', reason: 'not-opened' });
  });

  test('open-tool-refuses-private-addresses', () => {
    const page = 'https://intranet-looks-public.example.com/';
    for (const address of ['10.1.2.3', '192.168.0.10', '127.0.0.1', '::1', '[fd00::1]', '169.254.1.1', '100.64.0.1', '::ffff:192.168.1.1', 'garbage']) {
      create();
      const contents = loadPage(page);
      addresses.set(contents, address);
      expect(controller.openTool('page-speed'), address).toEqual({ status: 'refused', reason: 'private-address' });
      expect(controller.getState().tabs, address).toHaveLength(1);
    }
    for (const address of ['93.184.216.34', '2606:4700::1111', null]) {
      create();
      const contents = loadPage(page);
      addresses.set(contents, address);
      expect(controller.openTool('page-speed').status, String(address)).toBe('opened');
    }
  });

  test('response-recorder-keeps-the-address', () => {
    const recorder = createResponseRecorder();
    const url = 'https://www.example.com/a';
    const respond = (id: number, ip: string | undefined) =>
      recorder.responded({ id, url, webContentsId: 7, resourceType: 'mainFrame', statusCode: 200, fromCache: false, responseHeaders: {}, ...(ip === undefined ? {} : { ip }) } as unknown as Parameters<typeof recorder.responded>[0]);
    expect(recorder.addressFor(7)).toBeNull();
    respond(1, '192.168.1.20');
    recorder.committed(7, url, 200);
    expect(recorder.addressFor(7)).toBe('192.168.1.20');
    // An in-page navigation keeps the document, so its address.
    expect(recorder.responseFor(7, `${url}#x`)).not.toBeNull();
    expect(recorder.addressFor(7)).toBe('192.168.1.20');
    // A new document without an address (no ip reported): unknown.
    respond(2, undefined);
    recorder.committed(7, url, 200);
    expect(recorder.addressFor(7)).toBeNull();
    // A back/forward restore main never saw a response for: unknown.
    respond(3, '10.0.0.1');
    recorder.committed(7, url, 200);
    expect(recorder.addressFor(7)).toBe('10.0.0.1');
    recorder.committed(7, 'https://www.example.com/other', 200);
    expect(recorder.addressFor(7)).toBeNull();
    // Garbage is kept as text (it is then not public), cut to a sane length.
    respond(4, 'x'.repeat(500));
    recorder.committed(7, url, 200);
    expect(recorder.addressFor(7)!.length).toBeLessThanOrEqual(64);
    recorder.forget(7);
    expect(recorder.addressFor(7)).toBeNull();
    respond(5, '10.0.0.1');
    recorder.committed(7, url, 200);
    recorder.clear();
    expect(recorder.addressFor(7)).toBeNull();
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
