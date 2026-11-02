import type { GscInspectInput, GscInspectionAnswer, GscOpenLinkResult } from '@app/specs/gsc-inspection.schema';
import type {
  GscConnectResult,
  GscCountriesAnswer,
  GscPerformanceAnswer,
  GscPerformanceQuery,
  GscPropertiesAnswer,
  GscPropertyForAnswer,
  GscQueriesAnswer,
  GscStatus,
} from '@app/specs/gsc.schema';

// Search Console as main serves it (Phase 4 Task 8; spec `specs/gsc.schema.ts`; acceptance
// `specs/gsc.feature.md`; plan "Interfaces for other phases"). Main implements it
// (`createGscService(...)` in `apps/desktop/src/main/gsc/service.ts`); this package only knows the
// interfaces. Tokens stay in main: no member answers a token, code, verifier, `state` or account name.

/**
 * The read-only Search Console API: **stable across phases** (Phase 5's agent tool calls it in main;
 * changing it needs the owning phase's review). Every method:
 * - is not gated: Search Console needs no frost account or plan (`UNGATED_FEATURES`); main's service
 *   keeps an `entitled` seam whose `not-entitled` answer stays for wire compatibility only;
 * - **never throws** and never rejects: each answer is `{ status: 'ok', … }` or
 *   `{ status: 'unavailable', reason }` (`GSC_UNAVAILABLE_REASONS`), checked in this order:
 *   `unconfigured`, `not-entitled`, `not-connected`, the input (`not-a-web-page`, `invalid`),
 *   `no-property`, then Google's (`auth-expired`, `quota`, `network`, `invalid`);
 * - validates its input itself (a caller in main is not behind the router), and answers a value that
 *   passes its strict schema in `gsc.schema.ts`;
 * - reuses answers for `GSC_CACHE_TTL_MS` per key (cleared on disconnect), so calling it again is cheap.
 */
export interface GscService {
  /** The connection now (`GscStatusSchema`): configured, entitled, connected, connecting, keychain, last error, version. */
  status(): GscStatus;
  /** The verified properties of the connected account (`GscPropertiesAnswerSchema`), `siteUnverifiedUser` ones left out, sorted by `siteUrl`. */
  properties(): Promise<GscPropertiesAnswer>;
  /**
   * The property that covers `url` (`GscPropertyForAnswerSchema`): the longest URL-prefix property with
   * the URL's scheme and host, else the most specific domain property; `no-property` when none does.
   */
  propertyFor(url: string): Promise<GscPropertyForAnswer>;
  /**
   * Clicks, impressions, CTR and average position per day (`GscPerformanceAnswerSchema`) for `query.url`
   * (scope `page`: that URL without its fragment) or its whole property (scope `property`), with the
   * totals, over either `query.days` (7, 28 or 90) days ending `GSC_DATA_LAG_DAYS` before today (UTC)
   * or a custom `query.range` (`gscCustomRange`: its end clamped to the lag day; refused, `invalid`, if
   * it ends in the future, starts before `gscRetentionStart` or spans over `GSC_MAX_RANGE_DAYS`),
   * optionally only one `country` and one `device`. Exactly one of `days` and `range`.
   */
  performance(query: GscPerformanceQuery): Promise<GscPerformanceAnswer>;
  /** The top search queries (most clicks first, at most `GSC_LIMITS.maxTopQueries`) for the same page or property, range and filters (`GscQueriesAnswerSchema`). */
  topQueries(query: GscPerformanceQuery): Promise<GscQueriesAnswer>;
  /**
   * The countries with data (most clicks first, each once, at most `GSC_LIMITS.maxCountries`) for the
   * same page or property, range and `device` filter (`GscCountriesAnswerSchema`): the country picker's
   * list. A `country` filter is ignored here (the list would be only itself). Added in Phase 9.
   */
  countries(query: GscPerformanceQuery): Promise<GscCountriesAnswer>;
  /**
   * Google's URL Inspection of `input.url` (without its fragment) in the property that covers it
   * (`GscInspectionAnswerSchema`, spec `gsc-inspection.schema.ts`): index status, rich results and the
   * Search Console link, every string capped. Sends one request to Google's per-site quota, so it runs
   * only when the user asks (never on a page load), through its own rate (`GSC_INSPECTION_RATE`). An
   * `ok` answer is reused for `GSC_CACHE_TTL_MS`; `input.fresh` skips that. Added in Phase 9.
   */
  inspect(input: GscInspectInput): Promise<GscInspectionAnswer>;
}

/** What the `gsc.*` procedures also need: the long-poll and the connection's actions (the chrome's Settings). */
export interface GscIpcService extends GscService {
  /**
   * Resolves with the status once its `version` exceeds `sinceVersion` (at once if it already does), or
   * when `signal` aborts. At most `GSC_LIMITS.maxPendingWatches` wait; one more answers the oldest early.
   */
  watch(sinceVersion: number, signal?: AbortSignal): Promise<GscStatus>;
  /**
   * Starts connecting a Google account for app window `windowId` (the IPC sender's): needs a live user
   * gesture there (else `needs-gesture`, nothing opened) and `search-console`; opens Google's consent
   * page (read-only scope only) in the system browser.
   */
  connect(windowId: number): Promise<GscConnectResult>;
  /** Drops the pending connect: `true` if there was one. */
  cancelConnect(): Promise<boolean>;
  /** Forgets the connection (the refresh token deleted, then revoked at Google): `true` if connected. Works without `search-console`. */
  disconnect(): Promise<boolean>;
  /**
   * Opens the Search Console page of the inspection of `url` (the **page**, never a link) for app
   * window `windowId` (the IPC sender's): spends a live user gesture there (else `needs-gesture`),
   * takes the link from main's own cached `ok` answer for that page, checks its host again
   * (`GSC_INSPECTION_LINK_HOST`) and opens it with `openExternalIfAllowed`; else `no-link`. Never
   * calls Google, never opens anything else, never throws.
   */
  openInspectionLink(windowId: number, url: string): Promise<GscOpenLinkResult>;
}
