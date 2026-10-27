import { useEffect, useState } from 'react';
import type { CheckKind, ChecksState } from '@app/specs/seo-checks.spec';
import { rememberChecks } from '../checks-view';
import { ipc } from '../ipc';

// The active tab's link, sitemap and hreflang checks (acceptance `seo-checks.feature.md`, Panels):
// long-polls `checks.watch` while a check surface is mounted, so progress streams in as main pushes
// it (at most every `CHECKS_PUSH_INTERVAL_MS`). A failed poll waits a moment and asks again.

/** How long to wait after a failed poll. */
const RETRY_MS = 1_000;

/** The checks' procedures (each resolves `false` on an IPC failure). */
export const checksActions = {
  checkLinks: (tabId: number) => ipc.checks.checkLinks.mutate({ tabId }).catch(() => false),
  checkSitemaps: (tabId: number) => ipc.checks.checkSitemaps.mutate({ tabId }).catch(() => false),
  checkHreflang: (tabId: number) => ipc.checks.checkHreflang.mutate({ tabId }).catch(() => false),
  stop: (tabId: number, check: CheckKind) => ipc.checks.stop.mutate({ tabId, check }).catch(() => false),
};

/** The latest checks state of `tabId` (`null` until the first answer, or without a tab). */
export function useChecks(tabId: number | undefined): ChecksState | null {
  const [state, setState] = useState<ChecksState | null>(null);
  useEffect(() => {
    if (tabId === undefined) return;
    let live = true;
    let since = -1;
    const loop = async (): Promise<void> => {
      while (live) {
        try {
          const next = await ipc.checks.watch.query({ tabId, sinceVersion: since });
          if (!live) return;
          since = next.version;
          rememberChecks(next);
          setState(next);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
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
