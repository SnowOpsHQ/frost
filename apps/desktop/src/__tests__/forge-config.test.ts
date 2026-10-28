// Spec: specs/macos-package.spec.ts · Acceptance: specs/macos-package.feature.md (Forge configuration)
import { existsSync, readFileSync } from 'node:fs';
import { FuseV1Options } from '@electron/fuses';
import type { MakerBase } from '@electron-forge/maker-base';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import {
  MAC_APP_CATEGORY,
  MAC_ARCHS,
  MAC_BUNDLE_ID,
  MAC_DMG_FORMAT,
  MAC_ENTITLEMENTS,
  MAC_EXECUTABLE_NAME,
  MAC_PRODUCT_NAME,
  MAC_SIGNING_ENV,
  PACKAGED_FUSES,
} from '@app/specs/macos-package.spec';
import { makeForgeConfig } from '../../forge.config';
import { NOTICES_FILE } from '../../third-party-notices';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  productName: string;
  scripts: Record<string, string>;
};

/** Runs the `postPackage` hook for one packaged output dir, recording the commands it runs. */
async function postPackage(env: NodeJS.ProcessEnv, platform: 'darwin' | 'linux') {
  const commands: string[][] = [];
  const config = makeForgeConfig(env, (command, args) => void commands.push([command, ...args]));
  const outputPaths = [`/out/${MAC_PRODUCT_NAME}-${platform}-arm64`];
  await config.hooks?.postPackage?.({} as never, { platform, arch: 'arm64', outputPaths });
  return commands;
}

const AD_HOC_SEAL = (appPath: string) => [
  'codesign',
  '--sign',
  '-',
  '--force',
  '--deep',
  '--preserve-metadata=entitlements,requirements,flags,runtime',
  appPath,
];

const SIGNING_ENV = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAM123456)',
  APPLE_ID: 'dev@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
  APPLE_TEAM_ID: 'TEAM123456',
} satisfies Record<(typeof MAC_SIGNING_ENV)[number], string>;

function fusesPlugin(env: NodeJS.ProcessEnv) {
  const plugin = makeForgeConfig(env).plugins?.find((p) => p instanceof FusesPlugin);
  if (!(plugin instanceof FusesPlugin)) throw new Error('no FusesPlugin');
  return plugin.fusesConfig as unknown as Record<string, unknown>;
}

/** The darwin makers (the Linux-only ones are linux-package-config.test.ts's), prepared for arm64. */
async function makers(): Promise<Map<string, { platforms: string[]; config: Record<string, unknown> }>> {
  const result = new Map<string, { platforms: string[]; config: Record<string, unknown> }>();
  for (const maker of (makeForgeConfig({}).makers ?? []) as MakerBase<Record<string, unknown>>[]) {
    if (!maker.platforms.includes('darwin')) continue;
    await maker.prepareConfig('arm64');
    result.set(maker.name, { platforms: maker.platforms, config: maker.config });
  }
  return result;
}

describe('forge config (macOS package)', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('identifies-the-mac-bundle', () => {
    const { packagerConfig } = makeForgeConfig({});
    expect(packagerConfig).toMatchObject({
      name: MAC_PRODUCT_NAME,
      executableName: MAC_EXECUTABLE_NAME,
      appBundleId: MAC_BUNDLE_ID,
      appCategoryType: MAC_APP_CATEGORY,
      darwinDarkModeSupport: true,
      asar: true,
    });
    expect(packageJson.productName).toBe(MAC_PRODUCT_NAME);
  });

  test('ships-third-party-notices', () => {
    // specs/seo-speed.feature.md (Licenses): the notices file is an extra resource of every package
    // (resources/THIRD_PARTY_NOTICES beside app.asar), for the libraries frost bundles and injects.
    const { packagerConfig } = makeForgeConfig({});
    expect(packagerConfig?.extraResource).toEqual([NOTICES_FILE]);
    expect(existsSync(new URL(`../../${NOTICES_FILE}`, import.meta.url))).toBe(true);
  });

  test('flips-the-spec-fuses', () => {
    const config = fusesPlugin({});
    const fuses = Object.fromEntries(
      Object.entries(config)
        .filter(([key]) => /^\d+$/.test(key))
        .map(([key, value]) => [FuseV1Options[Number(key)], value]),
    );
    expect(fuses).toEqual(PACKAGED_FUSES);
  });

  const partialEnvs: [string, string | undefined][] = MAC_SIGNING_ENV.flatMap((name) => [
    [name, undefined],
    [name, ''],
  ]);
  test.each(partialEnvs)(
    'ad-hoc-signs-when-unsigned (%s=%j)',
    (name, value) => {
      const env: NodeJS.ProcessEnv = { ...SIGNING_ENV, [name]: value };
      const { packagerConfig } = makeForgeConfig(env);
      expect(packagerConfig?.osxSign).toBeUndefined();
      expect(packagerConfig?.osxNotarize).toBeUndefined();
      expect(fusesPlugin(env)['resetAdHocDarwinSignature']).toBe(true);
    },
  );

  test('ad-hoc-signs-when-unsigned (empty env)', () => {
    const { packagerConfig } = makeForgeConfig({});
    expect(packagerConfig?.osxSign).toBeUndefined();
    expect(packagerConfig?.osxNotarize).toBeUndefined();
    expect(fusesPlugin({})['resetAdHocDarwinSignature']).toBe(true);
  });

  test('ad-hoc-signs-when-unsigned (re-seals the packaged bundle)', async () => {
    expect(await postPackage({}, 'darwin')).toEqual([AD_HOC_SEAL(`/out/${MAC_PRODUCT_NAME}-darwin-arm64/${MAC_PRODUCT_NAME}.app`)]);
    expect(await postPackage({}, 'linux')).toEqual([]);
    expect(await postPackage({ ...SIGNING_ENV }, 'darwin')).toEqual([]);
  });

  test('warns-on-partial-signing-env', () => {
    const { APPLE_ID: _id, APPLE_TEAM_ID: _team, ...partial } = SIGNING_ENV;
    const { packagerConfig } = makeForgeConfig({ ...partial, APPLE_TEAM_ID: '' });
    expect(packagerConfig?.osxSign).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('APPLE_ID');
    expect(message).toContain('APPLE_TEAM_ID');
    expect(message).not.toContain('APPLE_SIGNING_IDENTITY');
    expect(message).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');

    warn.mockClear();
    makeForgeConfig({});
    makeForgeConfig({ APPLE_ID: '' });
    makeForgeConfig({ ...SIGNING_ENV });
    expect(warn).not.toHaveBeenCalled();
  });

  test('signs-and-notarizes-when-configured', () => {
    const { packagerConfig } = makeForgeConfig({ ...SIGNING_ENV });
    expect(packagerConfig?.osxSign).toMatchObject({ identity: SIGNING_ENV.APPLE_SIGNING_IDENTITY, continueOnError: false });
    const osxSign = packagerConfig?.osxSign;
    if (typeof osxSign !== 'object') throw new Error('osxSign is not an options object');
    expect(osxSign.optionsForFile?.('/x/frost.app', {} as never)).toEqual({ hardenedRuntime: true, entitlements: [...MAC_ENTITLEMENTS] });
    expect(packagerConfig?.osxNotarize).toEqual({
      appleId: SIGNING_ENV.APPLE_ID,
      appleIdPassword: SIGNING_ENV.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: SIGNING_ENV.APPLE_TEAM_ID,
    });
    expect(fusesPlugin({ ...SIGNING_ENV })['resetAdHocDarwinSignature']).toBe(false);
  });

  test('makes-zip-and-dmg', async () => {
    const byName = await makers();
    expect([...byName.keys()].sort()).toEqual(['dmg', 'zip']);
    expect(byName.get('zip')?.platforms.sort()).toEqual(['darwin', 'linux']);
    expect(byName.get('dmg')?.platforms).toEqual(['darwin']);
    expect(byName.get('dmg')?.config).toMatchObject({ format: MAC_DMG_FORMAT });
  });

  test('linux-build-unaffected', async () => {
    expect(packageJson.scripts['build']).toBe('electron-forge package');
    expect(packageJson.scripts['make']).toBe('electron-forge make');
    expect(packageJson.scripts['make:mac']).toBe(`electron-forge make --platform darwin --arch ${MAC_ARCHS.join(',')}`);
    expect((await makers()).get('dmg')?.platforms).not.toContain('linux');
  });
});
