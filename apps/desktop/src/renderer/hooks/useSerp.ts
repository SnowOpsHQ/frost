import { useCallback, useEffect, useState } from 'react';
import type { IntentState } from '@app/specs/intent-classifier.spec';
import type { SerpTabState } from '@app/specs/serp-service.schema';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { ipc } from '../ipc';
import { rememberIntent, rememberSerp } from '../serp-view';
import { rememberProbes } from '../visibility-view';

// The SERP and Visibility panels' state (acceptance `serp-panels.feature.md`): `useSerp` long-polls
// `serp.watch` and `useProbes` `serp.watchProbes` for the active tab while a panel is mounted, as
// `useChecks` does; a failed poll backs off (doubling, capped) and asks again, and an answer that did
// not advance is never re-asked at once. Nothing here fetches: the only
// procedures that do (`checkPackUpdate`, `enableIntent`, `runProbes`) run from the user's click.

/** How long to wait after a failed poll, doubling with each failure in a row up to `RETRY_MAX_MS`. */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/**
 * The least time between two polls whose answer did not advance: a long-poll that timed out has
 * waited already, but one answered at once with the same version (main disposed, say) would
 * otherwise spin.
 */
const MIN_IDLE_POLL_MS = 1_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SERP procedures the panels and the palette call (each resolves `false` / `null` on an IPC failure). */
export const serpActions = {
  setOutlines: (tabId: number, on: boolean) => ipc.serp.setOutlines.mutate({ tabId, on }).catch(() => false),
  checkPackUpdate: () => ipc.serp.checkPackUpdate.mutate().catch(() => null),
  enableIntent: () => ipc.serp.enableIntent.mutate().catch(() => null),
  intentState: () =>
    ipc.serp.intentState
      .query()
      .then((state) => {
        rememberIntent(state);
        return state;
      })
      .catch(() => null),
  classify: (query: string) => ipc.serp.classify.query({ query }).catch(() => null),
  runProbes: (tabId: number) => ipc.serp.runProbes.mutate({ tabId }).catch(() => false),
  stopProbes: (tabId: number) => ipc.serp.stopProbes.mutate({ tabId }).catch(() => false),
};

/** A long-poll loop over `watch` for `tabId`, keeping the latest answer for that tab. */
function useWatch<T extends { readonly tabId: number; readonly version: number }>(tabId: number | undefined, watch: (tabId: number, since: number) => Promise<T>, remember: (state: T) => void): T | null {
  const [state, setState] = useState<T | null>(null);
  useEffect(() => {
    if (tabId === undefined) return;
    let live = true;
    let since = -1;
    let failures = 0;
    const loop = async (): Promise<void> => {
      while (live) {
        const started = Date.now();
        try {
          const next = await watch(tabId, since);
          if (!live) return;
          failures = 0;
          const advanced = next.version > since;
          since = next.version;
          remember(next);
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
    };
  }, [tabId]);
  return state !== null && state.tabId === tabId ? state : null;
}

const watchSerp = (tabId: number, sinceVersion: number) => ipc.serp.watch.query({ tabId, sinceVersion });
const watchProbes = (tabId: number, sinceVersion: number) => ipc.serp.watchProbes.query({ tabId, sinceVersion });

/** The tab's SERP state (`null` until the first answer, or without a tab). */
export function useSerp(tabId: number | undefined): SerpTabState | null {
  return useWatch(tabId, watchSerp, rememberSerp);
}

/** The tab's visibility probes (`null` until the first answer, or without a tab). */
export function useProbes(tabId: number | undefined): ProbesState | null {
  return useWatch(tabId, watchProbes, rememberProbes);
}

/**
 * Where on-device intent stands: asked on mount and whenever `key` changes (a new SERP state), and
 * again by `refresh` (after "Enable"). `null` until answered.
 */
export function useIntentState(key: unknown): [IntentState | null, () => void] {
  const [state, setState] = useState<IntentState | null>(null);
  const refresh = useCallback(() => {
    void serpActions.intentState().then((next) => {
      if (next !== null) setState(next);
    });
  }, []);
  useEffect(refresh, [key, refresh]);
  return [state, refresh];
}
