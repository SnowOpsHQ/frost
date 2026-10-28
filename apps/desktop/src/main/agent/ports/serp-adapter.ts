import type { AiSearchAnswer, AiSearchQuery, PortQueryOptions, SerpPort, SerpQuery, SerpResults } from '@app/ai-skills';
import { readAnswer } from './read-answer';

// The `SerpPort` over Phase 3's SERP read API (Phase 5 Task 8; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). A thin adapter: Phase 3 exports a Zod-typed read
// API from `packages/ipc-contract/src/serp-service.ts`, which had not merged when this was written,
// so the service is typed here by the minimal structure the adapter needs (`SerpReadService`).
//
// TODO(lead, after Phase 3 merges):
// - point `results` at serp-service's read query for a query's stored or fetched organic results
//   (query, locale, device), mapping its rows to `SerpResults` (`position` 1-based, `url`, `title`,
//   `snippet`; `features` as plain names; `fetchedAt` ISO 8601) and answering `null` when it has
//   none for that query;
// - point `aiSearch` at its AI answer read (answer text and cited sources, in order), or leave it
//   out if Phase 3 has none (the tool then says it isn't connected);
// - pass `options.signal` on if the service takes one;
// - then add `ports: { serp: serpAdapter(services.serp), … }` to `createAgentService` in main's
//   `index.ts` (the plan's Task 8 as-built note has the exact line).

/** The read queries the adapter needs (structural; match Phase 3's serp-service here). */
export interface SerpReadService {
  results(query: SerpQuery, options: PortQueryOptions): Promise<SerpResults | null | undefined>;
  aiSearch?(query: AiSearchQuery, options: PortQueryOptions): Promise<AiSearchAnswer | null | undefined>;
}

/** `service` as a `SerpPort`, or `null` without one (main then wires the not-connected port). */
export function serpAdapter(service: SerpReadService | null | undefined): SerpPort | null {
  if (!service) return null;
  return {
    results: (query, options) =>
      readAnswer(() => service.results(query, options ?? {}), options, {
        missing: 'No search results are stored for this query yet.',
        failed: 'The search results could not be read.',
      }),
    aiSearch: (query, options) =>
      readAnswer(async () => (service.aiSearch ? service.aiSearch(query, options ?? {}) : null), options, {
        missing: service.aiSearch ? 'No AI answer is stored for this query yet.' : "AI answers aren't connected in this build.",
        failed: 'The AI answer could not be read.',
      }),
  };
}
