import { useEffect, useRef, useState } from 'react';
import { createPromptArming } from '../prompt-arming';

/**
 * Allow / Block arming (clickjacking): disarmed on mount (a new bar, prompt or shown tab: the bar
 * is keyed by both), whenever the chrome's window regains focus or becomes visible, and for as
 * long as the bar is `covered` (the tab's fullscreen page lies over it), restarting once it is not.
 * `delayMs` (read on mount) defaults to `PROMPT_ARMING_DELAY_MS`.
 */
export function usePromptArmed(covered: boolean, delayMs?: number): boolean {
  const [armed, setArmed] = useState(false);
  const arming = useRef<ReturnType<typeof createPromptArming> | null>(null);
  useEffect(() => {
    const created = createPromptArming(setArmed, delayMs);
    arming.current = created;
    const disarm = () => created.disarm();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') created.disarm();
    };
    window.addEventListener('focus', disarm);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', disarm);
      document.removeEventListener('visibilitychange', onVisibility);
      created.dispose();
      arming.current = null;
    };
  }, []);
  useEffect(() => arming.current?.setCovered(covered), [covered]);
  // Covered counts at once (the effect above disarms only after this render).
  return armed && !covered;
}
