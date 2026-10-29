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
import type { RetentionMode, ScreenshotKind } from './capture-db.spec';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from './render-profile.spec';
import type { SearchParams } from './serp-search-params.schema';
import { SERP_DEVICE_LABELS, SERP_PARAM_LIMITS, type SerpDevice } from './serp.spec';

// ---- The capture run ---------------------------------------------------------------------------

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
 *   oldest early with the current state.
 */
export const PROJECT_RUN_LIMITS = {
  maxRunTargets: 70,
  targetActiveTimeoutMs: 45_000,
  captureRetryMs: 500,
  runStateWatchTimeoutMs: 25_000,
  maxPendingRunWatches: 4,
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

// ---- Answers -----------------------------------------------------------------------------------

/**
 * Why a project change was refused:
 * - `not-found`: no such live project (or page, or query, in it);
 * - `unfiled`: Unfiled cannot be renamed or deleted;
 * - `invalid-name`: blank, or too long, after trimming;
 * - `invalid-url`: not an `http(s)` URL frost can store;
 * - `invalid-query`: a search that does not fit `SavedSearchInputSchema`, or whose URL Phase 3 does
 *   not read back as a result page with the country and language asked for;
 * - `invalid-profile`: not a render profile;
 * - `no-page`: the active tab shows no web page (Add the current page);
 * - `limit`: the project (or frost) holds as many as it can (`MAX_PROJECTS`, `MAX_PROJECT_PAGES`,
 *   `MAX_PROJECT_QUERIES`);
 * - `running`: a capture run of this project is under way (delete waits for it);
 * - `declined`: the confirmation was answered Cancel;
 * - `store-failed`: the database failed.
 */
export const PROJECT_REFUSALS = ['not-found', 'unfiled', 'invalid-name', 'invalid-url', 'invalid-query', 'invalid-profile', 'no-page', 'limit', 'running', 'declined', 'store-failed'] as const;
export type ProjectRefusal = (typeof PROJECT_REFUSALS)[number];

export const PROJECT_REFUSAL_MESSAGES: Readonly<Record<ProjectRefusal, string>> = {
  'not-found': 'That project (or entry) no longer exists.',
  unfiled: 'Unfiled cannot be renamed or deleted.',
  'invalid-name': 'Give the project a name.',
  'invalid-url': 'Enter an http or https address.',
  'invalid-query': 'Enter a query, and a two-letter country and a short language code (or leave them empty).',
  'invalid-profile': 'That render profile cannot be used.',
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

/** A project as listed. */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Whether this is Unfiled (listed first; cannot be renamed or deleted). */
  unfiled: boolean;
  /** The profile its runs use; `null`: frost's default. */
  renderProfile: RenderProfile | null;
  retention: { mode: RetentionMode; value: number | null };
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
}

export interface ProjectQueryEntry extends ProjectEntryCaptures {
  id: string;
  /** The saved search, as Phase 3 reads its URL (`serp-search-params.schema.ts`). */
  params: SearchParams;
  /** `params.url`: the canonical URL a run visits. */
  url: string;
}

/** `projects.get`: the project with its pages and queries (`null`: no such live project). */
export type ProjectDetail = { project: ProjectSummary; pages: ProjectPageEntry[]; queries: ProjectQueryEntry[] } | null;

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

// ---- Wording -----------------------------------------------------------------------------------

export const PROJECTS_TITLE = 'Projects' as const;

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
