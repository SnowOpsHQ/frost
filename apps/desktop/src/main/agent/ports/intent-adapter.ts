import type { IntentClassification, IntentPort, IntentQuery, PortQueryOptions } from '@app/ai-skills';
import { readAnswer } from './read-answer';

// The `IntentPort` over the search-intent read API (Phase 5 Task 8; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). Expected from Phase 3's
// `packages/ipc-contract/src/serp-service.ts` (not merged when this was written), so the service is
// typed by the minimal structure the adapter needs.
//
// TODO(lead, after Phase 3 merges): point `classify` at the service's intent query, mapping its
// labels to `SEARCH_INTENTS` (`informational`, `navigational`, `commercial`, `transactional`; the
// tool drops any other) with confidences from 0 to 1, most likely first, and answering `null` when
// it can't classify the query; pass `options.signal` on if the service takes one.

/** The read query the adapter needs (structural; match the real service here). */
export interface IntentReadService {
  classify(query: IntentQuery, options: PortQueryOptions): Promise<IntentClassification | null | undefined>;
}

/** `service` as an `IntentPort`, or `null` without one. */
export function intentAdapter(service: IntentReadService | null | undefined): IntentPort | null {
  if (!service) return null;
  return {
    classify: (query, options) =>
      readAnswer(() => service.classify(query, options ?? {}), options, {
        missing: "This query's intent could not be classified.",
        failed: 'The search intent could not be read.',
      }),
  };
}
