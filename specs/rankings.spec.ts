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
 */
import type { SearchEngineId } from './browser-polish.spec';
import type { SerpResultType } from './serp-selector-pack.spec';
import type { SerpDevice, SerpFeatureType } from './serp.spec';
import type { SerpReadingSource } from './workspace-db.spec';

export type { SerpResultType } from './serp-selector-pack.spec';

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
  readonly params: SearchParamsShape;
  readonly filters: SerpFilters;
  readonly observedAt: number;
  readonly source: SerpReadingSource;
  readonly snapshot: SerpSnapshotShape;
}

/** Whose position a rank is (Decision 7): the owner domain, the exact host, and whether subdomains count. */
export interface SiteMatch {
  readonly owner: string;
  readonly host: string;
  readonly subdomains: boolean;
}

/** A point's outcome (Decision 6). */
export type RankOutcome = 'ranked' | 'not-found' | 'unknown' | 'unreadable' | 'no-site';

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
