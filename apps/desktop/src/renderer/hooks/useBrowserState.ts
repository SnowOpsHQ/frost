import { useEffect, useState } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { BrowserState } from '@app/specs/browser.spec';
import { ipc } from '../ipc';

const RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Long-polls `browser.watch`; each answer carries the full state and its version. */
export function useBrowserState(): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null);
  useEffect(() => {
    let live = true;
    let since = 0;
    void (async () => {
      while (live) {
        try {
          const next = await ipc.browser.watch.query({ sinceVersion: since });
          if (!live) return;
          since = next.version;
          setState(next);
        } catch {
          if (live) await sleep(RETRY_MS);
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  return state;
}
