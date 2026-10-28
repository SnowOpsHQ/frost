# Feature: the row-mirror sync engine and its service

Spec: `specs/sync.spec.ts` (Sync tables: `SYNC_MERGE_RULES`, `SYNC_TABLES`, `SYNC_TOMBSTONE_TABLE`,
`SYNC_PURGE_DELETE_ORDER`, `SYNC_STATE_TABLE`, `SYNC_LOG_TABLE`, `SYNC_PAGE_ROWS`,
`SYNC_MAX_PAGES_PER_PASS`, `SYNC_PUSH_SETTLE_MS`, `SYNC_INTERVAL_MS`, `SYNC_SKIP_REASONS`) and the
plan's Sync design note. Phase 6's schema (`docs/plans/phase-6-change-intelligence.md`, Schema) for
the tables' columns and triggers. Phase 7 Task 8. Code: `apps/desktop/src/main/sync/engine.ts`,
`service.ts`. Tests: `apps/desktop/src/main/sync/__tests__/engine.test.ts` (fixture `ci_*` tables
created in the test with Phase 6's conventions and guard triggers, the session side over
`node:sqlite` and the replica over libSQL `file:`), `service.test.ts` (fake timers, fakes for the
drivers where named). Each scenario maps to one named test. Nothing contacts a remote host.

## Behaviour
- **Rows, not files.** The engine is pure over two `SqlDriver`s: the session database (source) and
  the replica (`frost-sync.db`). It reads and writes only `SYNC_TABLES` and their listed columns,
  plus its own `SYNC_STATE_TABLE` and `SYNC_LOG_TABLE` in the replica. Identifiers come only from
  the spec and are quoted; every value is a bound parameter. A tombstone's `table_name` is used
  only when it is one of `SYNC_PURGE_DELETE_ORDER`'s names (anything else is a row, never SQL).
- **A pass** is a push, then (with an endpoint) the replica's `sync()`, then a pull.
  - **Push** reads the session database's rows after the table's push mark, ordered by
    `(time, id)`, in pages of `SYNC_PAGE_ROWS` (`ci_purges` and `ci_tombstones` whole), merges them
    into the replica, appends a `SYNC_LOG_TABLE` row for each row inserted or changed, and moves the
    mark, all in one replica batch. The mark never passes `now − SYNC_PUSH_SETTLE_MS`.
  - **Pull** reads the replica's log after the table's pull mark, fetches those rows, and merges
    them into the session database in **one batch transaction** (`BEGIN IMMEDIATE`) per page; the
    pull marks move only after it commits.
  - Tables run in `SYNC_TABLES` order; a page that fills stops the direction there (later tables
    wait), so a child never arrives before its parent. Up to `SYNC_MAX_PAGES_PER_PASS` pages.
- **Merge rules** (`SYNC_MERGE_RULES`): `append-only` rows are inserted if missing and never when a
  tombstone names them; `mutable-lww` rows are inserted if missing, else replaced by a version with
  a later `updated_at`. On an equal `updated_at` with different values, the version whose values
  (the spec's columns, as JSON) sort larger wins, so both sides converge (the plan's "larger id"
  cannot tell two versions of one row apart: they share their `id`). Purges and tombstones are
  inserted if missing (a tombstone also not when its `(table_name, row_id)` already has one).
  Every insert is `INSERT … SELECT … WHERE NOT EXISTS`. Tombstones arriving in a page then delete
  the rows they name, in `SYNC_PURGE_DELETE_ORDER` (children first), in the same batch.
- **Marks** live in `SYNC_STATE_TABLE` in the replica, keyed by device ID, direction and table;
  the session database gets no table, row or column from sync.
- **Missing tables.** A table missing on either side (or missing a listed column, or an
  `append-only` one without `ci_tombstones` on both sides) is skipped and reported
  (`SYNC_SKIP_REASONS`). Before Phase 6 merges, every table is skipped as `missing-in-source`.

## Engine (`engine.test.ts`)
- **Scenario: engine-pushes-new-rows** — rows of every fixture table in the session database
  arrive in the replica with the same values; the report counts them; the log has one entry per row;
  the push marks are in the replica.
- **Scenario: engine-pulls-new-rows** — rows written to the replica by another device's push
  arrive in the session database with the same values, and its guard triggers stay quiet.
- **Scenario: engine-late-rows-still-pulled** — a row another device pushes after this device has
  pulled, with a `created_at` older than every row already pulled, still arrives.
- **Scenario: engine-lww** — a newer `updated_at` wins in both directions (rename, and a
  `deleted_at` tombstone, carried as values); an older one loses; on a tie with different values,
  both devices end with the same version (the larger by value); an identical row writes nothing.
- **Scenario: engine-applies-tombstones** — a purge on one device (its `ci_purges` row, tombstones,
  and the children-first deletes) reaches the other: the tombstoned diff, capture and version are
  deleted there, children first, past Phase 6's `_purge_only` and `ci_versions_unreferenced_only`
  triggers; the purge and tombstone rows arrive too. A second tombstone for the same row from a
  third device is not inserted.
- **Scenario: engine-never-resurrects** — a captured row that has a tombstone is never inserted,
  pushed or pulled (and Phase 6's `no_resurrect` trigger never fires).
- **Scenario: engine-skips-missing-tables** — with no `ci_*` table on either side (today), every
  table is reported skipped (`missing-in-source`) and nothing is written but the state table;
  with a table only in the session database, `missing-in-replica`; with a column missing,
  `columns-missing`; with no `ci_tombstones`, the captured tables are `needs-tombstones`.
- **Scenario: engine-is-idempotent** — running the pass again changes nothing (no rows written,
  no log entries); pages of `SYNC_PAGE_ROWS` add up to every row.
- **Scenario: engine-pull-rolls-back** — a pull whose batch fails part-way (a trigger in the
  session database refuses one row) writes nothing there and leaves the pull marks where they were;
  once the cause is gone the next pass applies every row.
- **Scenario: engine-state-in-replica-only** — after passes in both directions the session database
  has exactly the tables it started with; the replica has `SYNC_STATE_TABLE` and `SYNC_LOG_TABLE`.
- **Scenario: engine-quotes-spec-identifiers** — the SQL the engine runs (a recording driver)
  names no identifier outside `SYNC_TABLES`, their columns and its own tables; a tombstone whose
  `table_name` is `history` (or any SQL) is stored as a row and deletes nothing.

## Service (`service.test.ts`)
- **Scenario: service-off-loads-nothing** — with no config, or `enabled: false`, or a tampered one,
  `startSyncService` returns at once, the libSQL opener is never called, no `frost-sync.db` (or any
  file) is created, and no timer is set.
- **Scenario: service-local-staging** — `{"enabled": true}` opens `frost-sync.db` through libSQL
  with neither `syncUrl` nor `authToken`, narrows it (and any sidecar) to 0600 on POSIX, creates
  `SYNC_STATE_TABLE`, writes a `deviceId` into the config, runs a pass at once and another every
  `SYNC_INTERVAL_MS` (fake timers), and `dispose()` stops the timer and closes both databases.
- **Scenario: service-remote-calls-sync** — with a `url` and a token, the opener gets `syncUrl` and
  `authToken` (decrypted by the config store); the replica's `sync()` runs after each push; a
  `sync()` error (whose message holds the token) is logged with the token redacted, and the pass
  still ends; the service never throws.
- **Scenario: service-fail-safe** — the opener rejecting, the session database missing, or a pass
  throwing is one log line each and never a throw; `startSyncService` never throws, even when
  `app.getPath` does.

## Not here
Syncing the real Phase 6 tables (needs Phase 6 merged), any UI or IPC to turn sync on, a remote
`sync()` against a real server, live-key collisions on `ci_project_pages` /
`ci_project_queries`' unique live indexes, compacting `SYNC_LOG_TABLE`, and the screenshot files
(content-addressed blobs needing an object store of their own).
