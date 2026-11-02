import { useEffect, useState } from 'react';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { AiChecksState } from '@app/specs/ai-checks.schema';
import type { AiCheckMode } from '@app/specs/ai-checks.spec';
import { forgetAiChecks, rememberAiChecks } from '../ai-checks-view';
import { ipc } from '../ipc';

// The tab's AI checks (Phase 9 Task 11; acceptance `ai-checks.feature.md`, UI): `useAiChecks` long-polls
// `aiChecks.watch` for the tab while the card, the Quality row or the Settings section is mounted (as
// `useProbes` does `serp.watchProbes`); a failed poll backs off (doubling, capped), and an answer that did
// not advance is never re-asked at once. It only reads: a check runs only from `aiChecksActions.checkNow`
// (a click, or the palette), and the mode changes only through main's `setMode`, whose consent dialog is
// main's own. Each watcher remembers the tab's last state for the palette and forgets it when it stops.

const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The least time between two polls whose answer did not advance (a timed-out long-poll has waited already). */
const MIN_IDLE_POLL_MS = 1_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `aiChecks.*` calls (each resolves `null` / `false` on an IPC failure). */
export const aiChecksActions = {
  /** Asks for `mode`; resolves the mode in effect afterwards (main asks first when leaving `off`), `null` on a failure. */
  setMode: (mode: AiCheckMode): Promise<AiCheckMode | null> => ipc.aiChecks.setMode.mutate({ mode }).catch(() => null),
  /** "Check this page" (`again`: "Check again", past a cached answer); resolves whether a check runs or waits its turn. */
  checkNow: (tabId: number, again = false): Promise<boolean> => ipc.aiChecks.checkNow.mutate(again ? { tabId, again: true } : { tabId }).catch(() => false),
};

/** The tab's AI checks as main answers them (`null` until the first answer, or without a tab). */
export function useAiChecks(tabId: number | undefined): AiChecksState | null {
  const [state, setState] = useState<AiChecksState | null>(null);
  useEffect(() => {
    if (tabId === undefined) return;
    let live = true;
    let since = -1;
    let failures = 0;
    const loop = async (): Promise<void> => {
      while (live) {
        const started = Date.now();
        try {
          const next = await ipc.aiChecks.watch.query({ tabId, sinceVersion: since });
          if (!live) return;
          failures = 0;
          const advanced = next.version > since;
          since = next.version;
          rememberAiChecks(next);
          setState(next);
          const elapsed = Date.now() - started;
          if (!advanced && elapsed < MIN_IDLE_POLL_MS) await wait(MIN_IDLE_POLL_MS - elapsed);
        } catch {
          failures += 1;
          await wait(Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
        }
      }
    };
    void loop();
    return () => {
      live = false;
      forgetAiChecks(tabId);
    };
  }, [tabId]);
  return state !== null && state.tabId === tabId ? state : null;
}
