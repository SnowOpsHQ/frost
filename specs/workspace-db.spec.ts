/**
 * Project workspace storage and SERP readings (Phase 10 Task 1; acceptance `workspace-db.feature.md`;
 * the plan's Decisions 1, 2, 3, 8, 9 and 15). Plain values with no imports, so any process can read
 * them without bundling Zod.
 *
 * The tables live in the session database beside Phase 6's `ci_*` tables (`capture-db.spec.ts`),
 * created by migrations `0220`–`0223` (`WORKSPACE_MIGRATION_IDS`), and are reached only through
 * `@app/db`'s change-intelligence repository (`packages/db/src/change-intel/readings.ts` and
 * `workspace.ts`). Competitors and tags are mutable rows with Phase 6's conventions (UUIDv7 ids,
 * tombstoned with `deleted_at`, never deleted, one live row per key). SERP readings are append-only
 * with their own delete guard: a `capture` reading may be deleted only once its capture row is gone.
 * None of these tables is in `CAPTURED_TABLES` (its `ci_tombstones` `CHECK` is frozen in the applied
 * migration `0040`) or in `SYNC_TABLES`: they are device-local in this phase.
 */

/** The Phase 10 tables, in creation order. */
export const WORKSPACE_TABLES = ['ci_project_competitors', 'ci_entry_tags', 'ci_serp_readings'] as const;
export type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];

/** Phase 10's migrations, in order (ids `0220`–`0229` are Phase 10's; `0224`–`0229` are spare). */
export const WORKSPACE_MIGRATION_IDS = ['0220_project_workspace', '0221_project_workspace_guards', '0222_serp_readings', '0223_serp_readings_guards'] as const;

/**
 * Where a SERP reading came from: a capture of a result page (`capture`, Phase 10), or a SERP API
 * (`serp-api`, reserved in the table's `CHECK` now; refused by Phase 10's repository, enabled by Phase 12).
 */
export const SERP_READING_SOURCES = ['capture', 'serp-api'] as const;
export type SerpReadingSource = (typeof SERP_READING_SOURCES)[number];

/** A reading's status: Phase 3's analysed page (`ready`), or a page it could not read (`unreadable`). */
export const SERP_READING_STATUSES = ['ready', 'unreadable'] as const;
export type SerpReadingStatus = (typeof SERP_READING_STATUSES)[number];

/** What a tag is attached to: a project's saved page or its saved search (`ci_project_queries`). */
export const ENTRY_KINDS = ['page', 'search'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** A project's capture cadence: a due notice only (`off` by default). */
export const CAPTURE_CADENCES = ['off', 'daily', 'weekly'] as const;
export type CaptureCadence = (typeof CAPTURE_CADENCES)[number];

/** The version of the search-key rule each reading records (`search_key_version`; plan Decision 4). */
export const SEARCH_KEY_VERSION = 1;

// ---- Caps (bytes are UTF-8 bytes of the stored text) ------------------------------------------

/** Largest stored reading (the `SerpSnapshot` JSON). */
export const MAX_SERP_READING_JSON_BYTES = 524_288;

/** Largest stored filter set of a reading (known filter parameters, JSON). */
export const MAX_SERP_FILTERS_JSON_BYTES = 1_024;

/** At most this many live competitors per project. */
export const MAX_PROJECT_COMPETITORS = 10;

/** At most this many live tags on one page or saved search. */
export const MAX_TAGS_PER_ENTRY = 8;

/** At most this many distinct live tags in one project. */
export const MAX_PROJECT_TAGS = 50;

/** Longest tag (UTF-16 code units); a blank tag, or one with white space around it, is refused. */
export const TAG_MAX_CHARS = 32;

/** Longest stored site or competitor domain (a host name's limit). */
export const DOMAIN_MAX_CHARS = 253;

/** Most readings one `readings(…)` read answers (newest first); a larger `limit` is clamped to it. */
export const MAX_READINGS_PER_READ = 1_000;

/**
 * Most stored reading bytes one `readings(…)` read loads (32 MiB): it answers the newest readings
 * while their running total stays within it, and never reads the JSON of the rest.
 */
export const MAX_READING_BYTES_PER_READ = 33_554_432;
