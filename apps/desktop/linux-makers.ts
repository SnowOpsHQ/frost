import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerAppImage } from '@reforged/maker-appimage';
import {
  LINUX_APPIMAGE_RUNTIME,
  LINUX_DEB_OPTIONS,
  LINUX_DESKTOP_CATEGORIES,
  LINUX_EXECUTABLE_NAME,
  LINUX_PACKAGE_NAME,
} from '@app/specs/linux-package.spec';

/**
 * The pinned AppImage runtime for `arch` (specs/linux-package.spec.ts `LINUX_APPIMAGE_RUNTIME`).
 * Fails closed: an arch without a pin throws rather than fall back to the maker's default, a
 * moving tag it downloads unchecked.
 */
export function appImageRuntime(arch: string): string {
  if (!Object.hasOwn(LINUX_APPIMAGE_RUNTIME, arch)) {
    throw new Error(`forge.config: no pinned AppImage runtime for ${arch} (specs/linux-package.spec.ts LINUX_APPIMAGE_RUNTIME)`);
  }
  return LINUX_APPIMAGE_RUNTIME[arch as keyof typeof LINUX_APPIMAGE_RUNTIME].url;
}

/**
 * The Linux-only makers (specs/linux-package.spec.ts): the deb (no maintainer scripts) and the
 * AppImage (its runtime pinned per arch; verify-linux-package.mjs checks the AppImage starts with
 * exactly the pinned bytes). Both unsigned: frost has no repository key. The zip maker, shared
 * with macOS, stays in forge.config.ts.
 */
export function linuxMakers() {
  return [
    new MakerDeb({ options: { ...LINUX_DEB_OPTIONS, categories: [...LINUX_DESKTOP_CATEGORIES] } }, ['linux']),
    new MakerAppImage(
      (arch) => ({
        options: {
          name: LINUX_PACKAGE_NAME,
          bin: LINUX_EXECUTABLE_NAME,
          categories: [...LINUX_DESKTOP_CATEGORIES],
          runtime: appImageRuntime(arch),
        },
      }),
      ['linux'],
    ),
  ];
}
