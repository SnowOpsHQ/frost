import { unavailable, type GscPerformance, type GscPort, type PortAnswer } from '@app/ai-skills';

// The `GscPort` over Phase 4's read-only search performance API (Phase 5 Task 8 and its review;
// acceptance `specs/agent-search-tools.feature.md`, Wiring). Written against `GscService` in
// `packages/ipc-contract/src/gsc-service.ts` and `specs/gsc.schema.ts` on
// `phase-4/accounts-telemetry` at bc692be: `performance({ url, scope, days })` and
// `topQueries(...)` with `days` one of 7, 28 or 90, each answering `{ status: 'ok', … }` or
// `{ status: 'unavailable', reason }` (a code, `GSC_UNAVAILABLE_REASONS`), never throwing.
//
// The mapping: scope `page`; the tool's `days` (1 to 480) to the nearest range Phase 4 serves
// (`nearestGscRange`; the answer says which one); `performance`'s totals merged with `topQueries`'
// rows (a queries miss leaves the list empty: the totals still answer); a reason code to a plain
// sentence (`GSC_ADAPTER_REASONS`). The types below are minimal structural copies; Phase 4's
// `GscService` is assignable to `GscServiceLike` (a type-level test keeps it so).

/** The ranges Phase 4 serves (`GSC_RANGE_DAYS`). */
export const GSC_ADAPTER_RANGES = [7, 28, 90] as const;
export type GscRangeLike = (typeof GSC_ADAPTER_RANGES)[number];

export interface GscQueryLike {
  readonly url: string;
  readonly scope: 'page' | 'property';
  readonly days: GscRangeLike;
}

type Unavailable = { readonly status: 'unavailable'; readonly reason: string };
export type GscPerformanceAnswerLike = { readonly status: 'ok'; readonly totals: { readonly clicks: number; readonly impressions: number; readonly ctr: number; readonly position: number | null } } | Unavailable;
export type GscQueriesAnswerLike =
  | { readonly status: 'ok'; readonly rows: readonly { readonly query: string; readonly clicks: number; readonly impressions: number; readonly ctr: number; readonly position: number }[] }
  | Unavailable;

/** Phase 4's `GscService`, the members this adapter calls. */
export interface GscServiceLike {
  performance(query: GscQueryLike): Promise<GscPerformanceAnswerLike>;
  topQueries(query: GscQueryLike): Promise<GscQueriesAnswerLike>;
}

/** Each of Phase 4's reason codes as a sentence the model can relay (frost's own words). */
export const GSC_ADAPTER_REASONS: Readonly<Record<string, string>> = {
  unconfigured: "Search performance data isn't set up in this build.",
  'not-entitled': "Search performance data isn't included in the user's plan.",
  'not-connected': "No search performance account is connected. The user can connect one in frost's settings.",
  'not-a-web-page': "That address isn't a web page.",
  invalid: 'The search performance request was not accepted.',
  'no-property': "None of the connected account's sites covers this page.",
  'auth-expired': "The search performance connection has expired. The user can reconnect it in frost's settings.",
  quota: 'The search performance quota is used up for now. Try again later.',
  network: "The search performance data couldn't be reached. Try again later.",
};
const GSC_FAILED_REASON = 'The search performance data could not be read.';

/** The range Phase 4 serves nearest to `days` (a tie takes the longer one). */
export function nearestGscRange(days: number): GscRangeLike {
  let best: GscRangeLike = GSC_ADAPTER_RANGES[0];
  for (const range of GSC_ADAPTER_RANGES) if (Math.abs(range - days) <= Math.abs(best - days)) best = range;
  return best;
}

/** `service` as a `GscPort`, or `null` without one. */
export function gscAdapter(service: GscServiceLike | null | undefined): GscPort | null {
  if (!service) return null;
  return {
    async performance(query, options): Promise<PortAnswer<GscPerformance>> {
      const read: GscQueryLike = { url: query.url, scope: 'page', days: nearestGscRange(query.days) };
      let answers: [GscPerformanceAnswerLike, GscQueriesAnswerLike];
      try {
        answers = await Promise.all([service.performance(read), service.topQueries(read)]);
      } catch {
        return unavailable(GSC_FAILED_REASON);
      }
      options?.signal?.throwIfAborted();
      const [performance, queries] = answers;
      if (performance.status !== 'ok') return unavailable((Object.hasOwn(GSC_ADAPTER_REASONS, performance.reason) ? GSC_ADAPTER_REASONS[performance.reason] : undefined) ?? GSC_FAILED_REASON);
      const { totals } = performance;
      return {
        status: 'ok',
        data: {
          url: query.url,
          days: read.days,
          clicks: totals.clicks,
          impressions: totals.impressions,
          ctr: totals.ctr,
          position: totals.position,
          queries: queries.status === 'ok' ? queries.rows.map((row) => ({ query: row.query, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })) : [],
        },
      };
    },
  };
}
