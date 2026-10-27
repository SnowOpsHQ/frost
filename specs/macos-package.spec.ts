/**
 * macOS packaging contract (design doc §1 non-goals: macOS-first; Phase 0 Task 6). Implemented by
 * `apps/desktop/forge.config.ts`; checked by `apps/desktop/src/__tests__/forge-config.test.ts`
 * (config values) and `apps/desktop/scripts/verify-mac-package.mjs` (the built bundle, on macOS).
 * Acceptance list: `macos-package.feature.md`.
 *
 * Self-contained (no imports, erasable TypeScript only) so the verify script can load it with
 * Node's built-in type stripping.
 */

/** `CFBundleName` / `CFBundleDisplayName`, the `.app` name and `package.json#productName`. */
export const MAC_PRODUCT_NAME = 'frost';

/** `CFBundleExecutable`: `frost.app/Contents/MacOS/frost`. */
export const MAC_EXECUTABLE_NAME = 'frost';

/** `CFBundleIdentifier`. Helpers get `<id>.helper` (Electron Packager's default). */
export const MAC_BUNDLE_ID = 'com.snowopshq.frost';

/** `LSApplicationCategoryType`. */
export const MAC_APP_CATEGORY = 'public.app-category.productivity';

/** Apple Silicon only for now; x64 / universal builds are a follow-up. */
export const MAC_ARCHS = ['arm64'] as const;
export type MacArch = (typeof MAC_ARCHS)[number];

/**
 * No minimum macOS version is set here: `LSMinimumSystemVersion` is inherited from the Electron
 * build's own Info.plist (the oldest macOS that Electron line supports), which must be present.
 */
export const MAC_MINIMUM_SYSTEM_VERSION_KEY = 'LSMinimumSystemVersion';

/** DMG maker image format: ULFO (lzfse-compressed, read-only; macOS 10.11+). */
export const MAC_DMG_FORMAT = 'ULFO';

/**
 * Electron fuses flipped at package time (FusesPlugin), by `@electron/fuses` `FuseV1Options` name.
 * `true` = enabled, `false` = disabled. Fuses not listed keep Electron's default.
 */
export const PACKAGED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
} as const;
export type PackagedFuse = keyof typeof PACKAGED_FUSES;

/**
 * Real signing + notarization is wired only when **all** of these are set (non-empty); otherwise
 * the build is ad-hoc signed (the only option without an Apple Developer ID).
 * - `APPLE_SIGNING_IDENTITY` → `osxSign.identity` (e.g. `Developer ID Application: … (TEAMID)`).
 * - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` → `osxNotarize` (notarytool).
 */
export const MAC_SIGNING_ENV = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] as const;

/**
 * Entitlements for a Developer ID (hardened runtime) build: V8's JIT only. Ad-hoc builds carry no
 * entitlements; camera, microphone, location … are never requested.
 */
export const MAC_ENTITLEMENTS = ['com.apple.security.cs.allow-jit'] as const;

/** A packaged app must still be running this long after launch (no crash, no signature kill). */
export const MAC_LAUNCH_ALIVE_MS = 10_000;

/** Paths under `apps/desktop/out/` that `electron-forge make --platform darwin --arch <arch>` produces. */
export function macArtifacts(version: string, arch: MacArch) {
  const dir = `${MAC_PRODUCT_NAME}-darwin-${arch}`;
  return {
    /** `electron-forge package` output. */
    app: `${dir}/${MAC_PRODUCT_NAME}.app`,
    /** `@electron-forge/maker-zip`. */
    zip: `make/zip/darwin/${arch}/${dir}-${version}.zip`,
    /** `@electron-forge/maker-dmg` (its default name: `<name>-<version>-<arch>.dmg`). */
    dmg: `make/dmg/${arch}/${MAC_PRODUCT_NAME}-${version}-${arch}.dmg`,
  } as const;
}
