import { useSyncExternalStore } from 'react';
import type { AgentState } from '@app/specs/agent-session.spec';
import { ipc } from '../ipc';

/** Waits after a failed poll: doubling from the first, capped at the last; a success resets it. */
export const AGENT_WATCH_RETRY_MS = { first: 1_000, max: 15_000 } as const;

/** The wait after `failures` failed polls in a row (1 → `first`). */
export function agentWatchRetryMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(AGENT_WATCH_RETRY_MS.max, AGENT_WATCH_RETRY_MS.first * 2 ** Math.min(n - 1, 16));
}

/**
 * The pause before polling again after an answer that didn't advance the version (the long-poll
 * timed out, or main is shutting down and answers at once): never a tight loop.
 */
export const AGENT_WATCH_IDLE_PAUSE_MS = 250;

type Watch = (sinceVersion: number, signal: AbortSignal) => Promise<AgentState>;

const defaultWatch: Watch = (sinceVersion, signal) => ipc.agent.watch.query({ sinceVersion }, { signal });

interface AgentStore {
  /** For `useSyncExternalStore`: the first listener starts the poll, the last one's unsubscribe stops it. */
  subscribe(listener: () => void): () => void;
  /** The last state (`null` before the first answer, and again once the poll stopped). */
  current(): AgentState | null;
}

/**
 * Long-polls `agent.watch` (as `useBrowserState` does `browser.watch`) for every caller at once: each
 * answer is the panel's whole `AgentState` and its version. A failed poll waits (`agentWatchRetryMs`,
 * backing off) and tries again; an answer that didn't advance the version pauses
 * `AGENT_WATCH_IDLE_PAUSE_MS` first. When the last caller unmounts the loop stops, the poll in flight
 * is aborted (its answer, if any, is dropped) and the state is forgotten: the next caller starts afresh.
 * (Not `createWatchStore`: that one neither aborts nor pauses, and keeps its last answer.)
 */
function createAgentStore(watch: Watch): AgentStore {
  const listeners = new Set<() => void>();
  let value: AgentState | null = null;
  let stop: (() => void) | null = null;

  function start(): () => void {
    let live = true;
    const abort = new AbortController();
    let since = 0;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    void (async () => {
      while (live) {
        try {
          const next = await watch(since, abort.signal);
          if (!live) return;
          failures = 0;
          if (next.version === since) {
            await sleep(AGENT_WATCH_IDLE_PAUSE_MS);
            continue;
          }
          since = next.version;
          value = next;
          for (const listener of [...listeners]) listener();
        } catch {
          if (!live) return;
          failures += 1;
          await sleep(agentWatchRetryMs(failures));
        }
      }
    })();
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
      wake?.();
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      stop ??= start();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || stop === null) return;
        stop();
        stop = null;
        value = null;
      };
    },
    current: () => value,
  };
}

/** One store per `watch` (the app's is `agent.watch`; a test passes its own). */
const stores = new WeakMap<Watch, AgentStore>();

/** Main's `AgentState` (`null` until main answers), from the one poll every caller shares. */
export function useAgentState(watch: Watch = defaultWatch): AgentState | null {
  let store = stores.get(watch);
  if (store === undefined) {
    store = createAgentStore(watch);
    stores.set(watch, store);
  }
  return useSyncExternalStore(store.subscribe, store.current);
}
