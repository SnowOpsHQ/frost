import type { GscPerformance, GscPerformanceQuery, GscPort, PortQueryOptions } from '@app/ai-skills';
import { readAnswer } from './read-answer';

// The `GscPort` over Phase 4's search performance read API (Phase 5 Task 8; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). Phase 4 exports a Zod-typed read API from
// `packages/ipc-contract/src/gsc-service.ts`, not merged when this was written, so the service is
// typed by the minimal structure the adapter needs.
//
// TODO(lead, after Phase 4 merges): point `performance` at gsc-service's read query for one page
// over the last `days` (the site owner's connected property that covers `url`), mapping its totals
// (clicks, impressions, ctr 0–1, average position or `null` without impressions) and its top queries
// (most clicks first) to `GscPerformance`, and answering `null` when no connected property covers the
// page; pass `options.signal` on if the service takes one. Read-only: nothing here may change the
// user's connection or settings.

/** The read query the adapter needs (structural; match Phase 4's gsc-service here). */
export interface GscReadService {
  performance(query: GscPerformanceQuery, options: PortQueryOptions): Promise<GscPerformance | null | undefined>;
}

/** `service` as a `GscPort`, or `null` without one. */
export function gscAdapter(service: GscReadService | null | undefined): GscPort | null {
  if (!service) return null;
  return {
    performance: (query, options) =>
      readAnswer(() => service.performance(query, options ?? {}), options, {
        missing: 'No connected search performance data covers this page.',
        failed: 'The search performance data could not be read.',
      }),
  };
}
