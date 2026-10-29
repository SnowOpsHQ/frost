import type {
  GscConnectResult,
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
 * - is gated on the `search-console` feature itself (`not-entitled` before anything is sent);
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
   * (scope `page`: that URL without its fragment) or its whole property (scope `property`), over the
   * `query.days` (7, 28 or 90) days ending `GSC_DATA_LAG_DAYS` before today (UTC), with the totals.
   */
  performance(query: GscPerformanceQuery): Promise<GscPerformanceAnswer>;
  /** The top search queries (most clicks first, at most `GSC_LIMITS.maxTopQueries`) for the same page or property and range (`GscQueriesAnswerSchema`). */
  topQueries(query: GscPerformanceQuery): Promise<GscQueriesAnswer>;
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
}
