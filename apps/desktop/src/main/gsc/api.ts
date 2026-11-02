import type { z } from 'zod';
import { GoogleInspectionResponseSchema, type GoogleInspectionResponse } from '@app/specs/gsc-inspection.schema';
import {
  GOOGLE_QUOTA_REASONS,
  GoogleApiErrorSchema,
  GoogleSearchAnalyticsResponseSchema,
  GoogleSitesResponseSchema,
  type GoogleSearchAnalyticsResponse,
  type GoogleSitesResponse,
  type GscDateRange,
  type GscDevice,
} from '@app/specs/gsc.schema';
import { parseJson, send, type FetchLike } from './http';

// The Search Console API as main calls it (spec `gsc.schema.ts`, `gsc-inspection.schema.ts`, Google's
// answers; acceptance `gsc.feature.md`, Google API, and `gsc-inspection.feature.md`; plan Global
// Constraint "Outbound calls"). Read-only: v3's `GET /sites` and `POST
// /sites/{siteUrl}/searchAnalytics/query` (a query, not a write), and v1's `POST
// /urlInspection/index:inspect` on a second host (`inspectionBase`; a read of Google's index). No Electron import: main
// injects `net.fetch` (through `send`: `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`,
// a timeout, a capped body). The access token goes only in `Authorization: Bearer`. Failures are
// reported by kind only, never with a body, a URL or a token.

/**
 * - `auth`: 401: the access token is not accepted (refresh once and retry).
 * - `quota`: 429, or a 403 whose reason is a quota or rate limit (`GOOGLE_QUOTA_REASONS`).
 * - `forbidden`: any other 403: no permission for that property (any more).
 * - `network`: no answer (refused, DNS, TLS, timeout), 408 or a 5xx.
 * - `invalid`: any other answer: another status, or a body that is not the documented JSON.
 */
export type GscApiFailure = 'auth' | 'quota' | 'forbidden' | 'network' | 'invalid';
export type GscApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: GscApiFailure };

/** The dimensions frost asks for: per day, per search query, or per country. */
export type SearchAnalyticsDimension = 'date' | 'query' | 'country';

/** One `equals` filter (Google's documented members only). */
export interface SearchAnalyticsFilter {
  readonly dimension: 'page' | 'country' | 'device';
  readonly operator: 'equals';
  readonly expression: string;
}

/** A `searchAnalytics/query` request body (Google's documented members only). */
export interface SearchAnalyticsBody {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions: readonly [SearchAnalyticsDimension];
  readonly dimensionFilterGroups?: readonly [{ readonly groupType: 'and'; readonly filters: readonly SearchAnalyticsFilter[] }];
  readonly rowLimit: number;
  readonly type: 'web';
  readonly dataState: 'final';
}

/**
 * The body for one range (a preset's or a custom one, sent as given): per day (`date`), per search
 * query (`query`) or per country (`country`), for one page (`pageUrl`, already without its fragment:
 * `page equals`) or the whole property (`null`: no page filter), optionally only one `country`
 * (`country equals`, Google's lowercase alpha-3) and one `device` (`device equals`). The filters go,
 * in that order, in one `and` group; without any there is no group.
 */
export function searchAnalyticsBody(options: {
  range: GscDateRange;
  dimension: SearchAnalyticsDimension;
  pageUrl: string | null;
  country?: string | null | undefined;
  device?: GscDevice | null | undefined;
  rowLimit: number;
}): SearchAnalyticsBody {
  const filters: SearchAnalyticsFilter[] = [];
  if (options.pageUrl !== null) filters.push({ dimension: 'page', operator: 'equals', expression: options.pageUrl });
  if (options.country) filters.push({ dimension: 'country', operator: 'equals', expression: options.country });
  if (options.device) filters.push({ dimension: 'device', operator: 'equals', expression: options.device });
  return {
    startDate: options.range.start,
    endDate: options.range.end,
    dimensions: [options.dimension],
    ...(filters.length === 0 ? {} : { dimensionFilterGroups: [{ groupType: 'and', filters }] as const }),
    rowLimit: options.rowLimit,
    type: 'web',
    dataState: 'final',
  };
}

/** A URL Inspection request body: exactly the page and its property (no `languageCode`: Google's default). */
export interface UrlInspectionBody {
  readonly inspectionUrl: string;
  readonly siteUrl: string;
}

/** `<inspectionBase>/urlInspection/index:inspect`. */
export const urlInspectionUrl = (inspectionBase: string): string => `${inspectionBase}/urlInspection/index:inspect`;

/** `<apiBase>/sites/<siteUrl as one encoded path segment>/searchAnalytics/query`. */
export function siteQueryUrl(apiBase: string, siteUrl: string): string {
  return `${apiBase}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

export interface GscApi {
  /** `GET /sites`: the user's properties, as Google lists them. */
  sites(accessToken: string): Promise<GscApiResult<GoogleSitesResponse>>;
  /** `POST /sites/{siteUrl}/searchAnalytics/query`. */
  query(accessToken: string, siteUrl: string, body: SearchAnalyticsBody): Promise<GscApiResult<GoogleSearchAnalyticsResponse>>;
  /** `POST <inspectionBase>/urlInspection/index:inspect`. */
  inspect(accessToken: string, body: UrlInspectionBody): Promise<GscApiResult<GoogleInspectionResponse>>;
}

export interface CreateGscApiOptions {
  /** `GscConfig.endpoints.apiBase` (no trailing slash). */
  readonly apiBase: string;
  /** `GscConfig.endpoints.inspectionBase` (no trailing slash). */
  readonly inspectionBase: string;
  readonly fetch: FetchLike;
  /** Defaults to `GSC_LIMITS.timeoutMs`. */
  readonly timeoutMs?: number;
}

const fail = (failure: GscApiFailure): GscApiResult<never> => ({ ok: false, failure });

/** A 403's kind: a quota reason is `quota`; anything else (no permission) is `forbidden`. */
function forbiddenKind(text: string | null): GscApiFailure {
  const parsed = GoogleApiErrorSchema.safeParse(parseJson(text));
  if (!parsed.success) return 'forbidden';
  const reasons = (parsed.data.error.errors ?? []).map((e) => e.reason ?? '');
  return reasons.some((reason) => GOOGLE_QUOTA_REASONS.includes(reason)) ? 'quota' : 'forbidden';
}

export function createGscApi(options: CreateGscApiOptions): GscApi {
  const { apiBase, inspectionBase, fetch, timeoutMs } = options;

  async function call<S extends z.ZodType>(url: string, accessToken: string, json: unknown, schema: S): Promise<GscApiResult<z.infer<S>>> {
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${accessToken}` });
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    const outcome = await send(fetch, url, { method: json === undefined ? 'GET' : 'POST', headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) }, timeoutMs === undefined ? {} : { timeoutMs });
    if (outcome.kind === 'network') return fail('network');
    const { status, text } = outcome;
    if (status === 401) return fail('auth');
    if (status === 429) return fail('quota');
    if (status === 403) return fail(forbiddenKind(text));
    if (status === 408 || status >= 500) return fail('network');
    if (status < 200 || status > 299 || text === null) return fail('invalid');
    const parsed = schema.safeParse(parseJson(text));
    return parsed.success ? { ok: true, value: parsed.data } : fail('invalid');
  }

  return {
    sites: (accessToken) => call(`${apiBase}/sites`, accessToken, undefined, GoogleSitesResponseSchema),
    query: (accessToken, siteUrl, body) => call(siteQueryUrl(apiBase, siteUrl), accessToken, body, GoogleSearchAnalyticsResponseSchema),
    // Exactly the two documented members, whatever the caller's object carries.
    inspect: (accessToken, body) => call(urlInspectionUrl(inspectionBase), accessToken, { inspectionUrl: body.inspectionUrl, siteUrl: body.siteUrl }, GoogleInspectionResponseSchema),
  };
}
