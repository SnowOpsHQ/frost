# Feature: libSQL's native module in the packaged app

Spec: `specs/sync-package.spec.ts` (`LIBSQL_RUNTIME_PACKAGES`, `LIBSQL_UNLOADED_DEPENDENCIES`,
`LIBSQL_PREBUILD_TARGETS`, `LIBSQL_ASAR_UNPACK`, `PACKAGED_UNPACKED_ALLOWLIST`,
`PACKAGED_ASAR_NODE_MODULES`, `LIBSQL_SQLITE_VERSION`), with the resource and archive allowlists
of `linux-package.spec.ts` / `windows-package.spec.ts`. Phase 7 Task 7 (the driver itself is Task 6,
`sync-driver.feature.md`). Code: `apps/desktop/libsql-packaging.ts` (registered in
`forge.config.ts`), `apps/desktop/vite.main.config.ts`.
Config tests: `apps/desktop/src/__tests__/libsql-packaging.test.ts` (every CI run).
Package checks: `verify-package-common.mjs` (`sync-replica-opens` is Task 8's), run by `verify-linux-package.mjs`,
`verify-windows-package.mjs` and `verify-mac-package.mjs`. Each scenario maps to one named test or
check.

## Behaviour
- **Only libSQL leaves the bundle.** Main's bundle keeps `@libsql/client` and `libsql` (and their
  subpaths) external and turns `await import()` into a runtime `require`, so main loads
  `@libsql/client/sqlite3` from `app.asar/node_modules`. Everything else stays bundled.
- **Exactly the runtime set is copied.** Forge's `packageAfterCopy` hook copies
  `LIBSQL_RUNTIME_PACKAGES` and the target's prebuild (`@libsql/<LIBSQL_PREBUILD_TARGETS[target]>`)
  flat into the app's `node_modules/`. Each package is resolved as Node would from the package that
  requires it. Docs, type declarations and source maps are skipped; license files are kept. Nested
  `node_modules/` and symlinks are never copied.
- **Only the prebuild is unpacked.** `asar.unpack` is `LIBSQL_ASAR_UNPACK`: a prebuild's
  `index.node` and nothing else. All JavaScript stays in `app.asar`; `OnlyLoadAppFromAsar` and the
  other fuses are unchanged.
- **Integrity, honestly.** `app.asar`'s header records the unpacked file (`unpacked`, size,
  SHA-256), and that header is covered by Electron's ASAR integrity check on macOS and Windows.
  Electron never hashes the unpacked file's bytes when it loads them. On Windows and Linux nothing
  does at runtime; `unpacked-allowlist` compares the file with the header at build time only. On
  macOS, signing can rewrite the Mach-O after the header was written: a Developer ID run does, and
  the ad-hoc re-seal may. So the bundle signature alone vouches for its bytes
  (`signature-verifies`).
- **The packaged binary loading the prebuild (Task 8).** `libsql-loads` runs the repository's
  Electron, at the packaged version, as Node. It cannot run the packaged executable, whose
  `RunAsNode` fuse is off. `sync-replica-opens` runs the packaged executable itself, with its fuses
  (and on macOS its re-signed bundle, so library validation decides), on a profile whose sync
  config turns local staging on, and confirms main opened the replica through libSQL.
- **Cross-target builds fail closed.** pnpm installs only the build machine's own prebuild, so
  packaging another platform (`--platform win32` on Linux) fails in the hook with a message naming
  the missing package. CI packages each platform on its own runner.

## Forge configuration (`libsql-packaging.test.ts`)
- **Scenario: libsql-runtime-copied**: over a fake hoisted install, the hook for `linux`/`x64`
  copies exactly `LIBSQL_RUNTIME_PACKAGES` and `@libsql/linux-x64-gnu` (prebuild last). The result
  is `PACKAGED_ASAR_NODE_MODULES['linux-x64']`, flat, using `libsql`'s nested `detect-libc` (not the
  hoisted one), without READMEs, `.d.ts` or `.map` files, and with license files kept.
  `forge.config.ts` registers the hook as `packageAfterCopy`. On a packaged host, copying from the
  real install gives that host's set. Main resolving `@libsql/client/sqlite3` from
  `.vite/build/` in the copy loads only files inside it and reads `LIBSQL_SQLITE_VERSION`.
- **Scenario: libsql-prebuild-missing-fails**: the hook throws, and creates no `node_modules/`, in
  each of these cases:
  - the target's prebuild is not installed (`win32`/`x64` from a Linux install; the message names
    `@libsql/win32-x64-msvc` and says to package on that platform);
  - a runtime package is missing;
  - the target is not one frost packages (`linux-arm64`, `darwin-x64`);
  - the prebuild's version differs from the one `libsql` pins.
- **Scenario: libsql-runtime-is-closed**: the hook throws in each of these cases:
  - a runtime package declares a dependency that is neither shipped nor in
    `LIBSQL_UNLOADED_DEPENDENCIES`;
  - a shipped dependency resolves to another copy from one of its dependents, so a flat copy would
    change what it loads;
  - a `.node` file is found anywhere except the prebuild's `index.node`;
  - the build path already has a `node_modules/`.
- **Scenario: libsql-unpack-pattern**: `packagerConfig.asar` is `{ unpack: LIBSQL_ASAR_UNPACK }`.
  `@electron/asar` matches the pattern against absolute paths, with no `dot` option. The test packs
  a tree with `@electron/asar` under two dot directories (`.cache/build/.tmp/app`). Only
  `node_modules/@libsql/<prebuild>/index.node` is marked unpacked and written to
  `app.asar.unpacked/`. Another `.node` in that package, `libsql/index.node`, `.vite/**/*.node` and
  every JavaScript file stay packed. With no dot directory, and with `LIBSQL_ASAR_UNPACK_DOT_DIRS`
  (4) of them, the prebuild is unpacked. With one more, nothing is unpacked, which
  `unpacked-allowlist` would fail. `PACKAGED_UNPACKED_ALLOWLIST[target]` is that one file per
  target.
- **Scenario: libsql-external-in-main**: `vite.main.config.ts` makes `@libsql/client`,
  `@libsql/client/sqlite3`, `libsql`, `libsql/promise` and `node:sqlite` external. It does not make
  `@libsql/core`, `@libsql/clientx`, `libsqlx`, `drizzle-orm` or `@app/db` external. It sets
  `output.dynamicImportInCjs: false`.
- **Scenario: libsql-targets-are-the-packaged-ones**: the keys of `LIBSQL_PREBUILD_TARGETS` are
  exactly darwin × `MAC_ARCHS`, linux × `LINUX_ARCHS` and win32 × `WIN_ARCHS`. The installed
  `libsql` pins a prebuild for each of them.

## Built packages (`verify-*-package.mjs`)
These checks run on the packaged tree. On Linux and Windows they also run on every extracted tree
(deb, AppImage, zip, nupkg), as part of that tree's checks. `target` is `<platform>-<arch>`.
- **Scenario: unpacked-allowlist**: every entry that `app.asar`'s header marks `unpacked` is listed
  in `PACKAGED_UNPACKED_ALLOWLIST[target]`, and every listed entry is marked. The same holds for the
  files in `resources/app.asar.unpacked/`; a symlink there fails. Off macOS, each unpacked file's
  size and SHA-256 equal the header's `size` and `integrity.hash`. On macOS only the set of files
  is checked, and the bytes are left to `signature-verifies` (see Integrity).
- **Scenario: asar-node-modules-allowlist**: the packages in `app.asar/node_modules/` are exactly
  `PACKAGED_ASAR_NODE_MODULES[target]`. Any other entry there fails, such as a lock file or an
  unknown scope. No `node_modules/` is nested anywhere in the archive, and no `.node` file is packed
  inside it.
- **Scenario: libsql-loads**: the repository's `electron` (the version Forge packaged) is run as
  Node with `ELECTRON_RUN_AS_NODE=1`; the packaged binary has its `RunAsNode` fuse off, and no CLI
  switch or production code path was added. It does the following:
  - resolves `@libsql/client/sqlite3` from `resources/app.asar/.vite/build/main.cjs`, as the
    packaged main does: Electron reads the archive and loads the prebuild from
    `app.asar.unpacked/`;
  - opens a `file:` database in a temporary directory (always removed);
  - reads `SELECT sqlite_version()`, which must be `LIBSQL_SQLITE_VERSION`.

  The probe's `process.versions.electron` must equal the packaged app's Electron. That version comes
  from the packaged tree's `version` file on Linux and Windows, and from the bundled
  `Electron Framework.framework`'s `CFBundleShortVersionString` on macOS. Every module it loads lies
  inside that `app.asar` (the prefix is compared after `realpath`, since module paths are resolved
  through it, e.g. macOS `/var` → `/private/var`), so nothing comes from the repository's
  `node_modules`. The only native module it loads is the target's prebuild. `NODE_OPTIONS`,
  `NODE_PATH` and `LIBSQL_JS_DEV` are removed from its environment. An `INFO` line states the
  Electron version. Under `verify-windows-package.mjs --static` off Windows, this check is skipped
  with an `INFO` line, because a win32 prebuild loads only on Windows.

- **Scenario: sync-replica-opens**: on the packaged tree only (never an extracted one). A fresh
  profile directory gets `SYNC_CONFIG_FILE_NAME` holding `SYNC_PACKAGED_PROBE_CONFIG`
  (`{"enabled":true}`: local staging, no endpoint, no token, so neither the network nor
  `safeStorage` is involved). The packaged executable is started with `--user-data-dir=<profile>`
  first (as `launches-and-stays-alive`). Within `SYNC_REPLICA_OPENS_MS`:
  - `SYNC_REPLICA_FILE_NAME` appears in the profile, and Node's `node:sqlite`, opening it
    read-only, finds `SYNC_STATE_TABLE` in it (so the packaged main loaded libSQL's unpacked
    prebuild, opened the replica and ran SQL in it);
  - on POSIX the file's mode is 0600;
  - the app is still running.

  It is then terminated by its PID, and the profile removed. A failure prints the app's stderr
  tail. Under `verify-windows-package.mjs --static` it is skipped with an `INFO` line, like the
  other launch checks.

## Known limits
- The unpacked `index.node` is not checked at runtime on Windows or Linux (see Integrity above).
- `libsql-loads` runs the repository's Electron with Node's loader, not the packaged executable
  with its fuses; `sync-replica-opens` covers the packaged executable. On macOS the CI build is
  ad-hoc signed: a Developer ID build's library validation is exercised only when one is made.
- `LIBSQL_ASAR_UNPACK` allows at most `LIBSQL_ASAR_UNPACK_DOT_DIRS` dot directories in the build
  path. Beyond that, the prebuild stays packed and the verifiers fail.
- Linux ships the glibc prebuild only. On a musl system libSQL (and so sync) is unavailable.
- `THIRD_PARTY_NOTICES` lists the shipped JavaScript packages and `libsql`, whose MIT license
  covers its `@libsql/<target>` prebuilds; the prebuild package ships no license file of its own.
  The licenses of the Rust crates and SQLite statically linked into the prebuild are not listed
  separately.
- When `LIBSQL_JS_DEV` is set, `libsql` looks for `libsql/index.node`. The package has no such file,
  so libSQL fails to load; no other path is ever loaded.
