import type { z } from 'zod';
import {
  GOOGLE_QUOTA_REASONS,
  GoogleApiErrorSchema,
  GoogleSearchAnalyticsResponseSchema,
  GoogleSitesResponseSchema,
  type GoogleSearchAnalyticsResponse,
  type GoogleSitesResponse,
  type GscDateRange,
} from '@app/specs/gsc.schema';
import { parseJson, send, type FetchLike } from './http';

// The Search Console API v3 as main calls it (spec `gsc.schema.ts`, Google's answers; acceptance
// `gsc.feature.md`, Google API; plan Global Constraint "Outbound calls"). Read-only: `GET /sites` and
// `POST /sites/{siteUrl}/searchAnalytics/query` (a query, not a write). No Electron import: main
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

/** A `searchAnalytics/query` request body (Google's documented members only). */
export interface SearchAnalyticsBody {
  readonly startDate: string;
  readonly endDate: string;
  readonly dimensions: readonly ['date'] | readonly ['query'];
  readonly dimensionFilterGroups?: readonly [
    { readonly groupType: 'and'; readonly filters: readonly [{ readonly dimension: 'page'; readonly operator: 'equals'; readonly expression: string }] },
  ];
  readonly rowLimit: number;
  readonly type: 'web';
  readonly dataState: 'final';
}

/**
 * The body for one range: per day (`date`) or per search query (`query`), for one page (`pageUrl`,
 * already without its fragment: `page equals`) or the whole property (`null`: no filter).
 */
export function searchAnalyticsBody(options: { range: GscDateRange; dimension: 'date' | 'query'; pageUrl: string | null; rowLimit: number }): SearchAnalyticsBody {
  return {
    startDate: options.range.start,
    endDate: options.range.end,
    dimensions: options.dimension === 'date' ? ['date'] : ['query'],
    ...(options.pageUrl === null
      ? {}
      : { dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'equals', expression: options.pageUrl }] }] as const }),
    rowLimit: options.rowLimit,
    type: 'web',
    dataState: 'final',
  };
}

/** `<apiBase>/sites/<siteUrl as one encoded path segment>/searchAnalytics/query`. */
export function siteQueryUrl(apiBase: string, siteUrl: string): string {
  return `${apiBase}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
}

export interface GscApi {
  /** `GET /sites`: the user's properties, as Google lists them. */
  sites(accessToken: string): Promise<GscApiResult<GoogleSitesResponse>>;
  /** `POST /sites/{siteUrl}/searchAnalytics/query`. */
  query(accessToken: string, siteUrl: string, body: SearchAnalyticsBody): Promise<GscApiResult<GoogleSearchAnalyticsResponse>>;
}

export interface CreateGscApiOptions {
  /** `GscConfig.endpoints.apiBase` (no trailing slash). */
  readonly apiBase: string;
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
  const { apiBase, fetch, timeoutMs } = options;

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
  };
}
