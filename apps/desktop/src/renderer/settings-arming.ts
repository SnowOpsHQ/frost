import { useEffect, useState } from 'react';
import { SETTINGS_CONFIRM_ARM_MS } from '@app/specs/account-settings.spec';

// The in-app sign-in confirmation's guard (Phase 4 Task 9; acceptance `account-settings.feature.md`,
// Confirmation arming): its button takes no activation until it has been on screen for
// `SETTINGS_CONFIRM_ARM_MS`, counted again whenever the window regains focus or becomes visible, so a
// click or key meant for something else (the Sign in button before it, another window) never confirms.

export interface Arming {
  armed(): boolean;
  /** Starts the delay again (the window regained focus or became visible). */
  disarm(): void;
  /** Stops for good. */
  dispose(): void;
}

/** Starts disarmed; `onChange` hears every change of `armed()`. */
export function createArming(delayMs: number, onChange: (armed: boolean) => void): Arming {
  let armed = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (value: boolean) => {
    if (armed === value) return;
    armed = value;
    onChange(value);
  };
  const disarm = () => {
    if (disposed) return;
    clearTimeout(timer);
    set(false);
    timer = setTimeout(() => set(true), delayMs);
  };
  disarm();
  return {
    armed: () => armed,
    disarm,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/** Whether the confirmation's button (mounted with this hook) may be activated now. */
export function useConfirmArmed(): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const arming = createArming(SETTINGS_CONFIRM_ARM_MS, setArmed);
    const disarm = () => arming.disarm();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') arming.disarm();
    };
    window.addEventListener('focus', disarm);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', disarm);
      document.removeEventListener('visibilitychange', onVisibility);
      arming.dispose();
    };
  }, []);
  return armed;
}
