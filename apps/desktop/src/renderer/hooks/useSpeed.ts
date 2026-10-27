import { useEffect, useRef, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { actions } from '../ipc';
import { createSpeedPoller, IDLE_SPEED_STATE, type SpeedPoller, type SpeedPollState } from '../speed-poller';

/**
 * Live speed measurements of `tab` while the component using it is mounted (the Speed panel is open):
 * one poll session per tab, URL and document (`speed-poller.ts`), ended when the tab, its URL or its
 * document changes (a reload of the same URL: `documentSeq`) or the panel goes.
 */
export function useSpeed(tab: TabState | undefined): { readonly state: SpeedPollState; readonly resume: () => void; readonly restart: () => void } {
  const [state, setState] = useState<SpeedPollState>(IDLE_SPEED_STATE);
  const poller = useRef<SpeedPoller | null>(null);
  poller.current ??= createSpeedPoller({ measure: actions.measureSpeed, onChange: setState });
  const tabId = tab?.id;
  const url = tab?.url ?? '';
  const documentSeq = tab?.documentSeq ?? 0;
  useEffect(() => {
    if (tabId === undefined || url === '') poller.current!.stop();
    else poller.current!.start(tabId, url, documentSeq);
  }, [tabId, url, documentSeq]);
  useEffect(() => () => poller.current!.stop(), []);
  return { state, resume: () => poller.current!.resume(), restart: () => poller.current!.restart() };
}
