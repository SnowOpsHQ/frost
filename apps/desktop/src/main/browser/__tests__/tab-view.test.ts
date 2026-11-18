// Spec: specs/browser.spec.ts (TAB_VIEW_WEB_PREFERENCES) · Acceptance: specs/browser-chrome.feature.md (Tab view factory)
import { describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, TAB_VIEW_WEB_PREFERENCES } from '@app/specs/browser.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
import { LOCATION_WEBRTC_POLICY, locationPartition } from '@app/specs/location-profiles.spec';
import { PAGE_NO_DRAG_CSS, PAGE_NO_DRAG_SELECTORS } from '@app/specs/title-bar.spec';
import type { FakeWebContentsView } from '../../../test/electron-fake';
import { createTabView } from '../../window';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

function webPreferencesOf(): Record<string, unknown> {
  const view = createTabView() as unknown as FakeWebContentsView;
  return { ...view.options.webPreferences };
}

describe('createTabView', () => {
  test('tab-view-prefs-equal-spec', () => {
    expect(webPreferencesOf()).toEqual(TAB_VIEW_WEB_PREFERENCES);
    // The spec itself keeps the four hardened values.
    expect(TAB_VIEW_WEB_PREFERENCES).toMatchObject(HARDENED_WEB_PREFERENCES);
  });

  test('tab-view-uses-browse-partition', () => {
    expect(webPreferencesOf()['partition']).toBe(BROWSE_PARTITION);
    expect(BROWSE_PARTITION.startsWith('persist:')).toBe(true);
  });

  test('tab-view-has-no-preload', () => {
    expect(Object.hasOwn(webPreferencesOf(), 'preload')).toBe(false);
  });

  test('tab-view-disables-dialogs', () => {
    expect(webPreferencesOf()['disableDialogs']).toBe(true);
  });

  // Acceptance: specs/tabs.feature.md (Dragging: only the chrome drags, never a page)
  test.each(['darwin', 'win32', 'linux'] as const)('tab-view-pages-cannot-drag-the-window (%s)', async (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      const view = createTabView() as unknown as FakeWebContentsView;
      const insertCSS = vi.fn(async (_css: string, _options?: { cssOrigin?: string }) => 'key');
      Object.assign(view.webContents, { insertCSS });
      // Nothing before a document commits; then once per main-frame navigation, in the user origin.
      expect(insertCSS).not.toHaveBeenCalled();
      view.webContents.emit('did-navigate', {}, 'https://example.com/');
      view.webContents.emit('did-navigate', {}, 'https://example.com/next');
      // Linux keeps its native frame, which makes Electron ignore every region: nothing to insert.
      const inserted = platform === 'linux' ? [] : [[PAGE_NO_DRAG_CSS, { cssOrigin: 'user' }], [PAGE_NO_DRAG_CSS, { cssOrigin: 'user' }]];
      expect(insertCSS.mock.calls).toEqual(inserted);
      // A page that is gone by then rejects the insert: swallowed, never an unhandled rejection.
      insertCSS.mockRejectedValueOnce(new Error('gone'));
      view.webContents.emit('did-navigate', {}, 'https://example.com/gone');
      await Promise.resolve();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
    // One rule per selector (an unknown one voids only its own), every one no region at all.
    expect(PAGE_NO_DRAG_CSS.split('\n')).toEqual(PAGE_NO_DRAG_SELECTORS.map((selector) => `${selector} { app-region: initial !important; }`));
    expect(PAGE_NO_DRAG_SELECTORS).toEqual(expect.arrayContaining(['*', '*::before', '*::after', '*::backdrop', '*::scroll-button(*)', '*::column::scroll-marker']));
    // Never ::first-letter or ::first-line: a universal rule there makes the pseudo-element in every block and splits its text.
    expect(PAGE_NO_DRAG_SELECTORS.filter((selector) => /first-(letter|line)/.test(selector))).toEqual([]);
  });
});

// Phase 12 Task 10b (specs/location-profiles.spec.ts LOCATION_WEBRTC_POLICY; location-profiles.feature.md,
// location-tab-webrtc-proxied-only): a location partition's tab view gets the WebRTC policy at creation, before any load.
describe('createTabView on a location partition', () => {
  test('location-tab-webrtc-proxied-only', () => {
    const partition = locationPartition('01920000-0000-7000-8000-0000000000c1');
    const view = createTabView(partition) as unknown as FakeWebContentsView;
    // Only the partition changes; the hardened preferences stay the spec's.
    expect({ ...view.options.webPreferences }).toEqual({ ...TAB_VIEW_WEB_PREFERENCES, partition });
    const contents = view.webContents as unknown as { setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>; loadURL?: unknown };
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith(LOCATION_WEBRTC_POLICY);
    expect(LOCATION_WEBRTC_POLICY).toBe('disable_non_proxied_udp');
    // A home tab keeps Chromium's default.
    const home = createTabView() as unknown as FakeWebContentsView;
    expect((home.webContents as unknown as { setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn> }).setWebRTCIPHandlingPolicy).not.toHaveBeenCalled();
  });
});
