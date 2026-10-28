// Spec: specs/account-settings.spec.ts (SETTINGS_SECTIONS), specs/account-state.schema.ts (ACCOUNT_STATUSES)
// Acceptance: specs/account-settings.feature.md (Opening and closing)
import { describe, expect, test, vi } from 'vitest';
import { SETTINGS_SECTIONS } from '@app/specs/account-settings.spec';
import { ACCOUNT_STATUSES } from '@app/specs/account-state.schema';
import { holdsSheet, isMenuRequest, onSettingsRequest, opensForConfirmation, requestSettings, SETTINGS_CLOSED, settingsReducer, type SettingsEvent } from '../settings-open';

const run = (...events: SettingsEvent[]) => events.reduce(settingsReducer, SETTINGS_CLOSED);

describe('opening and closing the Settings sheet', () => {
  test('settings-opens-on-request', () => {
    expect(SETTINGS_CLOSED.open).toBe(false);
    for (const { id } of SETTINGS_SECTIONS) expect(run({ type: 'request', section: id })).toEqual({ open: true, section: id, focusSeq: 1 });
    // A second request moves to its section and asks for focus again.
    expect(run({ type: 'request', section: 'account' }, { type: 'request', section: 'telemetry' })).toEqual({ open: true, section: 'telemetry', focusSeq: 2 });
    // The palette's bus reaches the mounted slot only.
    const listener = vi.fn();
    expect(requestSettings('account')).toBe(false);
    const off = onSettingsRequest(listener);
    expect(requestSettings('search-console')).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith('search-console');
    off();
    expect(requestSettings('account')).toBe(false);
  });

  test('settings-closes', () => {
    const open = run({ type: 'request', section: 'telemetry' });
    expect(settingsReducer(open, { type: 'close' })).toMatchObject({ open: false, section: 'telemetry' });
    expect(settingsReducer(open, { type: 'history-opened' }).open).toBe(false);
    // Closing a closed sheet changes nothing.
    expect(settingsReducer(SETTINGS_CLOSED, { type: 'close' })).toBe(SETTINGS_CLOSED);
  });

  test('settings-closes-with-the-page', () => {
    const open = run({ type: 'request', section: 'account' });
    expect(settingsReducer(open, { type: 'page-changed', holding: false }).open).toBe(false);
    expect(settingsReducer(open, { type: 'page-changed', holding: true })).toBe(open);
    for (const status of ACCOUNT_STATUSES) expect(holdsSheet(status), status).toBe(status === 'confirming');
    expect(holdsSheet(null)).toBe(false);
  });

  test('settings-opens-for-confirmation', () => {
    expect(opensForConfirmation('awaiting-browser', 'confirming')).toBe(true);
    expect(opensForConfirmation(null, 'confirming')).toBe(true);
    expect(opensForConfirmation('confirming', 'confirming')).toBe(false);
    for (const status of ACCOUNT_STATUSES.filter((s) => s !== 'confirming')) expect(opensForConfirmation('confirming', status), status).toBe(false);
  });

  test('settings-menu-seq', () => {
    expect(isMenuRequest(undefined, 3)).toBe(false);
    expect(isMenuRequest(3, 3)).toBe(false);
    expect(isMenuRequest(3, 4)).toBe(true);
  });
});
