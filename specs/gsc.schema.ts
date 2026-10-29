/**
 * Search Console's schemas (Phase 4 Task 8; acceptance `gsc.feature.md`; review focus "Search Console
 * asks for read-only access only" and "The renderer never sees a token"). Main-only (Zod): the chrome
 * imports the plain values of `gsc.spec.ts` and this module's types only.
 *
 * - The `GscService` answers (`packages/ipc-contract/src/gsc-service.ts`, the stable read API Phase 5's
 *   agent tool calls in main) and the `gsc.*` procedures' outputs are **strict**: an answer with any
 *   other member (a token, a code) is refused by the router rather than forwarded. Every answer is
 *   `{ status: 'ok', … }` or `{ status: 'unavailable', reason }`.
 * - Inputs are strict: an unknown key, an over-long value or a non-`http(s)` URL is refused.
 * - Google's own answers (`Google*Schema`) are parsed leniently (unknown members stripped), then
 *   rebuilt into frost's shapes; nothing of them is forwarded as is.
 */
import { z } from 'zod';
import { KEYCHAIN_MODES } from './account-state.schema';
import {
  GSC_CONNECT_RESULTS,
  GSC_DATE_PATTERN,
  GSC_DOMAIN_PREFIX,
  GSC_ERRORS,
  GSC_LIMITS,
  GSC_PERMISSION_LEVELS,
  GSC_PROPERTY_KINDS,
  GSC_QUERY_SCOPES,
  GSC_RANGE_DAYS,
  GSC_UNAVAILABLE_REASONS,
  type GscConnectResult,
  type GscDateRange,
  type GscError,
  type GscProperty,
  type GscPropertyKind,
  type GscQueryScope,
  type GscRangeDays,
  type GscStatus,
  type GscUnavailableReason,
} from './gsc.spec';
import { isWebUrl } from './web-url.spec';

export * from './gsc.spec';

// ---- Status -------------------------------------------------------------------------------------

/** `gsc.status` / `gsc.watch` (`GscStatus`): booleans, the keychain mode, an error code, a version. */
export const GscStatusSchema = z
  .strictObject({
    configured: z.boolean(),
    entitled: z.boolean(),
    connected: z.boolean(),
    connecting: z.boolean(),
    keychain: z.enum(KEYCHAIN_MODES),
    error: z.enum(GSC_ERRORS).nullable(),
    version: z.int().nonnegative(),
  })
  .refine((s) => !(s.connected && s.connecting), { error: 'connecting is never set while connected', path: ['connecting'] })
  .refine((s) => s.configured || (!s.connected && !s.connecting), { error: 'an unconfigured build is never connected', path: ['connected'] });
export type { GscStatus, GscError };

// ---- Inputs -------------------------------------------------------------------------------------

/** `gsc.watch`: the status once its `version` exceeds `sinceVersion` (`-1`: at once). */
export const GscWatchInputSchema = z.strictObject({ sinceVersion: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type GscWatchInput = z.infer<typeof GscWatchInputSchema>;

const webUrl = z.string().min(1).max(GSC_LIMITS.maxUrlChars).refine(isWebUrl, { message: 'not an http(s) URL' });

/**
 * `gsc.performance` and `gsc.topQueries` (and `GscService.performance` / `topQueries`): the page
 * `url` (`http(s)`; main drops its fragment), whether to read that page or its whole property, and
 * the range (`GSC_RANGE_DAYS`).
 */
export const GscPerformanceQuerySchema = z.strictObject({
  url: webUrl,
  scope: z.enum(GSC_QUERY_SCOPES),
  days: z.union(GSC_RANGE_DAYS.map((days) => z.literal(days)) as [z.ZodLiteral<GscRangeDays>, ...z.ZodLiteral<GscRangeDays>[]]),
});
export type GscPerformanceQuery = z.infer<typeof GscPerformanceQuerySchema>;

/** `GscService.propertyFor`'s argument, as a schema (main validates what Phase 5 passes). */
export const GscUrlInputSchema = z.strictObject({ url: webUrl });
export type GscUrlInput = z.infer<typeof GscUrlInputSchema>;

/** `gsc.connect`'s answer (`GSC_CONNECT_RESULTS`). */
export const GscConnectResultSchema = z.enum(GSC_CONNECT_RESULTS);
export type { GscConnectResult };
/** `gsc.cancelConnect` (whether a connect was pending) and `gsc.disconnect` (whether one was connected). */
export const GscActionResultSchema = z.boolean();

// ---- Answers ------------------------------------------------------------------------------------

/** A property as frost shows it: its `siteUrl`, kind (from the `sc-domain:` prefix) and permission. */
export const GscPropertySchema = z
  .strictObject({
    siteUrl: z.string().min(1).max(GSC_LIMITS.maxUrlChars),
    kind: z.enum(GSC_PROPERTY_KINDS),
    permissionLevel: z.enum(GSC_PERMISSION_LEVELS),
  })
  .refine((p) => (p.kind === 'domain') === p.siteUrl.startsWith(GSC_DOMAIN_PREFIX), { error: 'kind follows the sc-domain: prefix', path: ['kind'] })
  .refine((p) => p.kind === 'domain' || isWebUrl(p.siteUrl), { error: 'a URL-prefix property is an http(s) URL', path: ['siteUrl'] });
export type { GscProperty, GscPropertyKind };

export const GscUnavailableSchema = z.strictObject({ status: z.literal('unavailable'), reason: z.enum(GSC_UNAVAILABLE_REASONS) });
export type GscUnavailable = z.infer<typeof GscUnavailableSchema>;
export type { GscUnavailableReason };

const count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ctr = z.number().min(0).max(1);
const position = z.number().min(0).max(1_000_000);

export const GscDateRangeSchema = z
  .strictObject({ start: z.string().regex(GSC_DATE_PATTERN), end: z.string().regex(GSC_DATE_PATTERN) })
  .refine((r) => r.start <= r.end, { error: 'start is not after end', path: ['start'] });
export type { GscDateRange };

/** One day of a performance answer (dates without data are absent; Google omits them). */
export const GscPerformanceRowSchema = z.strictObject({ date: z.string().regex(GSC_DATE_PATTERN), clicks: count, impressions: count, ctr, position });
export type GscPerformanceRow = z.infer<typeof GscPerformanceRowSchema>;

/**
 * The range's totals, from its rows: clicks and impressions summed, `ctr = clicks / impressions`
 * (`0` without impressions), `position` the impression-weighted mean (`null` without impressions).
 */
export const GscTotalsSchema = z.strictObject({ clicks: count, impressions: count, ctr, position: position.nullable() });
export type GscTotals = z.infer<typeof GscTotalsSchema>;

/** `GscService.properties()`: the verified properties (no `siteUnverifiedUser`), sorted by `siteUrl`. */
export const GscPropertiesAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), properties: z.array(GscPropertySchema).max(GSC_LIMITS.maxProperties) }),
  GscUnavailableSchema,
]);
export type GscPropertiesAnswer = z.infer<typeof GscPropertiesAnswerSchema>;

/** `GscService.propertyFor(url)`: the property covering `url` (`no-property` when none does). */
export const GscPropertyForAnswerSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('ok'), property: GscPropertySchema }), GscUnavailableSchema]);
export type GscPropertyForAnswer = z.infer<typeof GscPropertyForAnswerSchema>;

/** `gsc.performance`: clicks, impressions, CTR and position per day over the range, and the totals. */
export const GscPerformanceAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    property: GscPropertySchema,
    scope: z.enum(GSC_QUERY_SCOPES),
    range: GscDateRangeSchema,
    rows: z.array(GscPerformanceRowSchema).max(GSC_LIMITS.maxDateRows),
    totals: GscTotalsSchema,
  }),
  GscUnavailableSchema,
]);
export type GscPerformanceAnswer = z.infer<typeof GscPerformanceAnswerSchema>;
export type { GscQueryScope, GscRangeDays };

/** One search query of a `topQueries` answer (its text cut to `GSC_LIMITS.maxQueryChars`). */
export const GscQueryRowSchema = z.strictObject({ query: z.string().max(GSC_LIMITS.maxQueryChars), clicks: count, impressions: count, ctr, position });
export type GscQueryRow = z.infer<typeof GscQueryRowSchema>;

/** `gsc.topQueries`: the page's (or property's) top queries over the range, most clicks first, capped. */
export const GscQueriesAnswerSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    property: GscPropertySchema,
    scope: z.enum(GSC_QUERY_SCOPES),
    range: GscDateRangeSchema,
    rows: z.array(GscQueryRowSchema).max(GSC_LIMITS.maxTopQueries),
  }),
  GscUnavailableSchema,
]);
export type GscQueriesAnswer = z.infer<typeof GscQueriesAnswerSchema>;

// ---- Google's answers (main only; parsed leniently, never forwarded) ------------------------------

const secretText = z.string().min(1).max(4_096);

/**
 * The token endpoint's answer (code exchange and refresh). `refresh_token` only on an exchange;
 * `scope` is the space-separated grant, checked against `GSC_SCOPE`.
 */
export const GoogleTokenResponseSchema = z.object({
  access_token: secretText,
  expires_in: z.number().int().positive().max(366 * 86_400),
  refresh_token: secretText.optional(),
  scope: z.string().max(4_096).optional(),
  token_type: z.string().regex(/^bearer$/i),
});
export type GoogleTokenResponse = z.infer<typeof GoogleTokenResponseSchema>;

/** A token endpoint refusal: `invalid_grant` means the code or refresh token is no longer accepted. */
export const GoogleTokenErrorSchema = z.object({ error: z.string().max(256) });

/** `GET /sites`: the user's properties (absent when there are none). Entries are filtered in main. */
export const GoogleSitesResponseSchema = z.object({
  siteEntry: z.array(z.object({ siteUrl: z.string(), permissionLevel: z.string() })).optional(),
});
export type GoogleSitesResponse = z.infer<typeof GoogleSitesResponseSchema>;

/** `POST /sites/{siteUrl}/searchAnalytics/query`: rows (absent when there is no data). */
export const GoogleSearchAnalyticsResponseSchema = z.object({
  rows: z
    .array(
      z.object({
        keys: z.array(z.string()).optional(),
        clicks: z.number().nonnegative(),
        impressions: z.number().nonnegative(),
        ctr: z.number().nonnegative(),
        position: z.number().nonnegative(),
      }),
    )
    .optional(),
});
export type GoogleSearchAnalyticsResponse = z.infer<typeof GoogleSearchAnalyticsResponseSchema>;

/** An API error body (`{ error: { status, errors: [{ reason }] } }`): read only to tell quota from other 403s. */
export const GoogleApiErrorSchema = z.object({
  error: z.object({
    status: z.string().max(128).optional(),
    errors: z.array(z.object({ reason: z.string().max(128).optional() })).optional(),
  }),
});

/** 403 reasons that mean a quota or rate limit (`quota`), not a missing permission. */
export const GOOGLE_QUOTA_REASONS: readonly string[] = Object.freeze(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);
