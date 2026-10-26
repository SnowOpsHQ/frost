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
});
