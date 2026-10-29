import { PROMPT_ARMING_DELAY_MS } from '@app/specs/permissions.spec';

// Clickjacking guard for the permission prompt bar (spec `permissions.feature.md`, Prompt bar):
// Allow and Block only take clicks once the bar has been on screen, unchanged, uncovered and in a
// focused, visible window, for `PROMPT_ARMING_DELAY_MS`.

export interface PromptArming {
  /** Whether Allow / Block may be activated now. */
  armed(): boolean;
  /** Starts the delay again (the window regained focus or became visible). */
  disarm(): void;
  /**
   * The bar is (`true`) or is no longer (`false`) covered by the page (HTML fullscreen): covered
   * it is disarmed and stays so; uncovered it starts the delay again. No change, no effect.
   */
  setCovered(covered: boolean): void;
  /** Stops the timer for good (the bar is gone). */
  dispose(): void;
}

/**
 * A fresh arming starts disarmed; `onChange` hears every change of `armed()`. `delayMs` defaults to
 * `PROMPT_ARMING_DELAY_MS` (the agent's approval cards pass `APPROVAL_ENABLE_DELAY_MS`).
 */
export function createPromptArming(onChange: (armed: boolean) => void, delayMs: number = PROMPT_ARMING_DELAY_MS): PromptArming {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let covered = false;
  const set = (value: boolean): void => {
    if (armed === value) return;
    armed = value;
    onChange(value);
  };
  const disarm = (): void => {
    if (disposed) return;
    clearTimeout(timer);
    timer = undefined;
    set(false);
    if (!covered) timer = setTimeout(() => set(true), delayMs);
  };
  disarm();
  return {
    armed: () => armed,
    disarm,
    setCovered(value) {
      if (covered === value) return;
      covered = value;
      disarm();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
