/**
 * Rank tracking over stored SERP readings (Phase 10; plan Decisions 1, 3, 4 and 10; acceptance
 * `changes-capture.feature.md`, SERP reading). Plain values, types and pure functions in **plain
 * ECMAScript** (no Zod, no Node, no DOM, not even `URL` or `TextEncoder`): `@app/change-intel` (the
 * rank read model, type-checked with `lib: ES2023` and no types) imports this file, and so does the
 * chrome renderer. What needs `URL` (reading a page's filters and its engine host, comparing a run's
 * search) is `rankings-url.spec.ts`, also Zod-free. The Zod side, and the compile-time proofs that
 * Phase 3's schemas fit the shapes here, is `rankings.schema.ts`; the storage is
 * `workspace-db.spec.ts` (`ci_serp_readings`).
 *
 * ## A reading and its search key (Decision 4)
 * Each capture of a result page stores Phase 3's analysed reading of it (`SerpSnapshot`, Zod-free
 * here as `SerpSnapshotShape`) with:
 * - its **filters**: the known result-shaping parameters of the page's own URL (`SERP_FILTER_PARAMS`,
 *   read by `rankings-url.spec.ts` `serpFiltersOf`), which Phase 3's canonical URL leaves out;
 * - its **search key**: the SHA-256 (hex, computed in main) of `searchIdentityJson(params, filters,
 *   host)`: every search parameter present except `SEARCH_IDENTITY_EXCLUDED`, the engine's host (from
 *   `params.url`, `rankings-url.spec.ts` `searchHostOf`) and the filters, as canonical JSON (keys sorted, at every level), so
 *   the order the fields come in never matters. The key's rule version is `SEARCH_KEY_VERSION`
 *   (`workspace-db.spec.ts`).
 *   - `query` keeps its case ("Green tea" and "green tea" are two series); `device` counts (a phone's
 *     results are not a desktop's); `google.de` is not `google.com`; a filtered page ("past week") is
 *     its own series.
 *   - A field a later phase adds to the search parameters counts as soon as it is present (it splits
 *     series); while it is absent (`undefined`) the key is the one it always was.
 *
 * ## A run's verdict on a result page (Decision 10)
 * `SERP_RUN_VERDICTS`: what Phase 3's SERP state says of the run tab's landed page — `ready` (read),
 * `unreadable`, `not-serp`, `pending` (not read yet; also a state of another tab or page, an unbound
 * read API, or anything that does not fit), `disabled` (SERP reading is off). A run waits while it is
 * `pending`, up to `SERP_SETTLE_WAIT_MS` (`projects.spec.ts`). `rankings-url.spec.ts` `sameRunSearch`
 * says whether the tab's search is the run target's (engine, host, query, `gl`, `hl`, page; not the
 * device).
 *
 * ## The rank read model (Decisions 5, 6, 7 and 15; Phase 10 Task 3)
 * `@app/change-intel` `rankOf`, `rankSeries`, `rankTable`, `rankCsvRows` and `compareSerps` compute
 * positions, change, best, trend points, CSV rows and comparisons from `SerpObservation`s, whatever
 * their source, with the values and wording below (`RANK_OUTCOMES`, `RANK_RANGES`, `RANK_LIMITS`, the
 * CSV columns, `rankLabel`, `changeLabel`, `RANK_HISTORY_NOTE`). Acceptance: `rankings.feature.md`.
 *
 * ## The `rankings.*` procedures (Phase 10 Task 5; Decision 14)
 * What main answers the Rankings and Compare views (`RANKINGS_REFUSALS`, `RankTableAnswer`,
 * `RankSeriesAnswer`, `ReadingDatesAnswer`, `CompareAnswer`, `CopyCsvAnswer`, `SaveCsvAnswer`) and the
 * CSV export's file name and save dialog wording (`RANK_CSV_FILE_NAME`, `rankCsvFileName`,
 * `RANK_CSV_SAVE_DIALOG`). Zod side: `rankings.schema.ts`; acceptance: `rankings.feature.md`, Router and Export.
 */
import type { SearchEngineId } from './browser-polish.spec';
import type { RetentionMode } from './capture-db.spec';
import type { SerpResultType } from './serp-selector-pack.spec';
import type { SerpDevice, SerpFeatureType } from './serp.spec';
import { MAX_PROJECT_COMPETITORS, SEARCH_KEY_VERSION, type SerpReadingSource } from './workspace-db.spec';

export type { SerpResultType } from './serp-selector-pack.spec';
export { SERP_FEATURE_TYPES, type SerpFeatureType } from './serp.spec';
/** Re-exported for `@app/change-intel`, which imports no spec but this one and `capture.spec.ts`. */
export { MAX_PROJECT_COMPETITORS, SEARCH_KEY_VERSION };

// ---- Shapes (Zod-free; `rankings.schema.ts` proves Phase 3's schemas fit them) -----------------

/** A result page's search parameters (`SearchParamsSchema`); a field a later phase adds passes through. */
export type SearchParamsShape = {
  readonly engine: string;
  readonly engineLabel: string;
  readonly query: string;
  readonly gl: string | null;
  readonly hl: string | null;
  readonly device: SerpDevice;
  readonly page: number;
  readonly offset: number | null;
  readonly url: string;
} & Readonly<Record<string, unknown>>;

/** One analysed result (`SerpResultSchema`). */
export type SerpResultShape = {
  readonly rank: number;
  readonly type: SerpResultType;
  readonly position: number | null;
  readonly featureSlot: number | null;
  readonly title: string;
  readonly url: string | null;
  readonly redirected: boolean;
  readonly domain: string | null;
};

/** One registrable domain's share of the page's organic results (`SerpDomainShareSchema`). */
export type SerpDomainShareShape = {
  readonly domain: string;
  readonly count: number;
  readonly share: number;
  readonly positions: readonly number[];
  readonly best: number;
};

/** A ready reading (`SerpReadySchema`). */
export type SerpReadyShape = {
  readonly status: 'ready';
  readonly params: SearchParamsShape;
  readonly packVersion: number;
  readonly results: readonly SerpResultShape[];
  readonly composition: {
    readonly counts: Readonly<Record<SerpResultType, number>>;
    readonly features: readonly { readonly slot: number; readonly type: SerpFeatureType; readonly results: number }[];
  };
  readonly ownership: { readonly page: number; readonly organic: number; readonly complete: boolean; readonly domains: readonly SerpDomainShareShape[] };
  readonly truncated: boolean;
};

/** A page Phase 3 could not read (`SerpUnreadableSchema`). */
export type SerpUnreadableShape = {
  readonly status: 'unreadable';
  readonly reason: string;
  readonly params: SearchParamsShape | null;
  readonly packVersion: number | null;
};

/** The analysed reading of one result page (`SerpSnapshotSchema`). */
export type SerpSnapshotShape = SerpReadyShape | SerpUnreadableShape;

/** The known filter parameters of a result page's URL (`serpFiltersOf`): names of `SERP_FILTER_PARAMS`, lowercase values, sorted keys. */
export type SerpFilters = Readonly<Record<string, string>>;

/** One stored reading as the read model takes it, whatever its source (Decision 3). */
export interface SerpObservation {
  readonly id: string;
  readonly searchKey: string;
  /**
   * The key rule `searchKey` was made under (the row's `search_key_version`); absent means
   * `SEARCH_KEY_VERSION`. A reading of any other version is filed under the key its parameters and
   * filters have today (`SearchKeyOf`, Decision 4).
   */
  readonly searchKeyVersion?: number;
  readonly params: SearchParamsShape;
  readonly filters: SerpFilters;
  readonly observedAt: number;
  readonly source: SerpReadingSource;
  readonly snapshot: SerpSnapshotShape;
}

/**
 * The current-version search key of a search (main: SHA-256 hex of `searchIdentityJson(params,
 * filters, searchHostOf(params.url))`), injected into the read model, which has no hash and no `URL`;
 * `null` when it has none (an engine URL that does not parse).
 */
export type SearchKeyOf = (params: SearchParamsShape, filters: SerpFilters) => string | null;

/**
 * Whose position a rank is (Decision 7), computed by main from the stored domain: `owner` its owner
 * domain (Phase 3's `ownerDomain`), `host` the domain as set (a lowercase host), `subdomains` whether
 * any host of the owner counts (on) or only `host` itself, give or take one leading `www.` (off).
 */
export interface SiteMatch {
  readonly owner: string;
  readonly host: string;
  readonly subdomains: boolean;
}

/**
 * A point's outcome (Decision 6): `ranked` (the site has an organic result on the page read),
 * `not-found` (every organic result was read and none is the site's), `unknown` (a reader cap cut
 * organic results and none read is the site's), `unreadable` (Phase 3 could not read the page),
 * `no-site` (the project has no site domain).
 */
export const RANK_OUTCOMES = ['ranked', 'not-found', 'unknown', 'unreadable', 'no-site'] as const;
export type RankOutcome = (typeof RANK_OUTCOMES)[number];

/**
 * One reading of one search for one site. `position` is the site's best organic position on the page
 * read (page-local; `ranked` only), `url` that result's link, `organicRead` the organic results read
 * on the page, `page` the result page (1 for saved searches), `alsoIn` the SERP feature types (in page
 * order, each once) with a result linking to the site: never a position.
 */
export interface RankPoint {
  readonly readingId: string;
  readonly at: number;
  readonly outcome: RankOutcome;
  readonly position: number | null;
  readonly url: string | null;
  readonly organicRead: number;
  readonly page: number;
  readonly alsoIn: readonly string[];
}

/**
 * One tracked search (Decision 5): `latest` and `previous` are its two newest readings (whatever the
 * range), `change` between them (`changeOf`); `points` (oldest first, the newest
 * `RANK_LIMITS.maxPointsPerSeries`) are within the range, and `best` is the best `ranked` position over
 * every reading in the range (before that cut); `competitors` maps each competitor's `host` to its point
 * on the latest reading (`null` with no reading).
 */
export interface RankRow {
  readonly searchKey: string;
  readonly params: SearchParamsShape;
  readonly filters: SerpFilters;
  readonly saved: { readonly id: string; readonly tags: readonly string[] } | null;
  readonly latest: RankPoint | null;
  readonly previous: RankPoint | null;
  readonly change: number | 'new' | 'lost' | null;
  readonly best: number | null;
  readonly points: readonly RankPoint[];
  readonly competitors: Readonly<Record<string, RankPoint | null>>;
}

// ---- Filters and the search key (Decision 4) ---------------------------------------------------

/**
 * Each engine's result-shaping URL parameters frost records as filters (Phase 3's canonical URL drops
 * them): Google's time range (`tbs`), results per page (`num`), SafeSearch (`safe`) and
 * personalisation (`pws`); DuckDuckGo's date (`df`) and safe search (`kp`); none for Bing in this phase.
 */
export const SERP_FILTER_PARAMS = {
  google: ['tbs', 'num', 'safe', 'pws'],
  bing: [],
  duckduckgo: ['df', 'kp'],
} as const satisfies Readonly<Record<SearchEngineId, readonly string[]>>;

/** Search parameter fields that never count toward the search key: `url` (its host does), `offset` (`page` says which page), `engineLabel` (a display string). */
export const SEARCH_IDENTITY_EXCLUDED = ['url', 'offset', 'engineLabel'] as const;

/** `value` as JSON with every object's keys sorted (UTF-16 order), at every level; `undefined` object members are left out. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return inner;
    const record = inner as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/**
 * What a search key hashes (pure): canonical JSON of `{ filters, host, params }`, `params` being every
 * field of `params` present (not `undefined`) except `SEARCH_IDENTITY_EXCLUDED`, `host` the engine's
 * (`rankings-url.spec.ts` `searchHostOf(params.url)`, lowercased). Keys are sorted at every level, so field order never matters.
 */
export function searchIdentityJson(params: SearchParamsShape, filters: SerpFilters, host: string): string {
  const excluded: readonly string[] = SEARCH_IDENTITY_EXCLUDED;
  const counted = Object.fromEntries(Object.entries(params).filter(([key, value]) => !excluded.includes(key) && value !== undefined));
  return sortedJson({ filters, host: host.toLowerCase(), params: counted });
}

// ---- A run's verdict on a result page (Decision 10) ---------------------------------------------

/** What the run tab's SERP state says of its landed page (see the header). */
export const SERP_RUN_VERDICTS = ['ready', 'unreadable', 'not-serp', 'pending', 'disabled'] as const;
export type SerpRunVerdict = (typeof SERP_RUN_VERDICTS)[number];

// ---- The rank read model (Decisions 5, 6, 7 and 15; acceptance `rankings.feature.md`) ------------

/** A saved search of the project as the rank table takes it: main computes its key (`SearchKeyOf`, no filters for a Phase 6 saved search). */
export interface SavedSearchRef {
  readonly id: string;
  readonly searchKey: string;
  readonly params: SearchParamsShape;
  readonly filters: SerpFilters;
  readonly tags: readonly string[];
}

/** The rank table: saved searches first, then searches seen only in readings; `truncated` when `RANK_LIMITS.maxRows` cut it. */
export interface RankTable {
  readonly rows: readonly RankRow[];
  readonly truncated: boolean;
}

/** The time ranges the rankings view filters points by (`all`: every point kept). */
export const RANK_RANGES = ['7d', '30d', '90d', '365d', 'all'] as const;
export type RankRange = (typeof RANK_RANGES)[number];

const DAY_MS = 86_400_000;
const RANGE_DAYS: Readonly<Record<Exclude<RankRange, 'all'>, number>> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

/**
 * The earliest `observedAt` a point of `range` may have at time `now` (inclusive; Unix ms): `now`
 * minus the range's days, never below 0. `all`, a value that is not a range, or a `now` that is not a
 * finite number keep every point (0).
 */
export function rangeStart(range: RankRange, now: number): number {
  if (!Object.prototype.hasOwnProperty.call(RANGE_DAYS, range) || !Number.isFinite(now)) return 0;
  return Math.max(0, now - RANGE_DAYS[range as Exclude<RankRange, 'all'>] * DAY_MS);
}

/**
 * What one read of the model answers at most: `maxPointsPerSeries` points per search (the newest),
 * `maxRows` rows per table and per comparison. Competitors are cut to `MAX_PROJECT_COMPETITORS`.
 */
export const RANK_LIMITS = { maxPointsPerSeries: 400, maxRows: 150 } as const;

/** The two exports: the table as shown, or every point of every row (`rankCsvRows`). */
export const RANK_CSV_KINDS = ['table', 'history'] as const;
export type RankCsvKind = (typeof RANK_CSV_KINDS)[number];

/**
 * The rank table's CSV header (`rankCsvRows(rows, 'table')`), followed by one column per competitor
 * named by its domain (its position on the latest reading). `Change` is a number (positions gained,
 * negative when lost), `new`, `lost` or empty; dates are ISO 8601 (UTC).
 */
export const RANK_CSV_COLUMNS = ['Search', 'Engine', 'Country', 'Language', 'Device', 'Page', 'Filters', 'Tags', 'Outcome', 'Position', 'Change', 'Best', 'URL', 'Last checked'] as const;

/** The history CSV's header (`rankCsvRows(rows, 'history')`): one line per point of each row, oldest first. */
export const RANK_HISTORY_CSV_COLUMNS = ['Search', 'Engine', 'Country', 'Language', 'Device', 'Page', 'Filters', 'Checked', 'Outcome', 'Position', 'Organic results read', 'URL', 'Also in'] as const;

/**
 * A point as the table shows it: `3`; on a later result page `p2 · 3` (never an absolute rank);
 * not found `> 10` (10 organic results read; `p2 · > 10` on page 2); `Unknown`, `Unreadable`,
 * `No site set`; a search with no reading `No reading`.
 */
export function rankLabel(point: RankPoint | null): string {
  if (point === null) return 'No reading';
  const onPage = (text: string) => (point.page > 1 ? `p${point.page} · ${text}` : text);
  switch (point.outcome) {
    case 'ranked':
      return onPage(String(point.position));
    case 'not-found':
      return onPage(`> ${point.organicRead}`);
    case 'unknown':
      return 'Unknown';
    case 'unreadable':
      return 'Unreadable';
    case 'no-site':
      return 'No site set';
  }
}

/** A change as the table shows it: `+2` (up two places), `-3` (down three), `0`, `new`, `lost`; empty with none. */
export function changeLabel(change: RankRow['change']): string {
  if (change === null) return '';
  if (typeof change === 'string') return change;
  return change > 0 ? `+${change}` : String(change);
}

/**
 * The rankings view's note on how far back history goes (Decision 15: a reading lives as long as its
 * capture), by the project's retention mode (`{n}` its value), and on whose view a position is.
 */
export const RANK_HISTORY_NOTE = {
  forever: 'This project keeps every capture, so its rank history reaches back to the first reading.',
  versions: 'This project keeps the newest {n} versions of each search, so its rank history reaches back only that far; result pages change often, so that can be days.',
  days: 'This project keeps captures for {n} days, so its rank history reaches back {n} days.',
  profile: 'Positions are as your signed-in browser profile sees them: an engine may tailor results to the account, location and history of that profile.',
} as const;

/** The full note for a project's retention (`RANK_HISTORY_NOTE`): its horizon, then whose view it is. */
export function rankHistoryNote(policy: { readonly mode: RetentionMode; readonly value: number | null }): string {
  const horizon = RANK_HISTORY_NOTE[policy.mode].replaceAll('{n}', String(policy.value ?? ''));
  return `${horizon} ${RANK_HISTORY_NOTE.profile}`;
}

// ---- Comparing two readings ---------------------------------------------------------------------

/** How a domain moved from reading A (the earlier pick) to reading B. */
export const COMPARE_MOVEMENTS = ['up', 'down', 'same', 'new', 'gone'] as const;
export type CompareMovement = (typeof COMPARE_MOVEMENTS)[number];

/** One side of a comparison. `features` lists the SERP feature types on its page (in page order, each once). */
export interface SerpComparisonSide {
  readonly readingId: string;
  readonly at: number;
  readonly params: SearchParamsShape | null;
  readonly filters: SerpFilters;
  readonly status: 'ready' | 'unreadable';
  readonly organicRead: number;
  readonly complete: boolean;
  readonly features: readonly SerpFeatureType[];
}

/** A domain's best organic result on one side. */
export interface SerpComparisonPlace {
  readonly position: number;
  readonly url: string | null;
}

/**
 * One owner domain's organic standing on both sides: `change` = A's position − B's (positive: moved
 * up), `null` unless on both; `role` flags the project's site and competitors (by owner domain).
 */
export interface SerpComparisonRow {
  readonly domain: string;
  readonly a: SerpComparisonPlace | null;
  readonly b: SerpComparisonPlace | null;
  readonly movement: CompareMovement;
  readonly change: number | null;
  readonly role: 'site' | 'competitor' | null;
}

/**
 * Two readings side by side (`compareSerps`): per owner domain, then which feature types each page has,
 * and the site's own point on each side (the full Decision 7 rule; `null` with no site). `truncated`
 * when `RANK_LIMITS.maxRows` cut the rows (the site's and competitors' rows are always kept).
 */
export interface SerpComparison {
  readonly a: SerpComparisonSide;
  readonly b: SerpComparisonSide;
  readonly rows: readonly SerpComparisonRow[];
  readonly features: readonly { readonly type: SerpFeatureType; readonly a: boolean; readonly b: boolean }[];
  readonly site: { readonly a: RankPoint; readonly b: RankPoint } | null;
  readonly truncated: boolean;
}

// ---- The `rankings.*` procedures (Phase 10 Task 5; acceptance `rankings.feature.md`, Router and Export) ----

/**
 * Why a rankings procedure answered no data: `not-found` (the project is not a live one, or a reading
 * named is not one of that project's), `store-failed` (the database failed; one log line),
 * `write-failed` (Save CSV: the file the user chose could not be written).
 */
export const RANKINGS_REFUSALS = ['not-found', 'store-failed', 'write-failed'] as const;
export type RankingsRefusal = (typeof RANKINGS_REFUSALS)[number];
export type RankingsRefused = { readonly status: 'refused'; readonly reason: RankingsRefusal };

/**
 * Most stored reading bytes one rank table read loads in all (64 MiB; the repository's
 * `reading_bytes`, summed over every per-search read): once spent, the rows still to read get no
 * points beyond their newest readings (`RankTableRow.capped`).
 */
export const MAX_RANK_TABLE_READ_BYTES = 67_108_864;

/**
 * A row of `rankings.table`: the model's `RankRow`, and `capped` when the search has more readings in
 * the range than were read for its points (`RANK_LIMITS.maxPointsPerSeries`, or the table's byte
 * budget `MAX_RANK_TABLE_READ_BYTES` spent), so its trend and best cover only the newest of them.
 */
export type RankTableRow = RankRow & { readonly capped: boolean };

/**
 * `rankings.table`: the project's rank table (`rows`, `truncated` when `RANK_LIMITS.maxRows` cut it)
 * over its readings and saved searches, with what the view needs around it: the project's retention
 * policy (for `rankHistoryNote`), its site (`null`: none set, or Unfiled), its competitors' domains
 * (the competitor columns, in the project's order) and the tags its saved searches carry (the tag
 * filter's options, sorted).
 */
export type RankTableAnswer =
  | {
      readonly status: 'ok';
      readonly rows: readonly RankTableRow[];
      readonly truncated: boolean;
      readonly retention: { readonly mode: RetentionMode; readonly value: number | null };
      readonly site: { readonly domain: string; readonly subdomains: boolean } | null;
      readonly competitors: readonly string[];
      readonly tags: readonly string[];
    }
  | RankingsRefused;

/** `rankings.series`: one search's points in the range (oldest first, at most `RANK_LIMITS.maxPointsPerSeries`). */
export type RankSeriesAnswer = { readonly status: 'ok'; readonly searchKey: string; readonly points: readonly RankPoint[] } | RankingsRefused;

/** One reading of a search, as the Compare view's date picker lists it. */
export interface ReadingDate {
  readonly readingId: string;
  readonly at: number;
  readonly status: 'ready' | 'unreadable';
}

/** At most this many dates per search (`rankings.readingDates`; the newest). */
export const MAX_READING_DATES = RANK_LIMITS.maxPointsPerSeries;

/** `rankings.readingDates`: one search's readings, newest first, at most `MAX_READING_DATES`. */
export type ReadingDatesAnswer = { readonly status: 'ok'; readonly dates: readonly ReadingDate[] } | RankingsRefused;

/** `rankings.compare`: two readings of one live project side by side (`compareSerps`). */
export type CompareAnswer = { readonly status: 'ok'; readonly comparison: SerpComparison } | RankingsRefused;

/** `rankings.copyCsv`: how many lines (the header aside) main wrote to the clipboard; `null` when nothing was written. */
export type CopyCsvAnswer = number | null;

/** `rankings.saveCsv`: written where the user chose (`rows` lines, the header aside), the dialog cancelled (nothing written), or refused. */
export type SaveCsvAnswer = { readonly status: 'saved'; readonly rows: number } | { readonly status: 'cancelled' } | RankingsRefused;

/**
 * The file name Save CSV… offers (`{date}`: the day, `YYYY-MM-DD`, UTC), in the Downloads folder; the
 * user may change both in main's save dialog. The renderer never names a path or a file name.
 */
export const RANK_CSV_FILE_NAME = {
  table: 'frost-rankings-{date}.csv',
  history: 'frost-rank-history-{date}.csv',
} as const satisfies Readonly<Record<RankCsvKind, string>>;

/** `RANK_CSV_FILE_NAME[kind]` for the time `at` (Unix ms; a time that is not a valid date gives `undated`). */
export function rankCsvFileName(kind: RankCsvKind, at: number): string {
  const date = typeof at === 'number' && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? new Date(at).toISOString().slice(0, 10) : 'undated';
  return (RANK_CSV_FILE_NAME[kind] ?? RANK_CSV_FILE_NAME.table).replace('{date}', date);
}

/** Main's save dialog for Save CSV… (its own words; a CSV filter only). */
export const RANK_CSV_SAVE_DIALOG = {
  title: { table: 'Save rankings as CSV', history: 'Save rank history as CSV' },
  buttonLabel: 'Save',
  filterName: 'CSV file',
  extensions: ['csv'],
} as const;

// ---- The Rankings and Compare views (Phase 10 Task 6; acceptance `rankings.feature.md`, The views) ----

/** A refusal as the views say it (frost's own words). */
export const RANKINGS_REFUSAL_MESSAGES: Readonly<Record<RankingsRefusal, string>> = {
  'not-found': 'That project no longer exists.',
  'store-failed': 'The rankings could not be read. Try again.',
  'write-failed': 'The file could not be written. Try another place.',
};

/** The range filter's options, in `RANK_RANGES` order. */
export const RANK_RANGE_LABELS: Readonly<Record<RankRange, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '365d': 'Last 12 months',
  all: 'All readings',
};

/** The range the Rankings view opens on. */
export const DEFAULT_RANK_RANGE: RankRange = '30d';

/**
 * The rank table's columns, in order (the view's header; one more per competitor, named by its
 * domain, after them). Not the CSV's (`RANK_CSV_COLUMNS`).
 */
export const RANK_TABLE_COLUMNS = ['Search', 'Engine', 'Locale', 'Device', 'Filters', 'Tags', 'Position', 'Change', 'Best', 'Trend', 'Last checked'] as const;

/** How a domain moved, as the Compare view says it (`{n}`: places). */
export const COMPARE_MOVEMENT_LABELS: Readonly<Record<CompareMovement, string>> = {
  up: 'Up {n}',
  down: 'Down {n}',
  same: 'Same',
  new: 'New',
  gone: 'Gone',
};

/** The Rankings and Compare views' own wording. */
export const RANK_VIEW_TEXT = {
  noSite: "Set your site's domain to see its position",
  noReadings: 'No readings yet: capture a search or run Check rankings',
  noTagged: 'No saved search carries this tag.',
  truncated: `Showing the first ${RANK_LIMITS.maxRows} searches.`,
  capped: 'Trend and best cover only the newest readings of this search.',
  allTags: 'All searches',
  noReading: 'Never',
  openResultPage: 'Open this result page',
  seriesEmpty: 'No readings of this search in this range.',
  alsoIn: 'Also in',
  copied: 'Copied {n} rows as CSV.',
  notCopied: 'Nothing was copied.',
  saved: 'Saved {n} rows as CSV.',
  saveCancelled: 'Nothing was saved.',
  exportKinds: { table: 'The table as shown', history: 'Every reading' },
  compareNeedsTwo: 'Choose a search and a date on each side.',
  compareNoDates: 'This search has no readings yet.',
  compareSame: 'Choose two different readings.',
  compareTruncated: `Showing the first ${RANK_LIMITS.maxRows} domains; your site and competitors are always listed.`,
  unreadableDate: 'unreadable',
  siteRole: 'Your site',
  competitorRole: 'Competitor',
  present: 'Yes',
  absent: 'No',
  none: '—',
} as const;
