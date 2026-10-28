# Feature: the row-mirror sync engine and its service

Spec: `specs/sync.spec.ts` (Sync tables: `SYNC_MERGE_RULES`, `SYNC_TABLES`, `SYNC_TOMBSTONE_TABLE`,
`SYNC_PURGE_DELETE_ORDER`, `SYNC_STATE_TABLE`, `SYNC_LOG_TABLE`, `SYNC_PAGE_ROWS`,
`SYNC_MAX_PAGES_PER_PASS`, `SYNC_PUSH_SETTLE_MS`, `SYNC_MAX_CLOCK_SKEW_MS`, `SYNC_MAX_ROW_BYTES`,
`SYNC_INTERVAL_MS`, `SYNC_SKIP_REASONS`, and its notes Where sync runs, What a pull page does when
the session database refuses a row, What a purge does not remove, Device ID) and the
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
    `(time, id)`, in pages of `SYNC_PAGE_ROWS` (every table alike), merges them
    into the replica, appends a `SYNC_LOG_TABLE` row for each row inserted or changed, and moves the
    mark, all in one replica batch. The mark never passes `now − SYNC_PUSH_SETTLE_MS`.
  - **Pull** reads the replica's log after the table's pull mark, measures those rows in SQL and
    skips (unread, counted as `tooLarge`) any over `SYNC_MAX_ROW_BYTES`, fetches the rest, and
    merges them into the session database in **one batch transaction** (`BEGIN IMMEDIATE`) per
    page; the pull marks move only after it commits.
  - Tables run in `SYNC_TABLES` order; a page that fills stops the direction there (later tables
    wait), so a child never arrives before its parent. Up to `SYNC_MAX_PAGES_PER_PASS` pages.
- **Merge rules** (`SYNC_MERGE_RULES`): `append-only` rows are inserted if missing and never when a
  tombstone names them; `mutable-lww` rows are inserted if missing, else replaced by a version with
  a later `updated_at`, where an `updated_at` more than `SYNC_MAX_CLOCK_SKEW_MS` ahead of this
  device's `now` counts as `now + SYNC_MAX_CLOCK_SKEW_MS` (the stored value is unchanged). On an equal `updated_at` with different values, the version whose values
  (the spec's columns, as JSON) sort larger wins, so both sides converge (the plan's "larger id"
  cannot tell two versions of one row apart: they share their `id`). Purges and tombstones are
  inserted if missing (a tombstone also not when its `(table_name, row_id)` already has one).
  Every insert is `INSERT … SELECT … WHERE NOT EXISTS`. On a page where `ci_tombstones` is caught
  up (its page was not full), every row still present that a tombstone names (this page's or an
  earlier one's) is deleted, in `SYNC_PURGE_DELETE_ORDER` (children first), in the same batch; so
  a purge whose tombstones span pages is deleted once all have arrived. The rows go from the
  replica's and the session database's tables, though not necessarily from disk (see Known limits).
- **Marks** live in `SYNC_STATE_TABLE` in the replica, keyed by device ID, direction and table;
  the session database gets no table, row or column from sync.
- **Missing tables.** A table missing on either side (or missing a listed column, or an
  `append-only` one without `ci_tombstones` on both sides) is skipped and reported
  (`SYNC_SKIP_REASONS`). Before Phase 6 merges, every table is skipped as `missing-in-source`.

- **Main thread.** The engine and `sync()` run on Electron's main thread; with an endpoint,
  libSQL's synchronous `sync()` blocks it on network I/O with no timeout. Moving them to a worker
  or utility process is required before remote sync is turned on.

## Engine (`engine.test.ts`)
- **Scenario: engine-pushes-new-rows** — rows of every fixture table in the session database
  arrive in the replica with the same values; the report counts them; the log has one entry per row;
  the push marks are in the replica.
- **Scenario: engine-pulls-new-rows** — rows written to the replica by another device's push
  arrive in the session database with the same values, and its guard triggers stay quiet.
- **Scenario: engine-pull-skips-oversize-rows** — a replica row over the size cap (`maxRowBytes`)
  is not pulled, is counted as `tooLarge`, and is not measured again on the next pass; the rows
  around it arrive.
- **Scenario: engine-late-rows-still-pulled** — a row another device pushes after this device has
  pulled, with a `created_at` older than every row already pulled, still arrives.
- **Scenario: engine-lww** — a newer `updated_at` wins in both directions (rename, and a
  `deleted_at` tombstone, carried as values); an older one loses; on a tie with different values,
  both devices end with the same version (the larger by value); an identical row writes nothing.
- **Scenario: engine-lww-clock-skew** — a row dated ten days ahead still replaces an older one,
  but compares as `now + SYNC_MAX_CLOCK_SKEW_MS`: an edit dated exactly there ties with it and wins
  on values, on every device and in the replica.
- **Scenario: engine-split-purge** — with pages of 2 rows, a purge of six captured rows whose
  tombstones are ordered parents first spans three pages each way; nothing is deleted until all
  its tombstones have arrived, then all six go, children first, past Phase 6's triggers.
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
- **Scenario: engine-pull-rolls-back** — the session database refusing one row (a trigger)
  rolls back that row's whole page: nothing of it is written there, the pull marks stay where they
  were, and every later pass fails on the same page (pull is stalled for every table). Only once
  the cause is removed does the next pass apply every row. This is a known limit, not a feature:
  see Known limits.
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

## Known limits
- **One refused row stalls pull.** A page is one transaction, so a row the session database
  refuses (a trigger or a foreign key; e.g. a tombstone for a version that a capture from a device
  still offline references) rolls back its page, and pull stalls for every table until that is
  handled. Per-row quarantine is required before real tables are synced.
- **A copied profile shares its `deviceId`** (and so its marks) with the original: the two would
  skip rows each other pushed.
- **Purged bytes can remain** in SQLite's free pages, in the remote primary's history (WAL frames,
  backups), and as row IDs in `SYNC_LOG_TABLE`.
- **Main thread.** See Behaviour: remote `sync()` blocks it with no timeout.

## Not here
Syncing the real Phase 6 tables (needs Phase 6 merged), any UI or IPC to turn sync on, a remote
`sync()` against a real server, live-key collisions on `ci_project_pages` /
`ci_project_queries`' unique live indexes, compacting `SYNC_LOG_TABLE`, and the screenshot files
(content-addressed blobs needing an object store of their own).
