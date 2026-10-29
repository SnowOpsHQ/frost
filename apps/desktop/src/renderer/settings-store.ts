import { settingsRetryDelay } from '@app/specs/account-settings.spec';

// One long-poll per piece of main's state for the whole chrome (Phase 4 Task 9; acceptance
// `account-settings.feature.md`, Shared watches): the Settings sheet and the Search Console panel
// read `account.watch` and `gsc.watch` through the same store, so they never hold two waits in main.
// The poll runs while anything subscribes; it stops after its current answer once nothing does (a wait
// already in main ends at its own timeout). A failed poll is tried again after `settingsRetryDelay`.

export interface WatchStore<T> {
  /** For `useSyncExternalStore`: starts the poll with the first listener; answers the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The last answer (`null` before the first). */
  current(): T | null;
  /** How many failures in a row there have been (`0` after an answer). */
  failures(): number;
}

export interface WatchStoreOptions {
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A store over `poll(since)` (`-1`: answer at once); `counter` is an answer's version, the next `since`. */
export function createWatchStore<T>(poll: (since: number) => Promise<T>, counter: (value: T) => number, options: WatchStoreOptions = {}): WatchStore<T> {
  const sleep = options.sleep ?? defaultSleep;
  const listeners = new Set<() => void>();
  let value: T | null = null;
  let failed = 0;
  let looping = false;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  async function loop(): Promise<void> {
    looping = true;
    // After a pause the state may have moved on: the first poll answers at once.
    let since = -1;
    while (listeners.size > 0) {
      try {
        const next = await poll(since);
        since = counter(next);
        value = next;
        failed = 0;
        notify();
      } catch {
        failed += 1;
        notify();
        await sleep(settingsRetryDelay(failed));
      }
    }
    looping = false;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!looping) void loop();
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => value,
    failures: () => failed,
  };
}
