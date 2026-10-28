import { useEffect, useState } from 'react';
import type { AgentState } from '@app/specs/agent-session.spec';
import { ipc } from '../ipc';

/** Waits after a failed poll: doubling from the first, capped at the last; a success resets it. */
export const AGENT_WATCH_RETRY_MS = { first: 1_000, max: 15_000 } as const;

/** The wait after `failures` failed polls in a row (1 → `first`). */
export function agentWatchRetryMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(AGENT_WATCH_RETRY_MS.max, AGENT_WATCH_RETRY_MS.first * 2 ** Math.min(n - 1, 16));
}

type Watch = (sinceVersion: number) => Promise<AgentState>;

const defaultWatch: Watch = (sinceVersion) => ipc.agent.watch.query({ sinceVersion });

/**
 * Long-polls `agent.watch` (as `useBrowserState` does `browser.watch`): each answer is the panel's
 * whole `AgentState` and its version. A failed poll waits (`agentWatchRetryMs`, backing off) and
 * tries again; unmounting stops the loop and drops any answer still in flight.
 */
export function useAgentState(watch: Watch = defaultWatch): AgentState | null {
  const [state, setState] = useState<AgentState | null>(null);
  useEffect(() => {
    let live = true;
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
          const next = await watch(since);
          if (!live) return;
          failures = 0;
          since = next.version;
          setState(next);
        } catch {
          if (!live) return;
          failures += 1;
          await sleep(agentWatchRetryMs(failures));
        }
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      wake?.();
    };
  }, [watch]);
  return state;
}
