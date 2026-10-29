// Spec: specs/macos-package.spec.ts · Acceptance: specs/macos-package.feature.md (Forge configuration)
// The intent runtime (Phase 3 Task 2): specs/intent-classifier.feature.md (Packaging)
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { createPackageWithOptions, listPackage } from '@electron/asar';
import { build, mergeConfig, type InlineConfig } from 'vite';
import intentViteConfig from '../../vite.intent.config';
import { FuseV1Options } from '@electron/fuses';
import type { MakerBase } from '@electron-forge/maker-base';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
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
import { PACKAGED_ASAR_NODE_MODULES, PACKAGED_ASAR_UNPACK, packagedTarget } from '@app/specs/sync-package.spec';
import { makeForgeConfig } from '../../forge.config';
import { NOTICES_FILE } from '../../third-party-notices';
import { copyIntentRuntime, INTENT_ASAR_UNPACK, intentRuntimeFiles } from '../../intent-runtime';

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
      asar: { unpack: PACKAGED_ASAR_UNPACK },
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
    expect(await postPackage({}, 'darwin')).toEqual([AD_HOC_SEAL(path.join(`/out/${MAC_PRODUCT_NAME}-darwin-arm64`, `${MAC_PRODUCT_NAME}.app`))]);
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

  // ---- The intent runtime (specs/intent-classifier.feature.md, Packaging) ----------------------

  const ORT = 'node_modules/onnxruntime-node';
  const COMMON = 'node_modules/onnxruntime-common';
  const natives = (files: readonly string[]) => files.filter((file) => file.startsWith(`${ORT}/bin/`)).sort();

  test('intent-runtime-files-per-platform', () => {
    // Only the target's binaries, and only the library the binding links against (no duplicate).
    expect(natives(intentRuntimeFiles('darwin', 'arm64'))).toEqual([`${ORT}/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`, `${ORT}/bin/napi-v6/darwin/arm64/onnxruntime_binding.node`]);
    expect(natives(intentRuntimeFiles('linux', 'x64'))).toEqual([`${ORT}/bin/napi-v6/linux/x64/libonnxruntime.so.1`, `${ORT}/bin/napi-v6/linux/x64/onnxruntime_binding.node`]);
    expect(natives(intentRuntimeFiles('linux', 'arm64'))).toEqual([`${ORT}/bin/napi-v6/linux/arm64/libonnxruntime.so.1`, `${ORT}/bin/napi-v6/linux/arm64/onnxruntime_binding.node`]);
    // The runtime JavaScript of both packages: their package.json and CommonJS dist, nothing else.
    const files = intentRuntimeFiles('linux', 'x64');
    for (const file of [`${ORT}/package.json`, `${ORT}/dist/index.js`, `${ORT}/dist/binding.js`, `${ORT}/dist/backend.js`, `${ORT}/dist/version.js`, `${COMMON}/package.json`, `${COMMON}/dist/cjs/package.json`, `${COMMON}/dist/cjs/index.js`]) {
      expect(files).toContain(file);
    }
    for (const file of files) {
      expect(file, file).toMatch(/^node_modules\/onnxruntime-(node|common)\//);
      expect(file, file).not.toMatch(/\.(map|d\.ts|ts)$|\/(lib|script|esm)\//);
    }
    expect(new Set(files).size).toBe(files.length);
    expect(natives(intentRuntimeFiles('win32', 'x64'))).toEqual([`${ORT}/bin/napi-v6/win32/x64/onnxruntime.dll`, `${ORT}/bin/napi-v6/win32/x64/onnxruntime_binding.node`]);
    // No binaries for a target frost does not package the runtime for: the build fails loudly.
    expect(() => intentRuntimeFiles('darwin', 'x64')).toThrow(/darwin-x64/);
  });

  test('intent-runtime-copied-by-the-package-hook', async () => {
    // The hook copies libSQL too (libsql-packaging.test.ts), whose prebuild is installed for the host
    // only: run it for the host's packaged target, and check the intent runtime's part of the copy.
    const target = packagedTarget(process.platform, process.arch);
    if (target === null) return; // a host frost does not package
    const buildPath = mkdtempSync(path.join(tmpdir(), 'frost-intent-pack-'));
    try {
      await makeForgeConfig({}).hooks?.packageAfterCopy?.({} as never, buildPath, '45.0.0', process.platform as never, process.arch as never);
      const copied = (dir: string, prefix = ''): string[] =>
        readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? copied(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name).split(path.sep).join('/')]));
      const intent = (files: string[]) => files.filter((file) => /^node_modules\/onnxruntime-(node|common)\//.test(file)).sort();
      const expected = [...intentRuntimeFiles(process.platform, process.arch)].sort();
      expect(intent(copied(buildPath))).toEqual(expected);
      // Both runtimes, and nothing else: the packages app.asar may hold (sync-package.spec.ts).
      expect(readdirSync(path.join(buildPath, 'node_modules')).flatMap((name) => (name.startsWith('@') ? readdirSync(path.join(buildPath, 'node_modules', name)).map((sub) => `${name}/${sub}`) : [name])).sort()).toEqual(PACKAGED_ASAR_NODE_MODULES[target]);
      const binding = `${ORT}/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
      expect(statSync(path.join(buildPath, binding)).size).toBeGreaterThan(0);
      // Copying again (a re-run) is idempotent.
      copyIntentRuntime(buildPath, process.platform, process.arch);
      expect(intent(copied(buildPath))).toEqual(expected);
    } finally {
      rmSync(buildPath, { recursive: true, force: true });
    }
  });

  test('intent-asar-unpacks-native', async () => {
    // asar takes the native files out of app.asar into app.asar.unpacked (they cannot be loaded from
    // inside an archive); everything else stays in the archive.
    const root = mkdtempSync(path.join(tmpdir(), 'frost-intent-asar-'));
    try {
      const app = path.join(root, 'app');
      for (const file of ['.vite/build/main.cjs', '.vite/build/stray.node', `${ORT}/dist/index.js`, `${ORT}/dist/stray.node`, `${ORT}/bin/napi-v6/linux/x64/onnxruntime_binding.node`, `${ORT}/bin/napi-v6/linux/x64/libonnxruntime.so.1`, `${ORT}/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`, `${ORT}/bin/napi-v6/win32/x64/onnxruntime.dll`]) {
        mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
        writeFileSync(path.join(app, file), 'x');
      }
      const archive = path.join(root, 'app.asar');
      await createPackageWithOptions(app, archive, { unpack: INTENT_ASAR_UNPACK });
      const unpacked = (dir: string, prefix = ''): string[] =>
        existsSync(path.join(dir, prefix))
          ? readdirSync(path.join(dir, prefix), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? unpacked(dir, path.join(prefix, entry.name)) : [path.join(prefix, entry.name).split(path.sep).join('/')]))
          : [];
      // A native file outside onnxruntime-node/bin/ stays in the archive.
      expect(unpacked(`${archive}.unpacked`).sort()).toEqual([`${ORT}/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib`, `${ORT}/bin/napi-v6/linux/x64/libonnxruntime.so.1`, `${ORT}/bin/napi-v6/linux/x64/onnxruntime_binding.node`, `${ORT}/bin/napi-v6/win32/x64/onnxruntime.dll`]);
      expect(listPackage(archive, { isPack: false })).toEqual(expect.arrayContaining([`/.vite/build/main.cjs`, `/${ORT}/dist/index.js`].map((file) => file.split('/').join(path.sep))));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('intent-worker-build-entry', () => {
    const vite = makeForgeConfig({}).plugins?.find((plugin) => plugin instanceof VitePlugin);
    if (!(vite instanceof VitePlugin)) throw new Error('no VitePlugin');
    // .vite/build/intent-worker.cjs, beside main.cjs (main forks it from there).
    expect(vite.config.build).toContainEqual({ entry: { 'intent-worker': 'src/workers/intent/index.ts' }, config: 'vite.intent.config.ts', target: 'main' });
    expect(existsSync(new URL('../../vite.intent.config.ts', import.meta.url))).toBe(true);
  });

  test('intent-worker-requires-the-runtime', { timeout: 60_000 }, async () => {
    // The worker bundle, built as Forge's main target builds it (CJS lib, Node builtins external)
    // with vite.intent.config.ts: onnxruntime-node is left out and loaded with a plain require
    // (Node's CommonJS loader, with Electron's ASAR redirect), never import() (the ESM loader).
    const outDir = mkdtempSync(path.join(tmpdir(), 'frost-intent-vite-'));
    try {
      const forgeLike: InlineConfig = {
        configFile: false,
        logLevel: 'silent',
        // fileURLToPath, not URL.pathname: on Windows the pathname is `/D:/…`, which is no path.
        root: fileURLToPath(new URL('../..', import.meta.url)),
        build: {
          outDir,
          emptyOutDir: true,
          minify: true,
          lib: { entry: { 'intent-worker': 'src/workers/intent/index.ts' }, fileName: () => '[name].cjs', formats: ['cjs'] },
          rollupOptions: { external: ['electron', ...builtinModules.flatMap((name) => [name, `node:${name}`])] },
        },
        resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
      };
      await build(mergeConfig(forgeLike, intentViteConfig as InlineConfig));
      const bundle = readFileSync(path.join(outDir, 'intent-worker.cjs'), 'utf8');
      expect(bundle).toContain('require("onnxruntime-node")');
      expect(bundle).not.toMatch(/import\(\s*[`'"]onnxruntime-node/);
      // Not bundled: the runtime's own code is not in the worker.
      expect(bundle).not.toContain('initOrtOnce');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
