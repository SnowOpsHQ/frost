/**
 * Windows packaging contract (design doc §4 Phase 7: cross-platform; Phase 7 Task 2). Implemented by
 * `apps/desktop/windows-makers.ts` (registered in `forge.config.ts`); checked by
 * `apps/desktop/src/__tests__/windows-package-config.test.ts` (config values) and
 * `apps/desktop/scripts/verify-windows-package.mjs` (the built packages, on Windows; its `--static`
 * checks also run elsewhere). Acceptance list: `windows-package.feature.md`.
 *
 * The fuses are `PACKAGED_FUSES` of `macos-package.spec.ts`: one fuse set for every platform.
 *
 * **Unsigned.** frost has no Windows Authenticode certificate: neither `frost.exe` nor the Squirrel
 * `Setup.exe` carries a signature, so SmartScreen warns before the installer runs. No signing option
 * is ever set (`WIN_SIGNING_OPTIONS`), and nothing here or in the docs claims otherwise.
 *
 * Self-contained (no imports, erasable TypeScript only) so the verify script can load it with
 * Node's built-in type stripping.
 */

/** Squirrel's app id: the NuGet package id, the `.nupkg` name and the install folder `%LocalAppData%\frost`. */
export const WIN_PACKAGE_NAME = 'frost';

/** The packaged executable (`packagerConfig.executableName` `frost`, the same on every platform). */
export const WIN_EXECUTABLE = 'frost.exe';

/** x64 only for now; arm64 is a follow-up. */
export const WIN_ARCHS = ['x64'] as const;
export type WinArch = (typeof WIN_ARCHS)[number];

/**
 * `@electron-forge/maker-squirrel` options (electron-winstaller). `name` is set because the maker's
 * default is the packaged `package.json#name` (`@app/desktop`), not a valid NuGet id; `authors` is
 * required by NuGet and `package.json` has no `author`. `noMsi`: no per-machine MSI, only the
 * per-user `Setup.exe`. `noDelta`: no delta package (there is no Squirrel update feed; frost's own
 * update check is Phase 7 Tasks 3–5). The setup file name is `winSetupExe()`.
 */
export const WIN_SQUIRREL_OPTIONS = {
  name: WIN_PACKAGE_NAME,
  title: 'frost',
  authors: 'SnowOpsHQ',
  description: 'frost, a desktop SEO browser',
  noMsi: true,
  noDelta: true,
} as const;

/**
 * electron-winstaller options that sign the installer and the app. None is ever set, by the config
 * or by any environment: the build is unsigned (`unsigned-as-documented` checks the result). Forge's
 * `packagerConfig.windowsSign` is never set either.
 */
export const WIN_SIGNING_OPTIONS = ['certificateFile', 'certificatePassword', 'signWithParams', 'windowsSign'] as const;

/** The Squirrel installer's file name. */
export function winSetupExe(version: string, arch: WinArch): string {
  return `${WIN_PACKAGE_NAME}-${version}-${arch}-setup.exe`;
}

/**
 * Inside the full `.nupkg` (a zip): the packaged tree, as electron-winstaller's nuspec template lays
 * it out. Squirrel installs this directory as `%LocalAppData%\frost\app-<version>\`.
 */
export const WIN_NUPKG_APP_DIR = 'lib/net45';

/**
 * Everything allowed directly in a packaged app's `resources/`: the app archive and the
 * third-party notices (`third-party-notices.ts` `NOTICES_FILE`, an extra resource). The same as
 * Linux (`linux-package.spec.ts`; `windows-package-config.test.ts` checks they agree): no
 * `app.asar.unpacked/`, no loose `app/` directory.
 */
export const PACKAGED_RESOURCES_ALLOWLIST = ['app.asar', 'THIRD_PARTY_NOTICES'] as const;

/** The top-level entries of `app.asar`: the Vite build output and the app's `package.json`. */
export const PACKAGED_ASAR_TOP_LEVEL = ['.vite', 'package.json'] as const;

/**
 * The ASAR integrity data Electron checks on Windows: a PE resource of `frost.exe` holding the JSON
 * `[{ "file": "resources\\app.asar", "alg": "SHA256", "value": "<hex>" }]`, where `value` is the
 * SHA-256 of `app.asar`'s header (the JSON string `@electron/asar` `getRawHeader` returns as
 * `headerString`). Electron looks it up as `Integrity` / `ElectronAsar`; PE resource names are
 * matched without regard to case, and Packager writes them upper-case (`INTEGRITY`,
 * `ELECTRONASAR`), so the verify script compares them case-insensitively.
 */
export const WIN_ASAR_INTEGRITY_RESOURCE = {
  type: 'Integrity',
  name: 'ElectronAsar',
  file: 'resources\\app.asar',
  alg: 'SHA256',
} as const;

/** A packaged app must still be running this long after launch (no crash, no sandbox abort). */
export const WIN_LAUNCH_ALIVE_MS = 10_000;

/** A copy with a tampered `app.asar` header must have exited (non-zero) within this time. */
export const WIN_TAMPER_EXIT_MS = 30_000;

/**
 * Paths under `apps/desktop/out/` that `electron-forge make --platform win32 --arch <arch>`
 * produces. `version` is `package.json#version`; the `.nupkg` name uses it as is, which holds for a
 * release version (NuGet rewrites a pre-release suffix such as `-beta.1` to `-beta1`).
 */
export function winArtifacts(version: string, arch: WinArch) {
  const dir = `${WIN_PACKAGE_NAME}-win32-${arch}`;
  const squirrel = `make/squirrel.windows/${arch}`;
  return {
    /** `electron-forge package` output (the executable is `<packaged>/<WIN_EXECUTABLE>`). */
    packaged: dir,
    /**
     * `@electron-forge/maker-zip`. Made on Windows, it holds the packaged tree's contents at its
     * root, without a `<packaged>/` folder (unlike the macOS and Linux zips).
     */
    zip: `make/zip/win32/${arch}/${dir}-${version}.zip`,
    /** `@electron-forge/maker-squirrel`: the per-user installer. */
    setupExe: `${squirrel}/${winSetupExe(version, arch)}`,
    /** Squirrel's full package (what `Setup.exe` installs). */
    nupkg: `${squirrel}/${WIN_PACKAGE_NAME}-${version}-full.nupkg`,
    /** Squirrel's release list: one `<SHA1> <file name> <size>` line per package. */
    releases: `${squirrel}/RELEASES`,
  } as const;
}
