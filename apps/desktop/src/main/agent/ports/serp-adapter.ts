import { unavailable, type AiSearchAnswer, type PortAnswer, type SerpPort, type SerpResults } from '@app/ai-skills';

// The `SerpPort` over Phase 3's `SerpReadApi` (Phase 5 Task 8 and its review; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). Written against
// `packages/ipc-contract/src/serp-service.ts` and `specs/serp-service.schema.ts` /
// `serp-snapshot.schema.ts` as they stand on `phase-3/serp-intent` at 45e8cf7: the read API is per
// tab (`snapshot(tabId)`: the reading of the result page the user loaded there) and has no
// query-based results read and no AI answer read.
//
// So, until Phase 3 exports a query-based read:
// - `serp_results` answers from the chat tab's reading when that tab shows a `ready` result page for
//   the same query (compared case- and space-insensitively), mapped below; any other state answers
//   `unavailable` with a reason the model can relay ("open the search in the tab first" …);
// - `run_ai_search` always answers `unavailable` (no AI answer read exists).
// When a query-based read lands, add it to `SerpReadApiLike` (optional) and prefer it here.
//
// The types below are minimal structural copies of the parts of Phase 3's types this adapter reads;
// Phase 3's `SerpReadApi` is assignable to `SerpReadApiLike` (a type-level test keeps it so).

/** A `ready` reading's snapshot, as far as the adapter reads it (`SerpReadySchema`). */
export interface SerpReadyLike {
  readonly params: { readonly query: string; readonly hl: string | null; readonly gl: string | null; readonly device: string };
  /** Every result in page order: `organic` ones have a 1-based `position`. */
  readonly results: readonly { readonly type: string; readonly position: number | null; readonly title: string; readonly url: string | null }[];
  readonly composition: { readonly features: readonly { readonly type: string }[] };
}

/** A tab's SERP reading (`SerpStateSchema`), as far as the adapter reads it. */
export type SerpStateLike =
  | { readonly status: 'ready'; readonly url: string; readonly readAt: number; readonly snapshot: SerpReadyLike }
  | { readonly status: 'not-serp' | 'pending' | 'unreadable' | 'disabled' };

/** Phase 3's `SerpReadApi`, the member this adapter calls. */
export interface SerpReadApiLike {
  snapshot(tabId: number): SerpStateLike;
}

/** Why there are no results to hand the model, per reading state (frost's own words). */
export const SERP_ADAPTER_REASONS = {
  noTab: 'There is no tab to read search results from.',
  'not-serp': "The chat's tab doesn't show a search result page. Ask the user to open the search for this query in that tab; frost reads results only from a page the user loaded.",
  pending: 'The result page in the chat\'s tab is still being read. Try again in a moment.',
  unreadable: "frost couldn't read the layout of the result page in the chat's tab.",
  disabled: 'Reading search result pages is turned off in this build.',
  otherQuery: "The result page in the chat's tab is for a different query. Ask the user to open the search for this query there first.",
  failed: 'The search results could not be read.',
  aiSearch: "Asking an AI answer engine isn't connected in this build.",
} as const;

const sameQuery = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** A reading's language and region as one BCP 47-like tag (`en-US`), `null` without a language. */
function localeOf(params: SerpReadyLike['params']): string | null {
  if (params.hl === null || params.hl === '') return null;
  const language = params.hl.split(/[-_]/)[0]!.toLowerCase();
  return params.gl === null || params.gl === '' ? language : `${language}-${params.gl.toUpperCase()}`;
}

/** A `ready` reading as `SerpResults`: its organic results in position order and its feature types, once each. */
export function serpResultsOf(state: Extract<SerpStateLike, { status: 'ready' }>): SerpResults {
  const { snapshot } = state;
  const results = snapshot.results
    .filter((result) => result.type === 'organic' && result.position !== null && result.url !== null)
    .map((result) => ({ position: result.position!, url: result.url!, title: result.title, snippet: '' }));
  return {
    query: snapshot.params.query,
    locale: localeOf(snapshot.params),
    device: snapshot.params.device === 'mobile' ? 'mobile' : 'desktop',
    fetchedAt: new Date(state.readAt).toISOString(),
    results,
    features: [...new Set(snapshot.composition.features.map((feature) => feature.type))],
  };
}

/** `readApi` as a `SerpPort`, or `null` without one (main then wires the not-connected port). */
export function serpAdapter(readApi: SerpReadApiLike | null | undefined): SerpPort | null {
  if (!readApi) return null;
  return {
    async results(query, options): Promise<PortAnswer<SerpResults>> {
      const tabId = options?.tabId;
      if (tabId === undefined) return unavailable(SERP_ADAPTER_REASONS.noTab);
      let state: SerpStateLike;
      try {
        state = readApi.snapshot(tabId);
      } catch {
        return unavailable(SERP_ADAPTER_REASONS.failed);
      }
      options?.signal?.throwIfAborted();
      if (state.status !== 'ready') return unavailable(SERP_ADAPTER_REASONS[state.status] ?? SERP_ADAPTER_REASONS.failed);
      if (!sameQuery(state.snapshot.params.query, query.query)) return unavailable(SERP_ADAPTER_REASONS.otherQuery);
      return { status: 'ok', data: serpResultsOf(state) };
    },
    // Phase 3 has no AI answer read (45e8cf7).
    aiSearch: async (): Promise<PortAnswer<AiSearchAnswer>> => unavailable(SERP_ADAPTER_REASONS.aiSearch),
  };
}
