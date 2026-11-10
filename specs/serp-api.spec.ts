/**
 * Bring-your-own SERP API → `SerpSnapshot` (Phase 12 Task 3; plan `docs/plans/phase-12-big-bets.md`,
 * Decisions 3 (K-A1), 4 and 7, Global constraints "Untrusted text", Threat model "Hostile vendor
 * JSON", and the lead's legal-gate rulings in "As built"; Zod side `serp-api.schema.ts`; the client
 * `data-sources.spec.ts`). Plain values and pure functions (no Zod).
 *
 * - `checkSearchViaApi(search, provider)` (`apps/desktop/src/main/data-sources/serp-api.ts`) refuses
 *   a vendor whose legal gate is closed (`unavailable`, `LEGAL_GATE_NOTE`) before anything else,
 *   validates the search (`SerpApiRequestSchema`), builds its search parameters exactly as a saved
 *   search's (`searchParamsForUrl(searchUrlFor(search), device)` with the bundled selector pack, plus
 *   `location: { via: 'api', label }` when a location is given), builds the vendor's request from
 *   those validated fields only (`SERP_API_PROVIDERS`), sends it through Task 1's `dataApiRequest`,
 *   and has the SERP worker (job kind `api`, never main's thread) map the answer.
 * - **The mapping** (`serp-api-parse.ts`, in the worker): the size cap (`maxResponseBytes`) and the
 *   nesting cap (`maxDepth`) are checked on the text **before** `JSON.parse`; the JSON is validated
 *   with the vendor's schema (`serp-api.schema.ts`); each vendor result type goes through
 *   `SERP_API_TYPE_MAP` to a `SerpResultType` (an unmapped type is skipped and counted); the blocks,
 *   in the vendor's page order, form a `SerpRead` (`SerpReadSchema`) that the existing `analyseSerp`
 *   turns into the snapshot, so ranks, positions, composition and ownership derive exactly as for a
 *   tab. Any problem is `invalid-answer`, never a throw.
 * - **Organic positions equal the vendor's own rank field (K-A1).** The organic results, in page
 *   order, must carry the vendor's ranks 1, 2, … n (`SERP_API_ORGANIC_RANK_FIELD`); otherwise the
 *   answer is `invalid-answer`: frost never shows a position the vendor did not give. Each vendor
 *   below maps to a `ready` snapshot meeting this (`serp-api-maps-to-a-ready-snapshot`), so none is
 *   dropped from `SERP_API_PROVIDERS` under K-A1's mapping half; its legal half is the closed gate
 *   (`SERP_API_VENDOR_AVAILABLE`).
 * - **Page order.** DataForSEO answers one list of elements, each with `rank_absolute` (its place
 *   among all of the page's elements): blocks follow it. SerpApi and Serper answer one JSON key per
 *   section, which carries no order between sections: blocks follow the key order of
 *   `SERP_API_TYPE_MAP` (a fixed, documented order; SerpApi's ads go first, or last when their
 *   `block_position` is `bottom`). Within a section, items follow the vendor's rank field when it has
 *   one, else the array's order. So a keyed vendor's counts and ownership are exact and its feature
 *   slots follow that fixed order.
 * - **Empty and error answers** (a false "not ranking" point is worse than none): a snapshot, even
 *   `no-results`, needs the vendor's organic container (`SERP_API_ORGANIC_CONTAINER`): SerpApi's
 *   `organic_results` (or `search_information.organic_results_state` saying the page was empty),
 *   Serper's `organic`, DataForSEO's `items` array. SerpApi's `error` key or a
 *   `search_metadata.status` other than `Success`, a Serper body with `message` and no organic
 *   results, and a DataForSEO status other than 20000 are `vendor-error`; anything else without the
 *   container is `invalid-answer`.
 * - **Ads without a web link** (no absolute `http(s)` URL) are dropped and counted in `skipped`
 *   (an ad is never a ranking); an organic result without one still refuses the answer (K-A1).
 * - `packVersion` is the version of the selector pack whose engine definition built the search's
 *   canonical URL and parameters (the bundled pack, as saved searches are built today), never
 *   nullable (plan Decision 7).
 * - Nothing here stores anything: Task 4 writes the reading (`source = 'serp-api'`).
 *
 * Vendor response fields read (plan Q1; the public API references, read on 2026-11-10; fixtures are
 * synthetic, frost's own values, in `apps/desktop/src/main/serp/__tests__/fixtures/serp-api/`):
 * - SerpApi: https://serpapi.com/search-api (parameters `q`, `location`, `gl`, `hl`, `google_domain`,
 *   `device` = `desktop` | `tablet` | `mobile`); https://serpapi.com/organic-results
 *   (`organic_results[]`: `position`, 1-based, `title`, `link`); https://serpapi.com/google-ads
 *   (`ads[]`: `position`, `block_position`, `title`, `link`); https://serpapi.com/direct-answer-box-api
 *   (`answer_box` object: `title`, `link`); https://serpapi.com/ai-overview (`ai_overview` object,
 *   `references[]`: `title`, `link`); https://serpapi.com/related-questions (`related_questions[]`:
 *   `question`, `link`); https://serpapi.com/local-pack (`local_results` object, `places[]`:
 *   `position`, `title`, `links.website`); https://serpapi.com/inline-videos (`inline_videos[]`:
 *   `position`, `title`, `link`); https://serpapi.com/top-stories (`top_stories[]`: `title`,
 *   `link`; an object of arrays on mobile); https://serpapi.com/knowledge-graph (`knowledge_graph`
 *   object: `title`, `website`); https://serpapi.com/related-searches (`related_searches[]`:
 *   `query`, `link`).
 * - DataForSEO: https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ (request:
 *   `keyword`, `location_code` | `location_name`, `language_code`, `device` = `desktop` | `mobile`, `depth`; response:
 *   `status_code`, `tasks[].status_code` (20000 = ok), `tasks[].result[].items[]` with `type`,
 *   `rank_group` ("position within a group of elements with identical type values"),
 *   `rank_absolute` ("absolute position among all the elements in SERP"), `title`, `url`; nested
 *   `items[]` of `title` / `url` (`people_also_ask`, `video`, `top_stories`, `shopping`), `alt` /
 *   `url` (`images`), strings (`related_searches`), and `references[]` (`ai_overview`)). Its
 *   `position` field is a side (`left` / `right`), never read. Each place of a local pack is its own
 *   `local_pack` element: consecutive elements of one type are joined into one block, as a tab reads
 *   one pack.
 * - Serper: **unverified**. serper.dev carries no fetchable API reference (as Task 1 found); the
 *   landing page's sample outputs (https://serper.dev/, 2026-11-10) show `organic[]` (`position`,
 *   `title`, `link`, `snippet`), `peopleAlsoAsk[]` (`question`, `title`, `link`), `relatedSearches[]`
 *   (`query`) and `knowledgeGraph` (`title`); only those are read, plus a top-level `message` (an
 *   error answer, such as running out of credits). The request body (`q`, `gl`,
 *   `hl`, `location`) is the plan's; no device field is documented, so Serper takes desktop only.
 */
import type { DataSerpProvider } from './data-sources.spec';
import { DATA_API_LIMITS, DATA_SERP_PROVIDERS, LEGAL_GATE_NOTE } from './data-sources.spec';
import type { SearchEngineId } from './browser-polish.spec';
import { SEARCH_LOCATION_MAX_CHARS } from './serp-search-params.schema';
import type { SerpResultType } from './serp-selector-pack.spec';
import { SERP_READ_LIMITS, type SerpDevice } from './serp.spec';

/** The SERP vendors (`DATA_SERP_PROVIDERS`); each is offered only while its legal gate is open. */
export type SerpApiProvider = DataSerpProvider;

/**
 * How each vendor takes a search (all from validated fields only; main builds every request):
 * - `engines`: the engines it searches (`google` only in v1);
 * - `devices`: the devices it can ask for (any other is `unsupported`);
 * - `pageSize`: results per page (the vendors' default; frost asks for page 1 only);
 * - `request`: how `gl`, `hl`, the location and the device reach it (documentation of the builder).
 */
export interface SerpApiProviderInfo {
  readonly engines: readonly SearchEngineId[];
  readonly devices: readonly SerpDevice[];
  readonly pageSize: number;
  readonly request: { readonly gl: string; readonly hl: string; readonly location: string; readonly device: string };
}

/**
 * The SERP vendors frost supports (v1: SerpApi, DataForSEO and Serper; each gated by L4 through
 * `SERP_API_VENDOR_AVAILABLE`; no retention field: a vendor whose terms limit how long results may be
 * kept is left out, plan Decision 4).
 */
export const SERP_API_PROVIDERS: Readonly<Record<SerpApiProvider, SerpApiProviderInfo>> = {
  serpapi: {
    engines: ['google'],
    devices: ['desktop', 'mobile', 'tablet'],
    pageSize: 10,
    request: {
      gl: '`gl` query parameter (absent when the search has no country)',
      hl: '`hl` query parameter (absent when the search has no language)',
      location: '`location` query parameter, as typed (absent when none)',
      device: '`device` query parameter (`desktop`, `mobile`, `tablet`)',
    },
  },
  dataforseo: {
    engines: ['google'],
    devices: ['desktop', 'mobile'],
    pageSize: 10,
    request: {
      gl: '`location_code` from `DATAFORSEO_COUNTRY_LOCATION_CODES` when no location is given; a search with neither, or with a country not in the table, is `unsupported`',
      hl: '`language_code` (required: a search without a language is `unsupported`)',
      location: '`location_name`, as typed (DataForSEO’s own place names)',
      device: '`device` (`desktop`, `mobile`; a tablet is `unsupported`); `depth` is the page size',
    },
  },
  serper: {
    engines: ['google'],
    devices: ['desktop'],
    pageSize: 10,
    request: {
      gl: '`gl` in the JSON body (absent when none)',
      hl: '`hl` in the JSON body (absent when none)',
      location: '`location` in the JSON body, as typed (absent when none)',
      device: 'none documented: desktop only',
    },
  },
};

/** The vendors frost maps, in `DATA_SERP_PROVIDERS` order (none dropped under K-A1). */
export const SERP_API_PROVIDER_IDS: readonly SerpApiProvider[] = DATA_SERP_PROVIDERS;

/** Each vendor's own organic rank field, which the snapshot's organic positions equal (K-A1). */
export const SERP_API_ORGANIC_RANK_FIELD: Readonly<Record<SerpApiProvider, string>> = {
  serpapi: 'organic_results[].position',
  dataforseo: 'items[].rank_group (type organic)',
  serper: 'organic[].position',
};

/**
 * Vendor result type → frost's `SerpResultType`. SerpApi and Serper: a top-level JSON key, listed
 * in the page order frost uses for them (see the header); DataForSEO: an element's `type`. A type
 * not listed is skipped and counted (`skipped`), never guessed.
 */
export const SERP_API_TYPE_MAP: Readonly<Record<SerpApiProvider, Readonly<Record<string, SerpResultType>>>> = {
  serpapi: {
    ads: 'ad',
    ai_overview: 'ai-overview',
    answer_box: 'featured-snippet',
    knowledge_graph: 'knowledge-panel',
    local_results: 'local-pack',
    top_stories: 'top-stories',
    organic_results: 'organic',
    related_questions: 'people-also-ask',
    inline_videos: 'video',
    related_searches: 'related-searches',
  },
  dataforseo: {
    paid: 'ad',
    organic: 'organic',
    featured_snippet: 'featured-snippet',
    people_also_ask: 'people-also-ask',
    local_pack: 'local-pack',
    video: 'video',
    images: 'images',
    top_stories: 'top-stories',
    knowledge_graph: 'knowledge-panel',
    shopping: 'shopping',
    ai_overview: 'ai-overview',
    related_searches: 'related-searches',
  },
  serper: {
    knowledgeGraph: 'knowledge-panel',
    organic: 'organic',
    peopleAlsoAsk: 'people-also-ask',
    relatedSearches: 'related-searches',
  },
};

/**
 * Top-level keys of SerpApi's and Serper's answers that describe the request, not the page: neither
 * mapped nor counted as skipped. Any other key not in `SERP_API_TYPE_MAP` is a skipped result type.
 */
export const SERP_API_METADATA_KEYS: Readonly<Record<'serpapi' | 'serper', readonly string[]>> = {
  serpapi: ['search_metadata', 'search_parameters', 'search_information', 'pagination', 'serpapi_pagination', 'error'],
  serper: ['searchParameters', 'credits', 'message'],
};

/** Where each vendor's organic results live: present (even empty) for any snapshot (see the header). */
export const SERP_API_ORGANIC_CONTAINER: Readonly<Record<SerpApiProvider, string>> = {
  serpapi: 'organic_results, or search_information.organic_results_state matching SERPAPI_EMPTY_STATE',
  dataforseo: 'tasks[0].result[0].items (an array)',
  serper: 'organic',
};

/** SerpApi's `search_information.organic_results_state` for a page with no organic results (`Fully empty`). */
export const SERPAPI_EMPTY_STATE = /\bempty\b/i;

/** SerpApi's `search_metadata.status` for a search that ran. */
export const SERPAPI_STATUS_OK = 'Success';

/** DataForSEO's task status meaning "ok" (`tasks[].status_code`). */
export const DATAFORSEO_TASK_OK = 20_000;

export const SERP_API_LIMITS = {
  /** The answer's text, at most (bytes, UTF-8); checked before `JSON.parse` (the client's cap). */
  maxResponseBytes: DATA_API_LIMITS.maxResponseBytes,
  /** Nesting of arrays and objects in the answer, at most; checked on the text before `JSON.parse`. */
  maxDepth: 64,
  /** Entries in any array read (results, sections, nested items, DataForSEO elements), at most. */
  maxItems: 100,
  /** A string read (a title, a link, a type), at most (UTF-16 code units); a title is then cut to `SERP_READ_LIMITS.maxTitleChars`. */
  maxStringChars: 8_192,
  /** A location as typed (the search parameters' own cap). */
  maxLocationChars: SEARCH_LOCATION_MAX_CHARS,
  /** The results one snapshot holds (the reader's caps: more is `truncated`). */
  maxResults: SERP_READ_LIMITS.maxResults,
  maxBlocks: SERP_READ_LIMITS.maxBlocks,
  /**
   * The SERP worker's deadline for one `api` job (ms; its own analyzer instance, `setup.ts`): longer
   * than a tab's `SERP_ANALYSIS_TIMEOUT_MS`, since the request already spent the user's credit.
   */
  parseTimeoutMs: 10_000,
} as const;

/**
 * Why `checkSearchViaApi` answered no snapshot:
 * - `unavailable`: the vendor's legal gate is closed (`LEGAL_GATE_NOTE`); nothing was read or sent;
 * - `invalid-search`: the search does not fit `SerpApiRequestSchema`, or Phase 3 cannot read its URL;
 * - `unsupported`: the vendor cannot take this search (an engine other than its `engines`, a device
 *   not in its `devices`, or DataForSEO without a language, or without a country or a location);
 * - `request-failed`: the data API client refused or failed (`refusal`, `DATA_API_REFUSALS`; `status`
 *   for `http-error`);
 * - `vendor-error`: the vendor answered but said it could not run the search (SerpApi's `error` or
 *   `search_metadata.status`, a Serper `message` without results, DataForSEO's status);
 * - `invalid-answer`: the answer was too large, too deep, not JSON, did not fit the vendor's schema,
 *   had no organic container (`SERP_API_ORGANIC_CONTAINER`), its organic ranks were not 1 … n
 *   (K-A1), or the worker could not map it in time.
 */
export const SERP_API_OUTCOMES = ['unavailable', 'invalid-search', 'unsupported', 'request-failed', 'vendor-error', 'invalid-answer'] as const;
export type SerpApiOutcome = (typeof SERP_API_OUTCOMES)[number];

/** What each outcome says (never a key, a URL or the vendor's own text). `request-failed` uses the client's message. */
export const SERP_API_OUTCOME_MESSAGES: Readonly<Record<SerpApiOutcome, string>> = {
  unavailable: LEGAL_GATE_NOTE,
  'invalid-search': 'This search can’t be checked via a data API.',
  unsupported: 'This provider can’t run this search (its engine, device, country or language).',
  'request-failed': 'The data source could not be reached.',
  'vendor-error': 'The data source could not run this search.',
  'invalid-answer': 'The data source’s answer could not be read.',
};

/**
 * DataForSEO's `location_code` for each country (`gl`, two lowercase letters), pinned from DataForSEO's
 * documented Google SERP locations list (https://docs.dataforseo.com/v3/serp/google/locations/, its CSV
 * https://cdn.dataforseo.com/v3/locations/locations_serp_google_2026_11_02.csv, read on 2026-11-10):
 * every row of `location_type` `Country`, keyed by its `country_iso_code` (213 countries). A country
 * not listed, with no typed location, is `unsupported`. Updating it is a reviewed change to this table.
 */
export const DATAFORSEO_COUNTRY_LOCATION_CODES: Readonly<Record<string, number>> = {
  ad: 2020, ae: 2784, af: 2004, ag: 2028, al: 2008, am: 2051, ao: 2024, aq: 2010, ar: 2032, as: 2016, at: 2040, au: 2036,
  az: 2031, ba: 2070, bb: 2052, bd: 2050, be: 2056, bf: 2854, bg: 2100, bh: 2048, bi: 2108, bj: 2204, bn: 2096, bo: 2068,
  bq: 2535, br: 2076, bs: 2044, bt: 2064, bw: 2072, bz: 2084, ca: 2124, cc: 2166, cd: 2180, cf: 2140, cg: 2178, ch: 2756,
  ci: 2384, ck: 2184, cl: 2152, cm: 2120, cn: 2156, co: 2170, cr: 2188, cv: 2132, cw: 2531, cx: 2162, cy: 2196, cz: 2203,
  de: 2276, dj: 2262, dk: 2208, dm: 2212, do: 2214, dz: 2012, ec: 2218, ee: 2233, eg: 2818, er: 2232, es: 2724, et: 2231,
  fi: 2246, fj: 2242, fm: 2583, fr: 2250, ga: 2266, gb: 2826, gd: 2308, ge: 2268, gg: 2831, gh: 2288, gm: 2270, gn: 2324,
  gq: 2226, gr: 2300, gs: 2239, gt: 2320, gu: 2316, gw: 2624, gy: 2328, hm: 2334, hn: 2340, hr: 2191, ht: 2332, hu: 2348,
  id: 2360, ie: 2372, il: 2376, im: 2833, in: 2356, iq: 2368, is: 2352, it: 2380, je: 2832, jm: 2388, jo: 2400, jp: 2392,
  ke: 2404, kg: 2417, kh: 2116, ki: 2296, km: 2174, kn: 2659, kr: 2410, kw: 2414, kz: 2398, la: 2418, lb: 2422, lc: 2662,
  li: 2438, lk: 2144, lr: 2430, ls: 2426, lt: 2440, lu: 2442, lv: 2428, ly: 2434, ma: 2504, mc: 2492, md: 2498, me: 2499,
  mf: 2663, mg: 2450, mh: 2584, mk: 2807, ml: 2466, mm: 2104, mn: 2496, mp: 2580, mr: 2478, mt: 2470, mu: 2480, mv: 2462,
  mw: 2454, mx: 2484, my: 2458, mz: 2508, na: 2516, nc: 2540, ne: 2562, nf: 2574, ng: 2566, ni: 2558, nl: 2528, no: 2578,
  np: 2524, nr: 2520, nu: 2570, nz: 2554, om: 2512, pa: 2591, pe: 2604, pf: 2258, pg: 2598, ph: 2608, pk: 2586, pl: 2616,
  pm: 2666, pn: 2612, pt: 2620, pw: 2585, py: 2600, qa: 2634, ro: 2642, rs: 2688, rw: 2646, sa: 2682, sb: 2090, sc: 2690,
  se: 2752, sg: 2702, sh: 2654, si: 2705, sk: 2703, sl: 2694, sm: 2674, sn: 2686, so: 2706, sr: 2740, st: 2678, sv: 2222,
  sx: 2534, sz: 2748, td: 2148, tf: 2260, tg: 2768, th: 2764, tj: 2762, tk: 2772, tl: 2626, tm: 2795, tn: 2788, to: 2776,
  tr: 2792, tt: 2780, tv: 2798, tz: 2834, ua: 2804, ug: 2800, um: 2581, us: 2840, uy: 2858, uz: 2860, va: 2336, vc: 2670,
  ve: 2862, vn: 2704, vu: 2548, wf: 2876, ws: 2882, ye: 2887, za: 2710, zm: 2894, zw: 2716,
};

/** DataForSEO's `location_code` for the country `gl` (`DATAFORSEO_COUNTRY_LOCATION_CODES`), or `null`. */
export function dataForSeoLocationCode(gl: string): number | null {
  return typeof gl === 'string' && /^[a-z]{2}$/.test(gl) && Object.prototype.hasOwnProperty.call(DATAFORSEO_COUNTRY_LOCATION_CODES, gl) ? DATAFORSEO_COUNTRY_LOCATION_CODES[gl]! : null;
}
