import { useEffect, useState } from 'react';
import type { SeoAuditResponse } from '@app/seo-core';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { ipc } from '../ipc';
import { shownResponse, type FetchedAudit } from '../seo-view';

/**
 * The active tab's SEO audit (`seo.getAudit`), fetched again whenever the tab, its URL, its
 * `auditVersion` or its error / crash state changes (`browser.watch` delivers those). Fetched while
 * the panel is collapsed too: the rail keeps its status dots. An answer is shown only for the tab
 * and URL it was fetched for (`shownResponse`); `null` for no tab or an empty one.
 */
export function useSeoAudit(tab: TabState | undefined): SeoAuditResponse | null {
  const [fetched, setFetched] = useState<FetchedAudit | null>(null);
  const tabId = tab?.id;
  const key = tab ? `${tab.id}\u0000${tab.url}\u0000${tab.auditVersion}\u0000${tab.error?.code ?? ''}\u0000${tab.crashed}` : '';
  useEffect(() => {
    if (tabId === undefined || tab?.url === '') return;
    let live = true;
    ipc.seo.getAudit
      .query({ tabId })
      .then((response) => {
        if (live) setFetched({ tabId, response });
      })
      .catch(() => {
        // Asked again on the next change.
      });
    return () => {
      live = false;
    };
  }, [key]);
  if (!tab || tab.url === '') return null;
  return shownResponse(tab, fetched);
}
