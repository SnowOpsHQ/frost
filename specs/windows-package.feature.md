# Feature: Windows packages (Squirrel installer, zip; x64)

Spec: `specs/windows-package.spec.ts` (fuses: `PACKAGED_FUSES`, `specs/macos-package.spec.ts`).
Design doc §4 Phase 7 (cross-platform). Phase 7 Task 2.
Config tests: `apps/desktop/src/__tests__/windows-package-config.test.ts` (every CI run).
Squirrel event tests: `apps/desktop/src/main/update/__tests__/squirrel-events.test.ts` (same runs).
Workflow tests: `apps/desktop/src/__tests__/platform-workflows.test.ts` (same runs).
Package checks: `apps/desktop/scripts/verify-windows-package.mjs`, with the checks shared with Linux
in `verify-package-common.mjs` (on Windows; run by `.github/workflows/windows.yml` after `make:win`,
and by hand; `--static` runs the file checks anywhere). Each scenario maps to one named test or check.

Build: `pnpm make:win` (= `electron-forge make --platform win32 --arch x64` in `@app/desktop`), then
`pnpm verify:win`.

**Unsigned.** frost has no Windows Authenticode certificate. Neither `frost.exe` nor `Setup.exe` is
signed, so SmartScreen warns before the installer runs ("Windows protected your PC"; More info ›
Run anyway).

## Forge configuration (`windows-package-config.test.ts`)
- **Scenario: makes-squirrel-and-zip** — the makers whose platforms include `win32` are exactly
  `squirrel` and `zip`, both for `win32` only (the macOS/Linux zip maker does not list `win32`), and
  the win32 zip has no options.
- **Scenario: squirrel-options-as-specified** — for every `WIN_ARCHS` arch the Squirrel maker's
  options are exactly `WIN_SQUIRREL_OPTIONS` plus `setupExe` = `winSetupExe(version, arch)`; `name`
  is `WIN_PACKAGE_NAME`, a valid NuGet id; `noMsi` is on; `winArtifacts()` names the same setup file
  and `<name>-<version>-full.nupkg`.
- **Scenario: squirrel-arch-fails-closed** — for an arch not in `WIN_ARCHS` (`arm64`, `ia32`,
  `armv7l`), preparing the Squirrel maker throws, so the make fails (`windows-makers.ts`
  `squirrelOptions`).
- **Scenario: unsigned-whatever-the-env** — with no environment and with signing-looking variables
  set (certificate paths and passwords, the Apple signing identity), the Squirrel options hold none
  of `WIN_SIGNING_OPTIONS` and `packagerConfig` has no `windowsSign`.
- **Scenario: windows-fuses-unchanged** — the FusesPlugin config holds exactly `PACKAGED_FUSES`, and
  the `postPackage` hook runs nothing for a win32 package.
- **Scenario: windows-version-strings** — `packagerConfig.win32metadata` is exactly
  `WIN_VERSION_STRINGS` without `LegalCopyright`, and `appCopyright` is its `LegalCopyright`
  (`windows-makers.ts` `windowsPackagerConfig`), replacing Electron's company and copyright strings
  in `frost.exe`'s version resource.
- **Scenario: resources-allowlist-matches-linux** — `PACKAGED_RESOURCES_ALLOWLIST` and
  `PACKAGED_ASAR_TOP_LEVEL` are the same as `linux-package.spec.ts`'s.
- **Scenario: windows-scripts** — `@app/desktop`'s `make:win` is
  `electron-forge make --platform win32 --arch <WIN_ARCHS>` and `verify:win` is
  `node scripts/verify-windows-package.mjs`; the root `make:win` / `verify:win` pass through to them.

## Squirrel events (`squirrel-events.test.ts`)
`apps/desktop/src/main/update/squirrel-events.ts`, called in main right after the remote-debugging
refusal and before anything else starts (single-instance lock, databases, windows). Spawning,
exiting, the clock and the file check are injected.
- **Scenario: squirrel-shortcut-events** — packaged on Windows, `argv[1]` `--squirrel-install` or
  `--squirrel-updated` spawns `<dir of frost.exe>\..\Update.exe --createShortcut frost.exe`
  (`--squirrel-uninstall`: `--removeShortcut`), with no shell, detached, no stdio; the app exits 0
  once `Update.exe` exits, and only once.
- **Scenario: squirrel-shortcut-wait-is-bounded** — if `Update.exe` has not exited after
  `WIN_SQUIRREL_HOOK_WAIT_MS` (well under Squirrel's `WIN_SQUIRREL_HOOK_LIMIT_MS`), the app exits 0
  anyway.
- **Scenario: squirrel-obsolete-exits-at-once** — `--squirrel-obsolete` exits 0 at once and spawns
  nothing.
- **Scenario: squirrel-firstrun-starts-normally** — `WIN_SQUIRREL_FIRSTRUN` is not handled: frost
  starts as usual.
- **Scenario: squirrel-events-only-packaged-on-windows** — on macOS or Linux, or unpackaged, no event
  is handled (frost starts as usual).
- **Scenario: squirrel-other-args-ignored** — only an `argv[1]` exactly equal to an event counts: no
  arguments, a URL, an event in a later position, `--squirrel-install=…`, other case, a prefix or
  suffix, and object keys such as `toString` all start frost as usual.
- **Scenario: squirrel-update-exe-missing-exits-quietly** — a missing `Update.exe`, a throwing spawn
  or a spawn `error` event exits 0, with nothing printed.

## Built packages (`verify-windows-package.mjs`, on Windows)
Every check prints `PASS <name>` or `FAIL <name>: <reason>` (and `INFO <name>: …` for stated facts);
any failure exits non-zero. Off Windows the script refuses to run (exit 2) unless given `--static`,
which runs `fuses-read-back`, `asar-integrity`, `no-stray-files` and `unsigned-as-documented`
(`frost.exe` only) on the packaged tree and prints `INFO … skipped` for the rest; it works on
`electron-forge package --platform win32 --arch x64` output made on Linux. CI never passes
`--static`. Every external command (`tar`) is killed after 5 minutes and fails its check; zips and
nupkgs are extracted with Windows' own `%SystemRoot%\System32\tar.exe` into temporary directories
(always removed).
- **Scenario: fuses-read-back** — `@electron/fuses` reads `frost.exe`'s fuse wire and every
  `PACKAGED_FUSES` entry has its configured state.
- **Scenario: asar-integrity** — `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar`
  are on, and `frost.exe` has exactly one `WIN_ASAR_INTEGRITY_RESOURCE` resource (type and name
  compared case-insensitively) holding the JSON array of exactly one record: `file`
  `resources\app.asar`, `alg` `SHA256`, `value` the hex SHA-256 of `app.asar`'s header string
  (`@electron/asar` `getRawHeader().headerString`).
- **Scenario: asar-tamper-refused** — the packaged tree is copied to a temporary directory; in the
  copy's `app.asar` one letter of a renderer asset's name in the JSON header is changed (same
  length, so the archive layout holds and only the header hash differs; a renamed asset alone would
  not stop the app from starting). The copy, launched on a throwaway profile, has exited with a
  non-zero code within `WIN_TAMPER_EXIT_MS` (still running fails the check).
- **Scenario: no-stray-files** — `resources/` holds exactly `PACKAGED_RESOURCES_ALLOWLIST`, and
  `app.asar` holds exactly `PACKAGED_ASAR_TOP_LEVEL` at its root, with no entry marked unpacked.
- **Scenario: launches-and-stays-alive** — `frost.exe`, started with no arguments other than a fresh
  throwaway `--user-data-dir`, is still running after `WIN_LAUNCH_ALIVE_MS` (then it is terminated
  by its PID). `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `ELECTRON_ENABLE_LOGGING` are removed from
  its environment.
- **Scenario: refuses-remote-debugging** — started, one at a time, with `--<name>=0` and `--<name>`
  for every `PACKAGED_FORBIDDEN_SWITCHES` name, and with `--inspect=0`, it exits with code 1 and its
  stderr contains `PACKAGED_DEBUG_REFUSAL` (`security-policy.spec.ts`).
- **Scenario: squirrel-obsolete-exits** — `frost.exe --squirrel-obsolete <version>` (the profile
  argument after them, so the event is `argv[1]`) has exited with code 0 within
  `WIN_SQUIRREL_OBSOLETE_EXIT_MS` (still running fails the check).
- **Scenario: squirrel-artifacts** — the Squirrel output directory holds exactly
  `winArtifacts().setupExe`, `.nupkg` and `RELEASES` (no `.msi`, no delta package), none empty.
  `RELEASES` (a leading byte-order mark ignored) has exactly one `<SHA1> <file> <size>` line: the
  full `.nupkg`'s name, its SHA-1 (any case) and its size in bytes, matching the file. The
  `.nupkg`'s `WIN_NUPKG_APP_DIR` (what `Setup.exe` installs) passes the `fuses-read-back`,
  `no-stray-files`, `asar-integrity` and `unsigned-as-documented` checks. An `INFO` line states
  `frost.exe`'s `SquirrelAwareVersion` (Squirrel hands the events to the app).
- **Scenario: zip-contents** — `winArtifacts().zip` exists; extracted, its root holds the same
  entries as the packaged tree (Forge zips the tree's contents on Windows, with no top folder), and
  that tree passes the `fuses-read-back`, `no-stray-files`, `asar-integrity` and
  `unsigned-as-documented` checks.
- **Scenario: unsigned-as-documented** — `frost.exe` and `Setup.exe` have an empty Authenticode
  certificate table (PE optional header data directory 4, `IMAGE_DIRECTORY_ENTRY_SECURITY`: offset
  and size 0). A signed file fails the check with a message to update this spec, the feature file
  and the README first.

## CI (`.github/workflows/windows.yml`)
Checked by `platform-workflows.test.ts` (the named test below), by actionlint
(`uvx --from actionlint-py actionlint`, by hand) and by the workflow runs themselves.
- **Scenario: windows-ci-job** — job `windows` on `windows-2025`, for pull requests touching the app
  (`apps/desktop`, `packages`, `specs`, the lockfile, workspace and root `package.json`,
  `turbo.json`, `tsconfig.base.json`, the workflow itself), pushes to `main` and manual dispatch.
  Before checkout, `git config --global core.autocrlf false` (the tests read repo files and match on
  `\n`). Then: install (frozen lockfile), `turbo run lint test`, `build`, the e2e as a step of its
  own (`continue-on-error` while it is evaluated on Windows; a failure still uploads its Playwright
  report), `make:win`, `verify:win` (never `--static`), then uploads `Setup.exe` and the zip
  (7 days) only if `verify:win` succeeded. Every action is pinned to a commit SHA.

## Known limits
- No signing (see above); x64 only; Electron's default icon.
- Squirrel installs per user into `%LocalAppData%\frost` (no administrator rights, no MSI) and
  includes its `Update.exe`, but frost never runs it: no Squirrel update feed exists, and frost's
  own update check (Phase 7 Tasks 3–5) does not use Squirrel.
- Not exercised by any check: running `Setup.exe` (installing, and so the shortcuts `Update.exe`
  creates) and uninstalling. Only `--squirrel-obsolete` is run against the packaged app.
