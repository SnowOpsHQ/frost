# Feature: Linux packages (AppImage, deb; x64)

Spec: `specs/linux-package.spec.ts` (fuses: `PACKAGED_FUSES`, `specs/macos-package.spec.ts`).
Design doc §4 Phase 7 (cross-platform). Phase 7 Task 1.
Config tests: `apps/desktop/src/__tests__/linux-package-config.test.ts` (every CI run).
Workflow tests: `apps/desktop/src/__tests__/platform-workflows.test.ts` (same runs).
Package checks: `apps/desktop/scripts/verify-linux-package.mjs`, with the checks shared with Windows
in `verify-package-common.mjs` (Linux only; run by `.github/workflows/linux-package.yml` after
`make:linux`, and by hand). Each scenario maps to one named test or check.

Build: `pnpm make:linux` (= `electron-forge make --platform linux --arch x64` in `@app/desktop`),
then `pnpm verify:linux` (needs a display and `dpkg-deb`).

**Unsigned.** frost has no Linux repository key. The deb is not signed and not served from an apt
repository; the AppImage embeds no signature.

## Forge configuration (`linux-package-config.test.ts`)
- **Scenario: makes-zip-deb-and-appimage** — the makers whose platforms include `linux` are exactly
  `zip`, `deb` and `AppImage`; `deb` and `AppImage` target `linux` only.
- **Scenario: deb-options-as-specified** — the deb maker's options are `LINUX_DEB_OPTIONS` with
  categories `LINUX_DESKTOP_CATEGORIES`, and it has no `scripts` (no maintainer scripts);
  `package.json#license` is `LINUX_LICENSE`.
- **Scenario: appimage-options-as-specified** — for every `LINUX_ARCHS` arch the AppImage maker's
  options name `LINUX_PACKAGE_NAME`, run `LINUX_EXECUTABLE_NAME`, carry `LINUX_DESKTOP_CATEGORIES`
  and use the pinned runtime `LINUX_APPIMAGE_RUNTIME[arch].url` (never the maker's moving default).
- **Scenario: linux-fuses-unchanged** — the FusesPlugin config holds exactly `PACKAGED_FUSES`, the
  same on Linux as on macOS, and the `postPackage` hook runs nothing for a linux package.
- **Scenario: linux-scripts** — `@app/desktop`'s `make:linux` is
  `electron-forge make --platform linux --arch <LINUX_ARCHS>` and `verify:linux` is
  `node scripts/verify-linux-package.mjs`; the root `make:linux` / `verify:linux` pass through to
  them.

## Built packages (`verify-linux-package.mjs`, on Linux)
Every check prints `PASS <name>` or `FAIL <name>: <reason>` (and `INFO <name>: …` for stated facts);
any failure exits non-zero. Only the packaged tree (`out/<linuxArtifacts().packaged>`) is launched.
The deb and AppImage trees are extracted as an unprivileged user and checked statically: the
extracted deb's `chrome-sandbox` is not root-owned, and nothing here turns the sandbox off.
- **Scenario: fuses-read-back** — `@electron/fuses` reads the packaged executable's fuse wire and
  every `PACKAGED_FUSES` entry has its configured state.
- **Scenario: asar-integrity** — `EnableEmbeddedAsarIntegrityValidation` is on. Electron enforces
  ASAR integrity only on macOS and Windows (Packager embeds no integrity data for Linux), so the
  check prints an `INFO` line stating this platform gap and asserts `OnlyLoadAppFromAsar` is on.
- **Scenario: no-stray-files** — `resources/` holds exactly `PACKAGED_RESOURCES_ALLOWLIST`, and
  `app.asar` holds exactly `PACKAGED_ASAR_TOP_LEVEL` at its root, with no entry marked unpacked.
- **Scenario: launches-and-stays-alive** — the packaged executable, started with no arguments other
  than a fresh throwaway `--user-data-dir`, is still running after `LINUX_LAUNCH_ALIVE_MS` (then it
  is terminated by its PID). The Chromium sandbox stays on: on Ubuntu 24.04 CI allows unprivileged
  user namespaces (`kernel.apparmor_restrict_unprivileged_userns=0`) rather than pass
  `--no-sandbox`. `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `ELECTRON_ENABLE_LOGGING` are removed
  from its environment.
- **Scenario: refuses-remote-debugging** — started, one at a time, with `--<name>=0` and `--<name>`
  for every `PACKAGED_FORBIDDEN_SWITCHES` name, and with `--inspect=0`, it exits with code 1 and its
  stderr contains `PACKAGED_DEBUG_REFUSAL` (`security-policy.spec.ts`).
- **Scenario: deb-metadata** — `linuxArtifacts().deb` exists. `dpkg-deb -f`: `Package` =
  `LINUX_PACKAGE_NAME`, `Version` = `package.json#version`, `Architecture` = `LINUX_DEB_ARCH[arch]`,
  and `Section`, `Maintainer`, `Homepage` from `LINUX_DEB_OPTIONS`. `dpkg-deb -I`: the control
  archive holds `control` only (no maintainer scripts). `dpkg-deb -c`: every entry is owned by
  `root/root` and lies under `LINUX_DEB_INSTALL_ROOTS`; `LINUX_DEB_APP_DIR/<executable>` is
  executable, `LINUX_DEB_BIN_LINK` links to it, `LINUX_DEB_DESKTOP_FILE` exists, and the setuid /
  setgid files are exactly `LINUX_DEB_SETUID_FILES`. Then `dpkg-deb -x` into a temporary directory
  (always removed): the `fuses-read-back` and `no-stray-files` checks pass on
  `LINUX_DEB_APP_DIR`.
- **Scenario: appimage-contents** — `linuxArtifacts().appImage` exists and is executable. Before it
  is run at all, its first `LINUX_APPIMAGE_RUNTIME[arch].bytes` bytes have the pinned SHA-256, and
  `--appimage-offset` reports that size. Then `--appimage-extract` in a temporary directory (always
  removed): `squashfs-root/AppRun` resolves to the app's executable under `LINUX_APPIMAGE_APP_DIR`,
  and the `fuses-read-back` and `no-stray-files` checks pass on that tree.

## CI (`.github/workflows/linux-package.yml`)
Checked by `platform-workflows.test.ts` (the named test below), by actionlint
(`uvx --from actionlint-py actionlint`, by hand) and by the workflow runs themselves.
- **Scenario: linux-package-ci-job** — job `linux-package` on `ubuntu-24.04`, for pull requests
  touching the app (`apps/desktop`, `packages`, `specs`, the lockfile, workspace and root
  `package.json`, `turbo.json`, `tsconfig.base.json`, the workflow itself), pushes to `main` and
  manual dispatch: install (frozen lockfile), the apt packages the makers and checks need, `build`,
  `make:linux`, the user-namespace sysctl, `verify:linux` under `xvfb-run`, then uploads the
  AppImage and deb (7 days) only if `verify:linux` succeeded. No lint, test or e2e: `ci.yml` runs
  them on Linux already.

## Known limits
- No signing (see above); x64 only; Electron's default icon.
- The deb's `/usr/share/doc/frost/copyright` is the packaged tree's `LICENSE`, which is Electron's
  (electron-installer-debian copies it); frost's own license is `package.json#license`.
