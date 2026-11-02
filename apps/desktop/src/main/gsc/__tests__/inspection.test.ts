// Spec: specs/gsc-inspection.spec.ts (GSC_INSPECTION_VERDICTS, GSC_ROBOTS_TXT_STATES, GSC_INDEXING_STATES, GSC_PAGE_FETCH_STATES,
// GSC_CRAWLED_AS, GSC_RICH_SEVERITIES, GSC_INSPECTION_LIMITS, GSC_INSPECTION_RATE, GSC_INSPECTION_LINK_HOST, GSC_OPEN_LINK_RESULTS),
// specs/gsc-inspection.schema.ts (GoogleInspectionResponseSchema, GscInspectionAnswerSchema), specs/gsc.spec.ts (GSC_ENDPOINTS.inspectionBase,
// GSC_SCOPE, GSC_RATE_LIMIT, GSC_CACHE_TTL_MS)
// Acceptance: specs/gsc-inspection.feature.md (Inspection) · plan Phase 9 Decisions 1, 2, 3 and 6 (security review)
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  GSC_CRAWLED_AS,
  GSC_INDEXING_STATES,
  GSC_INSPECTION_LIMITS,
  GSC_INSPECTION_LINK_HOST,
  GSC_INSPECTION_RATE,
  GSC_INSPECTION_VERDICTS,
  GSC_PAGE_FETCH_STATES,
  GSC_RICH_SEVERITIES,
  GSC_ROBOTS_TXT_STATES,
  GoogleInspectionResponseSchema,
  GscInspectionAnswerSchema,
  type GscInspectionAnswer,
  type GscInspectionOk,
} from '@app/specs/gsc-inspection.schema';
import { GSC_CACHE_TTL_MS, GSC_ENDPOINT_ENV, GSC_ENDPOINTS, GSC_LIMITS, GSC_RATE_LIMIT, GSC_SCOPE, type GscProperty } from '@app/specs/gsc.schema';
import { fakeInspection } from '../../../../e2e/fake-google';
import type { FetchLike } from '../http';
import { inspectionAnswerOf } from '../inspection';
import { createGscService, type GscMainService, type GscServiceDeps } from '../service';
import { createHarness, OTHER_WINDOW_ID, WINDOW_ID, type Harness } from './harness';

const SITE = 'https://www.example.com/';
const PAGE = 'https://www.example.com/blog/post?x=1';
const PROPERTY: GscProperty = { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' };
const INSPECTED_AT = '2026-10-28T12:00:00.000Z';

let h: Harness;
const services: GscMainService[] = [];

beforeEach(async () => {
  h = await createHarness();
  h.google.sites = [
    { siteUrl: SITE, permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteFullUser' },
  ];
});
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await h.close();
});

async function serviceWith(overrides: Partial<GscServiceDeps> = {}): Promise<GscMainService> {
  const service = await createGscService({
    config: h.config,
    fetch: h.fetch,
    store: h.store,
    entitled: () => true,
    userId: h.currentUser,
    startLoopback: h.startLoopback,
    openInBrowser: h.openInBrowser,
    consumeGesture: h.consumeGesture,
    log: h.log,
    now: h.now,
    ...overrides,
  });
  services.push(service);
  return service;
}

async function connected(overrides: Partial<GscServiceDeps> = {}): Promise<GscMainService> {
  const service = await serviceWith(overrides);
  h.grant();
  expect(await service.connect(WINDOW_ID)).toBe('started');
  await h.follow();
  await service.whenIdle();
  expect(service.status().connected).toBe(true);
  return service;
}

const ok = (answer: GscInspectionAnswer): GscInspectionOk => {
  expect(answer.status).toBe('ok');
  return answer as GscInspectionOk;
};

/** Google's answer with `index` / `rich` members replacing the default fixture's, parsed and mapped as main does. */
function mapped(index: Record<string, unknown> = {}, rich?: unknown, extra: Record<string, unknown> = {}): GscInspectionOk {
  const base = fakeInspection(PAGE, SITE) as { inspectionResult: { indexStatusResult: Record<string, unknown>; richResultsResult?: unknown } & Record<string, unknown> };
  const raw = {
    inspectionResult: {
      ...base.inspectionResult,
      indexStatusResult: { ...base.inspectionResult.indexStatusResult, ...index },
      ...(rich === undefined ? {} : { richResultsResult: rich }),
      ...extra,
    },
  };
  const answer = inspectionAnswerOf(GoogleInspectionResponseSchema.parse(raw), { property: PROPERTY, url: PAGE, inspectedAt: INSPECTED_AT });
  return GscInspectionAnswerSchema.parse(answer) as GscInspectionOk;
}

const rich = (detectedItems: unknown, verdict: unknown = 'PASS') => ({ verdict, detectedItems });

describe('URL Inspection', () => {
  test('inspect-request-shape', async () => {
    expect(GSC_ENDPOINTS.inspectionBase).toBe('https://searchconsole.googleapis.com/v1');
    expect(GSC_ENDPOINT_ENV.inspectionBase).toBe('FROST_GSC_INSPECTION_BASE');
    const seen: { url: string; init: RequestInit }[] = [];
    const recording: FetchLike = (url, init) => (seen.push({ url, init }), h.fetch(url, init));
    // Not connected: nothing is sent.
    const idle = await serviceWith({ fetch: recording });
    expect(await idle.inspect({ url: PAGE })).toEqual({ status: 'unavailable', reason: 'not-connected' });
    expect(await (await serviceWith({ config: null })).inspect({ url: PAGE })).toEqual({ status: 'unavailable', reason: 'unconfigured' });
    expect(seen).toEqual([]);

    const service = await connected({ fetch: recording });
    // Nothing is inspected unless `inspect` is called (a performance read never inspects).
    expect(await service.performance({ url: PAGE, scope: 'page', days: 28 })).toMatchObject({ status: 'ok' });
    expect(h.google.inspections).toEqual([]);
    // Malformed inputs: refused before anything is sent.
    const before = seen.length;
    expect(await service.inspect({ url: 'file:///etc/hosts' })).toEqual({ status: 'unavailable', reason: 'not-a-web-page' });
    for (const bad of [{ url: PAGE, fresh: 'yes' }, { url: PAGE, link: 'https://search.google.com/x' }, null, 'x', { url: 5 }]) {
      expect(await service.inspect(bad as never), JSON.stringify(bad)).toEqual({ status: 'unavailable', reason: 'invalid' });
    }
    expect(await service.inspect({ url: 'https://elsewhere.example.net/' })).toEqual({ status: 'unavailable', reason: 'no-property' });
    expect(seen).toHaveLength(before);

    const answer = ok(await service.inspect({ url: `${PAGE}#comments` }));
    const calls = seen.filter((c) => c.url.startsWith(h.config.endpoints.inspectionBase));
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(`${h.config.endpoints.inspectionBase}/urlInspection/index:inspect`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ inspectionUrl: PAGE, siteUrl: SITE });
    expect(String(init.body)).not.toContain('languageCode');
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization', 'content-type']);
    expect(headers.get('authorization')).toBe(`Bearer ${h.google.accessTokens.at(-1)}`);
    expect(new URL(url).search).toBe('');
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.google.inspections).toEqual([{ body: { inspectionUrl: PAGE, siteUrl: SITE } }]);

    expect(answer).toEqual({
      status: 'ok',
      property: PROPERTY,
      url: PAGE,
      inspectedAt: new Date(h.clock.now).toISOString(),
      index: {
        verdict: { value: 'PASS' },
        coverageState: 'Submitted and indexed',
        robotsTxtState: { value: 'ALLOWED' },
        indexingState: { value: 'INDEXING_ALLOWED' },
        pageFetchState: { value: 'SUCCESSFUL' },
        lastCrawlTime: '2026-10-20T08:15:30.000Z',
        crawledAs: { value: 'MOBILE' },
        googleCanonical: PAGE,
        userCanonical: PAGE,
      },
      richResults: { verdict: { value: 'PASS' }, types: [{ type: 'Breadcrumbs', items: [{ name: 'Unnamed item', issues: [{ message: 'Missing field "item"', severity: { value: 'WARNING' } }] }] }] },
      link: `https://${GSC_INSPECTION_LINK_HOST}/search-console/inspect?resource_id=${encodeURIComponent(SITE)}&id=${encodeURIComponent(PAGE)}`,
    });
    expect(GscInspectionAnswerSchema.parse(answer)).toEqual(answer);
    // No token or code in the answer.
    const text = JSON.stringify(answer);
    for (const secret of [...h.google.accessTokens, ...h.google.refreshTokens, ...h.google.codes, h.config.clientSecret]) expect(text).not.toContain(secret);
    // A domain property: inspected under `sc-domain:…`.
    expect(ok(await service.inspect({ url: 'http://shop.example.org/a' })).property).toEqual({ siteUrl: 'sc-domain:example.org', kind: 'domain', permissionLevel: 'siteFullUser' });
    expect(h.google.inspections.at(-1)).toEqual({ body: { inspectionUrl: 'http://shop.example.org/a', siteUrl: 'sc-domain:example.org' } });
  });

  test('inspect-uses-readonly-scope', async () => {
    expect(GSC_SCOPE).toBe('https://www.googleapis.com/auth/webmasters.readonly');
    const service = await connected();
    expect(h.google.authRequests).toHaveLength(1);
    expect(h.google.authRequests[0]?.get('scope')).toBe(GSC_SCOPE);
    const opened = h.opened.length;
    const grants = h.google.tokenRequests.filter((f) => f.get('grant_type') === 'authorization_code').length;
    expect(ok(await service.inspect({ url: PAGE })).index.verdict).toEqual({ value: 'PASS' });
    // No new consent, no new grant, nothing opened: the same read-only connection.
    expect(h.google.authRequests).toHaveLength(1);
    expect(h.google.tokenRequests.filter((f) => f.get('grant_type') === 'authorization_code')).toHaveLength(grants);
    expect(h.opened).toHaveLength(opened);
    expect(service.status()).toMatchObject({ connected: true, error: null });
    // An expired access token is refreshed with the same grant (scope unchanged), then retried once.
    h.google.expireAccessTokens();
    expect(await service.inspect({ url: PAGE, fresh: true })).toMatchObject({ status: 'ok' });
    expect(h.google.tokenRequests.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(h.google.authRequests).toHaveLength(1);
  });

  test('inspect-maps-enums', async () => {
    const tables: [string, Readonly<Record<string, string>>][] = [
      ['verdict', GSC_INSPECTION_VERDICTS],
      ['robotsTxtState', GSC_ROBOTS_TXT_STATES],
      ['indexingState', GSC_INDEXING_STATES],
      ['pageFetchState', GSC_PAGE_FETCH_STATES],
      ['crawledAs', GSC_CRAWLED_AS],
    ];
    expect(Object.keys(GSC_INSPECTION_VERDICTS).sort()).toEqual(['FAIL', 'NEUTRAL', 'PASS']);
    expect(Object.keys(GSC_PAGE_FETCH_STATES)).toHaveLength(11);
    for (const [field, table] of tables) {
      for (const code of Object.keys(table)) {
        expect((mapped({ [field]: code }).index as Record<string, unknown>)[field], `${field} ${code}`).toEqual({ value: code });
        expect(typeof table[code]).toBe('string');
      }
      for (const [raw, expected] of [
        ['SOMETHING_NEW', { value: 'unknown', code: 'SOMETHING_NEW' }],
        ['lower-case', { value: 'unknown', code: null }],
        [42, { value: 'unknown', code: null }],
        ['toString', { value: 'unknown', code: null }],
        ['__proto__', { value: 'unknown', code: null }],
        ['A'.repeat(65), { value: 'unknown', code: null }],
      ] as const) {
        expect((mapped({ [field]: raw }).index as Record<string, unknown>)[field], `${field} ${String(raw)}`).toEqual(expected);
      }
    }
    // Deprecated and unspecified codes read as `unknown`, the raw code kept for display.
    expect(mapped({ verdict: 'PARTIAL' }).index.verdict).toEqual({ value: 'unknown', code: 'PARTIAL' });
    expect(mapped({ verdict: 'VERDICT_UNSPECIFIED' }).index.verdict).toEqual({ value: 'unknown', code: 'VERDICT_UNSPECIFIED' });
    expect(mapped({ robotsTxtState: 'ROBOTS_TXT_STATE_UNSPECIFIED' }).index.robotsTxtState).toEqual({ value: 'unknown', code: 'ROBOTS_TXT_STATE_UNSPECIFIED' });
    expect(mapped({ crawledAs: 'CRAWLING_USER_AGENT_UNSPECIFIED' }).index.crawledAs).toEqual({ value: 'unknown', code: 'CRAWLING_USER_AGENT_UNSPECIFIED' });
    // Absent: `unknown` without a code, except `crawledAs`, which is `null`.
    const bare = mapped({ verdict: undefined, robotsTxtState: undefined, crawledAs: undefined });
    expect(bare.index.verdict).toEqual({ value: 'unknown', code: null });
    expect(bare.index.robotsTxtState).toEqual({ value: 'unknown', code: null });
    expect(bare.index.crawledAs).toBeNull();
    expect(mapped({ crawledAs: null }).index.crawledAs).toBeNull();
    // Keys Google left out entirely read the same way (an empty index status, an empty issue).
    const empty = inspectionAnswerOf(
      GoogleInspectionResponseSchema.parse({ inspectionResult: { indexStatusResult: {}, richResultsResult: { detectedItems: [{ items: [{ issues: [{}] }] }] } } }),
      { property: PROPERTY, url: PAGE, inspectedAt: INSPECTED_AT },
    );
    expect(GscInspectionAnswerSchema.parse(empty)).toMatchObject({
      index: { verdict: { value: 'unknown', code: null }, coverageState: '', pageFetchState: { value: 'unknown', code: null }, lastCrawlTime: null, crawledAs: null, googleCanonical: null },
      richResults: { verdict: { value: 'unknown', code: null }, types: [{ type: '', items: [{ name: '', issues: [{ message: '', severity: { value: 'unknown', code: null } }] }] }] },
      link: null,
    });
    // Rich results: their verdict and each issue's severity.
    for (const severity of Object.keys(GSC_RICH_SEVERITIES)) {
      const r = mapped({}, rich([{ richResultType: 'FAQ', items: [{ name: 'q', issues: [{ issueMessage: 'm', severity }] }] }])).richResults;
      expect(r?.types[0]?.items[0]?.issues[0]?.severity).toEqual({ value: severity });
    }
    const odd = mapped({}, rich([{ richResultType: 'FAQ', items: [{ name: 'q', issues: [{ issueMessage: 'm', severity: 'SEVERITY_UNSPECIFIED' }] }] }], 'PARTIAL')).richResults;
    expect(odd?.verdict).toEqual({ value: 'unknown', code: 'PARTIAL' });
    expect(odd?.types[0]?.items[0]?.issues[0]?.severity).toEqual({ value: 'unknown', code: 'SEVERITY_UNSPECIFIED' });
    // No rich results reported: `null`.
    expect(mapped({}, undefined, { richResultsResult: undefined }).richResults).toBeNull();
    // Through the service: an unknown code from Google passes the strict answer schema.
    const service = await connected();
    h.google.inspection = (url, site) => {
      const body = fakeInspection(url, site) as { inspectionResult: { indexStatusResult: Record<string, unknown> } };
      Object.assign(body.inspectionResult.indexStatusResult, { verdict: 'PARTIAL', pageFetchState: 'BRAND_NEW_STATE', crawledAs: 7 });
      return body;
    };
    const answer = ok(await service.inspect({ url: PAGE }));
    expect(answer.index).toMatchObject({ verdict: { value: 'unknown', code: 'PARTIAL' }, pageFetchState: { value: 'unknown', code: 'BRAND_NEW_STATE' }, crawledAs: { value: 'unknown', code: null } });
  });

  test('inspect-caps-untrusted-strings', async () => {
    const { maxTextChars, maxItems, maxIssues } = GSC_INSPECTION_LIMITS;
    expect(GSC_INSPECTION_LIMITS).toEqual({ maxItems: 50, maxIssues: 20, maxTextChars: 500 });
    const long = 'x'.repeat(10_000);
    const capped = mapped(
      { coverageState: long },
      rich([{ richResultType: long, items: [{ name: long, issues: [{ issueMessage: long, severity: 'ERROR' }] }] }]),
    );
    expect(capped.index.coverageState).toBe('x'.repeat(maxTextChars));
    const type = capped.richResults!.types[0]!;
    expect(type.type).toHaveLength(maxTextChars);
    expect(type.items[0]!.name).toHaveLength(maxTextChars);
    expect(type.items[0]!.issues[0]!.message).toHaveLength(maxTextChars);
    // A cut never splits a surrogate pair.
    expect(mapped({ coverageState: `${'a'.repeat(maxTextChars - 1)}\u{1F600}` }).index.coverageState).toBe('a'.repeat(maxTextChars - 1));
    // Items in all, and issues per item, are capped.
    const items = (n: number, issues = 0) => Array.from({ length: n }, (_, i) => ({ name: `item ${i}`, issues: Array.from({ length: issues }, (_, j) => ({ issueMessage: `issue ${j}`, severity: 'WARNING' })) }));
    const many = mapped({}, rich([{ richResultType: 'A', items: items(30) }, { richResultType: 'B', items: items(30) }, { richResultType: 'C', items: items(5) }])).richResults!;
    expect(many.types.map((t) => t.items.length)).toEqual([30, maxItems - 30]);
    const noisy = mapped({}, rich([{ richResultType: 'A', items: items(1, 45) }])).richResults!;
    expect(noisy.types[0]!.items[0]!.issues).toHaveLength(maxIssues);
    const typesOnly = mapped({}, rich(Array.from({ length: 80 }, (_, i) => ({ richResultType: `T${i}`, items: [] })))).richResults!;
    expect(typesOnly.types).toHaveLength(maxItems);
    // Canonicals: only `http(s)` URLs within the URL cap; the crawl time only as an ISO time.
    const odd = mapped({ googleCanonical: 'javascript:alert(1)', userCanonical: `https://www.example.com/${'a'.repeat(GSC_LIMITS.maxUrlChars)}`, lastCrawlTime: 'yesterday' });
    expect(odd.index).toMatchObject({ googleCanonical: null, userCanonical: null, lastCrawlTime: null });
    expect(mapped({ googleCanonical: '/relative', userCanonical: 42, lastCrawlTime: '+275760-09-13T00:00:00Z' }).index).toMatchObject({ googleCanonical: null, userCanonical: null, lastCrawlTime: null });
    expect(mapped({ coverageState: 7, lastCrawlTime: '2026-10-20T08:15:30+02:00' }).index).toMatchObject({ coverageState: '', lastCrawlTime: '2026-10-20T06:15:30.000Z' });
    // Malformed lists read as absent rather than failing the whole answer.
    expect(mapped({}, rich('not a list')).richResults).toEqual({ verdict: { value: 'PASS' }, types: [] });
    // Through the service: the capped answer passes the strict schema.
    const service = await connected();
    h.google.inspection = () => ({
      inspectionResult: {
        indexStatusResult: { verdict: 'FAIL', coverageState: long },
        richResultsResult: rich([{ richResultType: long, items: items(70, 30) }], 'FAIL'),
      },
    });
    const answer = ok(await service.inspect({ url: PAGE }));
    expect(answer.index.coverageState).toHaveLength(maxTextChars);
    expect(answer.richResults!.types[0]!.items).toHaveLength(maxItems);
    expect(answer.link).toBeNull();
    // Google's answer without `inspectionResult` is not what the API documents: `invalid`.
    h.google.inspection = () => ({ somethingElse: true });
    expect(await service.inspect({ url: PAGE, fresh: true })).toEqual({ status: 'unavailable', reason: 'invalid' });
  });

  test('inspect-ignores-mobile-usability', async () => {
    const service = await connected();
    h.google.inspection = (url, site) => {
      const body = fakeInspection(url, site) as { inspectionResult: Record<string, unknown> };
      body.inspectionResult.ampResult = { verdict: 'FAIL', ampUrl: 'https://amp.example.com/MARKER-AMP' };
      body.inspectionResult.mobileUsabilityResult = { verdict: 'FAIL', issues: [{ message: 'MARKER-MOBILE' }] };
      return body;
    };
    const answer = ok(await service.inspect({ url: PAGE }));
    expect(Object.keys(answer).sort()).toEqual(['index', 'inspectedAt', 'link', 'property', 'richResults', 'status', 'url']);
    expect(Object.keys(answer.index).sort()).toEqual(['coverageState', 'crawledAs', 'googleCanonical', 'indexingState', 'lastCrawlTime', 'pageFetchState', 'robotsTxtState', 'userCanonical', 'verdict']);
    const text = JSON.stringify(answer);
    for (const dropped of ['MARKER-AMP', 'MARKER-MOBILE', 'sitemap', 'referrer', 'referringUrls', 'mobileUsability', 'ampResult']) expect(text, dropped).not.toContain(dropped);
  });

  test('inspect-link-host-checked', async () => {
    const good = `https://${GSC_INSPECTION_LINK_HOST}/search-console/inspect?resource_id=x&id=y`;
    expect(mapped({}, undefined, { inspectionResultLink: good }).link).toBe(good);
    for (const bad of [
      'http://search.google.com/search-console/inspect',
      'https://search.google.com.evil.example/x',
      'https://evil.example/?u=https://search.google.com/',
      'https://user:pw@search.google.com/x',
      'https://search.google.com:8443/x',
      'https://www.google.com/x',
      'javascript:alert(1)',
      '//search.google.com/x',
      `https://search.google.com/${'a'.repeat(GSC_LIMITS.maxUrlChars)}`,
      '',
      42,
    ]) {
      expect(mapped({}, undefined, { inspectionResultLink: bad }).link, String(bad)).toBeNull();
    }
    // Through the service, an off-host link is dropped and can never be opened.
    const service = await connected();
    h.google.inspection = (url, site) => ({ inspectionResult: { ...(fakeInspection(url, site) as { inspectionResult: object }).inspectionResult, inspectionResultLink: 'https://evil.example/phish' } });
    expect(ok(await service.inspect({ url: PAGE })).link).toBeNull();
    h.grant();
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('no-link');
    expect(h.opened.some((u) => u.includes('evil.example'))).toBe(false);
  });

  test('inspect-rate-bucket-separate', async () => {
    expect(GSC_INSPECTION_RATE).toEqual({ perSecond: 1, burst: 3 });
    const service = await connected();
    expect(await service.properties()).toMatchObject({ status: 'ok' });
    const answers = await Promise.all(Array.from({ length: GSC_INSPECTION_RATE.burst + 2 }, (_, i) => service.inspect({ url: `${SITE}page-${i}` })));
    expect(answers.filter((a) => a.status === 'ok')).toHaveLength(GSC_INSPECTION_RATE.burst);
    expect(answers.filter((a) => a.status === 'unavailable' && a.reason === 'quota')).toHaveLength(2);
    expect(h.google.inspections).toHaveLength(GSC_INSPECTION_RATE.burst);
    expect(await service.inspect({ url: `${SITE}one-more` })).toEqual({ status: 'unavailable', reason: 'quota' });
    expect(h.google.inspections).toHaveLength(GSC_INSPECTION_RATE.burst);
    // Performance reads still work: inspection never drew from `GSC_RATE_LIMIT`.
    const reads = await Promise.all(Array.from({ length: GSC_RATE_LIMIT.burst - 1 }, (_, i) => service.performance({ url: `${SITE}read-${i}`, scope: 'page', days: 28 })));
    expect(reads.every((a) => a.status === 'ok')).toBe(true);
    // A second later, `perSecond` more inspections.
    h.clock.now += 1000;
    const more = await Promise.all([service.inspect({ url: `${SITE}later-1` }), service.inspect({ url: `${SITE}later-2` })]);
    expect(more.map((a) => a.status).sort()).toEqual(['ok', 'unavailable']);
    expect(h.logs.some((l) => l.includes('inspection rate limit'))).toBe(true);
    for (const line of h.logs) expect(line).not.toContain(SITE);
  });

  test('performance-reads-dont-drain-inspection', async () => {
    const service = await connected();
    const reads = await Promise.all(Array.from({ length: GSC_RATE_LIMIT.burst + 5 }, (_, i) => service.performance({ url: `${SITE}page-${i}`, scope: 'page', days: 28 })));
    expect(reads.some((a) => a.status === 'unavailable' && a.reason === 'quota')).toBe(true);
    expect(await service.performance({ url: `${SITE}again`, scope: 'page', days: 7 })).toEqual({ status: 'unavailable', reason: 'quota' });
    // The read bucket is empty; inspection has its own.
    const answers = await Promise.all(Array.from({ length: GSC_INSPECTION_RATE.burst }, (_, i) => service.inspect({ url: `${SITE}page-${i}` })));
    expect(answers.map((a) => a.status)).toEqual(Array(GSC_INSPECTION_RATE.burst).fill('ok'));
    expect(h.google.inspections).toHaveLength(GSC_INSPECTION_RATE.burst);
  });

  test('open-link-needs-gesture-and-cached-answer', async () => {
    const service = await connected();
    const opened = h.opened.length;
    const sent = () => h.fetched.length;
    const before = sent();
    // No live gesture: `needs-gesture`, nothing opened.
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('needs-gesture');
    // A gesture, but no cached answer for the page: `no-link`, and the gesture is spent.
    h.grant();
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('no-link');
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('needs-gesture');
    // A link the renderer names is a page, never a link to open.
    for (const named of [`https://${GSC_INSPECTION_LINK_HOST}/search-console/inspect?id=x`, 'https://evil.example/', 'javascript:alert(1)', 42]) {
      h.grant();
      expect(await service.openInspectionLink(WINDOW_ID, named as string), String(named)).toBe('no-link');
    }
    expect(h.opened).toHaveLength(opened);
    // Opening never calls Google.
    expect(sent()).toBe(before);

    const answer = ok(await service.inspect({ url: PAGE }));
    expect(answer.link).not.toBeNull();
    // A gesture in another window does not count.
    h.grant();
    expect(await service.openInspectionLink(OTHER_WINDOW_ID, PAGE)).toBe('needs-gesture');
    // A live gesture in the sender's window and a cached answer: main opens its own link (fragment ignored).
    const afterInspect = sent();
    expect(await service.openInspectionLink(WINDOW_ID, `${PAGE}#frag`)).toBe('opened');
    expect(h.opened.slice(opened)).toEqual([answer.link]);
    expect(sent()).toBe(afterInspect);
    // One gesture backs one open.
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('needs-gesture');
    // An answer older than the cache's life is not used.
    h.clock.now += GSC_CACHE_TTL_MS;
    h.grant();
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('no-link');
    // After a disconnect, nothing cached is used.
    ok(await service.inspect({ url: PAGE }));
    expect(await service.disconnect()).toBe(true);
    h.grant();
    expect(await service.openInspectionLink(WINDOW_ID, PAGE)).toBe('no-link');
    expect(h.opened.slice(opened)).toEqual([answer.link]);
    // The opener refusing (`openExternalIfAllowed` answers false) is `no-link`.
    const refusing = await connected({ openInBrowser: (url, gesture) => !url.startsWith(`https://${GSC_INSPECTION_LINK_HOST}/`) && h.openInBrowser(url, gesture) });
    const consents = h.opened.length;
    ok(await refusing.inspect({ url: PAGE }));
    h.grant();
    expect(await refusing.openInspectionLink(WINDOW_ID, PAGE)).toBe('no-link');
    expect(h.opened).toHaveLength(consents);
  });

  test('inspect-cache-and-fresh', async () => {
    const service = await connected();
    const first = ok(await service.inspect({ url: PAGE }));
    expect(await service.inspect({ url: PAGE })).toEqual(first);
    expect(await service.inspect({ url: `${PAGE}#x`, fresh: false })).toEqual(first);
    expect(h.google.inspections).toHaveLength(1);
    // A performance read of the same page is not served from it, nor it from one.
    expect(await service.performance({ url: PAGE, scope: 'page', days: 28 })).toMatchObject({ status: 'ok' });
    expect(h.google.inspections).toHaveLength(1);
    // "Inspect again": sent, and the entry replaced.
    h.clock.now += 1000;
    h.google.inspection = (url, site) => {
      const body = fakeInspection(url, site) as { inspectionResult: { indexStatusResult: Record<string, unknown> } };
      body.inspectionResult.indexStatusResult.verdict = 'NEUTRAL';
      return body;
    };
    const fresh = ok(await service.inspect({ url: PAGE, fresh: true }));
    expect(h.google.inspections).toHaveLength(2);
    expect(fresh.index.verdict).toEqual({ value: 'NEUTRAL' });
    expect(fresh.inspectedAt).not.toBe(first.inspectedAt);
    expect(await service.inspect({ url: PAGE })).toEqual(fresh);
    expect(h.google.inspections).toHaveLength(2);
    // Within the TTL it is reused; after it, asked again.
    h.clock.now += GSC_CACHE_TTL_MS - 1;
    expect(await service.inspect({ url: PAGE })).toEqual(fresh);
    expect(h.google.inspections).toHaveLength(2);
    h.clock.now += 1;
    ok(await service.inspect({ url: PAGE }));
    expect(h.google.inspections).toHaveLength(3);
    // Failures are not kept.
    h.clock.now += 2000;
    const sent = () => h.google.requests.filter((r) => r.endsWith('/urlInspection/index:inspect')).length;
    const before = sent();
    h.google.mode = 'down';
    expect(await service.inspect({ url: `${SITE}other` })).toEqual({ status: 'unavailable', reason: 'network' });
    h.google.mode = 'ok';
    ok(await service.inspect({ url: `${SITE}other` }));
    expect(sent()).toBe(before + 2);
  });

  test('inspect-quota-429-and-403', async () => {
    const service = await connected();
    expect(await service.properties()).toMatchObject({ status: 'ok' });
    const cases = [
      ['quota', 'quota'],
      ['quota-403', 'quota'],
      ['down', 'network'],
      ['garbage', 'invalid'],
    ] as const;
    for (const [mode, reason] of cases) {
      h.clock.now += 1000;
      h.google.mode = mode;
      expect(await service.inspect({ url: PAGE }), mode).toEqual({ status: 'unavailable', reason });
    }
    // Another 403: no permission for the property; its list is read again next time.
    h.clock.now += 1000;
    h.google.mode = 'forbidden';
    expect(await service.inspect({ url: PAGE })).toEqual({ status: 'unavailable', reason: 'no-property' });
    h.google.mode = 'ok';
    const sites = h.google.sitesCalls;
    h.clock.now += 1000;
    ok(await service.inspect({ url: PAGE }));
    expect(h.google.sitesCalls).toBe(sites + 1);
  });

  test('inspect-connection-changed-mid-read', async () => {
    const service = await connected();
    ok(await service.inspect({ url: PAGE }));
    const release = h.hold('inspection');
    const running = service.inspect({ url: `${SITE}second` });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.disconnect()).toBe(true);
    h.grant();
    expect(await service.connect(WINDOW_ID)).toBe('started');
    await h.follow();
    await service.whenIdle();
    release();
    expect(await running).toEqual({ status: 'unavailable', reason: 'not-connected' });
    // Nothing of it, nor of the old connection, was kept: the new connection inspects afresh.
    const count = h.google.inspections.length;
    h.clock.now += 1000;
    ok(await service.inspect({ url: `${SITE}second` }));
    ok(await service.inspect({ url: PAGE }));
    expect(h.google.inspections).toHaveLength(count + 2);
  });
});
