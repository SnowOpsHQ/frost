// Spec: specs/serp-api.spec.ts (SERP_API_PROVIDERS, SERP_API_OUTCOMES, SERP_API_OUTCOME_MESSAGES,
// SERP_API_LIMITS, dataForSeoCountryName), specs/serp-api.schema.ts (SerpApiRequestSchema, SerpApiJobSchema,
// SerpApiCheck), specs/serp-search-params.schema.ts (location), specs/data-sources.spec.ts
// (SERP_API_VENDOR_AVAILABLE, LEGAL_GATE_NOTE, DATA_API_REQUESTS), specs/projects.spec.ts (searchUrlFor),
// specs/rankings.spec.ts (searchIdentityJson, SEARCH_IDENTITY_EXCLUDED)
// Plan: docs/plans/phase-12-big-bets.md, Decisions 3 (K-A1), 4 and 7, As built (legal gates), Task 3
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { DATA_API_REFUSAL_MESSAGES, DATA_API_REQUESTS, LEGAL_GATE_NOTE, SERP_API_VENDOR_AVAILABLE, type LegalGateId } from '@app/specs/data-sources.spec';
import type { SavedSearchInput } from '@app/specs/projects.spec';
import { searchUrlFor } from '@app/specs/projects.spec';
import { SEARCH_IDENTITY_EXCLUDED, SEARCH_KEY_VERSION, searchIdentityJson } from '@app/specs/rankings.spec';
import { StoredReadingSchema } from '@app/specs/rankings.schema';
import { SERP_API_LIMITS, SERP_API_OUTCOME_MESSAGES, SERP_API_PROVIDER_IDS, DATAFORSEO_COUNTRY_LOCATION_CODES, dataForSeoLocationCode, type SerpApiProvider } from '@app/specs/serp-api.spec';
import type { SerpApiJob, SerpApiCheck } from '@app/specs/serp-api.schema';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpSnapshotSchema } from '@app/specs/serp-snapshot.schema';
import { bundledPack, searchParamsForUrl } from '../../changes/serp-params';
import { savedSearchParams } from '../../changes/projects';
import { laneKeyFor, sha256Hex } from '../../changes/snapshot';
import { runSerpApiJob } from '../../serp/serp-api-parse';
import { createDataApiClient } from '../api-client';
import { createLegalGates } from '../gates';
import { checkSearchViaApi, type SerpApiCheckDeps } from '../serp-api';
import { allOpen, dataStore, DFS_LOGIN, DFS_PASSWORD, recordingFetch, SERPAPI_KEY, SERPER_KEY } from './fakes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = (provider: SerpApiProvider): string => readFileSync(path.join(HERE, '..', '..', 'serp', '__tests__', 'fixtures', 'serp-api', `${provider}.json`), 'utf8');

const SEARCH: SavedSearchInput = { engine: 'google', query: 'frost browser', country: 'us', language: 'en', device: 'desktop' };
const HOST = 'www.google.com';
const searchKey = (params: SearchParams) => sha256Hex(searchIdentityJson(params, {}, HOST));

async function keyedStore() {
  const setup = dataStore();
  for (const [slot, key] of [
    ['serpapi', SERPAPI_KEY],
    ['serper', SERPER_KEY],
    ['dataforseo-login', DFS_LOGIN],
    ['dataforseo-password', DFS_PASSWORD],
  ] as const) {
    expect(await setup.store.setKey(slot, key)).toBe('stored');
  }
  return setup;
}

/** A check over a keyed store and a fetch answering each vendor's fixture; the parse runs the worker's job in-process. */
async function harness(options: { isOpen?: (id: LegalGateId) => boolean; answer?: (url: string, init: RequestInit) => Response; extra?: Partial<SerpApiCheckDeps> } = {}) {
  const { store } = await keyedStore();
  const answer =
    options.answer ??
    ((url: string) => {
      const provider = (Object.keys(DATA_API_REQUESTS) as SerpApiProvider[]).find((p) => url.startsWith(DATA_API_REQUESTS[p][0]!.url))!;
      return new Response(fixtureText(provider), { status: 200 });
    });
  const { fetch, calls } = recordingFetch(answer);
  const isOpen = options.isOpen ?? allOpen;
  const client = createDataApiClient({ store, isOpen, fetch, sleep: async () => undefined });
  const jobs: SerpApiJob[] = [];
  const parse = vi.fn(async (job: SerpApiJob) => {
    jobs.push(job);
    return runSerpApiJob(job);
  });
  const deps: SerpApiCheckDeps = { client, isOpen, parse, ...options.extra };
  return { deps, calls, jobs, parse, client };
}

const ok = (check: SerpApiCheck) => {
  expect(check.ok, JSON.stringify(check).slice(0, 300)).toBe(true);
  if (!check.ok) throw new Error('not ok');
  return check;
};

describe('check a search via a SERP API', () => {
  test.each(SERP_API_PROVIDER_IDS)('serp-api-params-equal-the-saved-searchs (%s)', async (provider) => {
    const { deps } = await harness();
    const check = ok(await checkSearchViaApi(SEARCH, provider, deps));
    const saved = searchParamsForUrl(searchUrlFor(SEARCH), SEARCH.device)!;
    expect(check.params).toEqual(saved);
    expect(check.params).toEqual(savedSearchParams(SEARCH));
    expect('location' in check.params).toBe(false);
    expect(check.snapshot.params).toEqual(saved);
    expect(SerpSnapshotSchema.safeParse(check.snapshot).success).toBe(true);
    expect(check.snapshot.status).toBe('ready');
    // So the reading joins the tab captures' series: one search key (filters {}), SEARCH_IDENTITY_EXCLUDED unchanged.
    expect(searchIdentityJson(check.params, {}, HOST)).toBe(searchIdentityJson(saved, {}, HOST));
    expect(SEARCH_IDENTITY_EXCLUDED).toEqual(['url', 'offset', 'engineLabel']);
    expect(check.skipped).toBe(1);
    expect(check.url).not.toContain(SERPAPI_KEY);
  });

  test('serp-api-params-equal-the-saved-searchs: every device and locale a vendor takes', async () => {
    const { deps } = await harness();
    for (const search of [
      { ...SEARCH, device: 'mobile' as const },
      { ...SEARCH, device: 'tablet' as const },
      { ...SEARCH, country: null, language: null },
      { ...SEARCH, country: 'de', language: 'de' },
      { ...SEARCH, query: 'Frost & “ice” ?=/#' },
    ]) {
      const check = ok(await checkSearchViaApi(search, 'serpapi', deps));
      expect(check.params).toEqual(searchParamsForUrl(searchUrlFor(search), search.device));
    }
  });

  test('serp-api-location-splits-the-key', async () => {
    const { deps, calls } = await harness();
    const plain = ok(await checkSearchViaApi(SEARCH, 'serpapi', deps));
    const berlin = ok(await checkSearchViaApi({ ...SEARCH, location: 'Berlin, Germany' }, 'serpapi', deps));
    expect(berlin.params.location).toEqual({ via: 'api', label: 'Berlin, Germany' });
    expect(berlin.snapshot.params).toEqual(berlin.params);
    const { location: _location, ...rest } = berlin.params;
    expect(rest).toEqual(plain.params);
    // The Phase 10 search key and the Phase 6 lane key change only when `location` is present.
    expect(searchKey(berlin.params)).not.toBe(searchKey(plain.params));
    expect(searchKey({ ...plain.params, location: undefined })).toBe(searchKey(plain.params));
    expect(laneKeyFor(berlin.params.url, null, berlin.params)).not.toBe(laneKeyFor(plain.params.url, null, plain.params));
    expect(laneKeyFor(plain.params.url, null, { ...plain.params, location: undefined })).toBe(laneKeyFor(plain.params.url, null, plain.params));
    // Two places, two series.
    const paris = ok(await checkSearchViaApi({ ...SEARCH, location: 'Paris, France' }, 'serpapi', deps));
    expect(searchKey(paris.params)).not.toBe(searchKey(berlin.params));
    expect(new URL(calls[1]!.url).searchParams.get('location')).toBe('Berlin, Germany');
    expect(new URL(calls[0]!.url).searchParams.has('location')).toBe(false);
  });

  test('old-search-params-still-parse', () => {
    const old: SearchParams = searchParamsForUrl(searchUrlFor(SEARCH), 'desktop')!;
    const json = JSON.parse(JSON.stringify(old)) as Record<string, unknown>;
    expect('location' in json).toBe(false);
    expect(SearchParamsSchema.parse(json)).toEqual(old);
    const snapshot = { status: 'unreadable', reason: 'no-results', params: json, packVersion: 1 };
    expect(SerpSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // A Phase 10 reading row written before the field still parses.
    const row = {
      id: '01920000-0000-7000-8000-000000000001',
      projectId: '01920000-0000-7000-8000-000000000002',
      captureId: null,
      source: 'serp-api',
      searchKey: searchKey(old),
      searchKeyVersion: SEARCH_KEY_VERSION,
      params: json,
      filters: {},
      pageUrl: null,
      status: 'unreadable',
      packVersion: 1,
      snapshot,
      observedAt: 1,
    };
    expect(StoredReadingSchema.safeParse(row).success).toBe(true);
    // With a location it parses too; a malformed one is refused (strict, printable, trimmed, capped).
    expect(SearchParamsSchema.safeParse({ ...old, location: { via: 'api', label: 'Berlin' } }).success).toBe(true);
    expect(SearchParamsSchema.safeParse({ ...old, location: { via: 'proxy', label: 'Home office' } }).success).toBe(true);
    for (const location of [
      null,
      'Berlin',
      { via: 'gps', label: 'Berlin' },
      { via: 'api', label: '' },
      { via: 'api', label: ' Berlin' },
      { via: 'api', label: 'Ber\nlin' },
      { via: 'api', label: 'Ber‮lin' },
      { via: 'api', label: 'x'.repeat(SERP_API_LIMITS.maxLocationChars + 1) },
      { via: 'api', label: 'Berlin', source: 'serp-api' },
    ]) {
      expect(SearchParamsSchema.safeParse({ ...old, location }).success, JSON.stringify(location)).toBe(false);
    }
    // There is no `source` field (provenance lives on the reading row).
    expect(SearchParamsSchema.safeParse({ ...old, source: 'serp-api' }).success).toBe(false);
  });

  test('serp-api-request-built-by-main', async () => {
    const { deps, calls } = await harness();
    // SerpApi: one GET, its query built with URLSearchParams from validated fields; the key once, last.
    ok(await checkSearchViaApi({ ...SEARCH, query: 'frost & api_key=evil', location: 'Berlin, Germany', device: 'mobile' }, 'serpapi', deps));
    const serpapi = new URL(calls[0]!.url);
    expect(`${serpapi.origin}${serpapi.pathname}`).toBe(DATA_API_REQUESTS.serpapi[0]!.url);
    expect([...serpapi.searchParams]).toEqual([
      ['engine', 'google'],
      ['q', 'frost & api_key=evil'],
      ['location', 'Berlin, Germany'],
      ['gl', 'us'],
      ['hl', 'en'],
      ['google_domain', 'google.com'],
      ['device', 'mobile'],
      ['api_key', SERPAPI_KEY],
    ]);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body ?? null).toBeNull();

    // DataForSEO: a POST of one task, Basic auth from both slots; the country's pinned location_code when no location.
    ok(await checkSearchViaApi(SEARCH, 'dataforseo', deps));
    expect(calls[1]!.url).toBe(DATA_API_REQUESTS.dataforseo[0]!.url);
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual([{ keyword: 'frost browser', location_code: 2840, language_code: 'en', device: 'desktop', depth: 10 }]);
    const headers = new Headers(calls[1]!.init.headers);
    expect(headers.get('authorization')).toBe(`Basic ${Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64')}`);
    expect(headers.get('content-type')).toBe('application/json');
    ok(await checkSearchViaApi({ ...SEARCH, location: 'London,England,United Kingdom', device: 'mobile' }, 'dataforseo', deps));
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual([{ keyword: 'frost browser', location_name: 'London,England,United Kingdom', language_code: 'en', device: 'mobile', depth: 10 }]);

    // Serper: a POST with the key in X-API-KEY; absent fields left out.
    ok(await checkSearchViaApi({ ...SEARCH, country: null }, 'serper', deps));
    expect(calls[3]!.url).toBe(DATA_API_REQUESTS.serper[0]!.url);
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ q: 'frost browser', hl: 'en' });
    expect(new Headers(calls[3]!.init.headers).get('x-api-key')).toBe(SERPER_KEY);
    ok(await checkSearchViaApi({ ...SEARCH, location: 'Austin, Texas' }, 'serper', deps));
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ q: 'frost browser', gl: 'us', hl: 'en', location: 'Austin, Texas' });

    // Nothing but validated fields: anything else, or a location that is not printable, trimmed and capped, is refused before a request.
    const before = calls.length;
    for (const search of [
      { ...SEARCH, api_key: 'mine' },
      { ...SEARCH, num: 100 },
      { ...SEARCH, start: 10 },
      { ...SEARCH, location: '' },
      { ...SEARCH, location: ' Berlin' },
      { ...SEARCH, location: 'Berlin\r\nX-Api-Key: x' },
      { ...SEARCH, location: 'Ber‮lin' },
      { ...SEARCH, location: 'x'.repeat(SERP_API_LIMITS.maxLocationChars + 1) },
      { ...SEARCH, location: 7 },
      { ...SEARCH, query: ' frost' },
      { ...SEARCH, query: 'fro\u0000st' },
      { ...SEARCH, country: 'USA' },
      { ...SEARCH, device: 'watch' },
      null,
      'frost',
    ]) {
      expect(await checkSearchViaApi(search as never, 'serpapi', deps), JSON.stringify(search)).toEqual({ ok: false, outcome: 'invalid-search', message: SERP_API_OUTCOME_MESSAGES['invalid-search'] });
    }
    expect(await checkSearchViaApi({ ...SEARCH, location: 'x'.repeat(SERP_API_LIMITS.maxLocationChars) }, 'serpapi', deps)).toMatchObject({ ok: true });
    expect(calls.length).toBe(before + 1);

    // What a vendor cannot take is `unsupported`, never sent.
    for (const [search, provider] of [
      [{ ...SEARCH, engine: 'bing' }, 'serpapi'],
      [{ ...SEARCH, device: 'mobile' }, 'serper'],
      [{ ...SEARCH, device: 'tablet' }, 'dataforseo'],
      [{ ...SEARCH, language: null }, 'dataforseo'],
      [{ ...SEARCH, country: null }, 'dataforseo'],
      [{ ...SEARCH, country: 'xx' }, 'dataforseo'],
    ] as const) {
      expect(await checkSearchViaApi(search, provider, deps), `${provider} ${JSON.stringify(search)}`).toEqual({ ok: false, outcome: 'unsupported', message: SERP_API_OUTCOME_MESSAGES.unsupported });
    }
    expect(ok(await checkSearchViaApi({ ...SEARCH, country: null, location: 'Berlin,Berlin,Germany' }, 'dataforseo', deps)).params.location).toEqual({ via: 'api', label: 'Berlin,Berlin,Germany' });
    expect(await checkSearchViaApi(SEARCH, 'perplexity' as never, deps)).toMatchObject({ ok: false, outcome: 'unsupported' });
    expect(calls.length).toBe(before + 2);
  });

  test('serp-api-dataforseo-location-table', async () => {
    // Pinned from DataForSEO's documented locations list (every Country row): no ICU lookup remains.
    expect(Object.keys(DATAFORSEO_COUNTRY_LOCATION_CODES)).toHaveLength(213);
    expect(Object.keys(DATAFORSEO_COUNTRY_LOCATION_CODES).every((gl) => /^[a-z]{2}$/.test(gl))).toBe(true);
    expect([dataForSeoLocationCode('us'), dataForSeoLocationCode('gb'), dataForSeoLocationCode('de'), dataForSeoLocationCode('fr'), dataForSeoLocationCode('cz')]).toEqual([2840, 2826, 2276, 2250, 2203]);
    for (const unknown of ['xx', 'zz', 'US', 'usa', '', 'constructor', '__proto__', 'toString']) expect(dataForSeoLocationCode(unknown), unknown).toBeNull();
    const root = path.join(HERE, '..', '..', '..', '..', '..', '..');
    for (const file of ['specs/serp-api.spec.ts', 'apps/desktop/src/main/data-sources/serp-api.ts']) expect(readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(/DisplayNames|\bIntl\b/);
    const display = vi.spyOn(Intl, 'DisplayNames');
    const { deps, calls } = await harness();
    ok(await checkSearchViaApi({ ...SEARCH, country: 'de', language: 'de' }, 'dataforseo', deps));
    expect(JSON.parse(String(calls[0]!.init.body))[0]).toMatchObject({ location_code: 2276, language_code: 'de' });
    expect(display).not.toHaveBeenCalled();
    display.mockRestore();
    // A country not in the table: `unsupported` unless a location is typed.
    expect(await checkSearchViaApi({ ...SEARCH, country: 'xx' }, 'dataforseo', deps)).toMatchObject({ ok: false, outcome: 'unsupported' });
    ok(await checkSearchViaApi({ ...SEARCH, country: 'xx', location: 'Berlin,Berlin,Germany' }, 'dataforseo', deps));
    expect(JSON.parse(String(calls[1]!.init.body))[0]).toEqual({ keyword: 'frost browser', location_name: 'Berlin,Berlin,Germany', language_code: 'en', device: 'desktop', depth: 10 });
  });

  test('serp-api-empty-or-error-answers end to end', async () => {
    for (const [provider, body, outcome] of [
      ['serpapi', '{"search_metadata":{"status":"Error"},"error":"Invalid API key."}', 'vendor-error'],
      ['serper', '{"message":"Not enough credits"}', 'vendor-error'],
      ['serpapi', '{}', 'invalid-answer'],
      ['serper', '{}', 'invalid-answer'],
      ['dataforseo', '{}', 'invalid-answer'],
    ] as const) {
      const { deps } = await harness({ answer: () => new Response(body, { status: 200 }) });
      expect(await checkSearchViaApi(SEARCH, provider, deps), `${provider} ${body}`).toEqual({ ok: false, outcome, message: SERP_API_OUTCOME_MESSAGES[outcome] });
    }
    const empty = await harness({ answer: () => new Response('{"searchParameters":{"q":"frost browser"},"organic":[]}', { status: 200 }) });
    expect(ok(await checkSearchViaApi(SEARCH, 'serper', empty.deps)).snapshot).toMatchObject({ status: 'unreadable', reason: 'no-results' });
  });

  test('serp-api-request-built-by-main: the answer is parsed in the worker, never on main', async () => {
    const { deps, jobs, parse } = await harness();
    const check = ok(await checkSearchViaApi(SEARCH, 'serper', deps));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(jobs[0]).toEqual({ provider: 'serper', body: fixtureText('serper'), params: check.params, packVersion: check.snapshot.packVersion });

    // What the worker answers decides the outcome.
    const unreadable = (reason: string) => ({ status: 'unreadable' as const, reason: reason as never, params: check.params, packVersion: 1 });
    const answer = async (result: Awaited<ReturnType<SerpApiCheckDeps['parse']>>) => checkSearchViaApi(SEARCH, 'serper', { ...deps, parse: async () => result });
    expect(await answer({ snapshot: unreadable('invalid-answer'), skipped: 0, vendorError: false })).toEqual({ ok: false, outcome: 'invalid-answer', message: SERP_API_OUTCOME_MESSAGES['invalid-answer'] });
    expect(await answer({ snapshot: unreadable('timeout'), skipped: 0, vendorError: false })).toMatchObject({ ok: false, outcome: 'invalid-answer' });
    expect(await answer({ snapshot: unreadable('invalid-answer'), skipped: 0, vendorError: true })).toEqual({ ok: false, outcome: 'vendor-error', message: SERP_API_OUTCOME_MESSAGES['vendor-error'] });
    expect(ok(await answer({ snapshot: unreadable('no-results'), skipped: 2, vendorError: false })).snapshot).toMatchObject({ status: 'unreadable', reason: 'no-results' });
    // A snapshot of another search than the one asked is never answered.
    expect(await answer({ snapshot: { ...check.snapshot, params: { ...check.params, query: 'other' } } as never, skipped: 0, vendorError: false })).toMatchObject({ ok: false, outcome: 'invalid-answer' });
    // A parse that rejects is `invalid-answer`, never a throw.
    expect(await checkSearchViaApi(SEARCH, 'serper', { ...deps, parse: async () => Promise.reject(new Error('boom')) })).toMatchObject({ ok: false, outcome: 'invalid-answer' });

    // The client's refusals pass through as `request-failed`, with the client's message.
    const failing = await harness({ answer: () => new Response('secret error body', { status: 429 }) });
    expect(await checkSearchViaApi(SEARCH, 'serpapi', failing.deps)).toEqual({ ok: false, outcome: 'request-failed', refusal: 'http-error', status: 429, message: DATA_API_REFUSAL_MESSAGES['http-error'] });
    expect(failing.parse).not.toHaveBeenCalled();
  });

  test('serp-api-packversion-is-the-builders', async () => {
    const { deps, jobs } = await harness();
    const pack = bundledPack()!;
    const check = ok(await checkSearchViaApi(SEARCH, 'dataforseo', deps));
    expect(check.snapshot.packVersion).toBe(pack.version);
    expect(jobs[0]!.packVersion).toBe(pack.version);
    // The pack that builds the canonical URL and parameters is the one whose version is recorded.
    const later = { ...pack, version: pack.version + 41 };
    const withLater = ok(await checkSearchViaApi(SEARCH, 'dataforseo', { ...deps, pack: later }));
    expect(withLater.snapshot.packVersion).toBe(pack.version + 41);
    expect(withLater.params).toEqual(searchParamsForUrl(searchUrlFor(SEARCH), 'desktop', later));
    // No pack (it did not verify): no parameters can be built, so nothing is sent.
    const before = jobs.length;
    expect(await checkSearchViaApi(SEARCH, 'dataforseo', { ...deps, pack: null })).toMatchObject({ ok: false, outcome: 'invalid-search' });
    expect(jobs.length).toBe(before);
  });

  test('serp-api-gated-off-refuses', async () => {
    // As shipped: every vendor's gate closed (L4).
    expect(SERP_API_VENDOR_AVAILABLE).toEqual({ serpapi: false, dataforseo: false, serper: false });
    const gates = createLegalGates({ packaged: true });
    const { deps, calls, parse } = await harness({ isOpen: (id) => gates.isOpen(id) });
    const request = vi.spyOn(deps.client, 'dataApiRequest');
    for (const provider of SERP_API_PROVIDER_IDS) {
      expect(await checkSearchViaApi(SEARCH, provider, deps), provider).toEqual({ ok: false, outcome: 'unavailable', message: LEGAL_GATE_NOTE });
      // Refused early: even an invalid search answers `unavailable`, before validation.
      expect(await checkSearchViaApi(null as never, provider, deps)).toEqual({ ok: false, outcome: 'unavailable', message: LEGAL_GATE_NOTE });
    }
    expect(request).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // One gate open by injection: only that vendor runs.
    const one = await harness({ isOpen: (id) => id === 'serper' });
    expect(ok(await checkSearchViaApi(SEARCH, 'serper', one.deps)).snapshot.status).toBe('ready');
    expect(await checkSearchViaApi(SEARCH, 'serpapi', one.deps)).toEqual({ ok: false, outcome: 'unavailable', message: LEGAL_GATE_NOTE });
    expect(one.calls).toHaveLength(1);
  });
});
