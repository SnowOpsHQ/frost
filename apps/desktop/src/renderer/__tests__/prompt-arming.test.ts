// Spec: specs/permissions.spec.ts (PROMPT_ARMING_DELAY_MS) · Acceptance: specs/permissions.feature.md (Renderer)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PROMPT_ARMING_DELAY_MS } from '@app/specs/permissions.spec';
import { createPromptArming } from '../prompt-arming';

describe('prompt arming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('prompt-buttons-arm-after-delay', () => {
    expect(PROMPT_ARMING_DELAY_MS).toBe(750);
    const seen: boolean[] = [];
    const arming = createPromptArming((armed) => seen.push(armed));
    // Fresh: disarmed until the delay has passed.
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS - 1);
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(arming.armed()).toBe(true);
    expect(seen).toEqual([true]);

    // Focus / visibility: disarmed again, for a whole new delay.
    arming.disarm();
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS / 2);
    arming.disarm();
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS - 1);
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(arming.armed()).toBe(true);
    expect(seen).toEqual([true, false, true]);

    // Disposed: no timer left, no more changes.
    arming.disarm();
    arming.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS * 2);
    expect(arming.armed()).toBe(false);
    expect(seen).toEqual([true, false, true, false]);
  });

  test('prompt-disarms-while-covered', () => {
    const seen: boolean[] = [];
    const arming = createPromptArming((armed) => seen.push(armed));
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS);
    expect(arming.armed()).toBe(true);
    // Not covered: uncovering changes nothing.
    arming.setCovered(false);
    expect(arming.armed()).toBe(true);
    expect(seen).toEqual([true]);

    // Covered (the fullscreen page lies over the bar): disarmed at once, for as long as it lasts.
    arming.setCovered(true);
    expect(arming.armed()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    arming.disarm();
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS * 10);
    expect(arming.armed()).toBe(false);

    // Uncovered: a whole new delay before it arms.
    arming.setCovered(false);
    vi.advanceTimersByTime(PROMPT_ARMING_DELAY_MS - 1);
    expect(arming.armed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(arming.armed()).toBe(true);
    expect(seen).toEqual([true, false, true]);
    arming.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
