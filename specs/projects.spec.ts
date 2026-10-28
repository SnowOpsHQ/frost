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
 * A query is visited at its search URL (`searchUrlFor`): the engine's own address from
 * `SEARCH_ENGINES` plus the parameters frost knows that engine takes (`SEARCH_PARAM_URL_RULES`).
 */
import { SEARCH_ENGINES, searchEngine, searchEngineUrl, wellFormed, type SearchEngineId } from './browser-polish.spec';
import type { CaptureRefusal } from './changes.spec';
import type { RetentionMode, ScreenshotKind } from './capture-db.spec';
import type { SearchParams } from './capture-search-params.schema';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from './render-profile.spec';

// ---- The capture run ---------------------------------------------------------------------------

/**
 * Limits of a capture run:
 * - `maxRunTargets`: the most targets one run visits, all pages first, then queries (a project can
 *   hold more: the rest are `omitted`, and the run says so);
 * - `targetActiveTimeoutMs`: how long one target may take, counting only time while the run's tab is
 *   the active one; past it the target is `timed-out` and the run moves on;
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
/** The screenshot a run takes of each captured target. */
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
 * The render profile a query with device `mobile` is visited with, for that target only: a phone
 * with a mobile browser's user agent, otherwise frost's defaults. Other targets use the project's.
 */
export const MOBILE_QUERY_PROFILE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile' };

// ---- Search URLs -------------------------------------------------------------------------------

/**
 * frost's own table of the parameters each engine's results page takes:
 * - Google: `hl` = language, `gl` = country;
 * - Bing: `setlang` = language, `cc` = country;
 * - DuckDuckGo: `kl` = `<country>-<language>`, only when both are set (it takes one region value).
 *
 * A parameter that is `null` is left out. `location` is **never sent**: it is recorded with the query
 * only (results pages take a place through cookies or settings frost does not set). `device` is not
 * a parameter either: a `mobile` query is visited with `MOBILE_QUERY_PROFILE`.
 */
export const SEARCH_PARAM_URL_RULES = {
  google: { kind: 'separate', language: 'hl', country: 'gl' },
  bing: { kind: 'separate', language: 'setlang', country: 'cc' },
  duckduckgo: { kind: 'region', param: 'kl' },
} as const satisfies Readonly<Record<SearchEngineId, { readonly kind: 'separate'; readonly language: string; readonly country: string } | { readonly kind: 'region'; readonly param: string }>>;

/** The search parameters no URL carries (recorded only). */
export const SEARCH_PARAMS_NEVER_SENT = ['location'] as const satisfies readonly (keyof SearchParams)[];

/**
 * The results page of `params` (pure): the engine's `SEARCH_ENGINES` URL for the query (lone
 * surrogates as U+FFFD, `encodeURIComponent`-encoded: `searchEngineUrl`), then its
 * `SEARCH_PARAM_URL_RULES` parameters, in that order, each value encoded the same way.
 */
export function searchUrlFor(params: SearchParams): string {
  const engine = searchEngine(params.engine).id;
  const extra: [string, string][] = [];
  const rule: (typeof SEARCH_PARAM_URL_RULES)[SearchEngineId] = SEARCH_PARAM_URL_RULES[engine];
  if (rule.kind === 'separate') {
    if (params.language !== null) extra.push([rule.language, params.language]);
    if (params.country !== null) extra.push([rule.country, params.country]);
  } else if (params.country !== null && params.language !== null) {
    extra.push([rule.param, `${params.country}-${params.language}`]);
  }
  return searchEngineUrl(engine, params.query) + extra.map(([key, value]) => `&${key}=${encodeURIComponent(wellFormed(value))}`).join('');
}

/** How a query reads in the project view and the run's list: `“query” on Engine` and its settings. */
export function queryLabel(params: SearchParams): string {
  const label = SEARCH_ENGINES.find((engine) => engine.id === params.engine)?.label ?? params.engine;
  const settings = [params.country?.toUpperCase(), params.language, params.device === null ? null : SEARCH_DEVICE_LABELS[params.device].toLowerCase(), params.location].filter((part): part is string => typeof part === 'string' && part !== '');
  return `“${params.query}” on ${label}${settings.length > 0 ? ` (${settings.join(', ')})` : ''}`;
}

export const SEARCH_DEVICE_LABELS: Readonly<Record<NonNullable<SearchParams['device']>, string>> = { desktop: 'Desktop', mobile: 'Mobile' };

// ---- Answers -----------------------------------------------------------------------------------

/**
 * Why a project change was refused:
 * - `not-found`: no such live project (or page, or query, in it);
 * - `unfiled`: Unfiled cannot be renamed or deleted;
 * - `invalid-name`: blank, or too long, after trimming;
 * - `invalid-url`: not an `http(s)` URL frost can store;
 * - `invalid-query`: search parameters that do not fit `SearchParamsSchema`;
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
  'invalid-query': 'Enter a query, and a two-letter country and a language code (or leave them empty).',
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
  params: SearchParams;
  /** `searchUrlFor(params)`. */
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

/** The longest `language` and `location` the query form takes (`SEARCH_LANGUAGE_MAX_CHARS`, `SEARCH_LOCATION_MAX_CHARS` of the Zod schema). */
export const QUERY_FIELD_MAX_CHARS = { language: 35, location: 100 } as const;

/** Said in the query form: what `location` does (`SEARCH_PARAMS_NEVER_SENT`). */
export const QUERY_LOCATION_NOTE = 'The location is recorded with the query; it is not sent to the search engine.' as const;

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
  return { ...dialog, detail: dialog.detail.replace('{name}', `“⁨${name}⁩”`), buttons: [...dialog.buttons] };
}
