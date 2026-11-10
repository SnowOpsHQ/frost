import { unavailable, type AiSearchAnswer, type AiSearchQuery, type PortAnswer, type PortQueryOptions, type SerpPort } from '@app/ai-skills';

// `SerpPort.aiSearch` over main's AI search (Phase 12 Task 8; spec `specs/ai-search.spec.ts`;
// acceptance `specs/ai-search.feature.md`, Wiring). Thin: the approved `engine` and `via` (the input
// main's broker completed, showed and hashed, re-parsed by the runner) go to `ask` as they are; the
// service checks the setting again, sends through the data API client, has the SERP worker parse the
// answer, and answers a `PortAnswer`. A throw is a fixed reason; an abort goes on (the tool ends the
// call either way).

/** Main's AI search as the adapter calls it (`main/ai-search/service.ts`). */
export interface AiSearchServiceLike {
  ask(query: AiSearchQuery, options?: PortQueryOptions): Promise<PortAnswer<AiSearchAnswer>>;
}

export const AI_SEARCH_ADAPTER_FAILED = 'The AI search could not be run.';

/** `service` as the `aiSearch` member of a `SerpPort`, or `null` without one (`serpAdapter` keeps its reason). */
export function aiSearchAdapter(service: AiSearchServiceLike | null | undefined): SerpPort['aiSearch'] | null {
  if (!service) return null;
  return async (query, options) => {
    options?.signal?.throwIfAborted();
    try {
      return await service.ask(query, options);
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      return unavailable(AI_SEARCH_ADAPTER_FAILED);
    }
  };
}
