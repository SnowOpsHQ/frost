# Feature: change-intelligence storage

Spec: `specs/capture-db.spec.ts` (`CHANGE_INTEL_TABLES`, `CAPTURED_TABLES`, `AUDIT_TABLES`,
`UNFILED_PROJECT_ID`, `UNFILED_PROJECT_NAME`, `CAPTURE_SOURCES`, `SCREENSHOT_KINDS`,
`RETENTION_MODES`, `PURGE_REASONS`, `UUIDV7_PATTERN`, `SHA256_HEX_PATTERN`, `CAPTURES_DIR_NAME`, the
`MAX_*` caps), and the Schema section of `docs/plans/phase-6-change-intelligence.md` (the contract).
Phase 6 Task 1; builds on `browser-session-db.feature.md` (the session database, its migrations and
`MAX_STORED_URL_LENGTH`). Implemented by `packages/db/src/change-intel/` and reached as the session
store's `changeIntel` repository. Each scenario maps to one named test in
`packages/db/src/change-intel/__tests__/`.

## Behaviour
- **Where.** Nine `ci_*` tables (`CHANGE_INTEL_TABLES`) in the session database, created by
  `0040_change_intelligence`; `0041_change_intelligence_guards` adds the triggers. Plain SQLite SQL
  only, so the schema moves to libSQL unchanged: tables, indexes, `CHECK`s, partial indexes and
  triggers with `RAISE(ABORT, …)`; no `PRAGMA`, `ATTACH`, virtual tables, JSON functions or
  operators, generated columns, `STRICT`, `WITHOUT ROWID` or `AUTOINCREMENT`. No foreign keys: a
  version's parent and a screenshot's capture may be purged before the row that names them, and a
  sync inserts rows in any order.
- **Ids** are lowercase UUIDv7 (`UUIDV7_PATTERN`) made in main by `uuidv7(now)`: the time in
  milliseconds, then a 12-bit counter seeded at random each new millisecond and bumped within one
  (past its top the time moves on a millisecond), then 62 random bits. Ids from one process are
  strictly increasing, also when the clock goes back (the last time is reused). Every row's `id` is
  36 characters (`CHECK`). Times are Unix milliseconds.
- **The repository is dumb about JSON.** Main computes canonical JSON, the snapshot hash and the
  lane key and hands them in; the repository stores text, never parses it, and answers it as text.
  It checks what it can: ids match `UUIDV7_PATTERN`, hashes and lane keys `SHA256_HEX_PATTERN`, page
  URLs are stored as notes are keyed (`http(s)`, no userinfo, no `#fragment`, at most
  `MAX_STORED_URL_LENGTH`), enums, the JSON caps in UTF-8 bytes, times and counts are non-negative
  safe integers. Invalid input is refused (`null` or `false`) and writes nothing. Rows read back are
  checked the same way: a tampered row is skipped (each text read only up to its cap, plus one).
- **Unfiled.** `UNFILED_PROJECT_ID` (`UNFILED_PROJECT_NAME`, retention `forever`, times 0) is
  inserted by the migration. It can be given a render profile or a retention policy, but not
  renamed or deleted.

## Schema (`migrations.test.ts`)
- **Scenario: change-intel-migrations-create-schema** — on an empty database every
  `CHANGE_INTEL_TABLES` table exists with exactly the Drizzle schema's columns (name, type,
  not-null, primary key); every index of the Drizzle schema exists (`ci_versions (lane_key,
  created_at)` and `(page_url, created_at)`; `ci_captures (project_id, created_at)`, `(version_id)`,
  `(page_url, created_at)`; `ci_diffs (to_version_id)` and `(from_version_id)`; `ci_screenshots (project_id, created_at)`,
  `(page_url, created_at)`, `(sha256)`; `ci_project_pages (project_id)` and the unique live
  `(project_id, url) WHERE deleted_at IS NULL`; `ci_project_queries (project_id)` and the unique live
  `(project_id, query, search_params) WHERE deleted_at IS NULL`; `ci_tombstones (purge_id)`), plus
  `ci_tombstones`' unique `(table_name, row_id)`; every trigger of the Immutability section exists
  by name, and no other; the Unfiled row is there; and the `CHECK`s refuse an unknown enum value and a short id.
- **Scenario: change-intel-sql-is-portable** — no `CHANGE_INTEL_MIGRATIONS` SQL contains `PRAGMA`,
  `ATTACH`, `VIRTUAL`, a `json…(` function, `->`, `GENERATED`, `STRICT`, `WITHOUT ROWID` or
  `AUTOINCREMENT`.

## Immutability (`guards.test.ts`, raw SQL on the database file)
The triggers (all in `0041_change_intelligence_guards`):
- **Captured tables** (`T` in `CAPTURED_TABLES`): `T_no_update` refuses every `UPDATE`;
  `T_purge_only` refuses a `DELETE` unless a `ci_tombstones` row names `(T, id)` **and** its
  `purge_id` is a recorded `ci_purges` row; `T_no_resurrect` refuses an `INSERT` of an id a
  tombstone names for `T`; `T_no_replace` refuses an `INSERT` of an id `T` already has.
  `ci_versions_unreferenced_only` refuses a `DELETE` of a version a capture still points at (a purge
  deletes the captures first, in the same transaction), so a capture that raced in after a purge
  was planned aborts the purge rather than being left pointing at nothing.
- **The audit** (`AUDIT_TABLES`): `ci_purges_no_update`, `ci_purges_no_delete`,
  `ci_tombstones_no_update` and `ci_tombstones_no_delete` refuse every change; `ci_purges_no_replace`
  refuses an existing id, and `ci_tombstones_no_replace` an existing id or an existing
  `(table_name, row_id)`.
- **Mutable tables** (`ci_projects`, `ci_project_pages`, `ci_project_queries`): `T_no_delete` refuses
  `DELETE` (tombstone with `deleted_at` instead); `T_id_stays` refuses an `UPDATE` that changes the
  `id`; `T_no_replace` refuses an existing id, and for pages and queries a live row (`deleted_at IS
  NULL`) on an existing live key (`(project_id, url)`; `(project_id, query, search_params)`);
  `ci_project_pages_live_key_unique` and `ci_project_queries_live_key_unique` refuse an `UPDATE` that
  moves a live row onto another live row's key. `ci_projects_unfiled_stays` refuses an `UPDATE` of
  Unfiled that sets `deleted_at`, renames it or changes its `id`.

**Why the INSERT guards.** SQLite's conflict resolution `REPLACE` (`REPLACE INTO`, `INSERT OR
REPLACE`, `UPDATE OR REPLACE`) deletes the conflicting row without firing any DELETE trigger, so the
DELETE guards cannot see it. A `BEFORE INSERT` trigger runs before conflict resolution, so
`_no_replace` refuses first; `UPDATE OR REPLACE` is covered by the UPDATE guards. A consequence: an
upsert (`ON CONFLICT DO NOTHING`, `ON CONFLICT DO UPDATE`) onto an existing row aborts too, so a sync
inserts with `INSERT … SELECT … WHERE NOT EXISTS (…)` and changes a mutable row with a plain
`UPDATE`.

**What the guards do not do.** They bind the app and any SQL that respects the schema. Whoever can
write the database file can also `DROP TRIGGER` (or edit the file directly), and no trigger can
defend against that; reads still skip the malformed rows that result.
- **Scenario: captured-rows-are-immutable** — raw `UPDATE`, `UPDATE OR REPLACE` and `DELETE` on a
  row of each captured table throw and change nothing, and so do `REPLACE`, `INSERT OR REPLACE`,
  `ON CONFLICT DO NOTHING` and `ON CONFLICT DO UPDATE` of the same id; likewise on `ci_purges` and
  `ci_tombstones`.
- **Scenario: purge-needs-a-tombstone** — a tombstone whose `purge_id` names no recorded purge does
  not let the delete through; once that purge row exists, the same delete passes.
- **Scenario: versions-with-captures-stay** — a version a capture points at is not deleted even with
  a recorded purge's tombstone; once that capture is purged in the same transaction, it is.
- **Scenario: tombstoned-ids-never-return** — after a row is purged, inserting a row with its id
  into the same table throws, through `INSERT`, `REPLACE`, `INSERT OR REPLACE` or an upsert, and the
  repository refuses it; rewriting its tombstone (same id, another row) to free the id is refused.
- **Scenario: purges-and-tombstones-are-immutable** — a purge row and a tombstone cannot be updated,
  deleted or replaced (a tombstone neither under its own id for another row nor under a new id for
  the same row), not even inside a transaction.
- **Scenario: unfiled-project-cannot-be-deleted** — `tombstoneProject(UNFILED_PROJECT_ID)` answers
  `false`; a raw `UPDATE` setting its `deleted_at`, renaming it or changing its `id` throws, and so
  does a `REPLACE`, `INSERT OR REPLACE` or upsert of its row. On every mutable table a raw `DELETE`,
  a replace or upsert of a row, and an `UPDATE OR REPLACE` onto another row's id throw; a page or
  query inserted or moved onto a live row's key throws, a tombstoned row's key is free again.

## Ids (`ids.test.ts`)
- **Scenario: uuidv7-ids-are-time-ordered** — ids match `UUIDV7_PATTERN` and carry their time in
  the first 48 bits; ten thousand ids made in a tight loop at one millisecond are strictly
  increasing (the counter overflows into the next millisecond); ids of later milliseconds sort
  after earlier ones; a clock going back still gives an increasing id. `isUuidv7` accepts exactly
  the pattern.

## Captures (`captures.test.ts`)
A capture belongs to a live project and a **lane** (`lane_key`: main's SHA-256 of the canonical
`{url, renderProfile, searchParams}`). The lane's latest version (its **head**) is, among its rows
with a well-formed id (`UUIDV7_PATTERN`), hash and time, the one with the greatest
`(created_at, id)`; `latestVersion`, `appendCapture`'s read and its in-transaction check all pick it
the same way, so a malformed row can never become a head the reads do not see. `latestVersion`
answers `null` if the head fails its other checks (its URL, say). `appendCapture` (Review Focus: one
transaction, decided inside it):
- the snapshot hash equals the head's → the capture points at that version (no new version, no
  diff; a diff handed in is ignored);
- else a new version is inserted with `parent_version_id` the head (or `null`), and with it the
  capture and, when main could read the head, the diff handed in (`from` the head, `to` the new
  version). A diff is needed exactly when `latestVersion` answers the head: a missing diff, a diff
  when it answers `null` (an empty lane, or an unreadable head), or a diff from another version
  answers `{ status: 'stale' }` and writes nothing (main reads `latestVersion` and the parent's
  snapshot again, re-diffs and retries). Under an unreadable head the new version has that head as
  its parent and no stored diff, so the lane moves on.
- The new version sorts strictly after its parent by `(created_at, id)`: if its time is earlier,
  or equal with a lower id, it takes the parent's time plus one millisecond (its capture keeps the
  time it was given).
- The latest-version check, the project's liveness and the inserts are one batch: each insert is
  conditional on what the check saw, so a capture that raced another one into the same lane is
  refused as stale, never written against a parent that is no longer the latest.
- **Scenario: same-hash-reuses-the-lane-version** — two captures with the same hash in one lane give
  one version with two captures (`newVersion` true, then false); the same hash in another lane (the
  same URL with another render profile) is a version of its own; after a different hash, the first
  hash again is a new version (A → B → A is three versions).
- **Scenario: new-version-stores-its-diff** — a changed capture with a diff from the latest version
  stores the version (parent set) and the diff; `diffFor(parent, version)` answers it; `version(id)`
  answers the snapshot text as given and its byte size.
- **Scenario: new-version-sorts-after-its-parent** — a new version at its parent's time with a
  lower id, or at an earlier time, gets the parent's time + 1 and is the lane's latest; its diff has
  that time; a later time, or the same time with a higher id, is kept as given.
- **Scenario: tampered-lane-head-does-not-block** — later rows with a malformed id, hash or time are
  never the head: the next capture diffs against the real head. A well-formed head with a tampered
  URL reads as `null`; a capture with no diff then goes in after it (parent set, no stored diff) and
  becomes the head; a diff from the unreadable head is `stale`.
- **Scenario: omitted-limit-is-a-full-page** — `history`, `pages`, `screenshots` and `purges` with no
  `limit` answer up to `MAX_HISTORY_PAGE`; a given `limit` still caps them.
- **Scenario: stale-diff-parent-is-refused** — a diff from a version that is no longer the latest, a
  diff when the lane has no version yet, and no diff when it has one, each answer `stale` and write
  nothing. Two captures racing into one lane, both diffed against the same latest version (both
  read it before either writes): one is appended, the other is refused inside its transaction.
- **Scenario: history-pages-newest-first** — `history({ pageUrl })` lists the page's versions
  across lanes newest first by `(created_at, id)`, at most `limit` (≤ `MAX_HISTORY_PAGE`), with a
  cursor to the next page; each has its lane, profile and search-parameter text, hash, parent,
  capture count and last capture time, and the stored diff's summary and change count against its
  parent (none for the first). With `projectId` only versions captured in that project, counted in
  that project. The URL is matched without its fragment.
- **Scenario: screenshots-round-trip** — `appendScreenshot` stores a row (an `area` needs its rect,
  the other kinds have none; a `captureId` must name a capture; the project's liveness and the
  capture are checked inside the insert); `screenshot(id)`,
  `screenshots({ pageUrl | projectId })` newest first with a cursor, `isHashReferenced` and
  `screenshotHashes` (distinct, for the orphan sweep) answer it.
- **Scenario: pages-list-captured-urls** — `pages({ projectId? })` answers each captured page URL
  with its capture count and last capture time, most recently captured first.
- **Scenario: invalid-input-writes-nothing** — a bad id, hash, lane key, URL, enum, time, count,
  over-cap JSON, unknown or tombstoned project, an existing id, or an unknown screenshot capture is
  refused (`null`/`false`) and no row is written.
- **Scenario: tampered-rows-are-skipped** — rows planted with raw SQL (a non-UUID id, a bad hash, a
  `javascript:` URL, an over-cap snapshot, a negative time, an unknown kind, a tampered project) are
  skipped by every read of it. A snapshot over its cap fails `version(id)`; the history, which never
  reads snapshots, still lists that version's summary.

## Retention planning (`retention.test.ts`)
`planPurge({ projectId, policy, now })` is a dry run over one project. A screenshot's **lane** is its
`(page_url, render_profile, search_params)`, so a phone's and a desktop's screenshots of one page
never compete for one slot; its retention group is its lane and its `kind`.
- `forever` → an empty plan.
- `versions N`: in each lane, the versions the project's captures point at are ranked by their
  newest capture **in this project** (newest first, ties by version id descending); the captures of
  the top N stay, the project's other captures are purged. Screenshots: the newest N per
  `(page_url, kind, render_profile, search_params)` of the project stay (by `(created_at, id)`), the
  rest are purged.
- `days N`: the cutoff is `now − N × 86 400 000`. The project's captures created before it are
  purged, except the captures of each lane's newest version (ranked as above), so the next capture
  still has a parent to diff against. Screenshots before the cutoff are purged, except the newest
  per `(page_url, kind, render_profile, search_params)`.
- `all` (internal; the `project-deleted` purge): every capture and screenshot of the project. Only
  for a tombstoned project (Unfiled therefore never has one); `executePurge` takes reason
  `project-deleted` only with `all`, and `all` only with `project-deleted` (any other pairing: `null`).
  The retention policies plan for any project.
- Then: a version whose every capture (in any project) is purged is purged; a diff whose `from` or
  `to` version is purged is purged. `unreferencedHashes` are the purged screenshots' hashes that no
  remaining screenshot row has: only those files may be unlinked. `bytes` is what the purge frees:
  the purged versions' snapshots and the purged diffs' JSON (`length(CAST(… AS BLOB))`), plus each
  unreferenced hash's file size once (the row's `bytes`).
- The plan carries its `now`, sorted id lists, the counts and the bytes.

`executePurge(plan, reason, now)` plans again with the plan's inputs. Different id sets answer
`{ status: 'stale' }` and delete nothing; an empty plan answers `{ status: 'empty' }` and records
nothing. Otherwise one batch (the store's `BEGIN IMMEDIATE` transaction): the `ci_purges` row
(reason, project, the policy as canonical JSON, the counts, the bytes), one `ci_tombstones` row per
row to delete, then the deletes, children first (diffs, screenshots, captures, versions; `IN` lists
of at most 500 ids). It answers `{ status: 'purged', purgeId, plan }`. If the transaction fails it is
rolled back; when planning again then gives other rows (a capture raced in) the answer is `stale`,
otherwise the error is thrown (never `stale`). After it, main unlinks the
files of the answer's `plan.unreferencedHashes` (the plan as executed, planned again), checking
`isHashReferenced` once more before each unlink. `purges({ projectId?, limit })`
answers the purge log newest first.
- **Scenario: forever-plans-nothing** — a `forever` plan is empty and executes as `empty`.
- **Scenario: keep-n-versions-per-lane** — with two lanes of four versions each, `versions 2` keeps
  the captures of each lane's two newest versions (several captures of a kept version all stay) and
  purges the rest; a version last captured again recently ranks by that capture.
- **Scenario: keep-n-days-keeps-latest** — `days 1` purges captures older than a day, keeps newer
  ones, and keeps a lane's newest version's old captures when nothing newer exists in that lane.
- **Scenario: screenshots-follow-the-retention-window** — `versions 1` keeps the newest screenshot
  per lane and kind; `days 1` purges the old ones but keeps the newest per lane and kind; a phone's
  screenshots of a page are kept apart from the desktop's.
- **Scenario: project-deleted-purges-everything-of-a-deleted-project** — `all` on a live project
  plans nothing (`null`); `project-deleted` with a retention plan, and an `all` plan with
  `purge-now` or `retention`, are refused and record nothing; once the project is tombstoned its
  `all` plan executes with `project-deleted`; Unfiled has no `all` plan.
- **Scenario: orphaned-versions-are-purged-with-their-diffs** — versions left with no capture are
  purged with every diff from or to them; a kept version's diff to a kept child stays.
- **Scenario: shared-versions-survive-another-projects-purge** — a version captured in two projects
  survives a purge of all of one project's captures; its other project's capture still points at
  it.
- **Scenario: purge-matches-its-plan** — the executed purge deletes exactly the plan's rows; its
  `ci_purges` row has the plan's counts, bytes, policy and reason; there is one tombstone per
  deleted row; a plan made stale by a later capture is refused and deletes nothing; the purge log
  lists the purge.
- **Scenario: purge-raced-by-a-capture-is-stale** — a capture that reuses a planned-to-go version,
  committed after `executePurge` planned again but before its transaction, aborts the purge
  (`ci_versions_unreferenced_only`): the answer is `stale`, nothing is deleted or recorded, and a new
  plan keeps the version.
- **Scenario: execute-purge-is-one-transaction** — with a failure injected on the last delete (a
  temporary trigger), `executePurge` rejects with that error (the plan is unchanged, so it is not
  `stale`) and every row is still there, with no purge or tombstone row.
- **Scenario: unreferenced-hashes-only** — a hash another kept screenshot row still has is not in
  `unreferencedHashes` and its bytes are not counted; a hash only purged rows had is, once.

## Usage (`retention.test.ts`)
`usage(projectId?)`: `captures`; `versions` the distinct versions the project's captures point at;
`sharedVersions` of those, the ones another project's captures also point at; `snapshotBytes` their
snapshots; `diffBytes` the diffs into them; `screenshots`; `screenshotBytes` the rows' `bytes`, each
distinct hash once. Bytes are stored bytes, measured in SQL with `length(CAST(… AS BLOB))`. Without
a project: the totals over every row (a shared version is one referenced by two or more projects).
- **Scenario: usage-counts-stored-bytes** — the numbers match the UTF-8 sizes of the stored text, a
  shared version is counted in both projects and flagged shared, and a hash stored twice counts
  once.

## Projects (`projects.test.ts`)
Every write sets `updated_at`. A project's name is trimmed, non-blank, at most
`PROJECT_NAME_MAX_CHARS`; at most `MAX_PROJECTS` are live. `projects()` lists the live ones, Unfiled
first, then by creation. `tombstoneProject` sets `deleted_at` on the project and its live pages and
queries (never on Unfiled). Pages: a stored URL (fragment dropped), one live row per
`(project, url)`, at most `MAX_PROJECT_PAGES`; adding a live one again answers it unchanged. Queries:
trimmed, non-blank, at most `PROJECT_QUERY_MAX_CHARS`, with search-parameter JSON (at most
`MAX_SEARCH_PARAMS_JSON_BYTES`), one live row per `(project, query, search_params)`, at most
`MAX_PROJECT_QUERIES`. Retention: `forever` with no value, `versions` 1…`MAX_RETENTION_VERSIONS`,
`days` 1…`MAX_RETENTION_DAYS`.
- **Scenario: projects-crud** — create, rename, list, tombstone; names validated; the cap; a
  tombstoned project is gone from `projects()`/`project()` and takes no captures, pages or settings.
- **Scenario: project-settings** — a render profile (text, cleared with `null`, capped) and the
  retention policy round-trip; out-of-range values are refused.
- **Scenario: project-pages** — add (idempotent, fragment dropped, capped), list, remove;
  `projectsForPage` lists the live projects holding a URL.
- **Scenario: project-queries** — add (idempotent, capped), list, remove.
