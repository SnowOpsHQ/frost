// Spec: specs/browser.spec.ts (TAB_VIEW_WEB_PREFERENCES) · Acceptance: specs/browser-chrome.feature.md (Tab view factory)
import { describe, expect, test, vi } from 'vitest';
import { BROWSE_PARTITION, TAB_VIEW_WEB_PREFERENCES } from '@app/specs/browser.spec';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';
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
});
