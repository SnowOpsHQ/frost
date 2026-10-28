// Spec: specs/windows-package.spec.ts · Acceptance: specs/windows-package.feature.md (Forge configuration)
import { readFileSync } from 'node:fs';
import { FuseV1Options } from '@electron/fuses';
import type { MakerBase } from '@electron-forge/maker-base';
import type { ForgeArch } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { describe, expect, test } from 'vitest';
import * as linuxSpec from '@app/specs/linux-package.spec';
import { PACKAGED_FUSES } from '@app/specs/macos-package.spec';
import {
  PACKAGED_ASAR_TOP_LEVEL,
  PACKAGED_RESOURCES_ALLOWLIST,
  WIN_ARCHS,
  WIN_PACKAGE_NAME,
  WIN_SIGNING_OPTIONS,
  WIN_SQUIRREL_OPTIONS,
  winArtifacts,
  winSetupExe,
} from '@app/specs/windows-package.spec';
import { makeForgeConfig } from '../../forge.config';
import { squirrelOptions } from '../../windows-makers';

type PackageJson = { version: string; scripts: Record<string, string> };
const readPackageJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as PackageJson;
const packageJson = readPackageJson('../../package.json');
const rootPackageJson = readPackageJson('../../../../package.json');

type MakerInfo = { platforms: string[]; config: Record<string, unknown> };

/** The makers that target win32, by name, with their config for `arch`. */
async function windowsMakerConfigs(arch: ForgeArch, env: NodeJS.ProcessEnv = {}): Promise<Map<string, MakerInfo>> {
  const result = new Map<string, MakerInfo>();
  for (const maker of (makeForgeConfig(env).makers ?? []) as MakerBase<Record<string, unknown>>[]) {
    if (!maker.platforms.includes('win32')) continue;
    expect(result.has(maker.name), `two ${maker.name} makers target win32`).toBe(false);
    await maker.prepareConfig(arch);
    result.set(maker.name, { platforms: maker.platforms, config: maker.config });
  }
  return result;
}

describe('forge config (Windows packages)', () => {
  test('makes-squirrel-and-zip', async () => {
    const byName = await windowsMakerConfigs('x64');
    expect([...byName.keys()].sort()).toEqual(['squirrel', 'zip']);
    expect(byName.get('squirrel')?.platforms).toEqual(['win32']);
    expect(byName.get('zip')?.platforms).toEqual(['win32']);
    expect(byName.get('zip')?.config).toEqual({});
  });

  test.each(WIN_ARCHS)('squirrel-options-as-specified (%s)', async (arch) => {
    const squirrel = (await windowsMakerConfigs(arch)).get('squirrel');
    expect(squirrel?.config).toEqual({ ...WIN_SQUIRREL_OPTIONS, setupExe: winSetupExe(packageJson.version, arch) });
    expect(WIN_SQUIRREL_OPTIONS).toMatchObject({ name: WIN_PACKAGE_NAME, noMsi: true });
    // A valid NuGet id (the maker's default would be the packaged package.json#name, `@app/desktop`).
    expect(WIN_PACKAGE_NAME).toMatch(/^[A-Za-z0-9_.]+$/);
    // The artifact paths agree with the options.
    const artifacts = winArtifacts(packageJson.version, arch);
    expect(artifacts.setupExe.endsWith(`/${squirrel?.config['setupExe']}`)).toBe(true);
    expect(artifacts.nupkg).toBe(`make/squirrel.windows/${arch}/${WIN_SQUIRREL_OPTIONS.name}-${packageJson.version}-full.nupkg`);
  });

  test('squirrel-arch-fails-closed', async () => {
    for (const arch of ['arm64', 'ia32', 'armv7l'] as const) {
      expect(() => squirrelOptions(arch), arch).toThrow(/no Windows build for/);
      await expect(windowsMakerConfigs(arch), arch).rejects.toThrow(/no Windows build for/);
    }
    expect(() => squirrelOptions('toString')).toThrow(/no Windows build for/);
  });

  test('unsigned-whatever-the-env', async () => {
    // Nothing reads a signing secret: with every plausible signing variable set, the Squirrel
    // options and the packager config carry no signing option.
    const env = {
      WINDOWS_CERTIFICATE_FILE: 'C:\\cert.pfx',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret',
      CSC_LINK: 'C:\\cert.pfx',
      CSC_KEY_PASSWORD: 'secret',
      SIGNTOOL_PATH: 'C:\\signtool.exe',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAM123456)',
    };
    for (const arch of WIN_ARCHS) {
      for (const environment of [{}, env]) {
        const squirrel = (await windowsMakerConfigs(arch, environment)).get('squirrel');
        for (const option of WIN_SIGNING_OPTIONS) expect(squirrel?.config, option).not.toHaveProperty(option);
        expect(makeForgeConfig(environment).packagerConfig).not.toHaveProperty('windowsSign');
      }
    }
  });

  test('windows-fuses-unchanged', async () => {
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
    const outputPaths = [`C:\\out\\${winArtifacts('0.0.0', 'x64').packaged}`];
    await withRecorder.hooks?.postPackage?.({} as never, { platform: 'win32', arch: 'x64', outputPaths });
    expect(commands).toEqual([]);
  });

  test('resources-allowlist-matches-linux', () => {
    expect(PACKAGED_RESOURCES_ALLOWLIST).toEqual(linuxSpec.PACKAGED_RESOURCES_ALLOWLIST);
    expect(PACKAGED_ASAR_TOP_LEVEL).toEqual(linuxSpec.PACKAGED_ASAR_TOP_LEVEL);
  });

  test('windows-scripts', () => {
    expect(packageJson.scripts['make:win']).toBe(`electron-forge make --platform win32 --arch ${WIN_ARCHS.join(',')}`);
    expect(packageJson.scripts['verify:win']).toBe('node scripts/verify-windows-package.mjs');
    expect(rootPackageJson.scripts['make:win']).toBe('pnpm --filter @app/desktop make:win');
    expect(rootPackageJson.scripts['verify:win']).toBe('pnpm --filter @app/desktop verify:win');
  });
});
