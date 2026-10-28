/**
 * Change-intelligence storage (Phase 6 Task 1; acceptance `capture-db.feature.md`; the contract is
 * the Schema section of `docs/plans/phase-6-change-intelligence.md`). Plain values with no imports,
 * so any process can read them without bundling Zod.
 *
 * The tables live in the session database (`DB_FILE_NAME`, `browser-session-db.spec.ts`), created by
 * migrations `0040_change_intelligence` and `0041_change_intelligence_guards`, and are reached only
 * through `@app/db`'s change-intelligence repository (`packages/db/src/change-intel/`). Captured rows
 * are append-only: SQLite triggers refuse every `UPDATE`, and a `DELETE` of a row that no recorded
 * purge's tombstone names. Mutable rows (projects, their pages and queries) are tombstoned with
 * `deleted_at`, never deleted, so a later sync can carry the deletion.
 *
 * The repository is Zod-free and never parses JSON: main hands it canonical JSON text, hashes and
 * lane keys it computed, and validates what it reads back.
 */

/**
 * Every change-intelligence table, in creation order: the mutable ones (projects, their pages and
 * queries), then the captured ones (`CAPTURED_TABLES`), then the purge audit (`AUDIT_TABLES`).
 */
export const CHANGE_INTEL_TABLES = [
  'ci_projects',
  'ci_project_pages',
  'ci_project_queries',
  'ci_versions',
  'ci_captures',
  'ci_diffs',
  'ci_screenshots',
  'ci_purges',
  'ci_tombstones',
] as const;

/**
 * The append-only tables whose rows a purge may delete, once a tombstone of a recorded purge names
 * the row. A purge deletes children first, in the reverse of this order's dependencies: diffs,
 * screenshots, captures, then versions.
 */
export const CAPTURED_TABLES = ['ci_versions', 'ci_captures', 'ci_diffs', 'ci_screenshots'] as const;
export type CapturedTable = (typeof CAPTURED_TABLES)[number];

/** The purge audit: never updated, never deleted. */
export const AUDIT_TABLES = ['ci_purges', 'ci_tombstones'] as const;

/**
 * The project every capture without a project goes to. The migration inserts it (times 0), with the
 * same id on every device so a sync never duplicates it; it cannot be deleted or renamed.
 */
export const UNFILED_PROJECT_ID = '00000000-0000-7000-8000-000000000000' as const;
export const UNFILED_PROJECT_NAME = 'Unfiled' as const;

/** How a capture was taken: by the user on the current tab, or by a project's capture run. */
export const CAPTURE_SOURCES = ['manual', 'project'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** A screenshot of the visible viewport, of the whole page (stitched), or of a selected area. */
export const SCREENSHOT_KINDS = ['viewport', 'full', 'area'] as const;
export type ScreenshotKind = (typeof SCREENSHOT_KINDS)[number];

/**
 * A project's retention: keep everything, keep the captures of each lane's newest N versions
 * (`MAX_RETENTION_VERSIONS`), or keep N days (`MAX_RETENTION_DAYS`) and always each lane's newest.
 */
export const RETENTION_MODES = ['forever', 'versions', 'days'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

/** Why a purge ran: the project's retention, the user's "Purge now", or the project was deleted. */
export const PURGE_REASONS = ['retention', 'purge-now', 'project-deleted'] as const;
export type PurgeReason = (typeof PURGE_REASONS)[number];

/**
 * A row id: a lowercase RFC 9562 UUIDv7 (version nibble 7, variant bits `10`), 36 characters,
 * time-ordered. Generated in main (`packages/db/src/change-intel/ids.ts`); there is no autoincrement.
 */
export const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Snapshot hashes, lane keys and screenshot file hashes: lowercase hex SHA-256. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** The directory, directly in `app.getPath('userData')`, holding change-intelligence files (screenshots). */
export const CAPTURES_DIR_NAME = 'frost-captures' as const;

// ---- Caps (bytes are UTF-8 bytes of the stored text) ------------------------------------------

/** Largest stored capture snapshot (its canonical JSON). */
export const MAX_SNAPSHOT_JSON_BYTES = 1_048_576;

/** Largest stored diff between a version and its parent (its canonical JSON). */
export const MAX_DIFF_JSON_BYTES = 524_288;

/** Largest stored diff summary (counts per region, canonical JSON). */
export const MAX_DIFF_SUMMARY_JSON_BYTES = 4_096;

/** Largest stored render profile (a capture's, a screenshot's, a project's), as JSON. */
export const MAX_PROFILE_JSON_BYTES = 4_096;

/** Largest stored search parameters (a capture's, a screenshot's, a project query's), as JSON. */
export const MAX_SEARCH_PARAMS_JSON_BYTES = 4_096;

/** Largest stored area rectangle of an `area` screenshot, as JSON. */
export const MAX_RECT_JSON_BYTES = 256;

/** At most this many live projects, Unfiled included. */
export const MAX_PROJECTS = 100;

/** At most this many live pages per project. */
export const MAX_PROJECT_PAGES = 200;

/** At most this many live queries per project. */
export const MAX_PROJECT_QUERIES = 50;

/** Longest project name (UTF-16 code units, after trimming); a blank name is refused. */
export const PROJECT_NAME_MAX_CHARS = 80;

/** Longest project query (UTF-16 code units, after trimming); a blank query is refused. */
export const PROJECT_QUERY_MAX_CHARS = 200;

/** `versions` retention keeps at most this many versions per lane (and at least 1). */
export const MAX_RETENTION_VERSIONS = 1_000;

/** `days` retention keeps at most this many days (and at least 1). */
export const MAX_RETENTION_DAYS = 3_650;

/** Largest page of a history, screenshot, page or purge-log read. */
export const MAX_HISTORY_PAGE = 100;
