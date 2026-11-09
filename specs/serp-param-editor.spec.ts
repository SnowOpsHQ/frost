/**
 * The SERP parameter editor and "Track this search" (Phase 10 Task 9; plan Decisions 4 and 12;
 * acceptance `serp-panels.feature.md`, Edit search). Zod-free, so the chrome renderer imports it; it
 * needs the WHATWG `URL` and `URLSearchParams` globals (main and the chrome renderer have them).
 *
 * ## What the editor does
 * On a result page, the SERP panel's editor reloads the tab's search with other settings: it builds a
 * URL (`editedSearchUrl`) and the chrome loads it through `browser.navigate` (the address bar's path,
 * with its browse guards). It changes nothing that is tracked: a capture of the page it lands on is
 * filed under that page's own search key (`rankings.spec.ts`, Decision 4).
 *
 * - **Fields** (`SERP_EDITOR_FIELDS`, per engine): Google's domain (`GOOGLE_EDITOR_HOSTS`, the bundled
 *   selector pack's Google hosts: the host changes, the path is kept), country, language, time
 *   (`tbs`), results per page (`num`, with `SERP_NUM_HINT`), SafeSearch (`safe`) and personalisation
 *   (`pws`); Bing's country and language (`cc`, `setlang`); DuckDuckGo's region (`kl`), time (`df`)
 *   and SafeSearch (`kp`); any other engine, its country and language only, by the selector pack's
 *   names (main gives them with the tab's SERP state, `SerpTabState.paramNames`).
 * - **Country and language are search parameters, the rest are filters.** `gl` and `hl` are Phase 3's
 *   `SearchParams` fields, sent by the pack's names (`editorParamNames`: `SEARCH_PARAM_URL_RULES` for
 *   the three engines of `SEARCH_ENGINES`). DuckDuckGo's region `kl` is the pack's `gl` name, so the
 *   region is `SearchParams.gl` (`us-en`), never a filter: `SERP_FILTER_PARAMS.duckduckgo` lists only
 *   `df` and `kp`, and the editor's region field edits `gl`. Every other field is a filter, a name of
 *   `SERP_FILTER_PARAMS` for that engine, read from the page's own URL by `serpFiltersOf`.
 * - **Closed values only.** Every field offers a fixed list (`'' ` = not set, the parameter left out).
 *   The country and language lists are frost's own common sets (`EDITOR_COUNTRIES`,
 *   `EDITOR_LANGUAGES`, `EDITOR_DDG_REGIONS`); the tab's own value is offered too when it has the
 *   form a saved search takes (a country `^[a-z]{2}$`, a language as `SavedSearchInputSchema`, a
 *   DuckDuckGo region `<country>-<language>` of those forms), so editing another field never clears
 *   it. Nothing typed ever reaches the URL: the only text is the tab's own query, re-encoded.
 * - **It starts from the tab** (`editorStateOf`): its `gl` and `hl`, Google's host, and the filters on
 *   the page's current URL, so changing the country of a "past week" page keeps "past week". A filter
 *   value the editor does not offer (a custom date range) starts as not set, and
 *   `editorUnsupported` names it so the panel can say applying clears it.
 * - **The URL** (`editedSearchUrl`): the scheme, host and path of the tab's canonical URL
 *   (`params.url`; Google: `https:` and a host of `GOOGLE_EDITOR_HOSTS` only), then the query (the
 *   tab's own, as `searchEngineUrl` encodes it: lone surrogates as U+FFFD, `encodeURIComponent`), the
 *   country, the language and every filter set, in field order, each name and value
 *   `encodeURIComponent`-encoded. No page or offset parameter (page 1), no fragment, no user info,
 *   no parameter the editor does not know (the engine's session and tracking parameters are
 *   dropped, as Phase 3's canonical URL drops them). `null` when a value is not one the field offers,
 *   a name is not a plain parameter name, the URL is longer than `SERP_PARAM_LIMITS.maxUrlChars`, or
 *   the built URL is not the allowed origin with the same path and exactly the parameters meant.
 *
 * ## Track this search (Decision 12)
 * `trackableSearch(params, filters)` is the tab's search as a saved search (`SavedSearchInput`, the
 * Phase 6 shape `projects.addSearch` takes), or `null` (`trackRefusalOf` says why,
 * `TRACK_REFUSAL_MESSAGES`): only an engine of `SEARCH_ENGINES`, on its default address (the host
 * and path of its `SEARCH_ENGINES` template: `www.google.com/search`, not `google.de`), page 1, no
 * filters, a query a saved search takes, and a country and language `searchLocaleFor` sends back as
 * the same `gl` and `hl` (DuckDuckGo's "no region", `DDG_NO_REGION`, is not a country and language,
 * so it is refused as `locale`). Anything else is tracked by capturing it into a project (Decision 5).
 */
import { isSearchEngineId, searchEngine, wellFormed, type SearchEngineId } from './browser-polish.spec';
import { PROJECT_QUERY_MAX_CHARS } from './capture-db.spec';
import { PRINTABLE_TEXT, QUERY_FIELD_MAX_CHARS, SEARCH_PARAM_URL_RULES, searchLocaleFor, type SavedSearchInput } from './projects.spec';
import { SERP_FILTER_PARAMS, type SearchParamsShape, type SerpFilters } from './rankings.spec';
import { searchHostOf, serpFiltersOf } from './rankings-url.spec';
import { SERP_DEVICES, SERP_PARAM_LIMITS } from './serp.spec';

// ---- Value sets ----------------------------------------------------------------------------------

/** One choice of a field: the parameter's value (`''`: left out) and frost's label for it. */
export interface EditorOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Google's domains the editor offers: exactly the bundled selector pack's Google `hosts`
 * (`apps/desktop/src/main/serp/packs/serp-selectors.json`; `edited-url-reads-back` checks they agree),
 * so every edited URL is one Phase 3 reads.
 */
export const GOOGLE_EDITOR_HOSTS = [
  'www.google.com',
  'www.google.co.uk',
  'www.google.ca',
  'www.google.com.au',
  'www.google.de',
  'www.google.fr',
  'www.google.es',
  'www.google.it',
  'www.google.co.in',
  'www.google.com.br',
  'www.google.co.jp',
] as const;

/** A country value: two lowercase letters (as `SavedSearchInputSchema.country`). */
export const EDITOR_COUNTRY_PATTERN = /^[a-z]{2}$/;
/** A language value: a lowercase BCP 47-style tag (as `SavedSearchInputSchema.language`), at most `QUERY_FIELD_MAX_CHARS.language`. */
export const EDITOR_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/** Whether `value` is a country value (`EDITOR_COUNTRY_PATTERN`). */
export const isEditorCountry = (value: unknown): value is string => typeof value === 'string' && EDITOR_COUNTRY_PATTERN.test(value);
/** Whether `value` is a language value (`EDITOR_LANGUAGE_PATTERN`, bounded). */
export const isEditorLanguage = (value: unknown): value is string => typeof value === 'string' && value.length <= QUERY_FIELD_MAX_CHARS.language && EDITOR_LANGUAGE_PATTERN.test(value);
/** Whether `value` is a DuckDuckGo region: `<country>-<language>` of those forms (the form `searchLocaleFor` sends). */
export function isEditorRegion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const dash = value.indexOf('-');
  return dash > 0 && isEditorCountry(value.slice(0, dash)) && isEditorLanguage(value.slice(dash + 1));
}

/** frost's own list of common countries (ISO 3166-1 alpha-2, lowercase), for `gl` / `cc`. */
export const EDITOR_COUNTRIES: readonly EditorOption[] = (
  [
    ['ae', 'United Arab Emirates'],
    ['ar', 'Argentina'],
    ['at', 'Austria'],
    ['au', 'Australia'],
    ['be', 'Belgium'],
    ['br', 'Brazil'],
    ['ca', 'Canada'],
    ['ch', 'Switzerland'],
    ['cl', 'Chile'],
    ['co', 'Colombia'],
    ['cz', 'Czechia'],
    ['de', 'Germany'],
    ['dk', 'Denmark'],
    ['eg', 'Egypt'],
    ['es', 'Spain'],
    ['fi', 'Finland'],
    ['fr', 'France'],
    ['gb', 'United Kingdom'],
    ['gr', 'Greece'],
    ['hk', 'Hong Kong'],
    ['hu', 'Hungary'],
    ['id', 'Indonesia'],
    ['ie', 'Ireland'],
    ['il', 'Israel'],
    ['in', 'India'],
    ['it', 'Italy'],
    ['jp', 'Japan'],
    ['kr', 'South Korea'],
    ['mx', 'Mexico'],
    ['my', 'Malaysia'],
    ['ng', 'Nigeria'],
    ['nl', 'Netherlands'],
    ['no', 'Norway'],
    ['nz', 'New Zealand'],
    ['ph', 'Philippines'],
    ['pl', 'Poland'],
    ['pt', 'Portugal'],
    ['ro', 'Romania'],
    ['sa', 'Saudi Arabia'],
    ['se', 'Sweden'],
    ['sg', 'Singapore'],
    ['th', 'Thailand'],
    ['tr', 'Türkiye'],
    ['tw', 'Taiwan'],
    ['ua', 'Ukraine'],
    ['us', 'United States'],
    ['vn', 'Vietnam'],
    ['za', 'South Africa'],
  ] as [string, string][]
).map(([value, label]) => ({ value, label: `${label} (${value.toUpperCase()})` }));

/** frost's own list of common interface languages (lowercase tags), for `hl` / `setlang`. */
export const EDITOR_LANGUAGES: readonly EditorOption[] = (
  [
    ['ar', 'Arabic'],
    ['cs', 'Czech'],
    ['da', 'Danish'],
    ['de', 'German'],
    ['el', 'Greek'],
    ['en', 'English'],
    ['en-gb', 'English (UK)'],
    ['es', 'Spanish'],
    ['es-419', 'Spanish (Latin America)'],
    ['fi', 'Finnish'],
    ['fr', 'French'],
    ['he', 'Hebrew'],
    ['hi', 'Hindi'],
    ['hu', 'Hungarian'],
    ['id', 'Indonesian'],
    ['it', 'Italian'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['ms', 'Malay'],
    ['nl', 'Dutch'],
    ['no', 'Norwegian'],
    ['pl', 'Polish'],
    ['pt', 'Portuguese'],
    ['pt-br', 'Portuguese (Brazil)'],
    ['ro', 'Romanian'],
    ['ru', 'Russian'],
    ['sv', 'Swedish'],
    ['th', 'Thai'],
    ['tr', 'Turkish'],
    ['uk', 'Ukrainian'],
    ['vi', 'Vietnamese'],
    ['zh-cn', 'Chinese (Simplified)'],
    ['zh-tw', 'Chinese (Traditional)'],
  ] as [string, string][]
).map(([value, label]) => ({ value, label: `${label} (${value})` }));

/**
 * DuckDuckGo's "no region" value of `kl`: the editor offers it, but it names no country and language,
 * so a search with it is never a saved search (`trackRefusalOf`: `locale`).
 */
export const DDG_NO_REGION = 'wt-wt';

/** frost's own list of common DuckDuckGo regions (`kl` = `<country>-<language>`, as `searchLocaleFor` sends it). */
export const EDITOR_DDG_REGIONS: readonly EditorOption[] = (
  [
    ['ar-es', 'Argentina'],
    ['au-en', 'Australia'],
    ['at-de', 'Austria'],
    ['be-fr', 'Belgium (French)'],
    ['be-nl', 'Belgium (Dutch)'],
    ['br-pt', 'Brazil'],
    ['ca-en', 'Canada (English)'],
    ['ca-fr', 'Canada (French)'],
    ['ch-de', 'Switzerland (German)'],
    ['ch-fr', 'Switzerland (French)'],
    ['de-de', 'Germany'],
    ['dk-da', 'Denmark'],
    ['es-es', 'Spain'],
    ['fi-fi', 'Finland'],
    ['fr-fr', 'France'],
    ['ie-en', 'Ireland'],
    ['in-en', 'India'],
    ['it-it', 'Italy'],
    ['jp-jp', 'Japan'],
    ['mx-es', 'Mexico'],
    ['nl-nl', 'Netherlands'],
    ['no-no', 'Norway'],
    ['nz-en', 'New Zealand'],
    ['pl-pl', 'Poland'],
    ['pt-pt', 'Portugal'],
    ['se-sv', 'Sweden'],
    ['uk-en', 'United Kingdom'],
    ['us-en', 'United States'],
    [DDG_NO_REGION, 'No region'],
  ] as [string, string][]
).map(([value, label]) => ({ value, label }));

/** What `num` says beside its choices (plan open question 2: not verified on a real profile). */
export const SERP_NUM_HINT = 'Google may ignore this and show its usual number of results.';

// ---- Fields --------------------------------------------------------------------------------------

/**
 * A field's id: `host` (Google's domain), `gl` / `hl` (the search parameters, sent by the pack's
 * names), or a filter's parameter name (`SERP_FILTER_PARAMS`).
 */
export type EditorFieldId = 'host' | 'gl' | 'hl' | 'tbs' | 'num' | 'safe' | 'pws' | 'df' | 'kp';
/** `host`: the URL's host; `locale`: a `SearchParams` field (`gl` / `hl`); `filter`: a filter parameter. */
export type EditorFieldKind = 'host' | 'locale' | 'filter';

export interface EditorField {
  readonly id: EditorFieldId;
  readonly kind: EditorFieldKind;
  readonly label: string;
  /** The closed set, in menu order; `''` = the parameter left out (absent for `host`: a domain is always set). */
  readonly options: readonly EditorOption[];
  /** A note shown beside the choices (`SERP_NUM_HINT`). */
  readonly hint?: string;
}

const NOT_SET = (label: string): EditorOption => ({ value: '', label });
const options = (pairs: readonly (readonly [string, string])[]): EditorOption[] => pairs.map(([value, label]) => ({ value, label }));

const COUNTRY: EditorField = { id: 'gl', kind: 'locale', label: 'Country', options: [NOT_SET('Not set'), ...EDITOR_COUNTRIES] };
const LANGUAGE: EditorField = { id: 'hl', kind: 'locale', label: 'Language', options: [NOT_SET('Not set'), ...EDITOR_LANGUAGES] };

/** The editor's fields per engine (`other`: an engine outside `SEARCH_ENGINES`: country and language only, by the pack's names). */
export const SERP_EDITOR_FIELDS: Readonly<Record<SearchEngineId | 'other', readonly EditorField[]>> = {
  google: [
    { id: 'host', kind: 'host', label: 'Domain', options: GOOGLE_EDITOR_HOSTS.map((host) => ({ value: host, label: host.replace(/^www\./, '') })) },
    COUNTRY,
    LANGUAGE,
    {
      id: 'tbs',
      kind: 'filter',
      label: 'Time',
      options: options([
        ['', 'Any time'],
        ['qdr:h', 'Past hour'],
        ['qdr:d', 'Past day'],
        ['qdr:w', 'Past week'],
        ['qdr:m', 'Past month'],
        ['qdr:y', 'Past year'],
      ]),
    },
    {
      id: 'num',
      kind: 'filter',
      label: 'Results per page',
      options: options([
        ['', 'Engine default'],
        ['10', '10'],
        ['20', '20'],
        ['50', '50'],
        ['100', '100'],
      ]),
      hint: SERP_NUM_HINT,
    },
    {
      id: 'safe',
      kind: 'filter',
      label: 'SafeSearch',
      options: options([
        ['', 'Engine default'],
        ['active', 'Filter explicit results'],
        ['off', 'Off'],
      ]),
    },
    {
      id: 'pws',
      kind: 'filter',
      label: 'Personalised results',
      options: options([
        ['', 'Engine default'],
        ['0', 'Off'],
      ]),
    },
  ],
  bing: [COUNTRY, LANGUAGE],
  duckduckgo: [
    { id: 'gl', kind: 'locale', label: 'Region', options: [NOT_SET('Not set'), ...EDITOR_DDG_REGIONS] },
    {
      id: 'df',
      kind: 'filter',
      label: 'Time',
      options: options([
        ['', 'Any time'],
        ['d', 'Past day'],
        ['w', 'Past week'],
        ['m', 'Past month'],
        ['y', 'Past year'],
      ]),
    },
    {
      id: 'kp',
      kind: 'filter',
      label: 'SafeSearch',
      options: options([
        ['', 'Engine default'],
        ['1', 'Strict'],
        ['-2', 'Off'],
      ]),
    },
  ],
  other: [COUNTRY, LANGUAGE],
};

// ---- Parameter names -----------------------------------------------------------------------------

/** The URL parameter names of the query, the country and the language (`null`: the engine has none). */
export interface EditorParamNames {
  readonly query: string;
  readonly gl: string | null;
  readonly hl: string | null;
}

/** A plain parameter name, as the selector pack takes one (`serp-selector-pack.schema.ts`). */
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,32}$/;

/** The query parameter of an engine's `SEARCH_ENGINES` template (the one holding `{q}`). */
function templateQueryName(engine: SearchEngineId): string {
  const template = new URL(searchEngine(engine).template);
  for (const [name, value] of template.searchParams) if (value === '{q}') return name;
  return 'q';
}

/**
 * The names `editedSearchUrl` sends for `engine`: `SEARCH_PARAM_URL_RULES` for an engine of
 * `SEARCH_ENGINES` (DuckDuckGo: its region `kl` as `gl`, no `hl`), else the selector pack's names main
 * gave with the tab's state (`packNames`; `null` without them).
 */
export function editorParamNames(engine: string, packNames: EditorParamNames | null | undefined): EditorParamNames | null {
  if (isSearchEngineId(engine)) {
    const rule: (typeof SEARCH_PARAM_URL_RULES)[SearchEngineId] = SEARCH_PARAM_URL_RULES[engine];
    return { query: templateQueryName(engine), gl: rule.gl, hl: rule.kind === 'separate' ? rule.hl : null };
  }
  return packNames ?? null;
}

/** `names` when every name is a plain parameter name and no two (nor a filter's) are the same; else `null`. */
function checkedNames(engine: string, names: EditorParamNames | null): EditorParamNames | null {
  if (names === null || typeof names !== 'object') return null;
  const list = [names.query, names.gl, names.hl].filter((name): name is string => name !== null);
  if (!list.every((name) => typeof name === 'string' && PARAM_NAME.test(name))) return null;
  const filters: readonly string[] = isSearchEngineId(engine) ? SERP_FILTER_PARAMS[engine] : [];
  const all = [...list, ...filters];
  return new Set(all).size === all.length ? names : null;
}

// ---- The fields of a tab -------------------------------------------------------------------------

/** The editor's state: each field's chosen value (`''`: not set), by field id. */
export type EditorState = Readonly<Partial<Record<EditorFieldId, string>>>;

/** The field set of `engine` (`other` for an engine outside `SEARCH_ENGINES`). */
const fieldSetOf = (engine: string): readonly EditorField[] => SERP_EDITOR_FIELDS[isSearchEngineId(engine) ? engine : 'other'];

/** Whether `value` has the form of the tab's own `gl` / `hl` for `engine`'s field `id`. */
function fitsLocale(engine: string, id: 'gl' | 'hl', value: string): boolean {
  if (engine === 'duckduckgo') return id === 'gl' && isEditorRegion(value);
  return id === 'gl' ? isEditorCountry(value) : isEditorLanguage(value);
}

/**
 * The fields the editor shows for the tab (`names`: `editorParamNames`): the engine's set, without a
 * country or language the engine has no name for; a country or language field also offers the tab's
 * own value when it is not listed and has the form a saved search takes (labelled as this page's).
 */
export function editorFields(params: SearchParamsShape, names: EditorParamNames | null): EditorField[] {
  return fieldSetOf(params.engine)
    .filter((field) => field.kind !== 'locale' || (field.id === 'gl' ? names?.gl : names?.hl) != null)
    .map((field) => {
      if (field.kind !== 'locale') return field;
      const own = field.id === 'gl' ? params.gl : params.hl;
      if (own === null || own === '' || field.options.some((option) => option.value === own) || !fitsLocale(params.engine, field.id as 'gl' | 'hl', own)) return field;
      return { ...field, options: [...field.options, { value: own, label: `${own} (this page)` }] };
    });
}

/** The value of field `id` of the tab: its host, `gl`, `hl`, or the page's filter. */
function tabValue(field: EditorField, params: SearchParamsShape, filters: SerpFilters): string {
  if (field.kind === 'host') return searchHostOf(params.url) ?? '';
  if (field.kind === 'locale') return (field.id === 'gl' ? params.gl : params.hl) ?? '';
  return filters[field.id] ?? '';
}

/**
 * The editor's starting state for the tab (`pageUrl`: the page's own URL, whose filters
 * `serpFiltersOf` reads; `names`: as `editorFields` takes them): each field's tab value when the field
 * offers it, else `''` (Google's domain: `''` until one of `GOOGLE_EDITOR_HOSTS` is chosen).
 */
export function editorStateOf(params: SearchParamsShape, pageUrl: string, names: EditorParamNames | null = editorParamNames(params.engine, null)): EditorState {
  const filters = serpFiltersOf(pageUrl, params.engine) ?? {};
  const state: Partial<Record<EditorFieldId, string>> = {};
  for (const field of editorFields(params, names)) {
    const value = tabValue(field, params, filters);
    state[field.id] = field.options.some((option) => option.value === value) ? value : '';
  }
  return state;
}

/**
 * The labels of the fields whose value on the tab the editor does not offer (a custom date range, an
 * unlisted domain): applying leaves them out. Empty when there is none.
 */
export function editorUnsupported(params: SearchParamsShape, pageUrl: string, names: EditorParamNames | null = editorParamNames(params.engine, null)): string[] {
  const filters = serpFiltersOf(pageUrl, params.engine) ?? {};
  return editorFields(params, names)
    .filter((field) => {
      const value = tabValue(field, params, filters);
      return value !== '' && !field.options.some((option) => option.value === value);
    })
    .map((field) => field.label);
}

// ---- The edited URL ------------------------------------------------------------------------------

/** The `https:` origin of a Google domain the editor offers. */
const GOOGLE_ORIGINS: ReadonlySet<string> = new Set(GOOGLE_EDITOR_HOSTS.map((host) => `https://${host}`));

/**
 * The URL that loads the tab's search with `state`'s settings (see the header), or `null`. Never
 * throws. `names`: `editorParamNames(params.engine, …)`.
 */
export function editedSearchUrl(params: SearchParamsShape, state: EditorState, names: EditorParamNames | null): string | null {
  try {
    if (typeof params?.url !== 'string' || typeof params.query !== 'string' || typeof params.engine !== 'string') return null;
    const query = params.query;
    if (query.trim() === '' || query.length > SERP_PARAM_LIMITS.maxQueryChars) return null;
    const checked = checkedNames(params.engine, names);
    if (checked === null) return null;
    const source = new URL(params.url);
    if (source.protocol !== 'https:' && source.protocol !== 'http:') return null;
    const fields = editorFields(params, checked);
    const valueOf = (field: EditorField): string | null => {
      const value = state[field.id] ?? '';
      return typeof value === 'string' && field.options.some((option) => option.value === value) ? value : null;
    };
    // The origin: Google's chosen domain over `https:`, else the tab's own.
    let origin = source.origin;
    const hostField = fields.find((field) => field.kind === 'host');
    if (hostField !== undefined) {
      const host = valueOf(hostField);
      if (host === null || host === '') return null;
      origin = `https://${host}`;
      if (!GOOGLE_ORIGINS.has(origin)) return null;
    }
    // The parameters: the query, then each field set, in field order.
    const entries: [string, string][] = [[checked.query, wellFormed(query)]];
    for (const field of fields) {
      if (field.kind === 'host') continue;
      const value = valueOf(field);
      if (value === null) return null;
      if (value === '') continue;
      const name = field.kind === 'locale' ? (field.id === 'gl' ? checked.gl : checked.hl) : field.id;
      if (name === null) return null;
      entries.push([name, value]);
    }
    const out = new URL(origin);
    out.pathname = source.pathname;
    out.search = entries.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
    // What was built must be exactly what was meant: the origin, the same path, these parameters.
    if (out.origin !== origin || out.pathname !== source.pathname || out.username !== '' || out.password !== '' || out.hash !== '') return null;
    const built = [...out.searchParams];
    if (built.length !== entries.length || built.some(([name, value], index) => name !== entries[index]![0] || value !== entries[index]![1])) return null;
    return out.href.length <= SERP_PARAM_LIMITS.maxUrlChars ? out.href : null;
  } catch {
    return null;
  }
}

// ---- Track this search ---------------------------------------------------------------------------

/**
 * Why the tab's search cannot be a saved search: `engine` (not one of `SEARCH_ENGINES`), `address`
 * (not the engine's default host and path), `page` (not page 1), `filters` (the page has filters),
 * `query` (a query a saved search does not take), `locale` (a country or language a saved search
 * cannot send back as the same `gl` and `hl`).
 */
export const TRACK_REFUSALS = ['engine', 'address', 'page', 'filters', 'query', 'locale'] as const;
export type TrackRefusal = (typeof TRACK_REFUSALS)[number];

export const TRACK_REFUSAL_MESSAGES: Readonly<Record<TrackRefusal, string>> = {
  engine: 'Saved searches use Google, Bing or DuckDuckGo. Capture this page into a project to track it.',
  address: 'Saved searches use the engine’s main address. Capture this page into a project to track it.',
  page: 'Saved searches start on page 1. Go back to the first page, or capture this one into a project.',
  filters: 'This search has filters (time, SafeSearch, results per page…). Saved searches have none: capture this page into a project to track it.',
  query: `A saved search takes a query of up to ${PROJECT_QUERY_MAX_CHARS} characters. Capture this page into a project to track it.`,
  locale: 'Saved searches take a two-letter country and a short language code. Capture this page into a project to track it.',
};


/** The country and language a saved search would need to send `params`' `gl` and `hl` back (`null`: none). */
function savedLocaleOf(engine: SearchEngineId, gl: string | null, hl: string | null): { country: string | null; language: string | null } | null {
  if (SEARCH_PARAM_URL_RULES[engine].kind === 'region') {
    if (hl !== null) return null;
    if (gl === null) return { country: null, language: null };
    if (gl === DDG_NO_REGION) return null;
    const dash = gl.indexOf('-');
    return dash > 0 ? { country: gl.slice(0, dash), language: gl.slice(dash + 1) } : null;
  }
  return { country: gl, language: hl };
}

/** Why `params` (with the page's `filters`; `null`: too many to record) is not trackable as a saved search, or `null` when it is. */
export function trackRefusalOf(params: SearchParamsShape, filters: SerpFilters | null): TrackRefusal | null {
  if (!isSearchEngineId(params.engine)) return 'engine';
  const engine = params.engine;
  const template = new URL(searchEngine(engine).template);
  let page: URL;
  try {
    page = new URL(params.url);
  } catch {
    return 'address';
  }
  if (page.origin !== template.origin || page.pathname !== template.pathname) return 'address';
  if (params.page !== 1) return 'page';
  if (filters === null || Object.keys(filters).length > 0) return 'filters';
  const query = params.query;
  if (typeof query !== 'string' || query === '' || query !== query.trim() || query.length > PROJECT_QUERY_MAX_CHARS || !PRINTABLE_TEXT.test(query)) return 'query';
  const locale = savedLocaleOf(engine, params.gl, params.hl);
  if (locale === null) return 'locale';
  if ((locale.country !== null && !isEditorCountry(locale.country)) || (locale.language !== null && !isEditorLanguage(locale.language))) return 'locale';
  const sent = searchLocaleFor({ engine, ...locale });
  if (sent.gl !== params.gl || sent.hl !== params.hl) return 'locale';
  return null;
}

/** The tab's search as a saved search (`projects.addSearch`), or `null` (`trackRefusalOf` says why). */
export function trackableSearch(params: SearchParamsShape, filters: SerpFilters | null): SavedSearchInput | null {
  if (trackRefusalOf(params, filters) !== null || !(SERP_DEVICES as readonly string[]).includes(params.device)) return null;
  const engine = params.engine as SearchEngineId;
  const locale = savedLocaleOf(engine, params.gl, params.hl)!;
  return { engine, query: params.query, country: locale.country, language: locale.language, device: params.device };
}
