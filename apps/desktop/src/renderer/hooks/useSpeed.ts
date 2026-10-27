import { useEffect, useRef, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { actions } from '../ipc';
import { createSpeedPoller, IDLE_SPEED_STATE, type SpeedPoller, type SpeedPollState } from '../speed-poller';

/**
 * Live speed measurements of `tab` while the component using it is mounted (the Speed panel is open):
 * one poll session per tab and URL (`speed-poller.ts`), ended when the tab or its URL changes or
 * the panel goes.
 */
export function useSpeed(tab: TabState | undefined): { readonly state: SpeedPollState; readonly resume: () => void; readonly restart: () => void } {
  const [state, setState] = useState<SpeedPollState>(IDLE_SPEED_STATE);
  const poller = useRef<SpeedPoller | null>(null);
  poller.current ??= createSpeedPoller({ measure: actions.measureSpeed, onChange: setState });
  const tabId = tab?.id;
  const url = tab?.url ?? '';
  useEffect(() => {
    if (tabId === undefined || url === '') poller.current!.stop();
    else poller.current!.start(tabId, url);
  }, [tabId, url]);
  useEffect(() => () => poller.current!.stop(), []);
  return { state, resume: () => poller.current!.resume(), restart: () => poller.current!.restart() };
}
