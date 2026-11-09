// Spec: specs/serp-search-params.schema.ts (SearchParamsSchema), specs/serp-service.schema.ts (SerpState),
// specs/projects.spec.ts (SavedSearchInput, SEARCH_PARAM_URL_RULES, searchLocaleFor, searchUrlFor),
// specs/rankings.spec.ts (SERP_RUN_VERDICTS), specs/serp-snapshot.schema.ts (SerpSnapshotSchema)
// Acceptance: specs/changes-capture.feature.md (Search parameters of a tab; SERP reading), specs/changes-diff.feature.md
// (Search parameters), specs/projects.feature.md (Saved searches)
import { describe, expect, test } from 'vitest';
import { SEARCH_ENGINE_IDS } from '@app/specs/browser-polish.spec';
import { searchLocaleFor, searchUrlFor, type SavedSearchInput } from '@app/specs/projects.spec';
import { SERP_RUN_VERDICTS, type SerpRunVerdict } from '@app/specs/rankings.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpState } from '@app/specs/serp-service.schema';
import { SerpSnapshotSchema } from '@app/specs/serp-snapshot.schema';
import { SelectorPackSchema } from '@app/specs/serp-selector-pack.schema';
import { SERP_DEVICES } from '@app/specs/serp.spec';
import { BUNDLED_PACK } from '../../serp/bundled';
import { matchSerp } from '../../serp/engines';
import { bundledPack, lateSearchParams, searchParamsForUrl, searchParamsOfState, serpReadingOfState, serpVerdictOfState } from '../serp-params';
import { readyReading } from './fakes';

const PAGE = 'https://www.google.com/search?q=green+tea&gl=de&hl=de&ei=abc';
const PARAMS: SearchParams = {
  engine: 'google',
  engineLabel: 'Google',
  query: 'green tea',
  gl: 'de',
  hl: 'de',
  device: 'mobile',
  page: 1,
  offset: null,
  url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de',
};
const ready = (params: unknown, url = PAGE, tabId = 1) => ({
  status: 'ready',
  tabId,
  documentSeq: 3,
  url,
  readAt: 1,
  snapshot: { status: 'ready', params, packVersion: 1, results: [], composition: {}, ownership: {}, truncated: false },
});

describe('search parameters of a tab', () => {
  test('serp-state-to-search-params', () => {
    // A finished reading of the page: ready, or unreadable with its parameters.
    expect(searchParamsOfState(ready(PARAMS), 1, PAGE)).toEqual(PARAMS);
    expect(searchParamsOfState(ready(PARAMS, `${PAGE}#frag`), 1, PAGE)).toEqual(PARAMS);
    const unreadable = { status: 'unreadable', tabId: 1, documentSeq: 3, url: PAGE, readAt: 1, reason: 'no-results', params: PARAMS, packVersion: 1 } satisfies SerpState;
    expect(searchParamsOfState(unreadable, 1, PAGE)).toEqual(PARAMS);
    expect(searchParamsOfState({ ...unreadable, params: null }, 1, PAGE)).toBeNull();
    // Anything else is none.
    const states: unknown[] = [
      { status: 'not-serp', tabId: 1, url: PAGE },
      { status: 'pending', tabId: 1, documentSeq: 3, url: PAGE, params: PARAMS },
      { status: 'disabled', tabId: 1, reason: 'pack-invalid' },
      ready(PARAMS, 'https://www.google.com/search?q=black+tea'),
      ready(PARAMS, PAGE, 2),
      ready({ ...PARAMS, location: 'Berlin' }),
      ready({ engine: 'google', query: 'green tea', country: 'de', language: 'de', location: null, device: 'mobile' }),
      ready({ ...PARAMS, url: 'javascript:alert(1)' }),
      { ...unreadable, params: { ...PARAMS, page: 0 } },
      { status: 'ready', tabId: 1, url: PAGE },
      { status: 'ready', tabId: 1, url: 5, snapshot: { params: PARAMS } },
      null,
      undefined,
      'ready',
      42,
      [],
    ];
    for (const state of states) expect(searchParamsOfState(state, 1, PAGE), JSON.stringify(state)).toBeNull();
    // A page that is not storable is never a match.
    expect(searchParamsOfState(ready(PARAMS, 'about:blank'), 1, 'about:blank')).toBeNull();
  });

  test('serp-params-are-late-bound', () => {
    const late = lateSearchParams();
    expect(late.of(1, PAGE)).toBeNull();
    const asked: number[] = [];
    late.bind({
      snapshot: (tabId: number) => {
        asked.push(tabId);
        return ready(PARAMS, PAGE, tabId) as unknown as SerpState;
      },
    });
    expect(late.of(1, PAGE)).toEqual(PARAMS);
    expect(late.of(1, 'https://example.com/')).toBeNull();
    expect(asked).toEqual([1, 1]);
    late.bind({
      snapshot: () => {
        throw new Error('gone');
      },
    });
    expect(late.of(1, PAGE)).toBeNull();
  });
});

/** Phase 3's states of tab `tabId` showing `url`, one per status, with a valid ready reading. */
const states = (url = PAGE, tabId = 1) => {
  const reading = readyReading(PARAMS);
  return {
    ready: { status: 'ready', tabId, documentSeq: 3, url, readAt: 1, snapshot: reading },
    unreadable: { status: 'unreadable', tabId, documentSeq: 3, url, readAt: 1, reason: 'no-results', params: PARAMS, packVersion: 2 },
    'not-serp': { status: 'not-serp', tabId, url },
    pending: { status: 'pending', tabId, documentSeq: 3, url, params: PARAMS },
    disabled: { status: 'disabled', tabId, reason: 'pack-invalid' },
  } satisfies Record<SerpRunVerdict, SerpState>;
};
/** Garbage a read API might answer. */
const GARBAGE: unknown[] = [null, undefined, 'ready', 42, [], {}, { status: 'ready' }, { status: 'ready', tabId: 1, url: 5 }, { status: 'other', tabId: 1, url: PAGE }];

describe('the SERP reading of a tab', () => {
  test('serp-reading-of-state', () => {
    const all = states();
    // A ready state of the same tab and page (stored form, fragment aside): its snapshot, as SerpSnapshotSchema parses it.
    expect(serpReadingOfState(all.ready, 1, PAGE)).toEqual(SerpSnapshotSchema.parse(all.ready.snapshot));
    expect(serpReadingOfState({ ...all.ready, url: `${PAGE}#frag` }, 1, PAGE)).toEqual(all.ready.snapshot);
    // An unreadable state is rebuilt as a reading; without parameters it has no search key, so none.
    expect(serpReadingOfState(all.unreadable, 1, PAGE)).toEqual({ status: 'unreadable', reason: 'no-results', params: PARAMS, packVersion: 2 });
    expect(serpReadingOfState({ ...all.unreadable, params: null, packVersion: null }, 1, PAGE)).toBeNull();
    // Nothing for the rest: pending, not-serp, disabled, another tab or page.
    for (const state of [all.pending, all['not-serp'], all.disabled]) expect(serpReadingOfState(state, 1, PAGE), state.status).toBeNull();
    expect(serpReadingOfState(all.ready, 2, PAGE)).toBeNull();
    expect(serpReadingOfState(all.ready, 1, 'https://www.google.com/search?q=black+tea')).toBeNull();
    expect(serpReadingOfState(states('about:blank').ready, 1, 'about:blank')).toBeNull();
    // Anything that does not fit SerpSnapshotSchema.
    const bad: unknown[] = [
      ...GARBAGE,
      ready(PARAMS),
      { ...all.ready, snapshot: { ...all.ready.snapshot, results: [] } },
      { ...all.ready, snapshot: { ...all.ready.snapshot, extra: 1 } },
      { ...all.ready, snapshot: readyReading({ ...PARAMS, gl: 'DE' }) },
      { ...all.unreadable, reason: 'gone' },
      { ...all.unreadable, params: { ...PARAMS, page: 0 } },
    ];
    for (const state of bad) expect(serpReadingOfState(state, 1, PAGE), JSON.stringify(state)?.slice(0, 80)).toBeNull();

    // Late bound: none until bound, then the API's answer for the tab and page; a throwing API is none.
    const late = lateSearchParams();
    expect(late.readingOf(1, PAGE)).toBeNull();
    late.bind({ snapshot: (tabId: number) => states(PAGE, tabId).ready as SerpState });
    expect(late.readingOf(1, PAGE)).toEqual(all.ready.snapshot);
    expect(late.readingOf(1, 'https://example.com/')).toBeNull();
    late.bind({
      snapshot: () => {
        throw new Error('gone');
      },
    });
    expect(late.readingOf(1, PAGE)).toBeNull();
  });

  test('serp-verdict-of-state', () => {
    expect(SERP_RUN_VERDICTS).toEqual(['ready', 'unreadable', 'not-serp', 'pending', 'disabled']);
    // Each status maps to its verdict, for the same tab and stored page.
    for (const [verdict, state] of Object.entries(states())) expect(serpVerdictOfState(state, 1, PAGE), verdict).toBe(verdict);
    for (const [verdict, state] of Object.entries(states(`${PAGE}#frag`))) expect(serpVerdictOfState(state, 1, PAGE), verdict).toBe(verdict);
    // Disabled has no page: SERP reading is off whatever the tab shows.
    expect(serpVerdictOfState(states().disabled, 1, 'https://example.com/')).toBe('disabled');
    // Another tab or page, a ready state whose reading does not fit, and garbage: pending, never null.
    const other = [
      ...Object.values(states(PAGE, 2)),
      ...Object.values(states('https://www.google.com/search?q=black+tea')).filter((state) => state.status !== 'disabled'),
      ready(PARAMS),
      ...GARBAGE,
    ];
    for (const state of other) expect(serpVerdictOfState(state, 1, PAGE), JSON.stringify(state)?.slice(0, 80)).toBe('pending');
    expect(serpVerdictOfState(states('about:blank').ready, 1, 'about:blank')).toBe('pending');

    // Late bound: pending until bound, and when the API throws.
    const late = lateSearchParams();
    expect(late.verdictOf(1, PAGE)).toBe('pending');
    let status: SerpRunVerdict = 'not-serp';
    late.bind({ snapshot: (tabId: number) => states(PAGE, tabId)[status] as SerpState });
    expect(late.verdictOf(1, PAGE)).toBe('not-serp');
    status = 'ready';
    expect(late.verdictOf(1, PAGE)).toBe('ready');
    expect(late.verdictOf(1, 'https://example.com/')).toBe('pending');
    late.bind({
      snapshot: () => {
        throw new Error('gone');
      },
    });
    expect(late.verdictOf(1, PAGE)).toBe('pending');
  });
});

describe('saved searches', () => {
  test('bundled-pack-verifies', () => {
    const pack = bundledPack();
    expect(pack).not.toBeNull();
    expect(pack).toEqual(SelectorPackSchema.parse(JSON.parse(new TextDecoder().decode(BUNDLED_PACK.bytes))));
    expect(bundledPack()).toBe(pack);
  });

  test('search-url-reads-back-as-phase-3', () => {
    const pack = bundledPack()!;
    for (const engine of SEARCH_ENGINE_IDS) {
      for (const [country, language] of [[null, null], ['de', null], [null, 'en'], ['de', 'de'], ['us', 'en-gb']] as const) {
        for (const device of SERP_DEVICES) {
          const search: SavedSearchInput = { engine, query: 'green  tea & café/?#', country, language, device };
          const url = searchUrlFor(search);
          // The URL carries no device.
          expect(url).not.toMatch(/device|mobile|tablet|desktop/);
          const params = searchParamsForUrl(url, device);
          const label = `${engine} ${country} ${language} ${device}`;
          // What Phase 3's matcher reads from the URL, with the gl / hl asked for.
          expect(params, label).toEqual(matchSerp(url, pack, device)?.params);
          expect(params, label).toMatchObject({ engine, query: 'green tea & café/?#', device, page: 1, offset: null, ...searchLocaleFor(search) });
          // Its canonical URL reads back as the same parameters (the URL a run visits).
          expect(searchParamsForUrl(params!.url, device), label).toEqual(params);
        }
      }
    }
    // Each engine by the pack's parameter names, the country first.
    expect(searchUrlFor({ engine: 'google', query: 'tea', country: 'de', language: 'de', device: 'desktop' })).toBe('https://www.google.com/search?q=tea&gl=de&hl=de');
    expect(searchUrlFor({ engine: 'bing', query: 'tea', country: 'de', language: 'de', device: 'desktop' })).toBe('https://www.bing.com/search?q=tea&cc=de&setlang=de');
    expect(searchUrlFor({ engine: 'duckduckgo', query: 'tea', country: 'de', language: 'de', device: 'desktop' })).toBe('https://duckduckgo.com/?q=tea&kl=de-de');
    expect(searchUrlFor({ engine: 'duckduckgo', query: 'tea', country: 'de', language: null, device: 'desktop' })).toBe('https://duckduckgo.com/?q=tea');
    expect(searchParamsForUrl('https://example.com/search?q=tea', 'desktop')).toBeNull();
    expect(searchParamsForUrl('https://www.google.com/maps?q=tea', 'desktop')).toBeNull();
  });
});
