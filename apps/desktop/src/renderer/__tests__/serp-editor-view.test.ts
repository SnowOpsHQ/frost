// Spec: specs/serp-param-editor.spec.ts (SERP_EDITOR_FIELDS, GOOGLE_EDITOR_HOSTS, SERP_NUM_HINT, editorParamNames,
// editorFields, editorStateOf, editorUnsupported, editedSearchUrl, trackableSearch, trackRefusalOf,
// TRACK_REFUSAL_MESSAGES), specs/rankings.spec.ts (SERP_FILTER_PARAMS), specs/rankings-url.spec.ts (serpFiltersOf),
// specs/browser-polish.spec.ts (searchEngineUrl), specs/projects.spec.ts (SEARCH_PARAM_URL_RULES, searchLocaleFor)
// Acceptance: specs/serp-panels.feature.md (Edit search, View model)
import { describe, expect, test } from 'vitest';
import { searchEngineUrl, wellFormed } from '@app/specs/browser-polish.spec';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { PROJECT_REFUSAL_MESSAGES, SEARCH_PARAM_URL_RULES, searchLocaleFor, type ProjectSummary } from '@app/specs/projects.spec';
import { SERP_FILTER_PARAMS } from '@app/specs/rankings.spec';
import { serpFiltersOf } from '@app/specs/rankings-url.spec';
import {
  DDG_NO_REGION,
  EDITOR_COUNTRIES,
  EDITOR_DDG_REGIONS,
  EDITOR_LANGUAGES,
  GOOGLE_EDITOR_HOSTS,
  SERP_EDITOR_FIELDS,
  SERP_NUM_HINT,
  TRACK_REFUSAL_MESSAGES,
  editedSearchUrl,
  editorFields,
  editorParamNames,
  editorStateOf,
  editorUnsupported,
  isEditorCountry,
  isEditorLanguage,
  isEditorRegion,
  trackRefusalOf,
  trackableSearch,
  type EditorState,
} from '@app/specs/serp-param-editor.spec';
import type { PackStatus, SerpTabState } from '@app/specs/serp-service.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { editorApply, editorFieldRows, serpEditorModel, takeSerpEditorRequest, requestSerpEditor, trackAnswerText, trackProjectChoices, trackView, unsupportedNote } from '../serp-editor-view';

const google = (changes: Partial<SearchParams> = {}): SearchParams => ({
  engine: 'google',
  engineLabel: 'Google',
  query: 'green tea',
  gl: 'de',
  hl: 'de',
  device: 'desktop',
  page: 1,
  offset: null,
  url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de',
  ...changes,
});
const bing = (changes: Partial<SearchParams> = {}): SearchParams => ({ engine: 'bing', engineLabel: 'Bing', query: 'tea', gl: 'de', hl: 'de', device: 'desktop', page: 1, offset: null, url: 'https://www.bing.com/search?q=tea&cc=de&setlang=de', ...changes });
const ddg = (changes: Partial<SearchParams> = {}): SearchParams => ({ engine: 'duckduckgo', engineLabel: 'DuckDuckGo', query: 'tea', gl: 'de-de', hl: null, device: 'desktop', page: 1, offset: null, url: 'https://duckduckgo.com/?q=tea&kl=de-de', ...changes });
const other = (changes: Partial<SearchParams> = {}): SearchParams => ({ engine: 'synthetic', engineLabel: 'Synthetic', query: 'tea', gl: null, hl: null, device: 'desktop', page: 1, offset: null, url: 'http://search.frost-e2e.net/find?q=tea', ...changes });

const PACK: PackStatus = { state: 'ready', version: 2, source: 'bundled', published: null, lastUpdate: null, checking: false };
const tabState = (params: SearchParams, pageUrl: string, paramNames: SerpTabState['paramNames'] = null): SerpTabState => ({
  version: 1,
  tabId: 4,
  serp: { status: 'pending', tabId: 4, documentSeq: 1, url: pageUrl, params },
  outlines: false,
  intent: null,
  pack: PACK,
  paramNames,
});

const ids = (fields: readonly { readonly id: string }[]) => fields.map((field) => field.id);
const values = (fields: readonly { readonly id: string; readonly options: readonly { readonly value: string }[] }[], id: string) => fields.find((field) => field.id === id)!.options.map((option) => option.value);
const GOOGLE_NAMES = editorParamNames('google', null);

describe('the SERP parameter editor', () => {
  test('editor-fields-per-engine', () => {
    // Google: domain, country, language, time, results per page, SafeSearch, personalisation.
    expect(ids(SERP_EDITOR_FIELDS.google)).toEqual(['host', 'gl', 'hl', 'tbs', 'num', 'safe', 'pws']);
    expect(values(SERP_EDITOR_FIELDS.google, 'host')).toEqual([...GOOGLE_EDITOR_HOSTS]);
    expect(values(SERP_EDITOR_FIELDS.google, 'tbs')).toEqual(['', 'qdr:h', 'qdr:d', 'qdr:w', 'qdr:m', 'qdr:y']);
    expect(values(SERP_EDITOR_FIELDS.google, 'num')).toEqual(['', '10', '20', '50', '100']);
    expect(SERP_EDITOR_FIELDS.google.find((field) => field.id === 'num')!.hint).toBe(SERP_NUM_HINT);
    expect(values(SERP_EDITOR_FIELDS.google, 'safe')).toEqual(['', 'active', 'off']);
    expect(values(SERP_EDITOR_FIELDS.google, 'pws')).toEqual(['', '0']);
    // Bing: country and language; DuckDuckGo: region, time, SafeSearch.
    expect(ids(SERP_EDITOR_FIELDS.bing)).toEqual(['gl', 'hl']);
    expect(ids(SERP_EDITOR_FIELDS.duckduckgo)).toEqual(['gl', 'df', 'kp']);
    expect(SERP_EDITOR_FIELDS.duckduckgo[0]!.label).toBe('Region');
    expect(values(SERP_EDITOR_FIELDS.duckduckgo, 'df')).toEqual(['', 'd', 'w', 'm', 'y']);
    expect(values(SERP_EDITOR_FIELDS.duckduckgo, 'kp')).toEqual(['', '1', '-2']);
    expect(ids(SERP_EDITOR_FIELDS.other)).toEqual(['gl', 'hl']);
    // Every filter field is a known filter, and every known filter has its field; the region `kl` is
    // DuckDuckGo's `gl` (a search parameter), never a filter.
    for (const engine of ['google', 'bing', 'duckduckgo'] as const) {
      expect(SERP_EDITOR_FIELDS[engine].filter((field) => field.kind === 'filter').map((field) => field.id), engine).toEqual([...SERP_FILTER_PARAMS[engine]]);
    }
    expect(SERP_FILTER_PARAMS.duckduckgo).not.toContain('kl');
    expect(SEARCH_PARAM_URL_RULES.duckduckgo.gl).toBe('kl');
    // The names: the rules for the three engines, the pack's (from main) for any other.
    expect(GOOGLE_NAMES).toEqual({ query: 'q', gl: 'gl', hl: 'hl' });
    expect(editorParamNames('bing', { query: 'x', gl: 'y', hl: 'z' })).toEqual({ query: 'q', gl: 'cc', hl: 'setlang' });
    expect(editorParamNames('duckduckgo', null)).toEqual({ query: 'q', gl: 'kl', hl: null });
    expect(editorParamNames('synthetic', null)).toBeNull();
    expect(editorParamNames('synthetic', { query: 'q', gl: 'country', hl: null })).toEqual({ query: 'q', gl: 'country', hl: null });
    expect(ids(editorFields(other(), null))).toEqual([]);
    expect(ids(editorFields(other(), { query: 'q', gl: 'country', hl: null }))).toEqual(['gl']);
    expect(ids(editorFields(ddg(), editorParamNames('duckduckgo', null)))).toEqual(['gl', 'df', 'kp']);
    // Closed lists of frost's own: well formed, no value twice, a "not set" first.
    expect(EDITOR_COUNTRIES.length).toBeGreaterThan(20);
    expect(EDITOR_COUNTRIES.every((option) => isEditorCountry(option.value))).toBe(true);
    expect(EDITOR_LANGUAGES.every((option) => isEditorLanguage(option.value))).toBe(true);
    expect(EDITOR_DDG_REGIONS.every((option) => isEditorRegion(option.value))).toBe(true);
    for (const list of [EDITOR_COUNTRIES, EDITOR_LANGUAGES, EDITOR_DDG_REGIONS]) expect(new Set(list.map((option) => option.value)).size).toBe(list.length);
    for (const field of [...SERP_EDITOR_FIELDS.google, ...SERP_EDITOR_FIELDS.bing, ...SERP_EDITOR_FIELDS.duckduckgo]) {
      if (field.kind !== 'host') expect(field.options[0]!.value, field.id).toBe('');
    }
    // The tab's own country or language is offered when it has a saved search's form; never otherwise.
    expect(values(editorFields(google({ gl: 'zw', hl: 'sw' }), GOOGLE_NAMES), 'gl')).toContain('zw');
    expect(values(editorFields(google({ gl: 'zw', hl: 'sw' }), GOOGLE_NAMES), 'hl')).toContain('sw');
    expect(values(editorFields(google({ gl: '419', hl: 'en_gb' }), GOOGLE_NAMES), 'gl')).not.toContain('419');
    expect(values(editorFields(google({ gl: '419', hl: 'en_gb' }), GOOGLE_NAMES), 'hl')).not.toContain('en_gb');
    expect(values(editorFields(ddg({ gl: 'xa-ar' }), editorParamNames('duckduckgo', null)), 'gl')).toContain('xa-ar');
    expect(values(editorFields(ddg({ gl: 'us' }), editorParamNames('duckduckgo', null)), 'gl')).not.toContain('us');
    // The view model: rows with stable test ids, the hint, the chosen value.
    const model = serpEditorModel(tabState(google(), 'https://www.google.com/search?q=green+tea&gl=de&hl=de'))!;
    const rows = editorFieldRows(model, model.initial);
    expect(rows.map((row) => row.testId)).toEqual(['serp-edit-field-host', 'serp-edit-field-gl', 'serp-edit-field-hl', 'serp-edit-field-tbs', 'serp-edit-field-num', 'serp-edit-field-safe', 'serp-edit-field-pws']);
    expect(rows.find((row) => row.id === 'num')!.hint).toBe(SERP_NUM_HINT);
    expect(rows.find((row) => row.id === 'gl')!.value).toBe('de');
    // Another engine takes the pack's names from main; none for a state that is no result page.
    expect(ids(serpEditorModel(tabState(other(), other().url, { query: 'q', gl: 'gl', hl: 'hl' }))!.fields)).toEqual(['gl', 'hl']);
    expect(serpEditorModel({ ...tabState(google(), ''), serp: { status: 'not-serp', tabId: 4, url: 'https://tea.example/' } })).toBeNull();
  });

  test('editor-starts-from-the-tabs-filters', () => {
    const params = google({ url: 'https://www.google.de/search?q=green+tea&gl=de&hl=de' });
    const page = 'https://www.google.de/search?q=green+tea&gl=de&hl=de&tbs=qdr:w&num=20&ei=abc';
    const state = editorStateOf(params, page, GOOGLE_NAMES);
    expect(state).toEqual({ host: 'www.google.de', gl: 'de', hl: 'de', tbs: 'qdr:w', num: '20', safe: '', pws: '' });
    // Changing the country keeps "past week" (and every other known filter).
    const url = editedSearchUrl(params, { ...state, gl: 'fr' }, GOOGLE_NAMES)!;
    expect(new URL(url).searchParams.get('gl')).toBe('fr');
    expect(serpFiltersOf(url, 'google')).toEqual({ num: '20', tbs: 'qdr:w' });
    expect(editorUnsupported(params, page, GOOGLE_NAMES)).toEqual([]);
    // A value the editor does not offer starts as not set, and is named as cleared.
    const custom = 'https://www.google.de/search?q=green+tea&tbs=cdr:1,cd_min:1/1/2020&safe=images';
    expect(editorStateOf(params, custom, GOOGLE_NAMES)).toMatchObject({ tbs: '', safe: '' });
    expect(editorUnsupported(params, custom, GOOGLE_NAMES)).toEqual(['Time', 'SafeSearch']);
    // An unlisted Google domain: none chosen until the user picks one.
    expect(editorStateOf(google({ url: 'https://www.google.nl/search?q=tea' }), 'https://www.google.nl/search?q=tea', GOOGLE_NAMES).host).toBe('');
    // DuckDuckGo: the region is the tab's `gl`, the time and SafeSearch its filters.
    const names = editorParamNames('duckduckgo', null);
    expect(editorStateOf(ddg(), 'https://duckduckgo.com/?q=tea&kl=de-de&df=w&kp=-2', names)).toEqual({ gl: 'de-de', df: 'w', kp: '-2' });
    // The view model starts from the state's own page URL and says what applying clears.
    const model = serpEditorModel(tabState(params, custom))!;
    expect(model.initial).toMatchObject({ host: 'www.google.de', gl: 'de', tbs: '' });
    expect(model.unsupported).toEqual(['Time', 'SafeSearch']);
    expect(unsupportedNote(model.unsupported)).toMatch(/Time, SafeSearch/);
    expect(unsupportedNote([])).toBeNull();
  });

  test('edited-url-keeps-path-and-allowed-host', () => {
    const params = google();
    const base: EditorState = { host: 'www.google.com', gl: 'de', hl: 'de', tbs: '', num: '', safe: '', pws: '' };
    for (const host of GOOGLE_EDITOR_HOSTS) {
      const url = new URL(editedSearchUrl(params, { ...base, host }, GOOGLE_NAMES)!);
      expect(url.origin).toBe(`https://${host}`);
      expect(url.pathname).toBe('/search');
    }
    // Only a listed domain, over https: (an http page is upgraded).
    for (const host of ['', 'evil.com', 'www.google.com.evil.com', 'google.com', 'www.google.nl', 'WWW.GOOGLE.COM']) expect(editedSearchUrl(params, { ...base, host }, GOOGLE_NAMES), host).toBeNull();
    expect(new URL(editedSearchUrl(google({ url: 'http://www.google.com/search?q=green+tea' }), base, GOOGLE_NAMES)!).protocol).toBe('https:');
    // Other engines keep their origin and path (DuckDuckGo's HTML pages included).
    expect(editedSearchUrl(bing(), { gl: 'fr', hl: 'fr' }, editorParamNames('bing', null))).toBe('https://www.bing.com/search?q=tea&cc=fr&setlang=fr');
    expect(editedSearchUrl(ddg({ url: 'https://html.duckduckgo.com/html/?q=tea&kl=de-de' }), { gl: 'fr-fr', df: 'w', kp: '' }, editorParamNames('duckduckgo', null))).toBe('https://html.duckduckgo.com/html/?q=tea&kl=fr-fr&df=w');
    expect(editedSearchUrl(other(), { gl: 'de' }, { query: 'q', gl: 'gl', hl: 'hl' })).toBe('http://search.frost-e2e.net/find?q=tea&gl=de');
    // Unknown parameters are dropped: only the query, the locale and the editor's filters.
    const url = new URL(editedSearchUrl(google({ url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' }), { ...base, safe: 'active' }, GOOGLE_NAMES)!);
    expect([...url.searchParams.keys()]).toEqual(['q', 'gl', 'hl', 'safe']);
    expect(url.hash).toBe('');
    // Names that are not plain parameter names, or clash, build nothing.
    expect(editedSearchUrl(other(), { gl: 'de' }, { query: 'q', gl: 'a&b', hl: null })).toBeNull();
    expect(editedSearchUrl(other(), { gl: 'de' }, { query: 'q', gl: 'q', hl: null })).toBeNull();
    expect(editedSearchUrl(other(), { gl: 'de' }, null)).toBeNull();
    // The view model: Apply's URL, or why there is none.
    const model = serpEditorModel(tabState(google({ url: 'https://www.google.nl/search?q=tea' }), 'https://www.google.nl/search?q=tea'))!;
    expect(editorApply(model, model.initial)).toEqual({ url: null, problem: 'Choose a Google domain.' });
    expect(editorApply(model, { ...model.initial, host: 'www.google.fr' }).url).toBe('https://www.google.fr/search?q=green%20tea&gl=de&hl=de');
  });

  test('edited-url-encodes-values', () => {
    const base: EditorState = { host: 'www.google.com', gl: '', hl: '', tbs: '', num: '', safe: '', pws: '' };
    // The query is the tab's own, encoded as `searchEngineUrl` encodes it.
    for (const query of ['green tea', 'a&b=c', 'tea #1', '100% tea', 'line\nbreak', '//evil.com/x', 'me@evil.com', 'a?b/c', 'lone \ud800 half']) {
      const built = editedSearchUrl(google({ query, gl: null, hl: null }), base, GOOGLE_NAMES)!;
      expect(built, query).toBe(searchEngineUrl('google', query));
      const url = new URL(built);
      expect(url.origin).toBe('https://www.google.com');
      expect(url.pathname).toBe('/search');
      expect([...url.searchParams.keys()], query).toEqual(['q']);
      expect(url.searchParams.get('q')).toBe(wellFormed(query));
      expect(url.hash).toBe('');
    }
    // A crafted state value is not in its field's list: nothing is built.
    const crafted: [string, string][] = [
      ['gl', 'de&tbs=qdr:y'],
      ['gl', 'de#x'],
      ['hl', 'en=1'],
      ['hl', 'en%26x'],
      ['tbs', 'qdr:w&num=100'],
      ['num', '10\n'],
      ['safe', 'off#'],
      ['pws', '0&q=evil'],
      ['host', 'www.google.com/@evil.com'],
      ['host', 'evil.com#www.google.com'],
      ['host', '//evil.com'],
      ['host', 'www.google.com@evil.com'],
    ];
    for (const [id, value] of crafted) expect(editedSearchUrl(google(), { ...base, [id]: value }, GOOGLE_NAMES), `${id}=${value}`).toBeNull();
    expect(editedSearchUrl(ddg(), { gl: 'de-de&kp=1', df: '', kp: '' }, editorParamNames('duckduckgo', null))).toBeNull();
    // Keys outside the engine's fields are ignored, never sent.
    const ignored = editedSearchUrl(bing(), { gl: 'de', hl: 'de', tbs: 'qdr:w', host: 'evil.com' } as EditorState, editorParamNames('bing', null))!;
    expect(ignored).toBe('https://www.bing.com/search?q=tea&cc=de&setlang=de');
    // A query past Phase 3's cap, or a blank one, builds nothing.
    expect(editedSearchUrl(google({ query: 'x'.repeat(600) }), base, GOOGLE_NAMES)).toBeNull();
    expect(editedSearchUrl(google({ query: ' ' }), base, GOOGLE_NAMES)).toBeNull();
  });

  test('edited-url-resets-page', () => {
    const third = google({ page: 3, offset: 20, url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de&start=20' });
    const url = new URL(editedSearchUrl(third, editorStateOf(third, third.url, GOOGLE_NAMES), GOOGLE_NAMES)!);
    expect(url.searchParams.has('start')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['q', 'gl', 'hl']);
    const bingThird = bing({ page: 3, offset: 21, url: 'https://www.bing.com/search?q=tea&cc=de&setlang=de&first=21' });
    expect(new URL(editedSearchUrl(bingThird, { gl: 'de', hl: 'de' }, editorParamNames('bing', null))!).searchParams.has('first')).toBe(false);
  });

  test('editor-keeps-the-pages-port', () => {
    // spec: specs/serp-panels.feature.md — editor-keeps-the-pages-port
    const names = { query: 'q', gl: 'gl', hl: 'hl' };
    // The canonical URL (Phase 3's `params.url`) has no port; the page's own URL has it.
    const served = serpEditorModel(tabState(other({ page: 3, offset: 20, url: 'http://search.frost-e2e.net/find?q=tea&start=20' }), 'http://search.frost-e2e.net:8123/find?q=tea&start=20&x=1', names))!;
    expect(editorApply(served, { gl: 'de', hl: 'de' }).url).toBe('http://search.frost-e2e.net:8123/find?q=tea&gl=de&hl=de');
    // The same page on its default port: unchanged.
    const plain = serpEditorModel(tabState(other(), 'http://search.frost-e2e.net/find?q=tea', names))!;
    expect(editorApply(plain, { gl: 'de', hl: '' }).url).toBe('http://search.frost-e2e.net/find?q=tea&gl=de');
    // A page URL of another host, scheme or path is not the search's: the canonical origin stays.
    for (const pageUrl of ['http://evil.com:8123/find?q=tea', 'https://search.frost-e2e.net:8123/find?q=tea', 'http://search.frost-e2e.net:8123/other?q=tea', 'not a url']) {
      const model = serpEditorModel(tabState(other(), pageUrl, names))!;
      expect(editorApply(model, { gl: 'de', hl: '' }).url, pageUrl).toBe('http://search.frost-e2e.net/find?q=tea&gl=de');
    }
    // Google: the chosen domain over https:, never the page's port.
    const google8443 = serpEditorModel(tabState(google({ url: 'https://www.google.com/search?q=green+tea&gl=de&hl=de' }), 'https://www.google.com:8443/search?q=green+tea&gl=de&hl=de'))!;
    expect(editorApply(google8443, { ...google8443.initial, host: 'www.google.fr' }).url).toBe('https://www.google.fr/search?q=green%20tea&gl=de&hl=de');
  });

  test('trackable-search-rules', () => {
    // An engine of SEARCH_ENGINES, its default address, page 1, no filters: the Phase 6 shape.
    expect(trackableSearch(google({ gl: 'de', hl: 'en', device: 'mobile' }), {})).toEqual({ engine: 'google', query: 'green tea', country: 'de', language: 'en', device: 'mobile' });
    expect(trackableSearch(google({ gl: null, hl: null }), {})).toEqual({ engine: 'google', query: 'green tea', country: null, language: null, device: 'desktop' });
    expect(trackableSearch(bing(), {})).toEqual({ engine: 'bing', query: 'tea', country: 'de', language: 'de', device: 'desktop' });
    // A DuckDuckGo region is its country and language (sent back as the same `kl`).
    const duck = trackableSearch(ddg({ gl: 'us-en' }), {})!;
    expect(duck).toEqual({ engine: 'duckduckgo', query: 'tea', country: 'us', language: 'en', device: 'desktop' });
    expect(searchLocaleFor(duck)).toEqual({ gl: 'us-en', hl: null });
    expect(trackableSearch(ddg({ gl: null }), {})).toMatchObject({ country: null, language: null });
    // The editor still offers "no region" (it is a region DuckDuckGo takes).
    expect(EDITOR_DDG_REGIONS.map((option) => option.value)).toContain(DDG_NO_REGION);
    // Otherwise none, with the reason.
    const cases: [SearchParams, Record<string, string> | null, string][] = [
      [other(), {}, 'engine'],
      [google({ url: 'https://www.google.de/search?q=green+tea' }), {}, 'address'],
      [google({ url: 'http://www.google.com/search?q=green+tea' }), {}, 'address'],
      [ddg({ url: 'https://html.duckduckgo.com/html/?q=tea' }), {}, 'address'],
      [google({ page: 2, offset: 10 }), {}, 'page'],
      [google(), { tbs: 'qdr:w' }, 'filters'],
      [google(), null, 'filters'],
      [google({ query: 'x'.repeat(201) }), {}, 'query'],
      [google({ query: 'tea‮' }), {}, 'query'],
      [google({ gl: 'usa' }), {}, 'locale'],
      [google({ hl: 'en_gb' }), {}, 'locale'],
      [ddg({ gl: 'us' }), {}, 'locale'],
      // DuckDuckGo's "no region" names no country and language.
      [ddg({ gl: DDG_NO_REGION }), {}, 'locale'],
    ];
    for (const [params, filters, reason] of cases) {
      expect(trackRefusalOf(params, filters), reason).toBe(reason);
      expect(trackableSearch(params, filters), reason).toBeNull();
    }
    // The view model: the search, or the reason in frost's words; projects to pick (not Unfiled).
    const ok = serpEditorModel(tabState(google(), 'https://www.google.com/search?q=green+tea&gl=de&hl=de&ei=x'))!;
    expect(trackView(ok)).toEqual({ search: { engine: 'google', query: 'green tea', country: 'de', language: 'de', device: 'desktop' }, reason: null });
    const filtered = serpEditorModel(tabState(google(), 'https://www.google.com/search?q=green+tea&gl=de&hl=de&tbs=qdr:w'))!;
    expect(trackView(filtered)).toEqual({ search: null, reason: TRACK_REFUSAL_MESSAGES.filters });
    const project = (id: string, name: string, unfiled = false) => ({ id, name, unfiled }) as ProjectSummary;
    expect(trackProjectChoices([project(UNFILED_PROJECT_ID, 'Unfiled', true), project('p1', 'Leaf'), project('p1', 'Leaf'), project('p2', 'Brew')]).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(trackAnswerText({ status: 'added', query: { id: 'q1' } })).toBe('Search saved to the project.');
    expect(trackAnswerText({ status: 'refused', reason: 'limit' })).toBe(PROJECT_REFUSAL_MESSAGES.limit);
    expect(trackAnswerText(null)).toBe('Something went wrong. Try again.');
  });

  test('editor-requests-reach-the-panel', () => {
    // The palette asks; the panel of that tab takes the request once.
    requestSerpEditor(4, 'track');
    expect(takeSerpEditorRequest(5)).toBeNull();
    expect(takeSerpEditorRequest(4)).toBe('track');
    expect(takeSerpEditorRequest(4)).toBeNull();
  });
});
