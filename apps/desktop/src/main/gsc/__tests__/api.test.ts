// Spec: specs/gsc.spec.ts (GSC_LIMITS, GSC_ENDPOINTS, gscRetentionStart, GSC_DEVICES), specs/gsc.schema.ts (GoogleSitesResponseSchema,
// GoogleSearchAnalyticsResponseSchema, GoogleApiErrorSchema, GOOGLE_QUOTA_REASONS)
// Acceptance: specs/gsc.feature.md (Google API; Ranges and filters) · plan Global Constraint "Outbound calls"
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GSC_ENDPOINTS, GSC_LIMITS } from '@app/specs/gsc.schema';
import { createGscApi, searchAnalyticsBody, siteQueryUrl, type GscApiFailure } from '../api';

const TOKEN = 'fake-access-token-0123456789';
const RANGE = { start: '2026-09-29', end: '2026-10-26' };

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function apiWith(answer: () => Promise<Response> | Response, timeoutMs?: number) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => answer());
  return { fetch, api: createGscApi({ apiBase: GSC_ENDPOINTS.apiBase, inspectionBase: GSC_ENDPOINTS.inspectionBase, fetch, ...(timeoutMs === undefined ? {} : { timeoutMs }) }) };
}

const failureOf = async (answer: () => Promise<Response> | Response, timeoutMs?: number): Promise<GscApiFailure | 'ok'> => {
  const { api } = apiWith(answer, timeoutMs);
  const result = await api.sites(TOKEN);
  return result.ok ? 'ok' : result.failure;
};

const quotaError = (code: number, reason: string, status = 'PERMISSION_DENIED') => ({ error: { code, status, errors: [{ reason }] } });

afterEach(() => vi.useRealTimers());

describe('Search Console API client', () => {
  test('api-requests-omit-credentials', async () => {
    const { fetch, api } = apiWith(() => jsonResponse(200, {}));
    await api.sites(TOKEN);
    await api.query(TOKEN, 'https://www.example.com/', searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: null, rowLimit: 28 }));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url.startsWith(`${GSC_ENDPOINTS.apiBase}/sites`)).toBe(true);
      expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(url).not.toContain(TOKEN);
    }
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
    expect(fetch.mock.calls[1]![1].method).toBe('POST');
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('content-type')).toBe('application/json');
  });

  test('api-encodes-site-url', () => {
    expect(siteQueryUrl(GSC_ENDPOINTS.apiBase, 'https://www.example.com/')).toBe(`${GSC_ENDPOINTS.apiBase}/sites/https%3A%2F%2Fwww.example.com%2F/searchAnalytics/query`);
    expect(siteQueryUrl(GSC_ENDPOINTS.apiBase, 'sc-domain:example.com')).toBe(`${GSC_ENDPOINTS.apiBase}/sites/sc-domain%3Aexample.com/searchAnalytics/query`);
    expect(siteQueryUrl(GSC_ENDPOINTS.apiBase, 'https://www.example.com/a b/?#')).toBe(`${GSC_ENDPOINTS.apiBase}/sites/https%3A%2F%2Fwww.example.com%2Fa%20b%2F%3F%23/searchAnalytics/query`);
  });

  test('api-query-bodies-page-vs-property', () => {
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: 'https://www.example.com/a?b=1', rowLimit: 28 })).toEqual({
      startDate: RANGE.start,
      endDate: RANGE.end,
      dimensions: ['date'],
      dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'equals', expression: 'https://www.example.com/a?b=1' }] }],
      rowLimit: 28,
      type: 'web',
      dataState: 'final',
    });
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'query', pageUrl: null, rowLimit: GSC_LIMITS.maxTopQueries })).toEqual({
      startDate: RANGE.start,
      endDate: RANGE.end,
      dimensions: ['query'],
      rowLimit: GSC_LIMITS.maxTopQueries,
      type: 'web',
      dataState: 'final',
    });
  });

  test('body-custom-range', () => {
    // A custom range (here "Last 16 months" on 2026-10-28) is sent as given, whatever the dimension.
    const range = { start: '2025-06-28', end: '2026-10-26' };
    expect(searchAnalyticsBody({ range, dimension: 'date', pageUrl: null, rowLimit: GSC_LIMITS.maxDateRows })).toEqual({
      startDate: '2025-06-28',
      endDate: '2026-10-26',
      dimensions: ['date'],
      rowLimit: GSC_LIMITS.maxDateRows,
      type: 'web',
      dataState: 'final',
    });
    expect(searchAnalyticsBody({ range, dimension: 'country', pageUrl: null, rowLimit: GSC_LIMITS.maxCountries })).toEqual({
      startDate: '2025-06-28',
      endDate: '2026-10-26',
      dimensions: ['country'],
      rowLimit: GSC_LIMITS.maxCountries,
      type: 'web',
      dataState: 'final',
    });
  });

  test('body-filters', () => {
    const page = { dimension: 'page', operator: 'equals', expression: 'https://www.example.com/a?b=1' };
    const country = { dimension: 'country', operator: 'equals', expression: 'gbr' };
    const device = { dimension: 'device', operator: 'equals', expression: 'MOBILE' };
    // Page scope: the page filter, `country equals` and `device equals`, in one `and` group.
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: 'https://www.example.com/a?b=1', country: 'gbr', device: 'MOBILE', rowLimit: 28 })).toEqual({
      startDate: RANGE.start,
      endDate: RANGE.end,
      dimensions: ['date'],
      dimensionFilterGroups: [{ groupType: 'and', filters: [page, country, device] }],
      rowLimit: 28,
      type: 'web',
      dataState: 'final',
    });
    // Property scope: no page filter; the others still apply, alone or together.
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'query', pageUrl: null, country: 'gbr', device: 'MOBILE', rowLimit: 25 }).dimensionFilterGroups).toEqual([{ groupType: 'and', filters: [country, device] }]);
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'query', pageUrl: null, device: 'DESKTOP', rowLimit: 25 }).dimensionFilterGroups).toEqual([{ groupType: 'and', filters: [{ ...device, expression: 'DESKTOP' }] }]);
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: 'https://www.example.com/a?b=1', country: 'usa', rowLimit: 28 }).dimensionFilterGroups).toEqual([{ groupType: 'and', filters: [page, { ...country, expression: 'usa' }] }]);
    // No filter at all: no group.
    expect(searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: null, country: null, device: null, rowLimit: 28 })).not.toHaveProperty('dimensionFilterGroups');
  });

  test('api-maps-failures', async () => {
    expect(await failureOf(() => jsonResponse(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }))).toBe('auth');
    expect(await failureOf(() => jsonResponse(429, quotaError(429, 'rateLimitExceeded', 'RESOURCE_EXHAUSTED')))).toBe('quota');
    expect(await failureOf(() => jsonResponse(429, 'nope'))).toBe('quota');
    for (const reason of ['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']) {
      expect(await failureOf(() => jsonResponse(403, quotaError(403, reason))), reason).toBe('quota');
    }
    expect(await failureOf(() => jsonResponse(403, quotaError(403, 'forbidden')))).toBe('forbidden');
    expect(await failureOf(() => jsonResponse(403, 'not json'))).toBe('forbidden');
    for (const status of [408, 500, 502, 503]) expect(await failureOf(() => jsonResponse(status, {})), String(status)).toBe('network');
    expect(await failureOf(() => Promise.reject(new TypeError('fetch failed')))).toBe('network');
    for (const status of [400, 404, 302]) expect(await failureOf(() => new Response('x', { status })), String(status)).toBe('invalid');
    expect(await failureOf(() => jsonResponse(200, '<html>'))).toBe('invalid');
    expect(await failureOf(() => jsonResponse(200, { siteEntry: 'x' }))).toBe('invalid');
    expect(await failureOf(() => jsonResponse(200, 'x'.repeat(GSC_LIMITS.maxBodyBytes + 1)))).toBe('invalid');
    expect(await failureOf(() => jsonResponse(200, '{}', { 'Content-Length': String(GSC_LIMITS.maxBodyBytes + 1) }))).toBe('invalid');
    // A call with no answer is aborted at the timeout: `network`.
    vi.useFakeTimers();
    const { fetch, api } = apiWith(() => new Promise<Response>(() => undefined));
    fetch.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = api.sites(TOKEN);
    await vi.advanceTimersByTimeAsync(GSC_LIMITS.timeoutMs);
    await expect(pending).resolves.toEqual({ ok: false, failure: 'network' });
  });

  test('api-validates-answers', async () => {
    const sites = { siteEntry: [{ siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner', extra: 1 }] };
    expect(await apiWith(() => jsonResponse(200, sites)).api.sites(TOKEN)).toEqual({ ok: true, value: { siteEntry: [{ siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' }] } });
    expect(await apiWith(() => jsonResponse(200, {})).api.sites(TOKEN)).toEqual({ ok: true, value: {} });
    const rows = { rows: [{ keys: ['2026-10-01'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], responseAggregationType: 'byPage' };
    const body = searchAnalyticsBody({ range: RANGE, dimension: 'date', pageUrl: null, rowLimit: 7 });
    expect(await apiWith(() => jsonResponse(200, rows)).api.query(TOKEN, 'sc-domain:example.com', body)).toEqual({ ok: true, value: { rows: rows.rows } });
    expect(await apiWith(() => jsonResponse(200, {})).api.query(TOKEN, 'sc-domain:example.com', body)).toEqual({ ok: true, value: {} });
    expect(await apiWith(() => jsonResponse(200, { rows: [{ keys: ['x'], clicks: -1, impressions: 1, ctr: 0, position: 1 }] })).api.query(TOKEN, 'sc-domain:example.com', body)).toEqual({ ok: false, failure: 'invalid' });
  });
});
