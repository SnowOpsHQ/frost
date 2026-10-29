// Spec: specs/gsc.spec.ts (GSC_SCOPE, GSC_AUTH_FIXED_PARAMS, gscDateRange, GSC_LIMITS), specs/gsc.schema.ts
// (GscStatusSchema, GscPropertySchema, GscPerformanceQuerySchema, the answer schemas)
// Acceptance: specs/gsc.feature.md (Spec schema) · plan Global Constraint "Search Console is read-only"
import { describe, expect, test } from 'vitest';
import {
  GSC_AUTH_FIXED_PARAMS,
  GSC_AUTH_PARAMS,
  GSC_LIMITS,
  GSC_SCOPE,
  GSC_UNAVAILABLE_REASONS,
  GscPerformanceAnswerSchema,
  GscPerformanceQuerySchema,
  GscPropertiesAnswerSchema,
  GscPropertyForAnswerSchema,
  GscPropertySchema,
  GscQueriesAnswerSchema,
  GscStatusSchema,
  gscDateRange,
  type GscStatus,
} from '@app/specs/gsc.schema';

const STATUS: GscStatus = { configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 3 };
const PROPERTY = { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' } as const;
const RANGE = { start: '2026-09-29', end: '2026-10-26' };
const ROW = { date: '2026-10-01', clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 };
const TOTALS = { clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 };
const QUERY_ROW = { query: 'frost browser', clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 };

describe('Search Console spec', () => {
  test('gsc-scope-constant-is-read-only', () => {
    expect(GSC_SCOPE).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    expect(GSC_AUTH_FIXED_PARAMS).toEqual({ response_type: 'code', scope: GSC_SCOPE, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' });
    expect([...GSC_AUTH_PARAMS].sort()).toEqual(['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state']);
    expect(GSC_AUTH_PARAMS).not.toContain('include_granted_scopes');
    expect(Object.isFrozen(GSC_AUTH_FIXED_PARAMS)).toBe(true);
  });

  test('status-schema-has-no-secret-fields', () => {
    expect(GscStatusSchema.parse(STATUS)).toEqual(STATUS);
    for (const extra of [{ token: 'x' }, { accessToken: 'x' }, { refreshToken: 'x' }, { code: 'x' }, { email: 'dana@example.com' }, { state: 'x' }]) {
      expect(GscStatusSchema.safeParse({ ...STATUS, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(GscStatusSchema.safeParse({ ...STATUS, connecting: true }).success).toBe(false);
    expect(GscStatusSchema.safeParse({ ...STATUS, configured: false }).success).toBe(false);
    expect(GscStatusSchema.safeParse({ ...STATUS, configured: false, connected: false, entitled: false }).success).toBe(true);
    expect(GscStatusSchema.safeParse({ ...STATUS, connected: false, connecting: true, error: 'scope-refused' }).success).toBe(true);
    expect(GscStatusSchema.safeParse({ ...STATUS, error: 'oops' }).success).toBe(false);
    expect(GscStatusSchema.safeParse({ ...STATUS, version: -1 }).success).toBe(false);
  });

  test('answers-are-ok-or-unavailable', () => {
    const ok = { status: 'ok', property: PROPERTY, scope: 'page', range: RANGE, rows: [ROW], totals: TOTALS } as const;
    expect(GscPerformanceAnswerSchema.parse(ok)).toEqual(ok);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, totals: { ...TOTALS, position: null, impressions: 0, clicks: 0, ctr: 0 } }).success).toBe(true);
    for (const reason of GSC_UNAVAILABLE_REASONS) {
      for (const schema of [GscPerformanceAnswerSchema, GscQueriesAnswerSchema, GscPropertiesAnswerSchema, GscPropertyForAnswerSchema]) {
        expect(schema.safeParse({ status: 'unavailable', reason }).success, reason).toBe(true);
        expect(schema.safeParse({ status: 'unavailable', reason, token: 'x' }).success, reason).toBe(false);
      }
    }
    expect(GscPerformanceAnswerSchema.safeParse({ status: 'unavailable', reason: 'busy' }).success).toBe(false);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, accessToken: 'x' }).success).toBe(false);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, rows: [{ ...ROW, keys: ['2026-10-01'] }] }).success).toBe(false);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, rows: Array.from({ length: GSC_LIMITS.maxDateRows + 1 }, () => ROW) }).success).toBe(false);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, rows: [{ ...ROW, ctr: 1.5 }] }).success).toBe(false);
    expect(GscPerformanceAnswerSchema.safeParse({ ...ok, range: { start: RANGE.end, end: RANGE.start } }).success).toBe(false);
    const queries = { status: 'ok', property: PROPERTY, scope: 'property', range: RANGE, rows: [QUERY_ROW] } as const;
    expect(GscQueriesAnswerSchema.parse(queries)).toEqual(queries);
    expect(GscQueriesAnswerSchema.safeParse({ ...queries, rows: Array.from({ length: GSC_LIMITS.maxTopQueries + 1 }, () => QUERY_ROW) }).success).toBe(false);
    expect(GscQueriesAnswerSchema.safeParse({ ...queries, rows: [{ ...QUERY_ROW, query: 'q'.repeat(GSC_LIMITS.maxQueryChars + 1) }] }).success).toBe(false);
    expect(GscPropertiesAnswerSchema.parse({ status: 'ok', properties: [PROPERTY] })).toEqual({ status: 'ok', properties: [PROPERTY] });
    expect(GscPropertyForAnswerSchema.parse({ status: 'ok', property: PROPERTY })).toEqual({ status: 'ok', property: PROPERTY });
  });

  test('query-schema-is-strict', () => {
    const query = { url: 'https://www.example.com/a?b=1#c', scope: 'page', days: 28 } as const;
    expect(GscPerformanceQuerySchema.parse(query)).toEqual(query);
    for (const days of [7, 28, 90]) expect(GscPerformanceQuerySchema.safeParse({ ...query, days }).success).toBe(true);
    for (const bad of [
      { ...query, days: 30 },
      { ...query, days: '28' },
      { ...query, scope: 'site' },
      { ...query, url: 'file:///etc/passwd' },
      { ...query, url: 'javascript:alert(1)' },
      { ...query, url: 'https://' },
      { ...query, url: `https://example.com/${'a'.repeat(GSC_LIMITS.maxUrlChars)}` },
      { ...query, token: 'x' },
      { url: query.url, scope: 'page' },
    ]) {
      expect(GscPerformanceQuerySchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  test('property-schema-ties-kind-to-prefix', () => {
    expect(GscPropertySchema.safeParse(PROPERTY).success).toBe(true);
    expect(GscPropertySchema.safeParse({ siteUrl: 'sc-domain:example.com', kind: 'domain', permissionLevel: 'siteFullUser' }).success).toBe(true);
    expect(GscPropertySchema.safeParse({ siteUrl: 'sc-domain:example.com', kind: 'url-prefix', permissionLevel: 'siteFullUser' }).success).toBe(false);
    expect(GscPropertySchema.safeParse({ siteUrl: 'https://example.com/', kind: 'domain', permissionLevel: 'siteFullUser' }).success).toBe(false);
    expect(GscPropertySchema.safeParse({ siteUrl: 'ftp://example.com/', kind: 'url-prefix', permissionLevel: 'siteFullUser' }).success).toBe(false);
    expect(GscPropertySchema.safeParse({ ...PROPERTY, permissionLevel: 'admin' }).success).toBe(false);
  });

  test('date-range-ends-two-days-ago-utc', () => {
    expect(gscDateRange(28, Date.UTC(2026, 9, 28, 12, 30))).toEqual({ start: '2026-09-29', end: '2026-10-26' });
    expect(gscDateRange(7, Date.UTC(2026, 9, 28, 0, 0))).toEqual({ start: '2026-10-20', end: '2026-10-26' });
    expect(gscDateRange(7, Date.UTC(2026, 9, 28, 23, 59, 59, 999))).toEqual({ start: '2026-10-20', end: '2026-10-26' });
    // Month and year boundaries; 90 days inclusive.
    expect(gscDateRange(7, Date.UTC(2026, 2, 3))).toEqual({ start: '2026-02-23', end: '2026-03-01' });
    expect(gscDateRange(90, Date.UTC(2027, 0, 1))).toEqual({ start: '2026-10-02', end: '2026-12-30' });
    const { start, end } = gscDateRange(90, Date.UTC(2027, 0, 1));
    expect((Date.parse(end) - Date.parse(start)) / 86_400_000 + 1).toBe(90);
  });
});
