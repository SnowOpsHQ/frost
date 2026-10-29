import { readFileSync } from 'node:fs';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { WIN_ARCHS, WIN_SQUIRREL_OPTIONS, WIN_VERSION_STRINGS, winSetupExe, type WinArch } from '@app/specs/windows-package.spec';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/**
 * The Squirrel options for `arch` (specs/windows-package.spec.ts `WIN_SQUIRREL_OPTIONS`, setup file
 * `winSetupExe`). Fails closed on an arch the spec does not list. No signing option is set
 * (`WIN_SIGNING_OPTIONS`), whatever the environment: the installer and the app are unsigned.
 */
export function squirrelOptions(arch: string, appVersion: string = version) {
  if (!(WIN_ARCHS as readonly string[]).includes(arch)) {
    throw new Error(`forge.config: no Windows build for ${arch} (specs/windows-package.spec.ts WIN_ARCHS)`);
  }
  return { ...WIN_SQUIRREL_OPTIONS, setupExe: winSetupExe(appVersion, arch as WinArch) };
}

/**
 * The Windows-only makers (specs/windows-package.spec.ts): the Squirrel per-user installer and the
 * zip of the packaged tree, both unsigned (frost has no Authenticode certificate). The zip maker
 * shared by macOS and Linux stays in forge.config.ts.
 */
export function windowsMakers() {
  return [new MakerSquirrel((arch) => squirrelOptions(arch), ['win32']), new MakerZIP({}, ['win32'])];
}

/**
 * Packager options for `frost.exe`'s version resource (specs/windows-package.spec.ts
 * `WIN_VERSION_STRINGS`), replacing Electron's company and copyright strings. `appCopyright` is
 * also the macOS bundle's `NSHumanReadableCopyright`.
 */
export function windowsPackagerConfig() {
  const { LegalCopyright, ...win32metadata } = WIN_VERSION_STRINGS;
  return { win32metadata, appCopyright: LegalCopyright };
}
