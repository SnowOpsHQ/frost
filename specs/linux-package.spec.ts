/**
 * Linux packaging contract (design doc §4 Phase 7: cross-platform; Phase 7 Task 1). Implemented by
 * `apps/desktop/forge.config.ts`; checked by `apps/desktop/src/__tests__/linux-package-config.test.ts`
 * (config values) and `apps/desktop/scripts/verify-linux-package.mjs` (the built packages, on Linux).
 * Acceptance list: `linux-package.feature.md`.
 *
 * The fuses are `PACKAGED_FUSES` of `macos-package.spec.ts`: one fuse set for every platform.
 *
 * **Unsigned.** frost has no Linux repository key: the deb carries no signature (it is not served
 * from an apt repository) and the AppImage embeds none. Nothing here or in the docs claims otherwise.
 *
 * Self-contained (no imports, erasable TypeScript only) so the verify script can load it with
 * Node's built-in type stripping.
 */

/** The deb's `Package`, the AppImage's name, `/usr/bin/<name>` and `/usr/lib/<name>/`. */
export const LINUX_PACKAGE_NAME = 'frost';

/** The packaged executable (`packagerConfig.executableName`, the same on every platform). */
export const LINUX_EXECUTABLE_NAME = 'frost';

/** x64 only for now; arm64 is a follow-up. */
export const LINUX_ARCHS = ['x64'] as const;
export type LinuxArch = (typeof LINUX_ARCHS)[number];

/** Debian's name for each arch (the control file's `Architecture`, the `.deb` file name). */
export const LINUX_DEB_ARCH = { x64: 'amd64' } as const satisfies Record<LinuxArch, string>;

/** `package.json#license` (SPDX). Debian's control file has no license field. */
export const LINUX_LICENSE = 'AGPL-3.0-only';

/** The freedesktop.org menu categories of the `.desktop` file, in the deb and the AppImage alike. */
export const LINUX_DESKTOP_CATEGORIES = ['Network'] as const;

/**
 * `@electron-forge/maker-deb` options (electron-installer-debian). `bin` is the executable, since
 * the installer's default is the packaged `package.json#name` (`@app/desktop`). No `scripts`: the
 * deb runs no maintainer scripts (no preinst / postinst / prerm / postrm).
 */
export const LINUX_DEB_OPTIONS = {
  name: LINUX_PACKAGE_NAME,
  bin: LINUX_EXECUTABLE_NAME,
  section: 'web',
  priority: 'optional',
  categories: LINUX_DESKTOP_CATEGORIES,
  maintainer: 'SnowOpsHQ',
  homepage: 'https://github.com/SnowOpsHQ/frost',
} as const;

/**
 * Where the deb installs the app (`dpkg-deb -c`, without the leading `.`). Every file of the deb
 * lies under one of `LINUX_DEB_INSTALL_ROOTS`.
 */
export const LINUX_DEB_APP_DIR = `/usr/lib/${LINUX_PACKAGE_NAME}`;
export const LINUX_DEB_BIN_LINK = `/usr/bin/${LINUX_PACKAGE_NAME}`;
export const LINUX_DEB_DESKTOP_FILE = `/usr/share/applications/${LINUX_PACKAGE_NAME}.desktop`;
export const LINUX_DEB_INSTALL_ROOTS = [`${LINUX_DEB_APP_DIR}/`, '/usr/bin/', '/usr/share/'] as const;

/**
 * The only setuid file in the deb: Chromium's sandbox helper, setuid root (mode 4755). Chromium
 * uses it only where unprivileged user namespaces are unavailable; elsewhere (and always in the
 * AppImage, whose image is mounted `nosuid`) the namespace sandbox is used. The sandbox is never
 * turned off (`--no-sandbox` is not used anywhere).
 */
export const LINUX_DEB_SETUID_FILES = [`${LINUX_DEB_APP_DIR}/chrome-sandbox`] as const;

/** Inside the extracted AppImage (`squashfs-root/`): the packaged tree, as `@reforged/maker-appimage` lays it out. */
export const LINUX_APPIMAGE_APP_DIR = `usr/lib/${LINUX_PACKAGE_NAME}`;

/**
 * The AppImage runtime (the ELF stub that mounts or extracts the image), pinned to a dated
 * release of AppImage/type2-runtime instead of the maker's default moving `continuous` tag. The
 * maker downloads it without checking it, so the verify script checks that the AppImage starts with
 * exactly these bytes (`sha256` of the first `bytes` bytes).
 */
export const LINUX_APPIMAGE_RUNTIME = {
  x64: {
    url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
    sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
    bytes: 944_632,
  },
} as const satisfies Record<LinuxArch, { url: string; sha256: string; bytes: number }>;

/**
 * Everything allowed directly in a packaged app's `resources/`: the app archive and the
 * third-party notices (`third-party-notices.ts` `NOTICES_FILE`, an extra resource). Nothing else:
 * in particular no `app.asar.unpacked/` and no loose `app/` directory. A native module that must
 * be unpacked (Phase 7 Task 7) adds its own allowlist of unpacked files; there is none today.
 */
export const PACKAGED_RESOURCES_ALLOWLIST = ['app.asar', 'THIRD_PARTY_NOTICES'] as const;

/** The top-level entries of `app.asar`: the Vite build output and the app's `package.json`. */
export const PACKAGED_ASAR_TOP_LEVEL = ['.vite', 'package.json'] as const;

/** A packaged app must still be running this long after launch (no crash, no sandbox abort). */
export const LINUX_LAUNCH_ALIVE_MS = 10_000;

/**
 * Paths under `apps/desktop/out/` that `electron-forge make --platform linux --arch <arch>`
 * produces. `version` is `package.json#version`; the deb name uses it as is, which holds for a
 * release version (electron-installer-debian rewrites a pre-release suffix such as `-beta.1` to
 * `~beta.1`).
 */
export function linuxArtifacts(version: string, arch: LinuxArch) {
  const dir = `${LINUX_PACKAGE_NAME}-linux-${arch}`;
  return {
    /** `electron-forge package` output (the executable is `<packaged>/<LINUX_EXECUTABLE_NAME>`). */
    packaged: dir,
    /** `@electron-forge/maker-zip`. */
    zip: `make/zip/linux/${arch}/${dir}-${version}.zip`,
    /** `@electron-forge/maker-deb` (electron-installer-debian's `<name>_<version>_<arch>.deb`). */
    deb: `make/deb/${arch}/${LINUX_PACKAGE_NAME}_${version}_${LINUX_DEB_ARCH[arch]}.deb`,
    /** `@reforged/maker-appimage` (`<productName>-<version>-<arch>.AppImage`). */
    appImage: `make/AppImage/${arch}/${LINUX_PACKAGE_NAME}-${version}-${arch}.AppImage`,
  } as const;
}
