/**
 * Projects (Phase 6 Task 6; acceptance `projects.feature.md`; storage is the `ci_projects`,
 * `ci_project_pages` and `ci_project_queries` tables of `capture-db.spec.ts`, whose caps
 * `MAX_PROJECTS`, `MAX_PROJECT_PAGES`, `MAX_PROJECT_QUERIES`, `PROJECT_NAME_MAX_CHARS` and
 * `PROJECT_QUERY_MAX_CHARS` hold here too). Plain values and types with no Zod, so the chrome renderer
 * can use them; the Zod schemas of the `projects.*` inputs and answers are `projects.schema.ts`, each
 * `satisfies` a type here.
 *
 * A project is a named list of pages and search queries. "Capture now" visits each of them in a tab
 * of its own and captures it into the project (`source: 'project'`), one run at a time, app-wide.
 * A query (a saved search) is what the form describes (`SavedSearchInput`): main builds its search
 * URL (`searchUrlFor`: the engine's own address from `SEARCH_ENGINES` plus the selector pack's
 * country and language parameters, `SEARCH_PARAM_URL_RULES`), reads that URL as Phase 3 reads a
 * result page (`matchSerp` with the bundled selector pack), and stores those search parameters
 * (`serp-search-params.schema.ts`). A run visits the stored parameters' canonical `url`.
 */
import { searchEngine, searchEngineUrl, wellFormed, type SearchEngineId } from './browser-polish.spec';
import type { CaptureRefusal } from './changes.spec';
import { MAX_PROJECT_QUERIES, PROJECT_QUERY_MAX_CHARS, type RetentionMode, type ScreenshotKind } from './capture-db.spec';
import { isIpLiteral, isPublicHost } from './private-address.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from './render-profile.spec';
import type { SearchParams } from './serp-search-params.schema';
import { SERP_DEVICE_LABELS, SERP_PARAM_LIMITS, type SerpDevice } from './serp.spec';
import { DOMAIN_MAX_CHARS, MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, TAG_MAX_CHARS } from './workspace-db.spec';

// ---- The capture run ---------------------------------------------------------------------------

/**
 * How long a run's search target waits for Phase 3's reading of its landed result page (active time):
 * Phase 3's read timeout (2 s), its analysis (2 s) and its in-page debounce, with margin (plan
 * Decision 10; `rankings.spec.ts`, `SERP_RUN_VERDICTS`). Until Phase 10 Task 8 the target is captured
 * after the wait whatever the verdict, as Phase 6 captured it.
 */
export const SERP_SETTLE_WAIT_MS = 8_000;

/**
 * Limits of a capture run:
 * - `maxRunTargets`: the most targets one run visits, all pages first, then queries (a project can
 *   hold more: the rest are `omitted`, and the run says so);
 * - `targetActiveTimeoutMs`: how long one target may take, counting only time while the run's tab is
 *   the active one (from one look at the tab to the next, in front at both; time inside a capture or
 *   a screenshot counts the same way, an approximation); past it the target is `timed-out` and the
 *   run moves on;
 * - `captureRetryMs`: how often the run looks at its tab, and asks again while a capture answers
 *   `no-audit` or `busy` (the page is still loading, or its audit is not settled yet);
 * - `runStateWatchTimeoutMs`: how long one `projects.runState` long-poll waits for a change (the
 *   same as `browser.watch`'s `WATCH_TIMEOUT_MS`);
 * - `maxPendingRunWatches`: at most this many `runState` polls wait at once; one more answers the
 *   oldest early with the current state;
 * - `serpSettleWaitMs`: how long a search target waits, once it has landed, while Phase 3's SERP
 *   reading of the page is still `pending` (`SERP_SETTLE_WAIT_MS`); this wait counts toward the
 *   target's `targetActiveTimeoutMs`.
 */
export const PROJECT_RUN_LIMITS = {
  maxRunTargets: 70,
  targetActiveTimeoutMs: 45_000,
  captureRetryMs: 500,
  runStateWatchTimeoutMs: 25_000,
  maxPendingRunWatches: 4,
  serpSettleWaitMs: SERP_SETTLE_WAIT_MS,
} as const;
export type ProjectRunLimits = { readonly [K in keyof typeof PROJECT_RUN_LIMITS]: number };

/**
 * A run's state:
 * - `idle`: no run since the app started;
 * - `running`: visiting its targets, its tab the active one;
 * - `waiting-for-tab`: its tab is not the active one (the user switched away); it waits, and that
 *   time does not count against the target;
 * - `done`: every target was visited;
 * - `cancelled`: Cancel ended it;
 * - `tab-closed`: its tab was closed, which ends it;
 * - `failed`: its tab could not be opened.
 */
export const RUN_STATES = ['idle', 'running', 'waiting-for-tab', 'done', 'cancelled', 'tab-closed', 'failed'] as const;
export type RunStateName = (typeof RUN_STATES)[number];
/** The states a run ends in. */
export const RUN_END_STATES = ['done', 'cancelled', 'tab-closed', 'failed'] as const satisfies readonly RunStateName[];

/**
 * One target's outcome: `pending` (not reached yet), `running`, `captured` (a new version or one more
 * capture of the latest), `timed-out` (`targetActiveTimeoutMs` of active time without a capture),
 * `failed` (the page did not load, or the capture was refused for another reason than a page not
 * ready yet), `cancelled` (the run ended before it).
 */
export const RUN_TARGET_OUTCOMES = ['pending', 'running', 'captured', 'timed-out', 'failed', 'cancelled'] as const;
export type RunTargetOutcome = (typeof RUN_TARGET_OUTCOMES)[number];
export const RUN_TARGET_KINDS = ['page', 'query'] as const;
export type RunTargetKind = (typeof RUN_TARGET_KINDS)[number];
/** A target's screenshot, when the run takes them: `saved`, or `failed`; `null` when not asked (or not reached). */
export const RUN_SCREENSHOT_OUTCOMES = ['saved', 'failed'] as const;
export type RunScreenshotOutcome = (typeof RUN_SCREENSHOT_OUTCOMES)[number];
/**
 * The screenshot a run takes of each captured target. Its size is the page area's as shown: while a
 * run is under way the Projects sheet is a band of fixed height above the page area, so a run's
 * screenshots are smaller than the page area with the sheet closed.
 */
export const RUN_SCREENSHOT_KIND: ScreenshotKind = 'viewport';

export interface RunTarget {
  readonly kind: RunTargetKind;
  /** A page's URL, or a query's `queryLabel`. */
  readonly label: string;
  readonly outcome: RunTargetOutcome;
  /** The capture's changes against the lane's latest version: `0` none, `null` a first version (or not captured). */
  readonly changeCount: number | null;
  readonly screenshot: RunScreenshotOutcome | null;
}

/** `projects.runState`: the current (or last) run, with a version that grows with every change. */
export interface RunState {
  readonly version: number;
  readonly runId: string | null;
  readonly projectId: string | null;
  readonly state: RunStateName;
  /** The target being visited (1-based); `0` before the first. */
  readonly current: number;
  readonly total: number;
  /** Targets past `maxRunTargets`, not visited. */
  readonly omitted: number;
  /** Whether the run takes a viewport screenshot of each captured target. */
  readonly screenshot: boolean;
  readonly targets: readonly RunTarget[];
}

/**
 * The render profiles a query is visited with by its `device`: a `mobile` query as a phone, a
 * `tablet` query as a tablet, each with a mobile browser's user agent and otherwise frost's defaults
 * (Phase 3 reads the device back from the profile: `SERP_DEVICE_OF_PRESET`). Other targets (pages,
 * `desktop` queries) use the project's. A run groups its targets by the profile they need and visits
 * each group in a fresh tab whose profile is set once, before its first navigation, with no pin; a
 * group needing the default gets no profile set (setting the default is a Reset, which would also
 * unpin the site the tab shows). A site's pinned profile still applies in a run tab without one of its
 * own: pins are the user's choice, and the capture records the profile actually in effect (the
 * audit's `renderProfile`) and the search parameters the tab actually shows (below).
 */
export const MOBILE_QUERY_PROFILE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile' };
export const TABLET_QUERY_PROFILE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'tablet', userAgent: 'mobile' };
export const QUERY_DEVICE_PROFILES: Readonly<Record<Exclude<SerpDevice, 'desktop'>, RenderProfile>> = { mobile: MOBILE_QUERY_PROFILE, tablet: TABLET_QUERY_PROFILE };

// ---- Saved searches ----------------------------------------------------------------------------

/**
 * The query form's search (`projects.addSearch`), before main reads it as a result page:
 * - `engine`: one of `SEARCH_ENGINES`;
 * - `query`: trimmed, 1–`PROJECT_QUERY_MAX_CHARS`;
 * - `country`: two lowercase letters, or `null`;
 * - `language`: a lowercase BCP 47-style tag (`en`, `pt-br`) of at most
 *   `QUERY_FIELD_MAX_CHARS.language`, or `null`;
 * - `device`: `desktop`, `mobile` or `tablet` (`SERP_DEVICES`).
 *
 * There is no location: Phase 3's search parameters have none (a results page takes a place through
 * cookies or settings frost does not set).
 */
export interface SavedSearchInput {
  readonly engine: SearchEngineId;
  readonly query: string;
  readonly country: string | null;
  readonly language: string | null;
  readonly device: SerpDevice;
}

/**
 * Each engine's country and language parameters, by the bundled selector pack's names
 * (`packs/serp-selectors.json`, `params.gl` / `params.hl`), so the URL frost visits is one Phase 3
 * reads back with the same `gl` and `hl`:
 * - Google: `gl` = country, `hl` = language;
 * - Bing: `cc` = country, `setlang` = language;
 * - DuckDuckGo: one region parameter, `kl` = `<country>-<language>` (Phase 3's `gl`; it has no
 *   `hl`), sent only when both are set.
 *
 * A parameter that is `null` is left out; the country comes before the language, as in Phase 3's
 * canonical URL. `device` is not a parameter: a query is visited with `QUERY_DEVICE_PROFILES`.
 */
export const SEARCH_PARAM_URL_RULES = {
  google: { kind: 'separate', gl: 'gl', hl: 'hl' },
  bing: { kind: 'separate', gl: 'cc', hl: 'setlang' },
  duckduckgo: { kind: 'region', gl: 'kl' },
} as const satisfies Readonly<Record<SearchEngineId, { readonly kind: 'separate'; readonly gl: string; readonly hl: string } | { readonly kind: 'region'; readonly gl: string }>>;

/** The `gl` and `hl` values `searchUrlFor(search)` sends (what Phase 3 must read back from it). */
export function searchLocaleFor(search: Pick<SavedSearchInput, 'engine' | 'country' | 'language'>): { readonly gl: string | null; readonly hl: string | null } {
  const rule: (typeof SEARCH_PARAM_URL_RULES)[SearchEngineId] = SEARCH_PARAM_URL_RULES[searchEngine(search.engine).id];
  if (rule.kind === 'separate') return { gl: search.country, hl: search.language };
  return { gl: search.country !== null && search.language !== null ? `${search.country}-${search.language}` : null, hl: null };
}

/**
 * The results page of `search` (pure): the engine's `SEARCH_ENGINES` URL for the query (lone
 * surrogates as U+FFFD, `encodeURIComponent`-encoded: `searchEngineUrl`), then its
 * `SEARCH_PARAM_URL_RULES` parameters (`searchLocaleFor`), in that order, each value encoded the same
 * way. Main reads it with Phase 3's `matchSerp` and stores what that answers.
 */
export function searchUrlFor(search: SavedSearchInput): string {
  const engine = searchEngine(search.engine).id;
  const rule: (typeof SEARCH_PARAM_URL_RULES)[SearchEngineId] = SEARCH_PARAM_URL_RULES[engine];
  const { gl, hl } = searchLocaleFor(search);
  const extra: [string, string][] = [];
  if (gl !== null) extra.push([rule.gl, gl]);
  if (hl !== null && rule.kind === 'separate') extra.push([rule.hl, hl]);
  return searchEngineUrl(engine, search.query) + extra.map(([key, value]) => `&${key}=${encodeURIComponent(wellFormed(value))}`).join('');
}

/** How a query reads in the project view and the run's list: `“query” on Engine` and its country, language and device. */
export function queryLabel(params: SearchParams): string {
  const settings = [params.gl?.toUpperCase(), params.hl, SERP_DEVICE_LABELS[params.device]?.toLowerCase()].filter((part): part is string => typeof part === 'string' && part !== '');
  return `“${params.query}” on ${params.engineLabel}${settings.length > 0 ? ` (${settings.join(', ')})` : ''}`;
}

// ---- The project workspace (Phase 10 Task 4) -----------------------------------------------------

/**
 * Which targets a run visits (plan Decision 11): `all` (Capture now: the pages, then the saved
 * searches) or `searches` (Check rankings: only the saved searches). `projects.startRun` takes it,
 * `all` when left out.
 */
export const RUN_SCOPES = ['all', 'searches'] as const;
export type RunScope = (typeof RUN_SCOPES)[number];

/** A site or competitor as typed: a host or a web address (at most this many code units). */
export const SITE_INPUT_MAX_CHARS = 2_048;
/** A tag as typed, before `normalizeTag` (at most this many code units). */
export const TAG_INPUT_MAX_CHARS = TAG_MAX_CHARS * 2;

/** One DNS label of a stored host: letters, digits, `-` and `_` (punycode for IDN), 1–63 long, not starting or ending with `-`. */
const HOST_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
/** C0 and C1 controls, DEL, and bidirectional formatting characters. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

/**
 * A site or competitor domain (plan Decision 7) from what the user typed: a host (`Shop.Com`,
 * `shop.com/path`, `shop.com:8080`) or an `http(s)` URL, read with `URL` (so a name is lowercased and
 * an IDN becomes punycode), its trailing dots dropped. `null` unless the host is a public name
 * (`isPublicHost`: not `localhost`, a single label, or a name under a non-public suffix such as
 * `.local` or `.example`), not an IP literal, of DNS labels of `[a-z0-9_-]` only (none starting or
 * ending with `-`), and at most
 * `DOMAIN_MAX_CHARS` long; input with white space or an `@` (userinfo, `mailto:`) is refused. A leading `www.` is kept: matching takes care of it.
 */
export function normalizeSiteDomain(input: string): string | null {
  if (typeof input !== 'string' || input.length > SITE_INPUT_MAX_CHARS || UNPRINTABLE.test(input)) return null;
  const text = input.trim();
  // White space and userinfo (`me@host`, `mailto:me@host`) are never part of a site.
  if (text === '' || /[\s@]/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme !== null && !/^https?$/i.test(scheme[1]!)) return null;
  let host: string;
  try {
    host = new URL(scheme === null ? `http://${text}` : text).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.+$/, '');
  if (host === '' || host.length > DOMAIN_MAX_CHARS || isIpLiteral(host) || !isPublicHost(host)) return null;
  return host.split('.').every((label) => HOST_LABEL.test(label)) ? host : null;
}

/**
 * A tag (plan Decision 8) from what the user typed: NFC, white space runs (tabs and line breaks
 * included) as one space, trimmed, lowercase. `null` for a blank tag, one longer than `TAG_MAX_CHARS`
 * afterwards, or one with another control or a bidirectional formatting character.
 */
export function normalizeTag(input: string): string | null {
  if (typeof input !== 'string' || input.length > TAG_INPUT_MAX_CHARS) return null;
  // White space (tabs and line breaks too) first, so only other unprintable characters are refused.
  const tag = input.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return tag !== '' && tag.length <= TAG_MAX_CHARS && !UNPRINTABLE.test(tag) ? tag : null;
}

/**
 * The tags of one entry as typed, normalized (`normalizeTag`), duplicates dropped, sorted; `null` if
 * one is refused or there are more than `MAX_TAGS_PER_ENTRY`.
 */
export function normalizeTags(input: readonly string[]): string[] | null {
  const tags = new Set<string>();
  for (const raw of input) {
    const tag = normalizeTag(raw);
    if (tag === null) return null;
    tags.add(tag);
  }
  return tags.size > MAX_TAGS_PER_ENTRY ? null : [...tags].sort();
}

/**
 * Bulk add (plan Decision 8): at most `maxLines` queries (`MAX_PROJECT_QUERIES`) of at most
 * `maxTextChars` typed, with at most `maxLocales` country/language pairs and any of the three devices.
 */
export const BULK_SEARCH_LIMITS = {
  maxLines: MAX_PROJECT_QUERIES,
  maxLocales: 5,
  maxTextChars: MAX_PROJECT_QUERIES * (PROJECT_QUERY_MAX_CHARS + 2),
} as const;

/**
 * A line's outcome:
 * - `added`: at least one of its searches was added (and the rest were already saved);
 * - `exists`: every one of its searches was already saved;
 * - `invalid`: one of its searches is not a saved search frost can make (`invalid-query`): none of
 *   the line's searches is stored;
 * - `limit`: the project reached `MAX_PROJECT_QUERIES` (some of the line's searches may have been
 *   added before it did); every later line is `limit` too, without being tried.
 */
export const BULK_LINE_OUTCOMES = ['added', 'exists', 'invalid', 'limit'] as const;
export type BulkLineOutcome = (typeof BULK_LINE_OUTCOMES)[number];

/** One line's result: its query, outcome, and how many saved searches it added. */
export interface BulkLineResult {
  readonly query: string;
  readonly outcome: BulkLineOutcome;
  readonly added: number;
}

/** A country/language pair of a bulk add (each may be `null`, as in the query form). */
export interface BulkLocale {
  readonly country: string | null;
  readonly language: string | null;
}

/**
 * The Bulk add form (`projects.addSearches`): the typed `text` (`splitBulkSearches`), one engine, 1–
 * `maxLocales` distinct locales, 1–3 distinct devices, and tags for every search it adds (at most
 * `MAX_TAGS_PER_ENTRY`, `normalizeTag`ged by main).
 */
export interface BulkSearchesInput {
  readonly text: string;
  readonly engine: SearchEngineId;
  readonly locales: readonly BulkLocale[];
  readonly devices: readonly SerpDevice[];
  readonly tags: readonly string[];
}

/**
 * The queries of a Bulk add text: one per line, or comma-separated; each with its white space runs
 * as one space and trimmed; blanks and repeats dropped; in order. Never capped here: the form and the
 * input schema refuse more than `BULK_SEARCH_LIMITS.maxLines`.
 */
export function splitBulkSearches(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\r\n,]+/)) {
    const query = part.replace(/\s+/g, ' ').trim();
    if (query !== '' && !out.includes(query)) out.push(query);
  }
  return out;
}

/** The saved searches one line of a bulk add makes: each locale (in order), on each device (in order). */
export function bulkSearchInputs(query: string, input: Pick<BulkSearchesInput, 'engine' | 'locales' | 'devices'>): SavedSearchInput[] {
  return input.locales.flatMap((locale) => input.devices.map((device) => ({ engine: input.engine, query, country: locale.country, language: locale.language, device })));
}

/** The project list's sorts (view state, not persisted): by name, by its last capture (newest first), by creation (newest first). */
export const PROJECT_SORTS = ['name', 'last-captured', 'created'] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];
export const PROJECT_SORT_LABELS: Readonly<Record<ProjectSort, string>> = { name: 'Name', 'last-captured': 'Last captured', created: 'Created' };

/**
 * `projects` sorted for the list: Unfiled first, then the favorites, then the rest, each part by
 * `sort` (`name`: A–Z, case-insensitive; `last-captured`: newest `lastCapturedAt` first, never captured last;
 * `created`: newest first); ties by name, then id. A new array; `projects` is left as it is.
 */
export function sortProjects<T extends Pick<ProjectSummary, 'id' | 'name' | 'unfiled' | 'favorite' | 'createdAt' | 'lastCapturedAt'>>(projects: readonly T[], sort: ProjectSort): T[] {
  const rank = (project: T): number => (project.unfiled ? 0 : project.favorite ? 1 : 2);
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const by: Record<ProjectSort, (a: T, b: T) => number> = {
    name: () => 0,
    'last-captured': (a, b) => (b.lastCapturedAt ?? Number.NEGATIVE_INFINITY) - (a.lastCapturedAt ?? Number.NEGATIVE_INFINITY) || 0,
    created: (a, b) => b.createdAt - a.createdAt,
  };
  return [...projects].sort((a, b) => rank(a) - rank(b) || by[sort](a, b) || byName(a, b));
}

// ---- Answers -----------------------------------------------------------------------------------

/**
 * Why a project change was refused:
 * - `not-found`: no such live project (or page, query or competitor in it);
 * - `unfiled`: Unfiled cannot be renamed or deleted, and has no site or competitors;
 * - `invalid-name`: blank, or too long, after trimming;
 * - `invalid-url`: not an `http(s)` URL frost can store;
 * - `invalid-query`: a search that does not fit `SavedSearchInputSchema`, or whose URL Phase 3 does
 *   not read back as a result page with the country and language asked for;
 * - `invalid-profile`: not a render profile;
 * - `invalid-domain`: a site or competitor that `normalizeSiteDomain` does not read as a public host;
 * - `invalid-tag`: a tag that `normalizeTag` refuses, or more than `MAX_TAGS_PER_ENTRY` on one entry;
 * - `no-page`: the active tab shows no web page (Add the current page);
 * - `limit`: the project (or frost) holds as many as it can (`MAX_PROJECTS`, `MAX_PROJECT_PAGES`,
 *   `MAX_PROJECT_QUERIES`, `MAX_PROJECT_COMPETITORS`, `MAX_PROJECT_TAGS`);
 * - `running`: a capture run of this project is under way (delete waits for it);
 * - `declined`: the confirmation was answered Cancel;
 * - `store-failed`: the database failed.
 */
export const PROJECT_REFUSALS = ['not-found', 'unfiled', 'invalid-name', 'invalid-url', 'invalid-query', 'invalid-profile', 'invalid-domain', 'invalid-tag', 'no-page', 'limit', 'running', 'declined', 'store-failed'] as const;
export type ProjectRefusal = (typeof PROJECT_REFUSALS)[number];

export const PROJECT_REFUSAL_MESSAGES: Readonly<Record<ProjectRefusal, string>> = {
  'not-found': 'That project (or entry) no longer exists.',
  unfiled: 'Unfiled cannot be renamed or deleted, and has no site or competitors.',
  'invalid-name': 'Give the project a name.',
  'invalid-url': 'Enter an http or https address.',
  'invalid-query': 'Enter a query, and a two-letter country and a short language code (or leave them empty).',
  'invalid-profile': 'That render profile cannot be used.',
  'invalid-domain': 'Enter a public domain name or a web address.',
  'invalid-tag': `Tags are 1 to ${TAG_MAX_CHARS} characters, at most ${MAX_TAGS_PER_ENTRY} on a page or search.`,
  'no-page': 'The current tab shows no web page.',
  limit: 'This project cannot hold any more.',
  running: 'A capture run of this project is under way. Cancel it first.',
  declined: 'Nothing was deleted.',
  'store-failed': 'The change could not be saved.',
};

/**
 * Why a run did not start: `busy` (one is under way; one at a time, app-wide), `not-found` (no such
 * project), `no-targets` (it has no pages or queries), `no-tab` (no tab could be opened for it),
 * `store-failed`.
 */
export const RUN_REFUSALS = ['busy', 'not-found', 'no-targets', 'no-tab', 'store-failed'] as const;
export type RunRefusal = (typeof RUN_REFUSALS)[number];

export const RUN_REFUSAL_MESSAGES: Readonly<Record<RunRefusal, string>> = {
  busy: 'A capture run is already under way.',
  'not-found': 'That project no longer exists.',
  'no-targets': 'Add a page or a query to capture first.',
  'no-tab': 'No tab could be opened for the run. Close a tab and try again.',
  'store-failed': 'The project could not be read.',
};

export type ProjectRefused = { status: 'refused'; reason: ProjectRefusal };

/**
 * A project's site (Phase 10, plan Decision 7): `domain` its lowercase host as `normalizeSiteDomain`
 * gives it; `subdomains` whether every host of its owner domain counts as the site (on by default) or
 * only `domain` itself, give or take one leading `www.`.
 */
export interface ProjectSite {
  domain: string;
  subdomains: boolean;
}

/** A project as listed. */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Whether this is Unfiled (listed first; cannot be renamed or deleted). */
  unfiled: boolean;
  /** The profile its runs use; `null`: frost's default. */
  renderProfile: RenderProfile | null;
  retention: { mode: RetentionMode; value: number | null };
  /** Starred in the project list (Phase 10; device-local). */
  favorite: boolean;
  /** Whose positions the rank views show (Phase 10); `null`: none set (Unfiled never has one). */
  site: ProjectSite | null;
  /** When it was created (`created` sort). */
  createdAt: number;
  /** The newest capture filed in it, of any source (a manual capture or a run's), or `null` (`last-captured` sort). */
  lastCapturedAt: number | null;
}

/** What a page or query of a project shows: its last capture in the project and its latest version's change count. */
export interface ProjectEntryCaptures {
  /** The last capture in this project; `null`: never captured here. */
  lastCapturedAt: number | null;
  /** Changes of the latest version against the one before it; `null`: a first version, or none. */
  changeCount: number | null;
}

export interface ProjectPageEntry extends ProjectEntryCaptures {
  id: string;
  url: string;
  /** Its live tags (`normalizeTag` form), sorted (Phase 10). */
  tags: string[];
}

export interface ProjectQueryEntry extends ProjectEntryCaptures {
  id: string;
  /** The saved search, as Phase 3 reads its URL (`serp-search-params.schema.ts`). */
  params: SearchParams;
  /** `params.url`: the canonical URL a run visits. */
  url: string;
  /** Its live tags (`normalizeTag` form), sorted (Phase 10). */
  tags: string[];
}

/** A project's competitor (Phase 10): its host as `normalizeSiteDomain` gives it. */
export interface ProjectCompetitor {
  id: string;
  domain: string;
}

/**
 * `projects.get`: the project with its pages and queries, and (Phase 10) its competitors, oldest
 * first (`null`: no such live project).
 */
export type ProjectDetail = { project: ProjectSummary; pages: ProjectPageEntry[]; queries: ProjectQueryEntry[]; competitors: ProjectCompetitor[] } | null;

export interface ProjectsAnswer {
  projects: ProjectSummary[];
}

export type CreateProjectAnswer = { status: 'created'; project: ProjectSummary } | ProjectRefused;
export type ProjectChangeAnswer = { status: 'ok' } | ProjectRefused;
export type AddPageAnswer = { status: 'added'; page: { id: string; url: string } } | ProjectRefused;
export type AddQueryAnswer = { status: 'added'; query: { id: string } } | ProjectRefused;
/** What a delete purged (`null`: the project went but its purge did not run; retention can run it again). */
export type DeleteProjectAnswer = { status: 'deleted'; purged: { captures: number; versions: number; diffs: number; screenshots: number } | null } | ProjectRefused;
export type StartRunAnswer = { status: 'started'; runId: string } | { status: 'refused'; reason: RunRefusal };
/** `setSite`: the site as stored (`null`: cleared). */
export type SetSiteAnswer = { status: 'ok'; site: ProjectSite | null } | ProjectRefused;
/** `addCompetitor`: the competitor (its live row when the project already had the domain). */
export type AddCompetitorAnswer = { status: 'added'; competitor: ProjectCompetitor } | ProjectRefused;
/** `setTags`: the entry's tags afterwards, sorted. */
export type SetTagsAnswer = { status: 'ok'; tags: string[] } | ProjectRefused;
/** `addSearches`: one result per line of `splitBulkSearches(text)`, in order. */
export type BulkAddAnswer = { status: 'done'; lines: BulkLineResult[] } | ProjectRefused;

// ---- Wording -----------------------------------------------------------------------------------

export const PROJECTS_TITLE = 'Projects' as const;

/**
 * The views of one project in the sheet (Phase 10 Tasks 6 and 7; `projects.feature.md`, The sheet), in
 * the switch's order: `overview` (pages, queries, Capture now, retention), `rankings` (the rank table
 * and a search's series), `compare` (two readings side by side) and `settings` (the site, include
 * subdomains and the competitors; Task 8 adds the cadence).
 */
export const PROJECT_VIEWS = ['overview', 'rankings', 'compare', 'settings'] as const;
export type ProjectViewId = (typeof PROJECT_VIEWS)[number];

export const PROJECT_VIEW_LABELS: Readonly<Record<ProjectViewId, string>> = {
  overview: 'Overview',
  rankings: 'Rankings',
  compare: 'Compare',
  settings: 'Settings',
};

/** The project list's sort when the sheet opens (view state: not persisted). */
export const DEFAULT_PROJECT_SORT: ProjectSort = 'name';

/** The project list's star and what it says (Phase 10 Task 7). */
export const FAVORITE_TEXT = {
  /** The star's accessible name, `{name}` the project's (its state is `aria-pressed`). */
  label: 'Favorite {name}',
  added: 'Added to favorites.',
  removed: 'Removed from favorites.',
} as const;

/** The Settings view's wording (Phase 10 Task 7; plan Decision 7). */
export const PROJECT_SETTINGS_TEXT = {
  siteTitle: 'Site',
  siteLabel: 'Site domain',
  siteNote: 'Whose positions the Rankings view shows. Type a domain or paste a web address: frost keeps only its host.',
  subdomains: 'Include subdomains',
  subdomainsNote: 'On, every host of the domain counts as the site (shop.example.com too). Off, only this host does, with or without www.',
  siteSaved: 'Site saved.',
  siteCleared: 'Site cleared.',
  competitorsTitle: 'Competitors',
  competitorLabel: 'Competitor domain',
  competitorsNote: `Up to ${MAX_PROJECT_COMPETITORS}, each kept as its domain. Their positions come from the same readings, so adding one shows its history at once.`,
  noCompetitors: 'No competitors yet.',
  competitorAdded: 'Competitor added.',
  competitorExists: 'That domain is already a competitor.',
  competitorRemoved: 'Competitor removed.',
  unfiled: 'Unfiled is where captures land when no project was chosen: it has no site or competitors.',
} as const;

/** The tag editor of a page or saved search (Phase 10 Task 7; plan Decision 8). */
export const TAG_EDITOR_TEXT = {
  /** The editor's accessible name, `{label}` the page's URL or the search's `queryLabel`. */
  label: 'Tags for {label}',
  note: `Separate tags with commas; at most ${MAX_TAGS_PER_ENTRY}. Tags filter the Rankings view.`,
  saved: 'Tags saved.',
} as const;

/** The Bulk add dialog (Phase 10 Task 7; plan Decision 8). */
export const BULK_ADD_TEXT = {
  title: 'Bulk add searches',
  textLabel: 'Queries, one per line or separated by commas',
  /** What Bulk add does and does not do: it never contacts a search engine. */
  note: 'Bulk add only saves searches. Nothing is sent to a search engine until you run Check rankings (or Capture now).',
} as const;

/** A Bulk add line's outcome in words (`BULK_LINE_OUTCOMES`). */
export const BULK_LINE_OUTCOME_LABELS: Readonly<Record<BulkLineOutcome, string>> = {
  added: 'Added',
  exists: 'Already saved',
  invalid: 'Not a search frost can make',
  limit: 'Not added: the project is full',
};

/** Said beside Capture now: what a run does, and what it may meet. */
export const CAPTURE_RUN_NOTE =
  'frost visits each page in a tab of its own; search engines may show a consent page or a challenge, and that is what gets captured.' as const;

/**
 * The longest `language` the query form takes: a DuckDuckGo region (`<country>-<language>`) still
 * fits Phase 3's `SERP_PARAM_LIMITS.maxLocaleChars`.
 */
export const QUERY_FIELD_MAX_CHARS = { language: SERP_PARAM_LIMITS.maxLocaleChars - 3 } as const;

export const RUN_STATE_LABELS: Readonly<Record<RunStateName, string>> = {
  idle: 'Not run yet',
  running: 'Capturing',
  'waiting-for-tab': 'Waiting: bring the run’s tab to the front to go on',
  done: 'Done',
  cancelled: 'Cancelled',
  'tab-closed': 'Stopped: the run’s tab was closed',
  failed: 'Could not start',
};

export const RUN_TARGET_OUTCOME_LABELS: Readonly<Record<RunTargetOutcome, string>> = {
  pending: 'Waiting',
  running: 'Capturing…',
  captured: 'Captured',
  'timed-out': 'Timed out',
  failed: 'Failed',
  cancelled: 'Not visited',
};

/** Capture refusals a run waits through (the page is not ready yet); any other fails the target. */
export const RUN_RETRY_REFUSALS = ['no-audit', 'busy'] as const satisfies readonly CaptureRefusal[];

/** Said when a project was deleted but its captures could not be purged yet (retried at startup and before each run). */
export const DELETED_NOT_PURGED = 'Project deleted; its captures could not be removed yet.' as const;

/** "Delete project": the confirmation main shows (Cancel is the default and the cancel answer). */
export const DELETE_PROJECT = {
  dialog: {
    type: 'warning',
    message: 'Delete this project?',
    detail:
      'This deletes the project {name}, its pages and queries, and every capture and screenshot filed in it. Versions another project also captured stay with that project. It cannot be undone.',
    buttons: ['Delete Project', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  },
  confirmIndex: 0,
} as const;

/** `DELETE_PROJECT.dialog` for the project `name`, quoted and bidi-isolated (FSI … PDI). */
export function deleteProjectDialog(name: string): { type: 'warning'; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: boolean } {
  const { dialog } = DELETE_PROJECT;
  // A function replacement: a `$&` or `$'` in the name stays text.
  return { ...dialog, detail: dialog.detail.replace('{name}', () => `“⁨${name}⁩”`), buttons: [...dialog.buttons] };
}
