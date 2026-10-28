// Spec: specs/linux-package.spec.ts · Acceptance: specs/linux-package.feature.md (Forge configuration)
import { readFileSync } from 'node:fs';
import { FuseV1Options } from '@electron/fuses';
import type { MakerBase } from '@electron-forge/maker-base';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { describe, expect, test } from 'vitest';
import {
  LINUX_APPIMAGE_RUNTIME,
  LINUX_ARCHS,
  LINUX_DEB_OPTIONS,
  LINUX_DESKTOP_CATEGORIES,
  LINUX_EXECUTABLE_NAME,
  LINUX_LICENSE,
  LINUX_PACKAGE_NAME,
  type LinuxArch,
} from '@app/specs/linux-package.spec';
import { PACKAGED_FUSES } from '@app/specs/macos-package.spec';
import { makeForgeConfig } from '../../forge.config';

type PackageJson = { license: string; scripts: Record<string, string> };
const readPackageJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as PackageJson;
const packageJson = readPackageJson('../../package.json');
const rootPackageJson = readPackageJson('../../../../package.json');

type MakerInfo = { platforms: string[]; config: { options?: Record<string, unknown> } & Record<string, unknown> };

/** The makers that target linux, by name, with their config for `arch`. */
async function linuxMakers(arch: LinuxArch): Promise<Map<string, MakerInfo>> {
  const result = new Map<string, MakerInfo>();
  for (const maker of (makeForgeConfig({}).makers ?? []) as MakerBase<Record<string, unknown>>[]) {
    if (!maker.platforms.includes('linux')) continue;
    await maker.prepareConfig(arch);
    result.set(maker.name, { platforms: maker.platforms, config: maker.config });
  }
  return result;
}

describe('forge config (Linux packages)', () => {
  test('makes-zip-deb-and-appimage', async () => {
    const byName = await linuxMakers('x64');
    expect([...byName.keys()].sort()).toEqual(['AppImage', 'deb', 'zip']);
    expect(byName.get('deb')?.platforms).toEqual(['linux']);
    expect(byName.get('AppImage')?.platforms).toEqual(['linux']);
  });

  test('deb-options-as-specified', async () => {
    const deb = (await linuxMakers('x64')).get('deb');
    // Exactly the spec's options: in particular no `scripts` (no maintainer scripts).
    expect(deb?.config).toEqual({ options: { ...LINUX_DEB_OPTIONS, categories: [...LINUX_DESKTOP_CATEGORIES] } });
    expect(deb?.config.options).not.toHaveProperty('scripts');
    expect(packageJson.license).toBe(LINUX_LICENSE);
  });

  test.each(LINUX_ARCHS)('appimage-options-as-specified (%s)', async (arch) => {
    const appImage = (await linuxMakers(arch)).get('AppImage');
    expect(appImage?.config.options).toEqual({
      name: LINUX_PACKAGE_NAME,
      bin: LINUX_EXECUTABLE_NAME,
      categories: [...LINUX_DESKTOP_CATEGORIES],
      runtime: LINUX_APPIMAGE_RUNTIME[arch].url,
    });
    // A dated release, never the moving `continuous` tag.
    expect(LINUX_APPIMAGE_RUNTIME[arch].url).toMatch(/^https:\/\/github\.com\/AppImage\/type2-runtime\/releases\/download\/\d{8}\//);
  });

  test('linux-fuses-unchanged', async () => {
    const plugin = makeForgeConfig({}).plugins?.find((p) => p instanceof FusesPlugin);
    if (!(plugin instanceof FusesPlugin)) throw new Error('no FusesPlugin');
    const config = plugin.fusesConfig as unknown as Record<string, unknown>;
    const fuses = Object.fromEntries(
      Object.entries(config)
        .filter(([key]) => /^\d+$/.test(key))
        .map(([key, value]) => [FuseV1Options[Number(key)], value]),
    );
    expect(fuses).toEqual(PACKAGED_FUSES);

    const commands: string[][] = [];
    const withRecorder = makeForgeConfig({}, (command, args) => void commands.push([command, ...args]));
    await withRecorder.hooks?.postPackage?.({} as never, { platform: 'linux', arch: 'x64', outputPaths: [`/out/${LINUX_PACKAGE_NAME}-linux-x64`] });
    expect(commands).toEqual([]);
  });

  test('linux-scripts', () => {
    expect(packageJson.scripts['make:linux']).toBe(`electron-forge make --platform linux --arch ${LINUX_ARCHS.join(',')}`);
    expect(packageJson.scripts['verify:linux']).toBe('node scripts/verify-linux-package.mjs');
    expect(rootPackageJson.scripts['make:linux']).toBe('pnpm --filter @app/desktop make:linux');
    expect(rootPackageJson.scripts['verify:linux']).toBe('pnpm --filter @app/desktop verify:linux');
  });
});
