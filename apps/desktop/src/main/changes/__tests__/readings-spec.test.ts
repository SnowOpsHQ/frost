// Spec: specs/rankings.spec.ts (SERP_FILTER_PARAMS, SEARCH_IDENTITY_EXCLUDED, searchIdentityJson, the Zod-free shapes),
// specs/rankings-url.spec.ts (serpFiltersOf, searchHostOf, sameRunSearch), specs/rankings.schema.ts (SerpFiltersSchema, StoredReadingSchema),
// specs/workspace-db.spec.ts (MAX_SERP_FILTERS_JSON_BYTES, SEARCH_KEY_VERSION)
// Acceptance: specs/changes-capture.feature.md (SERP reading; Scenarios: SERP reading spec),
// specs/projects.feature.md (Searches in a run: `sameRunSearch` over the shipped engines' built URLs)
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import { sameRunSearch, searchHostOf, serpFiltersOf, utf8Bytes } from '@app/specs/rankings-url.spec';
import {
  SEARCH_IDENTITY_EXCLUDED,
  SERP_FILTER_PARAMS,
  searchIdentityJson,
  type SearchParamsShape,
  type SerpFilters,
  type SerpSnapshotShape,
} from '@app/specs/rankings.spec';
import { SerpFiltersSchema, StoredReadingSchema } from '@app/specs/rankings.schema';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpSnapshotSchema } from '@app/specs/serp-snapshot.schema';
import { MAX_SERP_FILTERS_JSON_BYTES } from '@app/specs/workspace-db.spec';
import { SEARCH_ENGINE_IDS } from '@app/specs/browser-polish.spec';
import { bulkSearchInputs, searchUrlFor, type BulkLocale } from '@app/specs/projects.spec';
import { SERP_DEVICES } from '@app/specs/serp.spec';
import { savedSearchParams } from '../projects';
import { searchParamsForUrl } from '../serp-params';
import { sha256Hex } from '../snapshot';
import { readyReading } from './fakes';

const PARAMS: SearchParams = { engine: 'google', engineLabel: 'Google', query: 'green tea', gl: 'de', hl: 'de', device: 'desktop', page: 1, offset: null, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' };
const HOST = 'www.google.com';
/** The search key as main computes it (`service.ts`). */
const keyOf = (params: SearchParamsShape, filters: SerpFilters = {}, host = searchHostOf(params.url)!) => sha256Hex(searchIdentityJson(params, filters, host));

describe('the search key', () => {
  test('search-identity-splits-by-host-filters-and-device', () => {
    const base = keyOf(PARAMS);
    // The same search, the same key.
    expect(keyOf({ ...PARAMS })).toBe(base);
    expect(searchHostOf(PARAMS.url)).toBe(HOST);
    // Another engine host (google.de is not google.com).
    expect(keyOf({ ...PARAMS, url: 'https://www.google.de/search?q=green+tea&gl=de&hl=de' })).not.toBe(base);
    // Filters split: "past week" is its own series, and so is another filter value.
    const week = keyOf(PARAMS, { tbs: 'qdr:w' });
    expect(week).not.toBe(base);
    expect(keyOf(PARAMS, { tbs: 'qdr:m' })).not.toBe(week);
    // The device splits.
    expect(keyOf({ ...PARAMS, device: 'mobile' })).not.toBe(base);
    expect(keyOf({ ...PARAMS, device: 'tablet' })).not.toBe(keyOf({ ...PARAMS, device: 'mobile' }));
    // So do the country, the language and the page.
    for (const changed of [{ gl: 'us' }, { hl: 'en' }, { gl: null }, { page: 2 }, { query: 'black tea' }, { engine: 'bing' }]) expect(keyOf({ ...PARAMS, ...changed }), JSON.stringify(changed)).not.toBe(base);
    // The host is taken as the key's rule says: case and one trailing dot aside, a non-default port kept.
    expect(searchHostOf('https://WWW.Google.COM./search?q=x')).toBe(HOST);
    expect(searchHostOf('https://www.google.com:443/search?q=x')).toBe(HOST);
    expect(searchHostOf('http://www.google.com:8080/search?q=x')).toBe('www.google.com:8080');
    expect(searchHostOf('not a url')).toBeNull();
    expect(searchIdentityJson(PARAMS, {}, 'WWW.GOOGLE.COM')).toBe(searchIdentityJson(PARAMS, {}, HOST));
  });

  test('search-identity-ignores-key-order', () => {
    const reversed = Object.fromEntries(Object.entries(PARAMS).reverse()) as SearchParams;
    expect(Object.keys(reversed)).not.toEqual(Object.keys(PARAMS));
    expect(searchIdentityJson(reversed, {}, HOST)).toBe(searchIdentityJson(PARAMS, {}, HOST));
    expect(searchIdentityJson(PARAMS, { tbs: 'qdr:w', num: '20' }, HOST)).toBe(searchIdentityJson(PARAMS, { num: '20', tbs: 'qdr:w' }, HOST));
    // Canonical: keys sorted at every level.
    expect(searchIdentityJson(PARAMS, { tbs: 'qdr:w' }, HOST)).toBe(
      '{"filters":{"tbs":"qdr:w"},"host":"www.google.com","params":{"device":"desktop","engine":"google","gl":"de","hl":"de","page":1,"query":"green tea"}}',
    );
  });

  test('search-identity-excludes-url-offset-and-label', () => {
    expect(SEARCH_IDENTITY_EXCLUDED).toEqual(['url', 'offset', 'engineLabel']);
    const base = keyOf(PARAMS);
    expect(keyOf({ ...PARAMS, engineLabel: 'Google Search' })).toBe(base);
    expect(keyOf({ ...PARAMS, offset: 0 })).toBe(base);
    // The URL counts only by its host: the rest of it (parameters, path, scheme) never does.
    expect(keyOf({ ...PARAMS, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de&start=0' })).toBe(base);
    expect(keyOf({ ...PARAMS, url: 'http://www.google.com/webhp?q=green+tea' })).toBe(base);
  });

  test('search-identity-takes-later-fields', () => {
    const base = keyOf(PARAMS);
    // A field a later phase adds (Phase 12's planned location) splits series once present...
    const located = { ...PARAMS, location: 'Berlin' } as SearchParamsShape;
    expect(keyOf(located)).not.toBe(base);
    expect(keyOf({ ...PARAMS, location: 'Hamburg' } as SearchParamsShape)).not.toBe(keyOf(located));
    // ...and leaves the key as it was while absent.
    expect(keyOf({ ...PARAMS, location: undefined } as SearchParamsShape)).toBe(base);
  });

  test('search-identity-keeps-case', () => {
    expect(keyOf({ ...PARAMS, query: 'Green tea' })).not.toBe(keyOf(PARAMS));
    expect(keyOf({ ...PARAMS, query: 'GREEN TEA' })).not.toBe(keyOf({ ...PARAMS, query: 'Green tea' }));
  });
});

describe('filters', () => {
  test('serp-filters-known-names-only', () => {
    expect(SERP_FILTER_PARAMS).toEqual({ google: ['tbs', 'num', 'safe', 'pws'], bing: [], duckduckgo: ['df', 'kp'] });
    // Known names only, values lowercased, keys sorted; the engine's session and tracking parameters dropped.
    const google = serpFiltersOf('https://www.google.com/search?q=tea&tbs=QDR:W&ei=abc&num=20&safe=Active&pws=0&sclient=x&tbm=', 'google');
    expect(google).toEqual({ num: '20', pws: '0', safe: 'active', tbs: 'qdr:w' });
    expect(Object.keys(google!)).toEqual(['num', 'pws', 'safe', 'tbs']);
    // The first value of a repeated name; an empty one is none.
    expect(serpFiltersOf('https://www.google.com/search?q=tea&num=10&num=50&tbs=', 'google')).toEqual({ num: '10' });
    expect(serpFiltersOf('https://duckduckgo.com/?q=tea&df=w&kp=-2&kl=de-de', 'duckduckgo')).toEqual({ df: 'w', kp: '-2' });
    // Another engine's names are not this engine's; Bing has none in this phase; an unknown engine or a bad URL has none.
    expect(serpFiltersOf('https://duckduckgo.com/?q=tea&tbs=qdr:w', 'duckduckgo')).toEqual({});
    expect(serpFiltersOf('https://www.bing.com/search?q=tea&filters=ex1', 'bing')).toEqual({});
    expect(serpFiltersOf('https://www.google.com/search?q=tea&num=20', 'constructor')).toEqual({});
    expect(serpFiltersOf('https://www.google.com/search?q=tea&num=20', 'other')).toEqual({});
    expect(serpFiltersOf('not a url', 'google')).toEqual({});
    // Past the byte cap: no filters at all (null), never a set with one cut out (that would merge series).
    expect(serpFiltersOf(`https://www.google.com/search?q=tea&num=20&tbs=${'x'.repeat(MAX_SERP_FILTERS_JSON_BYTES)}`, 'google')).toBeNull();
    expect(serpFiltersOf(`https://www.google.com/search?q=tea&num=20&tbs=${'é'.repeat(600)}`, 'google')).toBeNull();
    // At the cap exactly it is kept (UTF-8 bytes of its sorted JSON, `{"tbs":"…"}` being 10 bytes besides the value).
    const fits = serpFiltersOf(`https://www.google.com/search?q=tea&tbs=${'x'.repeat(MAX_SERP_FILTERS_JSON_BYTES - 10)}`, 'google');
    expect(utf8Bytes(JSON.stringify(fits))).toBe(MAX_SERP_FILTERS_JSON_BYTES);
    expect(SerpFiltersSchema.safeParse(fits).success).toBe(true);
  });

  test('same-run-search-compares-the-search', () => {
    expect(sameRunSearch(PARAMS, { ...PARAMS })).toBe(true);
    // Not the device, the label, the offset or the rest of the URL.
    expect(sameRunSearch({ ...PARAMS, device: 'mobile', engineLabel: 'G', offset: 0, url: `${PARAMS.url}&ei=x` }, PARAMS)).toBe(true);
    for (const changed of [{ gl: 'us' }, { hl: null }, { query: 'Green tea' }, { page: 2 }, { engine: 'bing' }, { url: 'https://www.google.de/search?q=green+tea&gl=de&hl=de' }, { url: 'nonsense' }]) {
      expect(sameRunSearch({ ...PARAMS, ...changed }, PARAMS), JSON.stringify(changed)).toBe(false);
    }
  });
});

describe('a run target and its landed page', () => {
  // spec: specs/projects.feature.md — Searches in a run (3. `sameRunSearch`): for every shipped engine and
  // every saved search Bulk add can make, the page a run lands on unchanged reads back as the target's
  // search, so the gate never stops a run that met its own result page.
  test('run-search-matches-built-urls', () => {
    const queries = ['green tea', 'Grüner Tee', 'c++ & "tea" 100%', 'a+b=c?#x', '東京 お茶', 'tea/coffee'];
    const locales: BulkLocale[] = [
      { country: null, language: null },
      { country: 'de', language: null },
      { country: null, language: 'en' },
      { country: 'us', language: 'en' },
      { country: 'br', language: 'pt-br' },
    ];
    let checked = 0;
    for (const engine of SEARCH_ENGINE_IDS) {
      for (const query of queries) {
        for (const search of bulkSearchInputs(query, { engine, locales, devices: SERP_DEVICES })) {
          const label = JSON.stringify(search);
          // The saved search (`searchUrlFor` → `searchParamsForUrl`), as Bulk add stores it.
          const target = savedSearchParams(search);
          expect(target, label).not.toBeNull();
          // The run visits its canonical URL; it lands there unchanged and Phase 3 reads it (on the device in effect).
          for (const landed of [target!.url, searchUrlFor(search)]) {
            const tab = searchParamsForUrl(landed, search.device);
            expect(tab, `${label} ${landed}`).not.toBeNull();
            expect(sameRunSearch(tab!, target!), `${label} ${landed}`).toBe(true);
            // A pin that sets another device changes nothing.
            const other = SERP_DEVICES.find((device) => device !== search.device)!;
            expect(sameRunSearch(searchParamsForUrl(landed, other)!, target!), `${label} on ${other}`).toBe(true);
            checked += 1;
          }
          // Another country, language, query or engine host is another search.
          for (const changed of [{ gl: target!.gl === 'zz' ? 'zy' : 'zz' }, { hl: target!.hl === 'xx' ? 'xy' : 'xx' }, { query: `${target!.query} 2` }, { url: target!.url.replace('://', '://other.') }]) {
            expect(sameRunSearch({ ...target!, ...changed }, target!), `${label} ${JSON.stringify(changed)}`).toBe(false);
          }
        }
      }
    }
    expect(checked).toBe(SEARCH_ENGINE_IDS.length * queries.length * locales.length * SERP_DEVICES.length * 2);
  });
});

describe('shapes and schemas', () => {
  test('rankings-shapes-match-schemas', () => {
    // Compile time: Phase 3's schemas, unchanged, parse to the Zod-free shapes.
    expectTypeOf<z.infer<typeof SearchParamsSchema>>().toExtend<SearchParamsShape>();
    expectTypeOf<z.infer<typeof SerpSnapshotSchema>>().toExtend<SerpSnapshotShape>();
    expectTypeOf<z.infer<typeof SerpFiltersSchema>>().toExtend<SerpFilters>();
    // And at run time, a parsed reading is a shape.
    const reading: SerpSnapshotShape = SerpSnapshotSchema.parse(readyReading(PARAMS));
    expect(reading.status).toBe('ready');

    // Filters: known names, lowercase, sorted, within the cap.
    expect(SerpFiltersSchema.safeParse({ num: '20', tbs: 'qdr:w' }).success).toBe(true);
    for (const bad of [{ tbs: 'qdr:w', num: '20' }, { ei: 'abc' }, { tbs: 'QDR:W' }, { tbs: '' }, { tbs: 1 }, { tbs: 'x'.repeat(MAX_SERP_FILTERS_JSON_BYTES) }]) {
      expect(SerpFiltersSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }

    // A stored reading: the row's checks over a valid snapshot.
    const row = {
      id: '01920000-0000-7000-8000-000000000001',
      projectId: '01920000-0000-7000-8000-0000000000aa',
      captureId: '01920000-0000-7000-8000-000000000002',
      source: 'capture',
      searchKey: keyOf(PARAMS, { tbs: 'qdr:w' }),
      searchKeyVersion: 1,
      params: PARAMS,
      filters: { tbs: 'qdr:w' },
      pageUrl: 'https://www.google.com/search?q=green+tea&gl=de&hl=de&tbs=qdr:w',
      status: 'ready',
      packVersion: 3,
      snapshot: readyReading(PARAMS),
      observedAt: 1_700_000_000_000,
    };
    expect(StoredReadingSchema.parse(row)).toEqual(row);
    const unreadable = { status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 3 };
    expect(StoredReadingSchema.safeParse({ ...row, status: 'unreadable', snapshot: unreadable }).success).toBe(true);
    expect(StoredReadingSchema.safeParse({ ...row, status: 'unreadable', packVersion: null, snapshot: { ...unreadable, params: null, packVersion: null } }).success).toBe(true);
    // A serp-api reading needs no capture.
    expect(StoredReadingSchema.safeParse({ ...row, source: 'serp-api', captureId: null }).success).toBe(true);
    const refused: Record<string, unknown>[] = [
      { status: 'unreadable' },
      { packVersion: 4 },
      { snapshot: readyReading({ ...PARAMS, gl: 'us' }) },
      { params: { ...PARAMS, query: 'black tea' } },
      { filters: { df: 'w' } },
      { captureId: null },
      { source: 'other' },
      { searchKey: 'ABC' },
      { snapshot: { ...readyReading(PARAMS), results: [] } },
      { extra: 1 },
    ];
    for (const change of refused) expect(StoredReadingSchema.safeParse({ ...row, ...change }).success, JSON.stringify(change).slice(0, 80)).toBe(false);
  });
});
