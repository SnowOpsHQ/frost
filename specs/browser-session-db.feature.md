# Feature: local browser-session database

Spec: `specs/browser-session-db.spec.ts` (`DB_FILE_NAME`, `CORRUPT_FILE_INFIX`,
`DB_SIDECAR_SUFFIXES`, `MIGRATIONS_TABLE`, `SESSION_TABLES`, `MAX_RESTORED_TABS`,
`MAX_RECENT_VISITS`, `MAX_STORED_URL_LENGTH`, `MAX_STORED_TITLE_LENGTH`, `SESSION_WRITE_BATCH_MS`,
`DB_BUSY_TIMEOUT_MS`, `DB_FILE_MODE`, `CORRUPTION_RESULT_CODES`, `CLEAR_BROWSING_DATA`),
`specs/browser.spec.ts` (`BROWSABLE_SCHEMES`, `BROWSE_PARTITION`) and `specs/permissions.spec.ts`
(`SITE_PERMISSIONS`, `REMEMBERED_DECISIONS`, `PERSISTED_DECISIONS`). Design doc §2 (Data). Phase 1 Task 5; builds on `tabs.feature.md`
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
  in `packages/db/src/schema.ts` and the migration SQL agree column for column. Migration `0002`
  changes no table: it deletes every stored decision that is not a Block (the Allows earlier builds
  persisted), since only Blocks persist now.
- **Migrations** are numbered SQL strings compiled into the main bundle (nothing is read from disk
  or `node_modules` at runtime). At startup the runner applies, in id order, each migration whose id
  `MIGRATIONS_TABLE` lacks, each in its own transaction together with its id row. Forward-only:
  there are no down migrations, an applied migration never runs again, and ids are strictly
  increasing. Running them again is a no-op. Ids the database has but the app does not know (a
  newer build's) are left alone.
- **Corrupt or unusable file.** Opening waits up to `DB_BUSY_TIMEOUT_MS` for another
  connection's lock. On POSIX the file is narrowed to `DB_FILE_MODE` (0600) whenever it is opened.
  Only a file known to be broken is moved aside: a path that is not a regular file (checked with
  `lstat`: a directory, or a symlink, which is never followed), an error whose SQLite primary
  result code is one of `CORRUPTION_RESULT_CODES` (`SQLITE_CORRUPT`, `SQLITE_NOTADB`), or a failed
  `PRAGMA quick_check`. It is renamed to `<file>CORRUPT_FILE_INFIX<ms timestamp>` with any
  `DB_SIDECAR_SUFFIXES` sidecar left beside it (SQLite itself drops the sidecars of a file it
  rejects), a fresh database is created in its place, and one line is logged saying what really
  happened. **Any other failure** — busy or locked past the timeout, I/O error, disk full, out of
  memory, cannot open (permissions), a failed migration — leaves the file in place for the next
  launch: the app runs on an in-memory database (nothing persists this run), logged once. If the
  fresh file cannot be created either, or the directory cannot be, the same in-memory fallback
  applies. The app always starts.
- **Single instance.** One frost per profile: main takes `app.requestSingleInstanceLock()` before
  it opens anything; a second launch on the same `userData` quits (the first instance, on
  `second-instance`, restores and focuses its window, or opens one if it has none), so two
  instances never save over each other's session. **Startup first:** a `second-instance` or
  (macOS) `activate` is acted on only once startup is complete (the saved session restored and the
  first window opened); one arriving earlier, even after the app is ready, waits for that, so it can
  never open a window before the restore or a second window next to the first.
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
  - When the window closes (`close`), a last change of its strip is saved (none if it is already
    saved, or the window is closed as it started: a macOS window reopened from the dock on an
    empty tab keeps the session saved before it); the empty tab the controller is left with
    afterwards is never saved, so the next launch restores the window that was closed.
- **Restore.** At startup, before the first window is attached (so the chrome's first state
  already has them), the saved tabs replace the controller's initial empty tab. A row whose URL is
  not a browsable `http(s)` URL — `file:`, `app:`, `javascript:`, `data:`, garbage — is **skipped**
  (`restore-skips-non-browsable-urls`); the controller checks again (and strips userinfo again)
  before loading. Loading reads at most `MAX_RESTORED_TABS` rows and, in SQL, at most what can be
  stored of each value, so a tampered file with huge rows cannot slow startup. The active
  tab is the saved active one, else (it was skipped) the next surviving tab to its right, else the
  last one. No rows, or no valid rows, restore one empty tab. Only the active tab loads at once; a
  background tab shows its saved title and URL and loads when first activated. A restored tab
  keeps its saved URL until its view commits something: if that first load is aborted, Reload
  loads the saved URL again; a typed navigation replaces it. Loading a restored tab's saved URL is
  not a visit.
- **Visits.** A committed main-frame navigation to an `http(s)` URL (`did-navigate`, and
  main-frame `did-navigate-in-page`) records a visit: `visit_count` + 1 and `last_visit_at` = now
  for its URL (userinfo stripped; over-long URLs not recorded). Error pages record nothing
  (Electron emits no `did-navigate` for them). A later title of that page updates the visit's
  title (capped); a title never creates a visit. After each batch the table is pruned to the
  `MAX_RECENT_VISITS` most recent rows.
- **Permission decisions.** Only **Block** decisions persist (`PERSISTED_DECISIONS`), keyed as
  `permissions.feature.md` keys them (requesting origin, top-level origin, `SitePermission`): they
  are loaded into memory at startup and written through when answered. An **Allow** is remembered
  in memory for the app session only (never written; the next launch asks again), so a grant never
  outlives the session the user gave it in. Rows with a non-`http(s)`-origin, an unknown
  permission, or any decision but Block (an Allow, a tampered value) are skipped on load, and the
  repository writes nothing but Blocks. An Allow given after a stored Block is in memory only: the
  Block is back after a relaunch. Dismissals, timeouts and the prompt back-off stay in memory for
  the app session only.
- **Clear browsing data.** The application menu has **Clear Browsing Data…**
  (`CLEAR_BROWSING_DATA`; the File menu, the app menu on macOS). Main asks first with a native
  message box (`dialog.showMessageBox`, parented to the focused window, else the app's window;
  Cancel is the default). Cancelling changes nothing. Confirming clears, in this order: every
  permission decision in memory (Allows and Blocks) and the prompt back-off; then, in one
  transaction after every earlier write, every `recent_visits` and `site_permissions` row (visits
  still pending in the writer are dropped, so none is written back; the tab strip is kept); then
  the browse partition's storage (`session.fromPartition(BROWSE_PARTITION).clearStorageData()`:
  cookies, local storage, IndexedDB, service workers, cache storage …) and its HTTP cache
  (`clearCache()`). One part failing is logged and the others still run. No tab is closed or
  reloaded, and the app UI's own session is untouched. Pending prompts stay pending (they are
  undecided); one that was narrowed by a now-forgotten decision grants only requests whose every
  permission is remembered Allowed when it is answered (`permissions.feature.md`, Remembered
  decisions).
- **Batched writes.** Tab and visit writes are batched by `SESSION_WRITE_BATCH_MS`: a navigation
  storm writes at most once per batch window (the latest tab list, all its visits, in one
  transaction). Pending writes are flushed on quit: the first `will-quit` is held until the flush
  is done and the database closed, then the app quits again (from a task of its own: Electron
  ignores a quit made while it is still dispatching `will-quit`). A failed write never throws into
  the app; each kind of failure (SQLite primary result code, else message) is logged once.

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
- **Scenario: migration-0002-drops-stored-allows** — a database migrated to `0001` holding Allow
  and Block rows keeps only the Block rows after the migrations run (`0002` recorded once).

## Opening (`packages/db/src/__tests__/open.test.ts`, a temp directory on disk)
- **Scenario: db-file-in-given-dir** — opening creates `<dir>/DB_FILE_NAME` (and the directory),
  migrated; reopening keeps the data.
- **Scenario: corrupt-db-moved-aside** — a garbage file (with stale sidecars) is renamed to
  `DB_FILE_NAME + CORRUPT_FILE_INFIX + <now>`, no stale sidecar is left next to the fresh migrated
  database, and exactly one line is logged.
- **Scenario: non-regular-file-moved-aside** — a directory in the file's place, a symlink to a
  valid database elsewhere, and a dangling symlink are each moved aside (the link itself, never
  its target, which stays untouched and is never created) and a fresh regular file opens.
- **Scenario: unreadable-db-left-in-place** (POSIX, not root) — a database file that cannot be
  opened (mode 000) is left in place with its data; an in-memory database is used, and the one
  log line claims no move.
- **Scenario: only-corruption-moves-aside** — `shouldMoveAside` is true for
  `CORRUPTION_RESULT_CODES` (primary and extended codes) and a failed `quick_check`
  (`CorruptDatabaseError`), and false for everything else: `SQLITE_ERROR`, `BUSY`, `LOCKED`,
  `NOMEM`, `READONLY`, `IOERR` (and its extended codes), `FULL`, `CANTOPEN`, `AUTH`, a plain error.
- **Scenario: db-file-is-private** (POSIX) — a fresh file has mode `DB_FILE_MODE`; an existing
  0644 file is narrowed to it when opened.
- **Scenario: busy-db-waits-for-lock** — a lock another process holds for a quarter of
  `DB_BUSY_TIMEOUT_MS` is waited out: the file itself is opened, nothing is logged.
- **Scenario: busy-db-not-moved-aside** — a database exclusively locked by another connection
  past the timeout is left in place; an in-memory database is used and one line, claiming no
  move, is logged.
- **Scenario: memory-fallback-when-nothing-opens** — when the directory cannot be created (it is
  a file), an in-memory database is used; the app still gets a working store, and the log line
  claims no move.

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
- **Scenario: oversized-tampered-rows-skipped** — a planted 40 MB URL and 40 MB title before
  300k more rows load in well under 100 ms: the URL row is skipped, the title is capped, and only
  `MAX_RESTORED_TABS` rows are read.
- **Scenario: restore-is-capped** — more than `MAX_RESTORED_TABS` rows load as the first
  `MAX_RESTORED_TABS`.
- **Scenario: visits-recorded** — recording a URL twice gives one row with `visit_count` 2 and the
  later `last_visit_at`; a title update sets its title.
- **Scenario: visits-only-browsable** — non-`http(s)` and over-long URLs are not recorded; userinfo
  is stripped; titles are capped; a title for a URL never visited creates nothing.
- **Scenario: visits-pruned-to-max** — beyond `MAX_RECENT_VISITS` rows, the least recently visited
  are deleted.
- **Scenario: permission-decisions-round-trip** — saved Blocks load back per (origin, top-level
  origin, permission); saving one again for the same key keeps one row.
- **Scenario: only-blocks-are-stored** — saving an Allow writes nothing (a stored Block for its
  key stays); an Allow row planted in the file is not loaded.
- **Scenario: tampered-permission-rows-skipped** — rows with a non-origin, an unknown permission
  or an unknown decision are not loaded.
- **Scenario: clear-browsing-data-in-repository** — `clearBrowsingData()` deletes every visit and
  every stored decision and keeps the saved tab strip.

## Writer (`packages/db/src/__tests__/writer.test.ts`, fake timers)
- **Scenario: writes-are-batched** — a storm of tab saves and visits within
  `SESSION_WRITE_BATCH_MS` is written once, carrying the latest tabs and every visit.
- **Scenario: flush-writes-pending** — `flush()` writes what is pending at once (before the timer)
  and resolves after it is on disk; `close()` flushes, then closes the database.
- **Scenario: permission-decisions-written-at-once** — a decision is written without waiting for
  the batch window.
- **Scenario: write-failures-logged-once-per-kind** — writes that throw never reject into the
  caller; the same kind of failure (disk full, three times) is logged once, and each new kind (an
  I/O error, counted once with its extended codes; a non-SQLite error) once more.
- **Scenario: clear-drops-pending-visits** — `clearBrowsingData()` runs after every earlier write
  (a decision written just before it is cleared too), drops visits still pending in the batch (they
  are never written), and keeps a pending tab strip, which is still written.
- **Scenario: close-flushes-then-closes** — `close()` writes what is pending, then the database is
  closed (`isOpen` false); a second `close()` is a no-op, and a reopened store reads what was
  pending.

## Controller (`apps/desktop/src/main/browser/__tests__/session.test.ts`)
- **Scenario: restore-recreates-tabs** — restored before the first attach, the first state has
  the saved tabs, order and active tab; only the active tab's view is created and loads its URL; a
  background tab loads its URL when first activated.
- **Scenario: restore-skips-non-web-urls-in-controller** — a non-`http(s)` URL handed to
  `restoreSession` is skipped and userinfo is stripped (defence in depth); none left restores one
  empty tab.
- **Scenario: restore-only-before-first-attach** — `restoreSession` after a window was attached
  changes nothing.
- **Scenario: tab-changes-are-saved** — attaching a window saves nothing; opening, closing,
  activating tabs and committing pages save the new projection (`{ url, title }` per tab, active
  index); an unchanged projection is not saved again.
- **Scenario: error-and-crash-state-not-saved** — a tab whose load failed, or whose renderer
  crashed, is saved with its URL only, and restores as a page that loads again.
- **Scenario: popup-opener-not-saved** — a popup tab is saved as a plain tab; restored, it has no
  opener (the opener's next popup lands right of the opener).
- **Scenario: window-close-keeps-saved-session** — closing a window whose strip is already saved
  saves nothing more, and the empty tab left behind is never saved; a window reopened from the
  dock and closed untouched keeps that session saved; a change made while a window closes is
  saved, nothing after its `close`.
- **Scenario: restored-tab-reload-after-aborted-load** — a restored tab whose first load is
  aborted (`ERR_ABORTED`) keeps its saved URL and title with no error; Reload loads the saved URL
  again (not a `webContents.reload()`); once a page committed, Reload is a plain reload.
- **Scenario: typed-navigation-replaces-restored-url** — after a typed navigation in a restored
  tab, its saved URL is no longer shown or reloaded.
- **Scenario: restore-load-records-no-visit** — committing a restored tab's saved URL (the active
  one at launch, a background one when activated) records no visit; later commits in those tabs
  do.
- **Scenario: visits-recorded-on-commit** — `did-navigate` to an `http(s)` URL and main-frame
  `did-navigate-in-page` record a visit; subframe in-page navigations, non-web URLs and failed
  loads record none; the page's title updates its visit, but not while an error page shows.

## Permissions (`apps/desktop/src/main/browser/__tests__/permissions.test.ts`, "persistent store")
- **Scenario: persistent-decision-store** — Blocks loaded at startup answer requests with no
  prompt (an Allow handed to `load` is ignored); a Block is written through with its key, an Allow
  is not written; after a "relaunch" (a new broker over the same saved decisions) the Blocks
  still answer and the Allows, dismissals and back-off are gone (the next request prompts).
- **Scenario: forget-decisions** — `forgetDecisions()` forgets every remembered Allow and Block
  (memory and store) and the back-off: the next request prompts again, also for a scope that was
  silenced; `check` answers `false`; pending prompts are kept.

## Clear browsing data (`apps/desktop/src/main/__tests__/clear-browsing-data.test.ts`, fakes)
- **Scenario: clear-asks-first** — the action asks for confirmation before anything; when it is
  not confirmed nothing is cleared and it answers `false`.
- **Scenario: clear-clears-everything** — confirmed, it forgets the in-memory decisions, then
  clears the stored visits and decisions, then the browse storage and cache, and answers `true`;
  it closes no tab.
- **Scenario: clear-goes-on-after-a-failure** — a part that throws or rejects is logged once and
  the other parts still run.
- **Scenario: clear-dialog-options** — the confirmation is `dialog.showMessageBox` with
  `CLEAR_BROWSING_DATA.dialog`, parented to the given window (none: an app-modal box); only
  `confirmIndex` confirms.
- **Scenario: clear-browse-storage** — the browse partition's session (`BROWSE_PARTITION`) has
  `clearStorageData()` then `clearCache()` called; the default session is not touched.

## Menu (`apps/desktop/src/main/__tests__/menu.test.ts`)
- **Scenario: clear-browsing-data-menu-item** — `CLEAR_BROWSING_DATA.menuItemId` is in the File
  menu on Linux / Windows and in the app menu on macOS (which keeps About, Services, Hide and Quit),
  labelled `CLEAR_BROWSING_DATA.menuLabel`, with no accelerator; clicking it runs the clear action
  once.

## Single instance (`apps/desktop/src/main/__tests__/single-instance.test.ts`)
- **Scenario: second-instance-quits** — without the lock, `claimSingleInstance` quits the app and
  answers `false` (main then starts nothing).
- **Scenario: second-instance-shows-existing-window** — with the lock, once startup is complete,
  a `second-instance` event restores (if minimized), shows and focuses the first live window; with
  none it opens one.
- **Scenario: second-instance-waits-for-startup** — a `second-instance` that arrives before
  startup is complete (`started` still pending, the app possibly already ready) does nothing yet;
  once `started` resolves it shows the window startup opened and opens none.
- **Scenario: activate-waits-for-startup** — `reopenOnActivate`: an `activate` before startup is
  complete opens nothing, and once it is, sees the window startup opened (no second one); an
  `activate` after startup with no live window opens one.

## Main wiring (`apps/desktop/src/main/__tests__/session-store.test.ts`, real `node:sqlite`, temp dir)
- **Scenario: session-persists-across-reopen** — tabs, visits and Blocks saved through one
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
- **Scenario: allow-is-session-only-e2e** — notifications allowed for a loopback origin are
  `granted` for the rest of that launch; after relaunch `Notification.permission` is no longer
  `granted` (Electron reports a check the app answers `false` as `denied`), a request prompts
  again, and no decision is stored.
- **Scenario: block-decision-persists-e2e** — notifications blocked for a loopback origin are still
  `denied` after relaunch, with no prompt.
- **Scenario: clear-browsing-data-e2e** — with visits recorded, notifications allowed and
  geolocation blocked on loopback origins, and a cookie and local storage set by a page: the menu
  item (triggered through `Menu.getApplicationMenu()`, with `dialog.showMessageBox` stubbed in main
  to record its arguments) first answered Cancel clears nothing; answered with the confirm button
  it asks once more, parented to the app window, and then the tabs are all still open on their
  pages, a reloaded page has no cookie or local storage, both permissions prompt again, and after
  quitting the database has no visit and no decision but still the tab strip.
- **Scenario: db-file-in-user-data-e2e** — `app.getPath('userData')` is the directory passed with
  `--user-data-dir` (compared by real path: on macOS the temporary directory `/var/…` is
  `/private/var/…`) and `DB_FILE_NAME` exists there.
- **Scenario: main-bundle-keeps-node-sqlite-external** — `.vite/build/main.cjs` requires
  `node:sqlite` and requires nothing from `drizzle-orm` (it is bundled).

## Packaged app (manual, recorded in the PR)
The packaged Linux build (`out/frost-linux-x64/frost`, fuses on), launched twice with a temporary
`HOME`/`XDG_CONFIG_HOME`, creates `frost/DB_FILE_NAME` under it and restores its tabs.
