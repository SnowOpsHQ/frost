import { aiDestination, aiDestinationUrl, type AiDestinationId, type OpenDestinationResult } from '@app/specs/ai-destinations.spec';
import type { SerpState } from '@app/specs/serp-service.schema';

// "Open in" an AI engine (Phase 10 Task 10; spec `ai-destinations.spec.ts`; plan Decision 13;
// acceptance `serp-panels.feature.md`, Open in an AI engine): `serp.openDestination`. Main builds the
// URL from the fixed table (`AI_SEARCH_DESTINATIONS`) and the SERP tab's **own** query (its SERP
// state's `params.query`), never from renderer text, and opens it through the browser controller's
// `openBackgroundTab(url, false)` (its browse guards and tab cap; no render profile inherited). It
// runs only when the user's click or palette action calls the procedure, only for the active tab
// (any other tab is `no-search`, its state never read), and reads nothing on the destination's page. Injected, so it is tested with fakes.

export interface DestinationsOptions {
  /** The tab's SERP state now, read passively (`Serp.peek`: no read is started). */
  readonly state: (tabId: number) => SerpState;
  /** The active tab's id (`browser.getState().activeTabId`): only its search is ever opened, as `browser.openTool` does. */
  readonly activeTabId: () => number | null;
  /** `browser.openBackgroundTab(url, false)`: the new tab's id, or `null` (the tab cap, no window). Absent: no tab ever opens. */
  readonly openBackgroundTab?: (url: string) => number | null;
}

export interface Destinations {
  /** Opens the tab's search in `destination`; never throws. */
  open(tabId: number, destination: AiDestinationId): OpenDestinationResult;
}

/** The query of the search a SERP state shows (`null`: it shows none). */
function queryOf(state: SerpState): string | null {
  switch (state.status) {
    case 'pending':
      return state.params.query;
    case 'ready':
      return state.snapshot.params.query;
    case 'unreadable':
      return state.params?.query ?? null;
    default:
      return null;
  }
}

export function createDestinations(options: DestinationsOptions): Destinations {
  const { state, activeTabId, openBackgroundTab } = options;
  return {
    open(tabId, id) {
      const destination = aiDestination(id);
      if (!destination) return { status: 'refused', reason: 'no-search' };
      let url: string | null = null;
      try {
        // Only the active tab: the one the user acted on, and the opener the new tab goes beside.
        if (activeTabId() !== tabId) return { status: 'refused', reason: 'no-search' };
        const serp = state(tabId);
        // Only the named tab's own search.
        const query = serp.tabId === tabId ? queryOf(serp) : null;
        url = query === null ? null : aiDestinationUrl(destination, query);
      } catch {
        url = null;
      }
      if (url === null) return { status: 'refused', reason: 'no-search' };
      if (!openBackgroundTab) return { status: 'refused', reason: 'no-tab' };
      let opened: number | null = null;
      try {
        opened = openBackgroundTab(url);
      } catch {
        opened = null;
      }
      return opened === null ? { status: 'refused', reason: 'no-tab' } : { status: 'opened', tabId: opened };
    },
  };
}
