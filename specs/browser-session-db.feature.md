# Feature: local browser-session database

Spec: `specs/browser-session-db.spec.ts` (`DB_FILE_NAME`, `CORRUPT_FILE_INFIX`,
`DB_SIDECAR_SUFFIXES`, `MIGRATIONS_TABLE`, `SESSION_TABLES`, `MAX_RESTORED_TABS`,
`MAX_RECENT_VISITS`, `MAX_STORED_URL_LENGTH`, `MAX_STORED_TITLE_LENGTH`, `SESSION_WRITE_BATCH_MS`),
`specs/browser.spec.ts` (`BROWSABLE_SCHEMES`) and `specs/permissions.spec.ts` (`SITE_PERMISSIONS`,
`REMEMBERED_DECISIONS`). Design doc §2 (Data). Phase 1 Task 5; builds on `tabs.feature.md`
(the controller's tabs), `browse-guard.feature.md` (error / crash state, popups) and
`permissions.feature.md` (the decision store). Each scenario maps to one named test.

## Behaviour
- **Engine.** Node's built-in `node:sqlite` (`DatabaseSync`), opened synchronously in Electron's
  main process, queried through Drizzle's SQLite dialect over `drizzle-orm/sqlite-proxy` (Drizzle
  0.45 has no `node:sqlite` driver). No native module ships: `node:sqlite` is a Node builtin, left
  external by the main bundle, and Drizzle is bundled into it. libSQL replaces the driver when
  sync lands (design §2); the schema and the async repository API stay.
- **Where.** One file, `DB_FILE_NAME`, directly in `app.getPath('userData')` (so a
  `--user-data-dir` switch moves it with the rest of the profile).
- **Main only.** `@app/db` and `node:sqlite` are imported only by the main process. The renderer,
  the preload and `@app/ipc-contract` never import them, and no IPC procedure takes or returns SQL:
  the chrome sees restored tabs only as ordinary `BrowserState`.
- **Schema** (migration `0001`): `browser_tabs` (`position` primary key, `url`, `title`, `active`),
  `recent_visits` (`url` primary key, `title`, `visit_count`, `last_visit_at` ms, indexed),
  `site_permissions` (`origin`, `top_level_origin`, `permission` composite primary key, `decision`,
  `updated_at` ms), plus `MIGRATIONS_TABLE` (`id` primary key, `applied_at` ms). The Drizzle schema
  in `packages/db/src/schema.ts` and the migration SQL agree column for column.
- **Migrations** are numbered SQL strings compiled into the main bundle (nothing is read from disk
  or `node_modules` at runtime). At startup the runner applies, in id order, each migration whose id
  `MIGRATIONS_TABLE` lacks, each in its own transaction together with its id row. Forward-only:
  there are no down migrations, an applied migration never runs again, and ids are strictly
  increasing. Running them again is a no-op. Ids the database has but the app does not know (a
  newer build's) are left alone.
- **Corrupt or unreadable file.** If the file cannot be opened, is not a database, fails
  `PRAGMA quick_check`, or fails its migrations, it is renamed to
  `<file>CORRUPT_FILE_INFIX<ms timestamp>` with any `DB_SIDECAR_SUFFIXES` sidecar left beside it
  (SQLite itself drops the sidecars of a file it rejects), a fresh
  database is created in its place, and one line is logged. If even that fails, the app runs on an
  in-memory database (nothing persists this run), logged once. A file that is only **busy**
  (locked by another process) is never moved aside: the app runs on an in-memory database. The app
  always starts.
- **Tabs.** The saved session is the window's tab strip: each tab's URL and title in strip order,
  and which one is active. Saved whenever that projection changes while a window is attached; what
  a window starts with is not a change (a macOS window reopened on an empty tab keeps the saved
  session until something happens in it).
  - Only `http(s)` URLs (`BROWSABLE_SCHEMES`) are stored, without userinfo, at most
    `MAX_STORED_URL_LENGTH` long; any other tab (an empty tab, an over-long URL) is stored as an
    empty tab. Titles are cut to `MAX_STORED_TITLE_LENGTH`. At most `MAX_RESTORED_TABS` tabs.
  - **Not stored:** load error and crash state (the URL is kept, so the tab loads it again), the
    unresponsive and fullscreen state, back/forward history, and popup opener links (a restored
    popup is an ordinary tab).
  - When the window closes (`close`), its session is saved one last time; the empty tab the
    controller is left with afterwards is not saved, so the next launch restores the window that
    was closed.
- **Restore.** At startup, before the first window is attached (so the chrome's first state
  already has them), the saved tabs replace the controller's initial empty tab. A row whose URL is
  not a browsable `http(s)` URL — `file:`, `app:`, `javascript:`, `data:`, garbage — is **skipped**
  (`restore-skips-non-browsable-urls`); the controller checks again before loading. The active
  tab is the saved active one, else (it was skipped) the next surviving tab to its right, else the
  last one. No rows, or no valid rows, restore one empty tab. Only the active tab loads at once; a
  background tab shows its saved title and URL and loads when first activated.
- **Visits.** A committed main-frame navigation to an `http(s)` URL (`did-navigate`, and
  main-frame `did-navigate-in-page`) records a visit: `visit_count` + 1 and `last_visit_at` = now
  for its URL (userinfo stripped; over-long URLs not recorded). Error pages record nothing
  (Electron emits no `did-navigate` for them). A later title of that page updates the visit's
  title (capped); a title never creates a visit. After each batch the table is pruned to the
  `MAX_RECENT_VISITS` most recent rows.
- **Permission decisions.** Allow / Block decisions, keyed as `permissions.feature.md` keys them
  (requesting origin, top-level origin, `SitePermission`), are loaded into memory at startup and
  written through on each answer (an Allow replaced by a Block overwrites it). Rows with a
  non-`http(s)`-origin, an unknown permission or an unknown decision are skipped on load.
  Dismissals, timeouts and the prompt back-off stay in memory for the app session only.
- **Batched writes.** Tab and visit writes are batched by `SESSION_WRITE_BATCH_MS`: a navigation
  storm writes at most once per batch window (the latest tab list, all its visits, in one
  transaction). Pending writes are flushed on quit: the first `will-quit` is held until the flush
  is done and the database closed, then the app quits again (from a task of its own: Electron
  ignores a quit made while it is still dispatching `will-quit`). A failed write is logged once and
  never throws into the app.

## Migrations (`packages/db/src/__tests__/migrations.test.ts`, in-memory `DatabaseSync`)
- **Scenario: migrations-create-schema** — on an empty database, every `SESSION_TABLES` table and
  `MIGRATIONS_TABLE` exist, with exactly the columns (names, types, not-null, primary key) of the
  Drizzle schema, and each migration id is recorded once.
- **Scenario: migrations-are-idempotent** — running the migrations again changes nothing (no error,
  the same rows in `MIGRATIONS_TABLE`, data kept).
- **Scenario: migrations-are-forward-only** — ids are strictly increasing; a migration already
  recorded is not run again even if its SQL would now fail; an unknown recorded id is left alone.
- **Scenario: failed-migration-rolls-back** — a migration that fails part-way leaves neither its
  tables nor its id behind, and the runner throws.

## Opening (`packages/db/src/__tests__/open.test.ts`, a temp directory on disk)
- **Scenario: db-file-in-given-dir** — opening creates `<dir>/DB_FILE_NAME` (and the directory),
  migrated; reopening keeps the data.
- **Scenario: corrupt-db-moved-aside** — a garbage file (with stale sidecars) is renamed to
  `DB_FILE_NAME + CORRUPT_FILE_INFIX + <now>`, no stale sidecar is left next to the fresh migrated
  database, and exactly one line is logged.
- **Scenario: unreadable-db-moved-aside** — a path that cannot be opened as a file (a directory in
  its place) is moved aside the same way and a fresh database opens.
- **Scenario: busy-db-not-moved-aside** — a database exclusively locked by another connection is
  left in place; an in-memory database is used and one line is logged.
- **Scenario: memory-fallback-when-nothing-opens** — when the fresh file cannot be created either
  (its directory is a file), an in-memory database is used; the app still gets a working store.

## Repository (`packages/db/src/__tests__/repository.test.ts`, in-memory `DatabaseSync`)
- **Scenario: session-round-trip** — saved tabs load back with the same URLs, titles, order and
  active tab; saving again replaces the previous session.
- **Scenario: empty-tabs-restore-empty** — empty tabs between pages are saved and load back as
  empty tabs, in place.
- **Scenario: save-stores-only-browsable-urls** — a tab with a non-`http(s)` URL or an over-long
  URL is saved as an empty tab; userinfo is stripped; titles are capped; at most
  `MAX_RESTORED_TABS` tabs are saved.
- **Scenario: restore-skips-non-browsable-urls** (Review Focus) — tampered rows (`file:///etc/passwd`,
  `app://app/`, `javascript:alert(1)`, `data:text/html,x`, `not a url`, a non-string) are skipped
  on load; the valid tabs keep their order; a skipped active tab hands active to its right
  neighbour, else the last tab.
- **Scenario: all-invalid-session-yields-one-empty-tab** — no rows, or only invalid rows, load as
  one empty tab, active.
- **Scenario: restore-is-capped** — more than `MAX_RESTORED_TABS` rows load as the first
  `MAX_RESTORED_TABS`.
- **Scenario: visits-recorded** — recording a URL twice gives one row with `visit_count` 2 and the
  later `last_visit_at`; a title update sets its title.
- **Scenario: visits-only-browsable** — non-`http(s)` and over-long URLs are not recorded; userinfo
  is stripped; titles are capped; a title for a URL never visited creates nothing.
- **Scenario: visits-pruned-to-max** — beyond `MAX_RECENT_VISITS` rows, the least recently visited
  are deleted.
- **Scenario: permission-decisions-round-trip** — saved decisions load back per (origin,
  top-level origin, permission); a later decision for the same key overwrites the earlier one.
- **Scenario: tampered-permission-rows-skipped** — rows with a non-origin, an unknown permission
  or an unknown decision are not loaded.

## Writer (`packages/db/src/__tests__/writer.test.ts`, fake timers)
- **Scenario: writes-are-batched** — a storm of tab saves and visits within
  `SESSION_WRITE_BATCH_MS` is written once, carrying the latest tabs and every visit.
- **Scenario: flush-writes-pending** — `flush()` writes what is pending at once (before the timer)
  and resolves after it is on disk; `close()` flushes, then closes the database.
- **Scenario: permission-decisions-written-at-once** — a decision is written without waiting for
  the batch window.
- **Scenario: write-failure-logged-once** — a write that throws is logged once (not per failure)
  and never rejects into the caller.

## Controller (`apps/desktop/src/main/browser/__tests__/session.test.ts`)
- **Scenario: restore-recreates-tabs** — restored before the first attach, the first state has
  the saved tabs, order and active tab; only the active tab's view is created and loads its URL; a
  background tab loads its URL when first activated.
- **Scenario: restore-skips-non-web-urls-in-controller** — a non-`http(s)` URL handed to
  `restoreSession` is skipped (defence in depth); none left restores one empty tab.
- **Scenario: restore-only-before-first-attach** — `restoreSession` after a window was attached
  changes nothing.
- **Scenario: tab-changes-are-saved** — attaching a window saves nothing; opening, closing,
  activating tabs and committing pages save the new projection (`{ url, title }` per tab, active
  index); an unchanged projection is not saved again.
- **Scenario: error-and-crash-state-not-saved** — a tab whose load failed, or whose renderer
  crashed, is saved with its URL only, and restores as a page that loads again.
- **Scenario: popup-opener-not-saved** — a popup tab is saved as a plain tab; restored, it has no
  opener (the opener's next popup lands right of the opener).
- **Scenario: window-close-keeps-saved-session** — closing the window saves its tabs once more and
  never saves the empty tab left behind.
- **Scenario: visits-recorded-on-commit** — `did-navigate` to an `http(s)` URL and main-frame
  `did-navigate-in-page` record a visit; subframe in-page navigations, non-web URLs and failed
  loads record none; the page's title updates its visit, but not while an error page shows.

## Permissions (`apps/desktop/src/main/browser/__tests__/permissions.test.ts`, "persistent store")
- **Scenario: persistent-decision-store** — decisions loaded at startup answer requests with no
  prompt; an Allow / Block is written through with its key; a dismissal and the back-off are not
  written and are gone after a "relaunch" (a new broker over the same saved decisions).

## Main wiring (`apps/desktop/src/main/__tests__/session-store.test.ts`, real `node:sqlite`, temp dir)
- **Scenario: session-persists-across-reopen** — tabs, visits and decisions saved through one
  opened store load back from a second one on the same directory after the quit flush
  (`flushBeforeQuit`: the first `will-quit` is prevented, the app quits again once flushed, and that
  second `will-quit` passes).
- **Scenario: db-only-in-main** — no source under `apps/desktop/src/renderer`,
  `apps/desktop/src/preload` or `packages/ipc-contract` imports `@app/db` or `node:sqlite`, and
  the IPC contract names no SQL.

## End to end (`apps/desktop/e2e/session-restore.e2e.ts`, real Electron, isolated `--user-data-dir`)
One loopback server runs for the whole file (its port stays the same across relaunches); every
launch passes the same temporary `--user-data-dir`.
- **Scenario: session-restore-e2e** — three tabs on loopback pages, the second active; after quit
  and relaunch the strip shows the same three tabs in order with the second active, and activating
  each shows its URL in the address bar.
- **Scenario: restore-skips-non-browsable-urls-e2e** (Review Focus) — rows planted with
  `node:sqlite` between launches (`file:///etc/passwd`, `app://app/`, `javascript:alert(1)`,
  garbage) are skipped: only the valid tabs come back, and no tab WebContents ever has a
  non-`http(s)` URL.
- **Scenario: all-invalid-session-restores-empty-tab-e2e** — with only invalid rows the app starts
  with one empty tab.
- **Scenario: permission-decision-persists-e2e** — notifications allowed for a loopback origin is
  still `granted` after relaunch, with no prompt.
- **Scenario: db-file-in-user-data-e2e** — `app.getPath('userData')` is the directory passed with
  `--user-data-dir` and `DB_FILE_NAME` exists there.
- **Scenario: main-bundle-keeps-node-sqlite-external** — `.vite/build/main.cjs` requires
  `node:sqlite` and requires nothing from `drizzle-orm` (it is bundled).

## Packaged app (manual, recorded in the PR)
The packaged Linux build (`out/frost-linux-x64/frost`, fuses on), launched twice with a temporary
`HOME`/`XDG_CONFIG_HOME`, creates `frost/DB_FILE_NAME` under it and restores its tabs.
