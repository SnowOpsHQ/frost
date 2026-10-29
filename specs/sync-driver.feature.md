# Feature: the database driver seam (Drizzle over `node:sqlite` or libSQL)

Spec: `specs/sync.spec.ts` (`DB_DRIVER_IDS`, `DEFAULT_DB_DRIVER`, `SYNC_REPLICA_FILE_NAME`,
`NEVER_SYNCED_FILE_NAMES`, `LIBSQL_SYNC_URL_SCHEMES`, `LIBSQL_LOOPBACK_HOSTS`, `LIBSQL_INT_MODE`,
`LIBSQL_SQLITE_VERSION`,
`libsqlFilePath`, `libsqlConfigProblem`) and `specs/browser-session-db.spec.ts` (`MIGRATIONS_TABLE`,
`SESSION_TABLES`). Design doc §2 (Data: `node:sqlite` now, libSQL when sync lands, as a driver swap
behind the async repository API). Phase 7 Task 6; Task 8 builds the sync engine on it.
Code: `packages/db/src/driver-types.ts`, `driver-node-sqlite.ts`, `driver-libsql.ts`,
`driver-drizzle.ts`, `driver-migrations.ts`. Tests: `packages/db/src/__tests__/driver.test.ts`
(plain Node under the db package's vitest; libSQL loads its prebuilt N-API module there). Each
scenario maps to one named test. Nothing here contacts a remote host or launches Electron.

## Behaviour
- **One seam.** A `SqlDriver` runs SQL asynchronously: `execute(sql, params, method)` answers rows
  as arrays in column order (the shape Drizzle's `sqlite-proxy` expects; `get` answers one row or
  nothing), `batch(items)` runs statements, and scripts, in one write transaction (`BEGIN
  IMMEDIATE`) that is rolled back as a whole on any error, `exec(script)` runs a multi-statement
  script outside a transaction, and `close()` (idempotent), `isOpen` and `kind` (`DB_DRIVER_IDS`).
  `createDrizzleOver(driver)` gives the same `SessionDatabase` every repository factory takes.
- **`node:sqlite` stays the default** (`DEFAULT_DB_DRIVER`). `openSessionStore`, `open.ts` and the
  browser-session database are unchanged: `createDrizzle(db)` is `createDrizzleOver` over the
  `node:sqlite` driver, with exactly the semantics it had (`setReturnArrays`, `BEGIN IMMEDIATE` /
  `COMMIT` / `ROLLBACK` in one synchronous callback).
- **libSQL is loaded only when used.** `openLibsqlDriver` imports `@libsql/client/sqlite3` (the
  local client: `file:` databases and embedded replicas, synced by the native module, so the
  WebSocket / HTTP clients never load) with `await import()`; nothing in `@app/db`'s index imports `driver-libsql`, so neither the package nor the
  desktop main bundle loads (or bundles) libSQL.
- **libSQL opens local files only** (`libsqlConfigProblem`, checked before libSQL is loaded): a
  `file:` URL with an absolute path (`file:///…` on POSIX, `file:C:/…` on Windows, since libSQL
  opens whatever follows `file:`), no host, query or fragment, and no UNC / SMB share however
  encoded (no decoded `\` or leading `//`). A `syncUrl` is `libsql:` or
  `https:` (`http:` only to a loopback literal, and only when the caller allows it: the tests), and
  only the sync replica file (`SYNC_REPLICA_FILE_NAME`) may have one, never the browser-session
  database. `authToken` and `syncInterval` need a `syncUrl`. `sync()` exists only with a `syncUrl`.
- **Same values.** libSQL is opened with one connection and `intMode: 'number'`
  (`LIBSQL_INT_MODE`): integers read as numbers, exact to 2^53 − 1 (a larger one throws instead
  of rounding), booleans as 0/1, blobs as `Uint8Array`, as `node:sqlite` reads them.
- **Different SQLite.** libSQL bundles SQLite 3.45.1 (`LIBSQL_SQLITE_VERSION`, compiled with
  `SQLITE_DEFAULT_RECURSIVE_TRIGGERS`, yet its connections read `PRAGMA recursive_triggers` as 0),
  `node:sqlite` in Node 26 and Electron 45 3.53.4. SQL meant for both drivers (migrations, Task 8's
  mirrored tables) uses only what 3.45 supports.
- **Same migrations.** `runMigrationsOver(driver)` applies `MIGRATIONS` with `runMigrations`'
  rules: `MIGRATIONS_TABLE` created if missing; in list order, each migration whose id is not
  recorded runs in its own transaction together with its id row; a failure rolls that migration
  back and rejects; recorded ids the list lacks (a newer build's) are left alone; it answers the
  ids it applied.

## Drivers (`drivers-are-named`)
- **Scenario: drivers-are-named** — `DB_DRIVER_IDS` is `node-sqlite`, `libsql`;
  `DEFAULT_DB_DRIVER` is `node-sqlite`; `LIBSQL_INT_MODE` is `number`. Each driver reports its
  `kind`, is open until `close()` (twice is fine) and then not; reads `PRAGMA recursive_triggers`
  as 0; libSQL runs `LIBSQL_SQLITE_VERSION` and `node:sqlite` a newer SQLite.

## Repositories (`driver.test.ts`, `drivers-run-the-same-repositories`)
- **Scenario: drivers-run-the-same-repositories** — for each driver (`node:sqlite` on a temporary
  file, libSQL on a temporary `file:` URL), migrated with `runMigrationsOver` and wrapped with
  `createDrizzleOver`, the existing repositories behave as their own tests expect:
  - session: a strip round-trips (active tab, empty tabs) and saving replaces it; visits record,
    keep a known title, never move time back, and are pruned to `MAX_RECENT_VISITS`; Blocks
    round-trip and Allows are not stored; Clear Browsing Data keeps the strip; pins round-trip;
  - history: newest first, paginated without repeats, LIKE-escaped search, Jump back in;
  - settings: the search engine round-trips; an unknown one is refused;
  - content notes: a target query and drafts round-trip, keyed without the fragment, and clear.

## Migrations (`migrations-over-both-drivers`)
- **Scenario: migrations-over-both-drivers** — on a fresh database each driver applies every
  `MIGRATIONS` id and records it; a re-run applies nothing; an id from a newer build is left alone
  and a new one is applied after the known ones; a failing migration is rolled back (no table, no
  id) and the run rejects. Both drivers end with the same `sqlite_master` (every table, index and
  their SQL), equal to `runMigrations` over `node:sqlite`.

## Transactions (`batch-rolls-back`)
- **Scenario: batch-rolls-back** — on each driver, a batch whose third statement fails (a primary
  key conflict), and a batch whose script fails, leave nothing written and the driver usable; a
  batch that succeeds answers each statement's rows.

## Values (`libsql-reads-numbers`)
- **Scenario: libsql-reads-numbers** — on both drivers, an integer column reads as a `number`
  (2^53 − 1 exactly), a bound `true` is stored as integer 1 and read as 1, a blob as `Uint8Array`;
  a join's columns that share a name all come back, in column order; `execute` with `get` answers
  one row or `undefined`. An integer beyond 2^53 − 1 throws a `RangeError` rather than rounding.

## Loading (`libsql-not-loaded-by-default`)
- **Scenario: libsql-not-loaded-by-default** — importing `@app/db` (its index) does not load
  `@libsql/client` (a module-load spy), and no module the index reaches imports `driver-libsql` or
  `@libsql/client` (the static import graph); opening a libSQL driver does load it.

## URL rules (`libsql-url-rules`)
- **Scenario: libsql-url-rules** — `libsqlConfigProblem`, as a table, and `openLibsqlDriver`
  refusing the same configs before libSQL loads:
  - accepted: `file:///abs/path.db`, `file:/abs/path.db`, `file:C:/abs/path.db` (percent-encoded,
    e.g. a space as `%20`), each naming exactly the path libSQL's own parser reads from it;
    with a `syncUrl` of `libsql://db.example.turso.io` or `https://sqld.example.com:8443` only for
    a file named `frost-sync.db`, with an `authToken` and a whole-second `syncInterval`;
    `http://127.0.0.1:<port>` or `http://[::1]:<port>` only with `allowLoopbackHttp`;
  - refused: another scheme (`libsql:`, `https:`, `http:` as the local `url`), a relative path,
    `:memory:`, a host (`file://host/x`, `file://localhost/x`), a query (`?authToken=`), a
    fragment, an invalid percent-encoding or a NUL; a UNC / SMB share (`file:////srv/…`,
    `file:/%2F%2Fsrv/…`, `%5C%5Csrv%5C…`, a decoded `\` anywhere); `file:///C:/…` (libSQL would
    hand Windows `/C:/…`) and drive-relative `file:C:x`;
  - refused `syncUrl`s: `http:` (any host without `allowLoopbackHttp`; `localhost`, `0x7f.1` or
    another host even with it), `ws:`/`wss:`/`file:`, upper-case schemes, user info, a query
    (`?tls=0`), a fragment, no host, a space or non-ASCII, longer than `MAX_LIBSQL_URL_CHARS`;
  - refused: a `syncUrl` on `frost-browser.db` or on any file but `frost-sync.db`; an
    `authToken` or `syncInterval` without a `syncUrl`; a token with a space or over
    `MAX_LIBSQL_AUTH_TOKEN_CHARS`; an interval that is not a whole number of seconds in range.
  - `libsqlFileUrl` round-trips through `libsqlFilePath` for POSIX (`path.posix`) and Windows
    (`path.win32`) paths with spaces, `#`, `%`, `?` and non-ASCII, and for the real platform's
    temporary path, which then opens; it refuses a relative path and, on Windows, a UNC or `\\?\`
    path.
  - A driver opened without a `syncUrl` has no `sync()`.
