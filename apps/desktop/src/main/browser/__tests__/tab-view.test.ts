// Spec: specs/browser.spec.ts (TAB_VIEW_WEB_PREFERENCES) · Acceptance: specs/browser-chrome.feature.md (Tab view factory)
import { describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, TAB_VIEW_WEB_PREFERENCES } from '@app/specs/browser.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
import { LOCATION_WEBRTC_POLICY, locationPartition } from '@app/specs/location-profiles.spec';
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
