/**
 * libSQL in the packaged app (Phase 7 Task 7; acceptance: `sync-package.feature.md`). Implemented by
 * `apps/desktop/libsql-packaging.ts` (a Forge `packageAfterCopy` hook and the `asar.unpack` pattern,
 * registered in `forge.config.ts`) and `apps/desktop/vite.main.config.ts` (libSQL stays external);
 * checked by `apps/desktop/src/__tests__/libsql-packaging.test.ts` (config) and the package
 * verifiers (`verify-{linux,windows,mac}-package.mjs`, through `verify-package-common.mjs`).
 *
 * Everything else main needs is bundled into `.vite/build/*.cjs`. libSQL cannot be: its native
 * module (`@libsql/<target>/index.node`, N-API, so the same file runs under Node and Electron) is
 * found at runtime by `libsql/index.js` (`@neon-rs/load`'s `currentTarget()`, then
 * `require('@libsql/<target>')`). So the main bundle `require`s `@libsql/client/sqlite3` at
 * runtime, and the packaged `app.asar` holds a `node_modules/` with exactly the packages that entry
 * loads, plus the prebuild for the target. Only the prebuild's `index.node` is unpacked (a native
 * module cannot be `dlopen`ed from inside an archive); every JavaScript file stays in `app.asar`.
 *
 * **Integrity.** `app.asar`'s header lists the unpacked `index.node` (marked `unpacked`, with its
 * size and SHA-256), so Electron's ASAR integrity check (macOS and Windows) covers that metadata.
 * It does **not** cover the unpacked file's bytes: Electron never hashes an unpacked file when it
 * loads it (a known Electron limit). On Windows and Linux nothing at runtime does; the verifiers
 * compare the file with the header (`unpacked-allowlist`), at build time only. On macOS the
 * header's size and SHA-256 are those of the file before signing: signing (a Developer ID
 * `osxSign` run, and possibly the ad-hoc `codesign --force --deep` re-seal) may rewrite the Mach-O
 * after Packager wrote the header, so `unpacked-allowlist` checks only which files are unpacked
 * there, and the bytes are left to the bundle's code signature, which seals the file
 * (`signature-verifies`). `OnlyLoadAppFromAsar` and every other `PACKAGED_FUSES` entry are
 * unchanged.
 *
 * **Not yet proven (as of Task 7): the packaged binary itself loading the prebuild.** The package
 * verifiers' `libsql-loads` runs the repository's Electron (the same version) as Node against the
 * packaged `app.asar`, because the packaged binary's `RunAsNode` fuse is off; that proves the files
 * are complete and that this Electron loads them, not that the packaged executable does. In
 * particular macOS library validation under the hardened runtime (a Developer ID build) could
 * refuse the prebuild. Task 8 adds that proof: a packaged-app check in all three verifiers that
 * enables sync through the profile's sync config and confirms main opens the replica.
 *
 * Self-contained (no imports, erasable TypeScript only) so the verify scripts can load it with
 * Node's built-in type stripping.
 */

/**
 * The SQLite each driver runs, which differ: `libsql` 0.5.29 bundles SQLite 3.45.1 (compiled with
 * `SQLITE_DEFAULT_RECURSIVE_TRIGGERS`; the driver's connections still read `PRAGMA
 * recursive_triggers` as 0, as `node:sqlite`'s do), while Node 26 and Electron 45's `node:sqlite`
 * bundle 3.53.4. A migration or query meant to run over both drivers (`MIGRATIONS`, and Phase 6's
 * `ci_*` tables when Task 8 mirrors them) uses only what SQLite 3.45 supports. Re-exported by
 * `sync.spec.ts`; here so the package verifiers (`libsql-loads`) can read it.
 */
export const LIBSQL_SQLITE_VERSION = '3.45.1' as const;

/**
 * The packages `@libsql/client/sqlite3` loads at runtime, copied flat into the packaged app's
 * `node_modules/` (`app.asar/node_modules/<name>`). Each is resolved as Node would resolve it from
 * the package that requires it (`requiredBy`; `@app/db` is the workspace package `packages/db`):
 * `detect-libc` is `libsql`'s exact 2.0.2, nested under `libsql/node_modules` in the install.
 */
export const LIBSQL_RUNTIME_PACKAGES = [
  { name: '@libsql/client', requiredBy: '@app/db' },
  { name: '@libsql/core', requiredBy: '@libsql/client' },
  { name: 'js-base64', requiredBy: '@libsql/core' },
  { name: 'libsql', requiredBy: '@libsql/client' },
  { name: '@neon-rs/load', requiredBy: 'libsql' },
  { name: 'detect-libc', requiredBy: 'libsql' },
] as const;
export type LibsqlRuntimePackage = (typeof LIBSQL_RUNTIME_PACKAGES)[number]['name'];

/**
 * Dependencies a runtime package declares that `@libsql/client/sqlite3` never loads (they serve its
 * HTTP / WebSocket clients), so they are not shipped. Any other declared dependency that is not a
 * runtime package fails the build (`libsql-runtime-copied`): an upgrade that adds one is reviewed.
 */
export const LIBSQL_UNLOADED_DEPENDENCIES = {
  '@libsql/client': ['@libsql/hrana-client', 'promise-limit'],
} as const satisfies Partial<Record<LibsqlRuntimePackage, readonly string[]>>;

/** The package that holds the per-target prebuilds (as its `optionalDependencies`). */
export const LIBSQL_NATIVE_PACKAGE = 'libsql' as const;

/**
 * The packaged targets (`<platform>-<arch>`: `MAC_ARCHS`, `LINUX_ARCHS`, `WIN_ARCHS` of the
 * platform specs) and the libSQL prebuild each ships, `@libsql/<prebuild>`. Linux is glibc only
 * (`-gnu`): on a musl system `libsql` asks for `linux-x64-musl`, which is not shipped, so libSQL
 * (sync) is unavailable there. A target not listed here fails the build.
 */
export const LIBSQL_PREBUILD_TARGETS = {
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64-gnu',
  'win32-x64': 'win32-x64-msvc',
} as const;
export type PackagedTarget = keyof typeof LIBSQL_PREBUILD_TARGETS;

/** The prebuild's native module, in its package directory. */
export const LIBSQL_PREBUILD_FILE = 'index.node' as const;

/** `@libsql/<prebuild>` for a packaged target. */
export function libsqlPrebuildPackage(target: PackagedTarget): string {
  return `@libsql/${LIBSQL_PREBUILD_TARGETS[target]}`;
}

/** The packaged target of a Forge `platform` / `arch`, or `null` when frost does not package it. */
export function packagedTarget(platform: string, arch: string): PackagedTarget | null {
  const target = `${platform}-${arch}`;
  return Object.hasOwn(LIBSQL_PREBUILD_TARGETS, target) ? (target as PackagedTarget) : null;
}

/**
 * `packagerConfig.asar.unpack`: a prebuild's `index.node` only, never JavaScript. `@electron/asar`
 * matches it with minimatch against each file's **absolute** path, with no `dot` option (only
 * `matchBase`), and `**` never crosses a dot directory. So the pattern spells out up to
 * `LIBSQL_ASAR_UNPACK_DOT_DIRS` dot directories (`.*`) anywhere in the build path, each optional
 * brace group allowing one. A build path with more of them unpacks nothing; that fails
 * closed at verify time (`unpacked-allowlist`), never ships JavaScript unpacked.
 */
export const LIBSQL_ASAR_UNPACK = '**/{.*/**/,}{.*/**/,}{.*/**/,}{.*/**/,}node_modules/@libsql/*/index.node' as const;

/** How many dot directories in the build path `LIBSQL_ASAR_UNPACK` allows. */
export const LIBSQL_ASAR_UNPACK_DOT_DIRS = 4;

/**
 * Files of a runtime package that are not copied, since the app never reads them (docs, types,
 * source maps). A license or notice file (`LIBSQL_KEPT_FILES`) is always copied.
 */
export const LIBSQL_SKIPPED_FILES = /(\.md|\.d\.[cm]?ts|\.map)$/i;
export const LIBSQL_KEPT_FILES = /^(licen[cs]e|notice|copying)/i;

/** One value per packaged target. */
function perTarget(value: (target: PackagedTarget) => readonly string[]): Readonly<Record<PackagedTarget, readonly string[]>> {
  return { 'darwin-arm64': value('darwin-arm64'), 'linux-x64': value('linux-x64'), 'win32-x64': value('win32-x64') };
}

/** The unpacked side of the archive, beside `app.asar` in `resources/`. */
export const PACKAGED_UNPACKED_DIR = 'app.asar.unpacked' as const;

/**
 * Everything allowed in `resources/app.asar.unpacked/` (paths relative to `resources/`), and the
 * only entries `app.asar`'s header may mark `unpacked`: the target's prebuild, nothing else.
 */
export const PACKAGED_UNPACKED_ALLOWLIST = perTarget((target) => [
  `${PACKAGED_UNPACKED_DIR}/node_modules/${libsqlPrebuildPackage(target)}/${LIBSQL_PREBUILD_FILE}`,
]);

/**
 * The packages allowed in `app.asar/node_modules/` (sorted): exactly `LIBSQL_RUNTIME_PACKAGES`
 * and the target's prebuild, flat (no nested `node_modules/`).
 */
export const PACKAGED_ASAR_NODE_MODULES = perTarget((target) =>
  [...LIBSQL_RUNTIME_PACKAGES.map((pkg) => pkg.name), libsqlPrebuildPackage(target)].sort(),
);
