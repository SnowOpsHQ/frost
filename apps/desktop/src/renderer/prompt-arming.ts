import { PROMPT_ARMING_DELAY_MS } from '@app/specs/permissions.spec';

// Clickjacking guard for the permission prompt bar (spec `permissions.feature.md`, Prompt bar):
// Allow and Block only take clicks once the bar has been on screen, unchanged and in a focused,
// visible window, for `PROMPT_ARMING_DELAY_MS`.

export interface PromptArming {
  /** Whether Allow / Block may be activated now. */
  armed(): boolean;
  /** Starts the delay again (the window regained focus or became visible). */
  disarm(): void;
  /** Stops the timer for good (the bar is gone). */
  dispose(): void;
}

/** A fresh arming starts disarmed; `onChange` hears every change of `armed()`. */
export function createPromptArming(onChange: (armed: boolean) => void): PromptArming {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const set = (value: boolean): void => {
    if (armed === value) return;
    armed = value;
    onChange(value);
  };
  const disarm = (): void => {
    if (disposed) return;
    clearTimeout(timer);
    set(false);
    timer = setTimeout(() => set(true), PROMPT_ARMING_DELAY_MS);
  };
  disarm();
  return {
    armed: () => armed,
    disarm,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
