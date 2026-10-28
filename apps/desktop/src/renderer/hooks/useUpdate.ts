import { useEffect, useState } from 'react';
import type { UpdateChecks, UpdateState } from '@app/specs/update-client.spec';
import { ipc } from '../ipc';

// The update state (acceptance `update-client.feature.md`, Chrome): long-polls `update.watch` from
// the chrome's start (the update bar is always mounted), so an offer, a download's progress or an
// error shows as main reaches it. A failed poll waits a moment and asks again. The chrome makes no
// request of its own: every step is an `update.*` procedure, and main does the rest.

/** How long to wait after a failed poll. */
const RETRY_MS = 1_000;

/** The last state any poll or action answered (for the palette's availability). */
let latest: UpdateState | undefined;
const listeners = new Set<(state: UpdateState) => void>();

/** Keeps `state` if it is newer than what the chrome has, and tells every mounted hook. */
function remember(state: UpdateState | null): UpdateState | null {
  if (state !== null && (latest === undefined || state.version > latest.version)) {
    latest = state;
    for (const listener of listeners) listener(state);
  }
  return state;
}

/** The last update state the chrome saw (`undefined` before the first answer). */
export const knownUpdate = (): UpdateState | undefined => latest;

/** The update procedures (each resolves `null`, or `false` for `install`, on an IPC failure). */
export const updateActions = {
  check: () => ipc.update.check.mutate().then(remember, () => null),
  download: () => ipc.update.download.mutate().then(remember, () => null),
  skip: () => ipc.update.skip.mutate().then(remember, () => null),
  setChecks: (checks: UpdateChecks) => ipc.update.setChecks.mutate({ checks }).then(remember, () => null),
  /** "Show file": main reveals the verified file; resolves whether it did. */
  install: () => ipc.update.install.mutate().catch(() => false),
};

/** The latest update state (`null` until the first answer). */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(latest ?? null);
  useEffect(() => {
    let live = true;
    listeners.add(setState);
    const loop = async (): Promise<void> => {
      while (live) {
        try {
          const next = await ipc.update.watch.query({ sinceVersion: latest?.version ?? -1 });
          if (!live) return;
          remember(next);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    };
    void loop();
    return () => {
      live = false;
      listeners.delete(setState);
    };
  }, []);
  return state;
}
