// Spec: specs/account-settings.spec.ts (SETTINGS_CONFIRM_ARM_MS)
// Acceptance: specs/account-settings.feature.md (Confirmation arming)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SETTINGS_CONFIRM_ARM_MS } from '@app/specs/account-settings.spec';
import { createArming } from '../settings-arming';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('confirmation arming', () => {
  test('confirm-arms-after-delay', () => {
    expect(SETTINGS_CONFIRM_ARM_MS).toBeGreaterThanOrEqual(1_000);
    const changes: boolean[] = [];
    const arming = createArming(SETTINGS_CONFIRM_ARM_MS, (armed) => changes.push(armed));
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(SETTINGS_CONFIRM_ARM_MS - 1);
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(arming.armed()).toBe(true);
    expect(changes).toEqual([true]);
  });

  test('confirm-disarms-on-focus', () => {
    const arming = createArming(SETTINGS_CONFIRM_ARM_MS, () => {});
    vi.advanceTimersByTime(SETTINGS_CONFIRM_ARM_MS);
    expect(arming.armed()).toBe(true);
    // The window came back: the whole delay again.
    arming.disarm();
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(SETTINGS_CONFIRM_ARM_MS - 1);
    arming.disarm();
    vi.advanceTimersByTime(SETTINGS_CONFIRM_ARM_MS - 1);
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(arming.armed()).toBe(true);
    // Disposed: nothing more.
    arming.disarm();
    arming.dispose();
    vi.advanceTimersByTime(SETTINGS_CONFIRM_ARM_MS * 2);
    expect(arming.armed()).toBe(false);
  });
});
