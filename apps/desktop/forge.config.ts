import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion, type FuseV1Config } from '@electron/fuses';
import { linuxMakers } from './linux-makers.ts';
import { NOTICES_FILE } from './third-party-notices.ts';
import {
  MAC_APP_CATEGORY,
  MAC_BUNDLE_ID,
  MAC_DMG_FORMAT,
  MAC_ENTITLEMENTS,
  MAC_EXECUTABLE_NAME,
  MAC_PRODUCT_NAME,
  MAC_SIGNING_ENV,
  PACKAGED_FUSES,
} from '@app/specs/macos-package.spec';

type MacSigning = Pick<NonNullable<ForgeConfig['packagerConfig']>, 'osxSign' | 'osxNotarize'>;

/**
 * Developer ID signing + notarization, only when every `MAC_SIGNING_ENV` variable is set
 * (specs/macos-package.spec.ts); otherwise `null` and the build is ad-hoc signed. A partial set is
 * most likely a typo or a missing secret, so the missing names are reported (the build stays
 * ad-hoc).
 */
export function macSigningFromEnv(env: NodeJS.ProcessEnv): MacSigning | null {
  const missing = MAC_SIGNING_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    if (missing.length < MAC_SIGNING_ENV.length) {
      console.warn(`forge.config: ad-hoc signing; Developer ID signing also needs ${missing.join(', ')}`);
    }
    return null;
  }
  return {
    osxSign: {
      identity: env['APPLE_SIGNING_IDENTITY'],
      // A signing failure fails the build (Packager's default only warns).
      continueOnError: false,
      // Hardened runtime with only the entitlements V8 needs (osx-sign's defaults also request
      // camera, microphone, location, …).
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: [...MAC_ENTITLEMENTS] }),
    },
    osxNotarize: {
      appleId: env['APPLE_ID'] ?? '',
      appleIdPassword: env['APPLE_APP_SPECIFIC_PASSWORD'] ?? '',
      teamId: env['APPLE_TEAM_ID'] ?? '',
    },
  };
}

/** Runs a build tool synchronously; throws on a non-zero exit. */
export type RunCommand = (command: string, args: readonly string[]) => void;

const runCommand: RunCommand = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
};

export function makeForgeConfig(env: NodeJS.ProcessEnv = process.env, run: RunCommand = runCommand): ForgeConfig {
  const signing = macSigningFromEnv(env);
  const fuses = Object.fromEntries(
    Object.entries(PACKAGED_FUSES).map(([name, enabled]) => [FuseV1Options[name as keyof typeof FuseV1Options], enabled]),
  );

  return {
    packagerConfig: {
      name: MAC_PRODUCT_NAME,
      executableName: MAC_EXECUTABLE_NAME,
      appBundleId: MAC_BUNDLE_ID,
      appCategoryType: MAC_APP_CATEGORY,
      darwinDarkModeSupport: true,
      asar: true,
      // The licenses of the bundled third-party packages (third-party-notices.ts), beside app.asar in
      // resources/ (specs/seo-speed.feature.md, Licenses). Relative to the app directory Forge runs in.
      extraResource: [NOTICES_FILE],
      ...signing,
    },
    rebuildConfig: {},
    hooks: {
      // Packager rewrites Info.plist and renames the bundle after the fuse flip re-signed it, so
      // the bundle seal no longer matches (`codesign --verify --strict` fails). Without a real
      // identity, re-seal the finished .app ad-hoc (osxSign does this when signing for real).
      postPackage: async (_config, { platform, outputPaths }) => {
        if (signing !== null || platform !== 'darwin') return;
        for (const outputPath of outputPaths) {
          run('codesign', [
            '--sign',
            '-',
            '--force',
            '--deep',
            '--preserve-metadata=entitlements,requirements,flags,runtime',
            path.join(outputPath, `${MAC_PRODUCT_NAME}.app`),
          ]);
        }
      },
    },
    makers: [new MakerZIP({}, ['darwin', 'linux']), new MakerDMG({ format: MAC_DMG_FORMAT }, ['darwin']), ...linuxMakers()],
    plugins: [
      new VitePlugin({
        // Object entries name the bundles (.vite/build/main.cjs, .vite/build/preload.cjs) so the two
        // `index.ts` entry files don't collide in the shared output dir. The SEO analysis worker is a
        // bundle of its own beside them (.vite/build/seo-analysis.cjs): main starts it with
        // `new Worker(path.join(__dirname, 'seo-analysis.cjs'))` (specs/seo-schema.feature.md).
        build: [
          { entry: { main: 'src/main/index.ts' }, config: 'vite.main.config.ts', target: 'main' },
          { entry: { 'seo-analysis': 'src/main/seo/analysis-worker.ts' }, config: 'vite.main.config.ts', target: 'main' },
          { entry: { preload: 'src/preload/index.ts' }, config: 'vite.preload.config.ts', target: 'preload' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
      }),
      // Applied at package time only (not to `electron-forge start`). Flipping fuses rewrites the
      // Electron binary; without a real signing identity it is re-signed ad-hoc right away, since
      // Apple Silicon kills arm64 code whose signature no longer matches (no-op off macOS). The
      // postPackage hook above re-seals the whole bundle anyway; this stays explicit (it is cheap)
      // so a valid signature never depends on that hook alone, e.g. if x64 / universal builds add
      // packaging steps between the flip and the final seal.
      new FusesPlugin({
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: signing === null,
        ...fuses,
      } as FuseV1Config),
    ],
  };
}

export default makeForgeConfig();
