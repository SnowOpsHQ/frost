# Feature: macOS package (Apple Silicon)

Spec: `specs/macos-package.spec.ts`. Design doc §1 (macOS-first). Phase 0 Task 6.
Config tests: `apps/desktop/src/__tests__/forge-config.test.ts` (Linux and macOS, every CI run).
Workflow tests: `apps/desktop/src/__tests__/ci-workflows.test.ts` (same runs).
Bundle checks: `apps/desktop/scripts/verify-mac-package.mjs` (macOS only; run by
`.github/workflows/macos.yml` after `make:mac`, and by hand on a Mac). Each scenario maps to one
named test or check.

Build: `pnpm make:mac` (= `electron-forge make --platform darwin --arch arm64` in `@app/desktop`),
then `node apps/desktop/scripts/verify-mac-package.mjs`.

## Forge configuration (`forge-config.test.ts`)
- **Scenario: identifies-the-mac-bundle** — `packagerConfig` sets `name` = `MAC_PRODUCT_NAME`,
  `executableName` = `MAC_EXECUTABLE_NAME`, `appBundleId` = `MAC_BUNDLE_ID`, `appCategoryType` =
  `MAC_APP_CATEGORY`, `darwinDarkModeSupport: true` and `asar: true`; `package.json#productName`
  is `MAC_PRODUCT_NAME`.
- **Scenario: flips-the-spec-fuses** — the FusesPlugin config holds exactly `PACKAGED_FUSES`.
- **Scenario: ad-hoc-signs-when-unsigned** — without the full `MAC_SIGNING_ENV` set (each variable
  missing or empty in turn), there is no `osxSign` / `osxNotarize`, and the fuse flip resets the
  ad-hoc signature (`resetAdHocDarwinSignature: true`; Apple Silicon kills arm64 code whose
  signature no longer matches; explicit even though the hook below re-seals everything, so the
  binary is never left with a broken signature mid-package). After packaging, the `postPackage` hook re-seals the finished
  darwin `.app` ad-hoc (`codesign --sign - --force --deep --preserve-metadata=…`), because Packager
  rewrites Info.plist after the fuse flip; it does nothing for linux or when signing for real.
- **Scenario: warns-on-partial-signing-env** — when some but not all `MAC_SIGNING_ENV` variables
  are set (non-empty), `console.warn` names the missing ones and the build is still ad-hoc; no
  warning when none or all of them are set.
- **Scenario: signs-and-notarizes-when-configured** — with every `MAC_SIGNING_ENV` variable set,
  `osxSign.identity` is `APPLE_SIGNING_IDENTITY` and `osxNotarize` carries `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`; the fuse flip does not ad-hoc sign.
- **Scenario: makes-zip-and-dmg** — makers are `zip` (darwin + linux) and `dmg` (darwin only,
  format `MAC_DMG_FORMAT`).
- **Scenario: linux-build-unaffected** — `@app/desktop`'s `build` script is still
  `electron-forge package` (the Linux CI gate), the DMG maker never targets linux, and
  `make:mac` targets darwin for exactly `MAC_ARCHS`.

## Built bundle (`verify-mac-package.mjs`, on macOS)
Every check prints `PASS <name>` or `FAIL <name>: <reason>`; any failure exits non-zero.
- **Scenario: bundle-identity** — `out/<macArtifacts().app>` exists; its Info.plist has
  `CFBundleIdentifier` = `MAC_BUNDLE_ID`, `CFBundleName` and `CFBundleDisplayName` =
  `MAC_PRODUCT_NAME`, `CFBundleExecutable` = `MAC_EXECUTABLE_NAME`, `LSApplicationCategoryType` =
  `MAC_APP_CATEGORY`, `NSRequiresAquaSystemAppearance` = false (dark mode), a
  `MAC_MINIMUM_SYSTEM_VERSION_KEY`, and `CFBundleShortVersionString` = `package.json#version`.
- **Scenario: bundle-arch** — `Contents/MacOS/<executable>` is a Mach-O for exactly the requested
  arch (`lipo -archs`).
- **Scenario: signature-verifies** — `codesign --verify --deep --strict` passes on the `.app`.
  The signing mode is read from the bundle, not the environment: `codesign -dv` reporting
  `Signature=adhoc` means ad-hoc, anything else Developer ID.
- **Scenario: entitlements-as-specified** — `codesign -d --entitlements - --xml` on the `.app`:
  ad-hoc → no entitlements at all (empty, no keys); Developer ID → exactly `MAC_ENTITLEMENTS`.
- **Scenario: fuses-read-back** — `@electron/fuses` reads the packaged app's fuse wire and every
  `PACKAGED_FUSES` entry has its configured state.
- **Scenario: launches-and-stays-alive** — the packaged executable, started with no arguments,
  is still running after `MAC_LAUNCH_ALIVE_MS` (then it is terminated).
- **Scenario: refuses-remote-debugging** — started, one at a time, with `--<name>=0` and `--<name>`
  for every `PACKAGED_FORBIDDEN_SWITCHES` name, and with `--inspect=0` (`PACKAGED_FORBIDDEN_ARGV`),
  it exits with code 1 and its stderr contains `PACKAGED_DEBUG_REFUSAL`
  (`security-policy.spec.ts`).
- **Scenario: zip-and-dmg-produced** — `macArtifacts().zip` and `.dmg` exist and are non-empty;
  `hdiutil imageinfo` reports the DMG format `MAC_DMG_FORMAT`.
- **Scenario: zip-app-verifies** — the published zip, unpacked with `ditto -x -k` into a temporary
  directory, holds `<MAC_PRODUCT_NAME>.app`, and `codesign --verify --deep --strict` passes on it
  (the temporary directory is always removed).
- **Scenario: dmg-app-verifies** — the published dmg, mounted with
  `hdiutil attach -readonly -nobrowse -mountpoint <tmp>`, holds `<MAC_PRODUCT_NAME>.app`, and
  `codesign --verify --deep --strict` passes on it; the image is always detached afterwards.

## CI (`.github/workflows/macos.yml`)
Checked by `ci-workflows.test.ts` (the named tests below), by actionlint
(`uvx --from actionlint-py actionlint`, by hand) and by the workflow runs themselves.
- **Scenario: macos-ci-job** — on `macos-15` (arm64), for pull requests touching the app (`apps/desktop`,
  `packages`, `specs`, the lockfile, workspace and root `package.json`, `turbo.json`,
  `tsconfig.base.json`, the workflow itself), pushes to `main`, `v*` tags and manual dispatch:
  install (frozen lockfile), `turbo run lint test`, `build` + `test:e2e` (a real macOS window),
  `make:mac`, `verify:mac`, then uploads the zip and dmg (14 days) only if both `test:e2e` and
  `verify:mac` succeeded and, on failure, the Playwright report.
- **Scenario: linux-ci-unaffected** — `.github/workflows/ci.yml` still runs on every pull request
  and on pushes to `main`, on `ubuntu-24.04`, with one step per `ci-gates.feature.md` gate
  (`Gate: <name>`, same names, same order) running its command.

## Follow-ups (not in this task)
- App icon (Electron's default icon is used for now).
- x64 / universal builds; Developer ID signing + notarization in CI (secrets); signed auto-update
  (design doc Phase 7).
