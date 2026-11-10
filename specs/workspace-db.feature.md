# Feature: project workspace storage and SERP readings

Spec: `specs/workspace-db.spec.ts` (`WORKSPACE_TABLES`, `WORKSPACE_MIGRATION_IDS`,
`SERP_READING_SOURCES`, `SERP_READING_STATUSES`, `ENTRY_KINDS`, `CAPTURE_CADENCES`,
`SEARCH_KEY_VERSION`, the `MAX_*` caps, `TAG_MAX_CHARS`, `DOMAIN_MAX_CHARS`, `MAX_READINGS_PER_READ`,
`MAX_READING_BYTES_PER_READ`), and Decisions 1, 2, 3,
8, 9 and 15 of `docs/plans/phase-10-projects-rank-tracking.md`. Phase 10 Task 1; builds on
`capture-db.feature.md` (Phase 6's `ci_*` tables, their guards and the purge path). Implemented by
`packages/db/src/change-intel/` (`workspace-migrations.ts`, `workspace-schema.ts`, `readings.ts`,
`workspace.ts`, and `repository.ts` / `purge.ts` where the Phase 6 paths take readings, competitors and
tags along), reached as the session store's `changeIntel` repository. Each scenario maps to one named
test; unless named otherwise it is in `packages/db/src/change-intel/__tests__/workspace.test.ts`.

## Migrations
- `0220_project_workspace`, `0221_project_workspace_guards`, `0222_serp_readings`,
  `0223_serp_readings_guards` (`WORKSPACE_MIGRATION_IDS`), spread last in `MIGRATIONS` as
  `...WORKSPACE_MIGRATIONS`, after Phase 9's `0210`. `0224`–`0229` are spare. Plain SQLite 3.45 SQL
  (`LIBSQL_SQLITE_VERSION`), with the same limits as Phase 6's (`change-intel-sql-is-portable`).
  `0040` and `0041` are never edited: `0221` and `0223` reuse Phase 6's guard helpers, exported from
  `change-intel/migrations.ts` with their SQL unchanged.

## Tables
- **`ci_projects` gains** (`0220`, `ALTER TABLE … ADD COLUMN`, so old rows and Unfiled take the
  defaults): `favorite INTEGER NOT NULL DEFAULT 0` (0/1), `site_domain TEXT` (nullable; at most
  `DOMAIN_MAX_CHARS`), `site_subdomains INTEGER NOT NULL DEFAULT 1` (0/1: include subdomains, on by
  default), `capture_cadence TEXT NOT NULL DEFAULT 'off'` (`CAPTURE_CADENCES`), `auto_capture
  INTEGER NOT NULL DEFAULT 0` (0/1). Each has a `CHECK`.
- **`ci_project_competitors`** `(id, project_id, domain, created_at, updated_at, deleted_at)`: up to
  `MAX_PROJECT_COMPETITORS` live per project, one live row per `(project_id, domain)` (unique partial
  index `ci_project_competitors_live_domain`; index `ci_project_competitors_project_id`).
- **`ci_entry_tags`** `(id, project_id, entry_kind, entry_id, tag, created_at, updated_at, deleted_at)`:
  `entry_kind` in `ENTRY_KINDS` (`page` → a `ci_project_pages` row, `search` → a `ci_project_queries`
  row of the same project); one live row per `(entry_kind, entry_id, tag)` (unique partial index
  `ci_entry_tags_live_tag`; index `ci_entry_tags_project_id`); up to `MAX_TAGS_PER_ENTRY` live tags on
  an entry and `MAX_PROJECT_TAGS` distinct live tags in a project; a tag is 1…`TAG_MAX_CHARS` code
  units with no white space around it.
- **`ci_serp_readings`** `(id, project_id, capture_id, source, search_key, search_key_version,
  search_params, filters, page_url, status, pack_version, reading, reading_bytes, observed_at,
  created_at)`: `source` in `SERP_READING_SOURCES`, `status` in `SERP_READING_STATUSES`,
  `CHECK (source <> 'capture' OR capture_id IS NOT NULL)`; index
  `ci_serp_readings_project_id_search_key_observed_at` and the unique partial index
  `ci_serp_readings_capture_id (capture_id) WHERE capture_id IS NOT NULL` (one reading per capture).
  `reading` is the `SerpSnapshot` JSON (at most `MAX_SERP_READING_JSON_BYTES`), `filters` the known
  filter parameters (at most `MAX_SERP_FILTERS_JSON_BYTES`), `search_params` the capture's search
  parameters (at most `MAX_SEARCH_PARAMS_JSON_BYTES`), `search_key` a SHA-256 hex, `observed_at` the
  capture's time, `page_url` the captured page (stored as Phase 6 stores URLs; `NULL` allowed for a
  `serp-api` reading).
- Ids are UUIDv7 (`CHECK (length(id) = 36)`), times Unix milliseconds. No foreign keys.

## Triggers
- **Competitors and tags** (`0221`, Phase 6's `mutable` guards): `T_no_delete`, `T_id_stays`,
  `T_no_replace` (an existing id, or a live row on a live key), `T_live_key_unique` (an `UPDATE` onto
  another live row's key), for `T` in `ci_project_competitors` (key `(project_id, domain)`) and
  `ci_entry_tags` (key `(entry_kind, entry_id, tag)`).
- **Readings** (`0223`):
  - `ci_serp_readings_no_update` (`BEFORE UPDATE`: abort; also covers `UPDATE OR REPLACE`);
  - `ci_serp_readings_no_replace` (`BEFORE INSERT`: abort over an existing `id`, **or** when
    `NEW.capture_id` is not null and a row with that `capture_id` already exists). SQLite's
    `REPLACE` deletes a conflicting row through any unique index without firing a `DELETE` trigger
    (`recursive_triggers` = 0 on both drivers, `sync-package.spec.ts`), so without the second
    condition an `INSERT OR REPLACE` with a fresh reading id and a taken capture id would remove the
    original behind the delete guard's back;
  - `ci_serp_readings_capture_gone_only` (`BEFORE DELETE`: abort unless `OLD.source = 'capture'` and
    no `ci_captures` row has `id = OLD.capture_id`). Phase 12's `0245` drops this one by name and
    replaces it with `ci_serp_readings_delete_guard` (API readings (Phase 12), below).

## Repository
- **Readings** (`readings.ts`). `appendReading(input)` refuses a `serp-api` reading in this phase
  (`false`, nothing written); a `capture` reading goes in only if its capture exists in its (live)
  project and has no reading yet. `appendCapture(input)` takes an optional `reading` and inserts it in
  the capture's own batch, conditional on the capture row existing (`EXISTS (SELECT 1 FROM
  ci_captures WHERE id = captureId)`), in **both** branches (the same hash as the lane's head, and a
  new version); a `stale` append therefore writes no reading. The reading takes the capture's id,
  project, page URL and time (`observed_at`, `created_at`), and `source = 'capture'`. An invalid
  reading (a bad id or key, over a cap, an unknown status) makes the whole append invalid (`null`).
  `readings({ projectId, searchKey?, from?, to?, limit })` answers a project's readings newest first by
  `(observed_at, id)`, `from ≤ observed_at ≤ to`, bounded twice: at most `limit` rows (`limit` is
  required, clamped to 1…`MAX_READINGS_PER_READ`), and only the newest prefix whose running total of
  stored reading bytes (`length(CAST(reading AS BLOB))`) stays within `MAX_READING_BYTES_PER_READ`
  (32 MiB). The sizes are read first, in SQL, with the ids; the JSON is then loaded for that prefix
  only, never beyond the budget. A reading is at most `MAX_SERP_READING_JSON_BYTES`, so a read with
  any reading answers at least one. A caller with a budget of its own across several reads (the rank
  table, `rankings.feature.md`, Router) passes `maxBytes` (clamped to 1…`MAX_READING_BYTES_PER_READ`),
  the bytes it has left: the newest prefix within it, possibly none.
  `countReadings({ projectId, searchKey?, from?, to? })` counts what `readings` would answer without its
  `limit` and byte bounds (one `count(*)`, orphans skipped), so a caller knows when a read was cut.
  `readingDates({ projectId, searchKey, limit })` answers one search key's readings of the project
  newest first, at most `limit` (clamped as `readings`): ids, `observed_at` and status only, the reading
  JSON never loaded (the Compare view's date picker);
  `readingSearches(projectId)` each search key (with its key version) seen, with its newest reading's
  parameters and filters (the newest in the reads' own order, `observed_at` then `id`: read from that
  row, never a grouped query's bare column, which SQLite may take from any row of a tie), its count and
  newest time; `reading(id)` one reading. Every read skips a
  tampered row (each value checked, text read only up to its cap plus one) and a **capture-sourced**
  reading whose capture is gone. `deleteOrphanReadings(projectId?)` deletes the capture-sourced
  readings whose capture row is gone (of one project, or all) and answers how many: a reading of
  another source (`capture_id` `NULL` by design) is never an orphan, so neither the sweep nor the
  read filter is written as "no `ci_captures` row with `id = capture_id`" alone.
- **Workspace** (`workspace.ts`). Competitors: `addCompetitor` (its live row if it has one already;
  `null` past the cap, on Unfiled, an invalid domain, or a project that is not live, even when that
  project still has a live row for the domain),
  `removeCompetitor` (tombstones), `competitors(projectId)`. Tags: `setEntryTags({ projectId,
  entryKind, entryId, tags, now })` makes the entry's live tags exactly `tags` (tombstoning the others,
  in one batch), refusing (`null`, nothing written) an entry that is not a live page or saved search
  of the live project, an invalid tag, more than `MAX_TAGS_PER_ENTRY`, or a project that would hold
  more than `MAX_PROJECT_TAGS` distinct tags; `projectTags(projectId)` lists the project's live tags.
  Project flags: `setProjectFavorite`, `setProjectSite` (a lowercase host of at most
  `DOMAIN_MAX_CHARS`, or `null`, and the subdomains switch; never on Unfiled), `setProjectCadence`
  (`CAPTURE_CADENCES`), `setProjectAutoCapture`; `projectWorkspace(id)` and `projectWorkspaces()` read
  them for live projects. `lastProjectRunAt(projectId)` answers the newest `source = 'project'`
  capture's time (or `null`), for "due". `projectsLastCapturedAt()` answers, in one grouped read
  (`max(created_at)` of `ci_captures` by `project_id`), every live project's newest capture time of
  any source (a project without captures is absent), for the project list's `last-captured` sort
  (Test: `last-captured-at-per-project`).
- **The `updated_at` rule (Decision 9).** The flag setters change their own column only and **never
  `updated_at`**: `ci_projects` merges last-writer-wins on `updated_at`, so a device-local star on one
  device must never beat a real rename on another. Renames, render profiles, retention and deletes
  still set `updated_at` as Phase 6 does.
- **Deletes take workspace rows along.** `tombstoneProject` tombstones the project's live competitors
  and tags in the same batch as its pages and searches. `removePage` / `removeQuery` tombstone that
  entry's live tags in the same batch.
- **Purge (Decision 15).** A reading lives as long as its capture. `executePurge` deletes the purged
  captures' readings in the same batch (one transaction), **after** `ci_captures` (the delete guard
  needs the capture gone). `planPurge` counts their stored bytes (`length(CAST(reading AS BLOB))`) in
  `bytes`; the `ci_purges` columns stay as they are. `usage(projectId?)` gains `readingBytes` (the
  stored readings' bytes, of the project or all).

## Orphans and when the sweeps run
- A capture deleted on this device by another device's purge (sync's `SYNC_PURGE_DELETE_ORDER`)
  leaves its reading behind (sync never touches `ci_serp_readings`). A project deleted on another
  device arrives as its synced `ci_projects.deleted_at` and never runs `tombstoneProject` here, so
  its device-local competitors and tags stay live.
- `projects-main.ts` runs, at startup after `purgeDeleted` (and before retention's startup):
  `deleteOrphanReadings()` and `tombstoneOrphanWorkspaceRows()`; after every purge that answers
  `purged` it runs `deleteOrphanReadings()` (none after `stale`, `empty` or `changed`). A failing sweep
  is logged by its error's name and never fails the purge or the startup chain. Task 5's
  rankings reads run `deleteOrphanReadings(projectId)` for the project first.
- `tombstoneOrphanWorkspaceRows(now?)` sets `deleted_at` (and `updated_at`) on the live competitors
  and tags of every project whose `deleted_at` is set, and on the live tags of a page or saved search
  whose row is tombstoned; it deletes nothing, and answers how many rows it tombstoned.

## Sync position (Decision 9)
- No Phase 10 data syncs in this phase: `SYNC_TABLES` stays exactly Phase 6's nine tables with their
  listed columns. The new `ci_projects` columns have `NOT NULL DEFAULT`s (or are nullable), and the
  sync engine copies listed columns only (its `INSERT` names them, its `UPDATE … SET` sets them), so
  a pulled project keeps this device's favorite, site, cadence and auto-start, and a project first
  pulled here takes the defaults. Readings, competitors and tags are device-local; a follow-up extends
  `SYNC_TABLES` (and its replica). Sync has no "what syncs" wording to update today.

## API readings (Phase 12)
Phase 12 Task 4 (`docs/plans/phase-12-big-bets.md`, Decision 7 and Task 4; `data-sources.feature.md`,
Check via API). Values: `SERP_API_READINGS_TABLES`, `SERP_API_READINGS_MIGRATION_IDS`. Implemented by
`packages/db/src/change-intel/serp-api-migrations.ts`, `serp-api-schema.ts`, `serp-api-readings.ts`, and
`purge.ts` / `repository.ts`; tests in `packages/db/src/change-intel/__tests__/serp-api-readings.test.ts`
unless named otherwise.
- **Migration `0245_serp_api_readings`** (spread in `MIGRATIONS` in id order after Phase 12's `0243`,
  and after `0244` once present): creates `ci_serp_api_purges (reading_id TEXT PRIMARY KEY NOT NULL
  CHECK (length(reading_id) = 36), purge_id, reason (PURGE_REASONS), project_id, purged_at)` with
  the index `ci_serp_api_purges_project_id_purged_at`; drops Phase 10's
  `ci_serp_readings_capture_gone_only`; creates `ci_serp_readings_delete_guard` (`BEFORE DELETE ON
  ci_serp_readings`: abort unless (`OLD.source = 'capture'` and no `ci_captures` row has `id =
  OLD.capture_id`) **or** (`OLD.source = 'serp-api'` and `OLD.id` is in `ci_serp_api_purges`)) and
  `ci_serp_readings_no_resurrect` (`BEFORE INSERT ON ci_serp_readings`: abort when `NEW.id` is in
  `ci_serp_api_purges`). The purge record itself is append-only: `ci_serp_api_purges_no_update` and
  `ci_serp_api_purges_no_delete` (a recorded id stays recorded). `ci_serp_readings_no_update` and
  `ci_serp_readings_no_replace` are untouched; `0223` is never edited. Plain portable SQL.
- **Writes.** Phase 10's public `appendReading` still refuses every source but `capture`, and
  `appendCapture` still writes `capture` readings only. A `serp-api` reading is written **only** by
  `appendApiReading(input)` (`serp-api-readings.ts`): `source = 'serp-api'`, `capture_id` `NULL`, a
  live project, the reading's own checks (`isCaptureReading`), `page_url` a stored URL or `NULL`; never
  over an existing id or a recorded one (`false`, nothing written).
- **Purge.** `planPurge` also selects the project's `serp-api` readings by its policy, **per search
  key** (`search_key`, `search_key_version`): `forever` none; `versions N` all but the N newest of
  each key (newest by `observed_at`, then `id`); `days N` those observed before `now − N days`, except
  each key's newest, which always stays (Phase 6's rule for captures; lead ruling, a deviation from the
  plan's "older than N days"); `all` (the project deleted) every one. The plan carries their ids (`apiReadingIds`, sorted), counts them
  in `counts.readings` (present **only** when at least one is selected, so every other count stays as
  it was) and their stored bytes in `bytes`. `executePurge`'s stale check compares `apiReadingIds`, its
  emptiness check counts them (an API-only plan is purged, not `empty`), and in the same transaction
  it records each id in `ci_serp_api_purges` (with the purge's id, reason and project) and then deletes
  those readings. `counts.readings` is never written to `ci_purges` (its columns are Phase 6's) nor to
  `PurgeRecord.counts`, and a purge that removes **only** API readings writes no `ci_purges` row at all
  (no all-zero row is synced): `ci_serp_api_purges` is its only, device-local, log, and the purge log
  view (`ci_purges`) does not list it. A purge that also removes captured rows writes its `ci_purges`
  row, and its records carry that row's id.
- **Orphans.** `deleteOrphanReadings` sweeps `source = 'capture'` rows only; the reads never skip a
  `serp-api` reading for having no capture.
- **Deleted projects.** `deletedProjectsWithRows` also lists a tombstoned project that still has
  `serp-api` readings, so the startup retry (`purgeDeleted`) finishes its deletion.

## Scenarios
- **Scenario: workspace-migrations-apply-in-order** — `0220`–`0223` run after `0041` and after
  Phase 9's `0210`, in `WORKSPACE_MIGRATION_IDS` order; their SQL is portable; the tables and columns
  match the Drizzle schema; `migrations-are-forward-only` stays green.
- **Scenario: serp-readings-triggers-named** — after `0245`: `ci_serp_readings_no_update`,
  `ci_serp_readings_no_replace`, `ci_serp_readings_delete_guard` and `ci_serp_readings_no_resurrect`
  exist by name in `sqlite_master` (`ci_serp_readings_capture_gone_only` is gone), with the
  competitors' and tags' `mutable` guards.
- **Scenario: serp-readings-are-append-only** — raw `UPDATE`, `UPDATE OR REPLACE`, `REPLACE`,
  `INSERT OR REPLACE`, `INSERT`, `INSERT OR IGNORE` and `INSERT … ON CONFLICT DO NOTHING / DO UPDATE`
  over an existing id, or with a new id over a taken capture id, abort and change nothing.
- **Scenario: serp-reading-replace-over-capture-id-refused** — `INSERT OR REPLACE` (and `REPLACE`)
  with a different reading id and the same capture id aborts and the original row is kept, on
  `node:sqlite` and on libSQL (`file:`).
- **Scenario: serp-reading-deleted-only-without-its-capture** — a reading whose capture exists cannot
  be deleted; once the capture is purged it can; a `serp-api` row (planted with raw SQL) is never
  deleted by the guard.
- **Scenario: serp-api-reading-only-through-appendApiReading** (replaces Phase 10's
  `serp-api-reading-refused-in-phase-10`) — `appendReading` with `source: 'serp-api'` (with or
  without a capture id) and `appendCapture` still refuse it, writing nothing; `appendApiReading`
  writes it (`capture_id` `NULL`), refusing a bad reading, a project that is not live, a taken id and
  a recorded one.
- **Scenario: serp-api-reading-deleted-only-by-a-recorded-purge** — a raw `DELETE` of a `serp-api`
  reading aborts until its id is in `ci_serp_api_purges`; then it succeeds. The record can be
  neither updated nor deleted.
- **Scenario: serp-api-reading-never-resurrected** — inserting a reading (raw, or through
  `appendApiReading`) with a recorded id aborts.
- **Scenario: capture-reading-guard-unchanged** — Phase 10's capture arm is as before: a capture
  reading whose capture exists is never deleted, once its capture is gone it can be, and a recorded
  id does not open a capture reading.
- **Scenario: orphan-sweep-skips-api-readings** — `deleteOrphanReadings` (one project's, and all)
  never deletes a `serp-api` reading; the reads answer it.
- **Scenario: purge-applies-retention-to-api-readings** — `versions N` keeps the N newest of each
  search key, `days N` removes those older than N days but each key's newest, `forever` none, a
  project's deletion (`all`) every one; each purged id is recorded with its purge, reason and project;
  an API-only purge writes no `ci_purges` row; another project's stay.
- **Scenario: api-only-project-obeys-retention** — a project with `serp-api` readings and no capture:
  each mode's plan selects what it should, `executePurge` purges it (never `empty`), and a plan made
  stale by a new API reading is `stale`; its retention purge writes no `ci_purges` row.
- **Scenario: api-only-purge-counts-show-readings** — `counts.readings` is present only when the
  plan selects an API reading; the `ci_purges` row and `PurgeRecord.counts` have no `readings`.
- **Scenario: api-only-project-delete-retried-after-restart** — a tombstoned project with only
  `serp-api` readings is listed by `deletedProjectsWithRows` until its `project-deleted` purge runs,
  which writes no `ci_purges` row.
- **Scenario: reading-goes-in-with-its-capture** — both `appendCapture` branches store the reading
  with the capture (its id, project, page URL and time); a `stale` append writes no reading; an
  invalid reading refuses the append; `readings`, `readingSearches` and `reading` answer it.
- **Scenario: purge-deletes-readings-of-purged-captures** — a retention purge and a `project-deleted`
  purge delete the purged captures' readings in their batch; kept captures keep theirs.
- **Scenario: purge-plan-counts-reading-bytes** — `planPurge`'s `bytes` include the purged readings'
  stored bytes, and the `ci_purges` row records that figure.
- **Scenario: reading-searches-take-the-newest-row** (both drivers) — one key whose readings' parameters
  and filters differ answers the newest reading's, also when it was stored between older ones, and on a
  tie at the newest time the row `readings` answers first.
- **Scenario: readings-read-is-bounded** — a `limit` above `MAX_READINGS_PER_READ` answers that many,
  newest first; readings of `MAX_SERP_READING_JSON_BYTES` each answer only the newest 64 (exactly
  `MAX_READING_BYTES_PER_READ`).
- **Scenario: reading-dates-count-and-byte-budget** — `readingDates` answers one key's readings of
  one project newest first (ids, times, statuses), bounded by `limit`, orphans skipped;
  `countReadings` counts as `readings` filters; `readings` with `maxBytes` answers the newest prefix
  within it (none when the newest alone is larger), never above `MAX_READING_BYTES_PER_READ`.
- **Scenario: orphan-readings-swept** — a capture-sourced reading whose capture is gone is skipped by
  the reads and removed by `deleteOrphanReadings` (of one project, or all); a `serp-api` row with no
  capture is neither skipped nor removed.
- **Scenario: competitors-and-tags-are-tombstoned** — one live row per key; removing a competitor,
  setting other tags, removing the tagged page or search, deleting the project and the orphan sweep
  tombstone (never delete); raw `DELETE` aborts; the caps and validation hold.
- **Scenario: project-flags-default-on-old-rows** — rows that existed before `0220` (Unfiled
  included) read cadence `off`, not favorite, no site, subdomains on, auto start off.
- **Scenario: workspace-updates-leave-updated-at** — the flag setters change their column and leave
  `updated_at`; a rename still sets it.
- **Scenario: usage-counts-reading-bytes** — `usage()` answers `readingBytes`, per project and in
  total.
- **Scenario: last-project-run-at** — the newest `project`-source capture's time; manual captures and
  other projects' runs do not count; `null` without one.
- **Scenario: change-intel-migrations-create-schema** (`migrations.test.ts`) — Phase 6's schema test,
  with the added `ci_projects` columns, the Phase 10 tables, their indexes and triggers.
- **Scenario: sync-keeps-device-local-project-columns** (`apps/desktop/src/main/sync/__tests__/engine.test.ts`)
  — a pulled `ci_projects` row changes its listed columns only; `SYNC_TABLES` is unchanged.
- **Scenario: device-local-change-never-wins-a-rename** (`engine.test.ts`) — device A renames, device
  B stars later; after a pass both have A's name and B keeps its star.
- **Scenario: orphan-readings-swept-after-sync-pull** (`engine.test.ts`) — a pulled tombstone deletes
  a capture; the next sweep removes its reading.
- **Scenario: orphan-competitors-and-tags-tombstoned-after-sync-pull** (`engine.test.ts`) — a pulled
  `ci_projects` row deletes a project; the next startup sweep tombstones its device-local competitors
  and tags, deleting none.
- **Scenario: workspace-sweeps-wired** (`apps/desktop/src/main/changes/__tests__/projects-main-sweep.test.ts`)
  — at startup `purgeDeleted`, then `deleteOrphanReadings` and `tombstoneOrphanWorkspaceRows`, then
  retention's startup; the readings sweep follows a `purged` purge, not a `stale`, `empty` or
  `changed` one; a failing sweep is logged and the chain goes on.
- **Scenario: usage-reports-reading-bytes** (`apps/desktop/src/main/changes/__tests__/retention.test.ts`)
  — the retention service's usage answer carries `readingBytes`.
- **Scenario: usage-rows-show-readings** (`apps/desktop/src/renderer/__tests__/projects-view.test.ts`)
  — the project view's usage rows show "Search readings".
