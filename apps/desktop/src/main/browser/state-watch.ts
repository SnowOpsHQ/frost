import { MAX_PENDING_WATCHES, type BrowserState } from '@app/specs/browser.spec';

// State versioning and the `browser.watch` long-poll (spec `browser-chrome.feature.md`,
// `watch-resolves-on-change` …): main pushes nothing; the chrome asks for the state newer than the
// version it has, and is answered once there is one.

export interface StateWatch {
  /** The current state version (starts at 1). */
  version(): number;
  /** The state changed: the version advances by one (waiters are woken by `wake`). */
  bump(): void;
  /** Answers every waiter whose version is now behind. */
  wake(): void;
  /**
   * Resolves `snapshot()` once `version > sinceVersion` (at once if it already is, or if `signal`
   * is aborted; when it aborts later). A version from the future waits for the next change only.
   * At `MAX_PENDING_WATCHES` waiting, the oldest is answered early with the current state.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<BrowserState>;
  /** How many watches are waiting. */
  pending(): number;
}

export function createStateWatch(snapshot: () => BrowserState): StateWatch {
  let version = 1;
  /** Pending watches, oldest first: their wake-up check → their early finish. */
  const waiters = new Map<() => void, () => void>();

  return {
    version: () => version,
    bump() {
      version += 1;
    },
    wake() {
      for (const wake of [...waiters.keys()]) wake();
    },
    watch(sinceVersion, signal) {
      // A version from the future is clamped: wait for the next change, not forever.
      const since = Math.min(sinceVersion, version);
      return new Promise((resolve) => {
        if (version > since || signal?.aborted) {
          resolve(snapshot());
          return;
        }
        const finish = (): void => {
          waiters.delete(wake);
          signal?.removeEventListener('abort', finish);
          resolve(snapshot());
        };
        const wake = (): void => {
          if (version > since) finish();
        };
        // At the cap the oldest waiter is answered early with the current state.
        while (waiters.size >= MAX_PENDING_WATCHES) {
          const oldest = waiters.values().next().value;
          if (!oldest) break;
          oldest();
        }
        waiters.set(wake, finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    },
    pending: () => waiters.size,
  };
}
