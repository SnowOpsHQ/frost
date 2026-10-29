# Feature: retention and disk usage

Spec: `specs/retention.spec.ts` (`RETENTION_ENFORCE_MIN_INTERVAL_MS`, `PURGE_LOG_LIMIT`,
`ORPHAN_TMP_MIN_AGE_MS`, `SCREENSHOT_FILE_NAME_PATTERN`, `SCREENSHOT_TMP_NAME_PATTERN`,
`RETENTION_VALUE_BOUNDS`, `isRetentionPolicy`, `RETENTION_REFUSALS` and their messages,
`RETENTION_LABELS`, `RETENTION_RULE_NOTES`, `PURGE_REASON_LABELS`, `USAGE_NOTE`, `PURGE_NOW`,
`COMPACT_DATABASE`, `formatBytes`, `purgeCountsText`, the answer types) and
`specs/retention.schema.ts` (the Zod inputs and answers). What a purge removes is
`specs/capture-db.feature.md` (Retention planning) and the plan's "The purge path"; N's bounds are
`MAX_RETENTION_VERSIONS` and `MAX_RETENTION_DAYS`. Phase 6 Task 7. Implemented by
`apps/desktop/src/main/changes/retention.ts` (the service), `purge-files.ts` (the purge-then-unlink
path it shares with a project's delete), `retention-dialog.ts` and `projects-main.ts` (Electron);
`store.changeIntel.compact()` and `screenshotHashes({ projectId })` in `@app/db`; the `projects.*`
retention procedures of `packages/ipc-contract/src/projects-router.ts`; and the chrome's
`components/changes/Retention.tsx` and `projects-view.ts`.

## Policy
- A project's policy is Keep everything (`forever`), Keep the last N versions of each page
  (`versions`, 1 ≤ N ≤ `MAX_RETENTION_VERSIONS`) or Keep N days (`days`, 1 ≤ N ≤
  `MAX_RETENTION_DAYS`). Unfiled has one too. `setRetention` refuses anything else
  (`invalid-retention`) and a project that is not live (`not-found`); the router refuses it first.
- Setting a policy deletes nothing by itself; it makes the next capture into the project enforce it.

## Preview and Purge now
- `retentionPreview(projectId)` is `planPurge` with the project's policy at `now`: the counts and the
  bytes it would free. A dry run: nothing is written.
- `purgeNow(projectId)`:
  1. a project whose capture run is under way is `running`;
  2. plan; an empty plan answers `empty` (no dialog);
  3. main's message box (`PURGE_NOW`: the plan's counts and bytes, the saved policy in words
     (`policyText`), the project's name quoted and bidi-isolated, each placeholder replaced by a
     function so a `$` pattern in a name stays text; Cancel is the default) — Cancel is `declined`,
     and nothing changes;
  4. the project's policy is read again: if it is not the plan's any more, `changed` (nothing
     deleted); else `executePurge(plan, 'purge-now')`;
  5. `stale` (a capture raced in) plans again and asks again, once; stale twice is `changed`;
  6. each of the purge's `unreferencedHashes`, with the hash's lock held (see Files below), is
     checked again with `isHashReferenced` and its file unlinked only if no row names it
     (`purge-files.ts`, shared with a project's delete);
  7. it answers the purge record's counts, the bytes **really** freed (the rows' stored bytes plus the
     files really unlinked, measured by `lstat`) and how many files went. `ci_purges.bytes` keeps the
     planned figure (`capture-db.feature.md`).

## Files and their lock
- `ScreenshotFiles.lock(sha)` is a per-hash mutex shared by every store over the directory in the
  process. A screenshot holds it from its file's `write` (which may reuse a file no row names yet)
  until `appendScreenshot` settles; a purge (`purge-files.ts`) and the orphan sweep hold it from
  `isHashReferenced` to `unlink`. So a file a new row is about to name is never removed.

## Automatic enforcement
- The project's own policy, as a recorded `retention` purge with no dialog (the user set the policy):
  - after a capture run of the project ends (`afterRun`);
  - after a manual capture or screenshot into the project (`afterCapture`), at most once per
    `RETENTION_ENFORCE_MIN_INTERVAL_MS` per project, and not while a run of it is under way (the
    run's end enforces);
  - at startup, for each project with a policy whose last enforcement is older than the interval.
- The last-enforced times live in memory, seeded at startup from the purge log: each project's newest
  `retention` purge. Enforcements run one at a time; a stale plan is planned again once; a policy
  changed since the plan gives up (the next enforcement follows the new one).
- The changes and screenshots services tell main of each capture or screenshot saved into a project
  (`onCaptured`, `onSaved`); the capture run of its end (`afterRun`).

## Usage
- `usage(projectId | null)`: the repository's numbers (captures, versions and the shared ones, stored
  snapshot and diff bytes, screenshots) and **measured** ones: each screenshot file the rows name,
  once, by `lstat` (a missing file, or one that is not a regular file, is counted as missing and
  shown as "N missing"; the files another project's rows also name are labelled shared), and the
  database file and its `-wal` by `stat` (the session store's `file`;
  in memory: unavailable). Without a project: the totals.
- The note says honestly that deleting frees space inside the file, which shrinks only after Compact
  (`USAGE_NOTE`).

## Purge log
- `purgeLog(projectId | null)`: the newest `PURGE_LOG_LIMIT` `ci_purges` rows (date, reason, policy,
  counts, bytes).

## Compact
- `compact()`: refused (`running`) while any capture run is under way, and (`unavailable`) for an
  in-memory database; else main's message box (`COMPACT_DATABASE`), then `VACUUM` on the session
  database; it answers the file's size (with its `-wal`) before and after. A failing `VACUUM` (all or
  nothing: the file is as it was) is `compact-failed`, with its own message.

## The orphan sweep (startup)
- It lists the screenshot directory (both directories `lstat`ed first: a symlink or a file there is
  refused, and nothing is touched), without following links, and removes only:
  - regular files named `<sha>.png` (`SCREENSHOT_FILE_NAME_PATTERN`) that no row names
    (`screenshotHashes()`, and `isHashReferenced` again just before, with the hash's lock held), older than
    `ORPHAN_TMP_MIN_AGE_MS` (a screenshot being written has its file before its row);
  - regular files named `<sha>.png.tmp-<16 hex>` older than `ORPHAN_TMP_MIN_AGE_MS`.
- Nothing else: symlinks, directories, other names and fresh files stay. One log line with counts.
- It is skipped (nothing listed is removed) when the rows that would name the files may be elsewhere:
  - the session database is `':memory:'` (it fell back: the file on disk, with its rows, is not open);
  - the database looks fresh (`hasAnyChangeIntelRows()` is false: no `ci_screenshots`, `ci_purges` or
    `ci_captures` row) while the directory holds hash-named files: it may have been moved aside as
    corrupt and recreated, and the aside copy still names them.
  Either skip logs one line with counts only (how many hash-named and temporary files were left).

## Router
- `projects.setRetention`, `retentionPreview`, `purgeNow`, `usage`, `purgeLog` and `compact` start
  with `enforceSender`, take strict inputs and check their answers on the way out. No procedure name
  says "query", "sql" or "db".

## The project view
- The retention section: the policy as a radio group with N's input (bounded, `noValidate`: the
  app's own message says what to fix) and Save, and the policy's one-line rule
  (`RETENTION_RULE_NOTES`); the preview line ("Purging now would remove … (≈ X)"), refreshed after
  each change; Purge now (main confirms; the outcome, with the bytes really freed, in the polite live
  region). Both follow the **saved** policy: while the form shows another one, the preview says
  `UNSAVED_POLICY_PREVIEW` (`data-stale`) and Purge now is disabled until Save. Usage (captures,
  versions and shared, screenshots, stored bytes, files with the shared ones and "N missing", the
  database file) with `USAGE_NOTE`; the purge log; Compact database (main confirms; before → after).
- After Purge now (and any change to the projects) the Changes panel reads its history and
  screenshots again.
- The palette: "Purge this project now" and "Compact the change database".

## Scenarios
- **Scenario: retention-spec-values** — bounds, cadence, wording, dialogs, `formatBytes`. Test:
  `apps/desktop/src/main/changes/__tests__/retention.test.ts` `retention-spec-values`.
- **Scenario: set-retention-validates** — Test: `retention.test.ts` `set-retention-validates`.
- **Scenario: preview-writes-nothing** — Test: `retention.test.ts` `preview-writes-nothing`.
- **Scenario: purge-now-confirms-and-matches-its-plan** — counts, bytes, the purge record and the
  tombstones equal the plan; files unlinked only when unreferenced. Test: `retention.test.ts`
  `purge-now-confirms-and-matches-its-plan`.
- **Scenario: purge-now-declined-removes-nothing** — Test: `retention.test.ts`
  `purge-now-declined-removes-nothing`.
- **Scenario: stale-plan-asks-again** — Test: `retention.test.ts` `stale-plan-asks-again`.
- **Scenario: purge-now-gives-up-when-the-policy-changed** — Test: `retention.test.ts`
  `purge-now-gives-up-when-the-policy-changed`.
- **Scenario: the file lock** — a purge and the sweep wait for a screenshot reusing their file, then
  keep it; the screenshots service holds the lock until its row is written; the lock is per hash and
  shared across stores. Tests: `retention.test.ts` `purge-waits-for-a-screenshot-reusing-its-file`,
  `sweep-waits-for-a-screenshot-reusing-its-file`; `screenshots/__tests__/service.test.ts`
  `screenshot-holds-its-file-lock-until-its-row`; `store.test.ts` `screenshot-lock-is-per-hash`.
- **Scenario: enforcement-after-a-run** — Test: `retention.test.ts` `enforcement-after-a-run`.
- **Scenario: enforcement-is-rate-limited** — Test: `retention.test.ts` `enforcement-is-rate-limited`.
- **Scenario: startup-enforcement-uses-the-purge-log** — Test: `retention.test.ts`
  `startup-enforcement-uses-the-purge-log`.
- **Scenario: files-removed-only-when-unreferenced** — Test: `retention.test.ts`
  `files-removed-only-when-unreferenced`.
- **Scenario: orphan-sweep-deletes-only-hash-named-files** — symlinks, directories, odd names, a fresh
  temporary file and a fresh orphan stay; an old temporary file and an old orphan go. Test:
  `retention.test.ts` `orphan-sweep-deletes-only-hash-named-files`.
- **Scenario: sweep-skips-an-in-memory-database** — with `databaseFile` `':memory:'`, an old orphan
  and an old temporary file stay. Test: `retention.test.ts` `sweep-skips-an-in-memory-database`.
- **Scenario: sweep-skips-a-fresh-database** — no capture, screenshot or purge row and old hash-named
  files in the directory: every file stays, one log line with the count; once any row exists the
  sweep runs again. Tests: `retention.test.ts` `sweep-skips-a-fresh-database`; the read:
  `packages/db/src/change-intel/__tests__/retention.test.ts` `has-any-change-intel-rows`.
- **Scenario: usage-counts-measured-bytes** — Test: `retention.test.ts` `usage-counts-measured-bytes`.
- **Scenario: compact-shrinks-and-refuses-during-a-run** — Test: `retention.test.ts`
  `compact-shrinks-and-refuses-during-a-run` (and `compact-failed`); the repository's `VACUUM`:
  `packages/db/src/change-intel/__tests__/retention.test.ts` `compact-vacuums`.
- **Scenario: capture hooks** — the changes and screenshots services report captures and screenshots
  into a project, and a run its end. Tests: `service.test.ts` `capture-reports-its-project`,
  `screenshots/__tests__/service.test.ts` `screenshot-reports-its-project`, `capture-run.test.ts`
  `capture-run-reports-its-end`.
- **Scenario: router** — Tests in `packages/ipc-contract/src/__tests__/projects-router.test.ts`:
  `every-projects-procedure-enforces-sender`, `projects-inputs-are-validated`,
  `projects-procedures-call-service`, `projects-answers-are-checked` (the retention procedures among them).
- **Scenario: the view's helpers and palette** — Tests in
  `apps/desktop/src/renderer/__tests__/projects-view.test.ts`: `retention-view-policy-form`,
  `retention-view-wording`, `retention-palette-actions`.

## End to end (`apps/desktop/e2e/retention.e2e.ts`, one loopback page that changes on each request)
- **Scenario: retention-keep-one-version** — a project with the page, captured three times (three
  versions); "Keep the last 1 version"; the preview; Purge now confirmed in main's dialog; one version
  remains in the Changes panel's history for the project, the purge log lists the purge with its
  counts, and usage shows one capture and one version.

## Known limits
- The database file shrinks only after Compact; usage says so.
- A file removed by hand is counted as missing; frost never re-creates it.
- A crash between a purge's commit and its unlinks leaves files no row names; the next startup's
  sweep removes them once they are older than `ORPHAN_TMP_MIN_AGE_MS`.
