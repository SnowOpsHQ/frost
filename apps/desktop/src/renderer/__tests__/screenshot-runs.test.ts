// Spec: specs/screenshot.spec.ts (TakeScreenshotAnswer)
// Acceptance: specs/screenshot.feature.md (The Changes panel; Scenario screenshot-runs-outlive-the-panel)
import { describe, expect, test, vi } from 'vitest';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { onScreenshotFinished, runScreenshot, screenshotRun } from '../components/changes/screenshot-runs';

const ID = '0190a000-0000-7000-8000-000000000001';

describe('screenshot runs', () => {
  test('screenshot-runs-outlive-the-panel', async () => {
    let answer!: (value: TakeScreenshotAnswer | null) => void;
    const take = vi.fn(() => new Promise<TakeScreenshotAnswer | null>((resolve) => (answer = resolve)));
    const heard = vi.fn();
    const stop = onScreenshotFinished(heard);
    // Running for its tab (whoever started it) until it answers.
    const pending = runScreenshot(take, 4, 'area');
    expect(screenshotRun(4)).toBe('area');
    expect(screenshotRun(5)).toBeNull();
    // A second one on the same tab leaves the first's state (main answers busy).
    const busy = runScreenshot(async () => ({ status: 'refused', reason: 'busy' }), 4, 'viewport');
    await expect(busy).resolves.toEqual({ status: 'refused', reason: 'busy' });
    expect(screenshotRun(4)).toBe('area');
    // Its answer reaches every listener (a panel mounted since included), and the tab is free again.
    const later = vi.fn();
    const stopLater = onScreenshotFinished(later);
    const saved: TakeScreenshotAnswer = { status: 'saved', id: ID, kind: 'area', width: 10, height: 10, bytes: 5, truncated: false };
    answer(saved);
    await expect(pending).resolves.toEqual(saved);
    expect(screenshotRun(4)).toBeNull();
    expect(heard).toHaveBeenLastCalledWith(4, saved);
    expect(later).toHaveBeenCalledWith(4, saved);
    // A failed call is a null answer, and the tab is freed all the same.
    await expect(runScreenshot(() => Promise.reject(new Error('ipc')), 4, 'full')).resolves.toBeNull();
    expect(screenshotRun(4)).toBeNull();
    expect(heard).toHaveBeenLastCalledWith(4, null);
    stop();
    stopLater();
  });
});
