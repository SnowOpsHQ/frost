#!/usr/bin/env node
// Checks a built macOS package against specs/macos-package.spec.ts (acceptance:
// specs/macos-package.feature.md, "Built bundle"): the .app in the build tree and the published zip
// and dmg. Run on macOS after `pnpm make:mac`:
//
//   node apps/desktop/scripts/verify-mac-package.mjs [--out <apps/desktop/out>] [--arch arm64]
//
// Each scenario prints `PASS <name>` or `FAIL <name>: <reason>`; any failure exits 1.
// The specs are plain erasable TypeScript, loaded with Node's built-in type stripping (Node >= 22.18).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import {
  MAC_APP_CATEGORY,
  MAC_ARCHS,
  MAC_BUNDLE_ID,
  MAC_DMG_FORMAT,
  MAC_ENTITLEMENTS,
  MAC_EXECUTABLE_NAME,
  MAC_LAUNCH_ALIVE_MS,
  MAC_MINIMUM_SYSTEM_VERSION_KEY,
  MAC_PRODUCT_NAME,
  PACKAGED_FUSES,
  macArtifacts,
} from '../../../specs/macos-package.spec.ts';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '../../../specs/security-policy.spec.ts';
// libSQL's unpacked prebuild and runtime packages (specs/sync-package.spec.ts), checked as on Linux and Windows.
import { assertAsarNodeModules, assertLibsqlLoads, assertSyncReplicaOpens, assertUnpackedAllowlist } from './verify-package-common.mjs';
import { INTENT_LIMITS, INTENT_SELFTEST_FAILED, INTENT_SELFTEST_OK, INTENT_SELFTEST_SWITCH } from '../../../specs/intent-classifier.spec.ts';
import { INTENT_NATIVE_FILES } from '../intent-runtime.ts';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(DESKTOP, 'out') },
    arch: { type: 'string', default: MAC_ARCHS[0] },
  },
});
if (process.platform !== 'darwin') {
  console.error('verify-mac-package: macOS only');
  process.exit(2);
}
if (!MAC_ARCHS.includes(args.arch)) {
  console.error(`verify-mac-package: --arch must be one of ${MAC_ARCHS.join(', ')}`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const artifacts = macArtifacts(version, args.arch);
const appPath = path.resolve(args.out, artifacts.app);
const executable = path.join(appPath, 'Contents/MacOS', MAC_EXECUTABLE_NAME);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
/** `out` is stdout + stderr (for messages); `stdout` alone for parsing. */
function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}`.trim() };
}
/** `codesign --verify --deep --strict` on a bundle; throws with codesign's output on failure. */
function verifySignature(bundle) {
  assert(existsSync(bundle), `missing ${bundle}`);
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  assert(verify.status === 0, verify.out);
}
/** `ad-hoc` or `Developer ID`, read from the bundle's signature (not from the environment). */
function signingMode(bundle) {
  const { status, out } = run('codesign', ['-dv', bundle]);
  if (status !== 0) return 'unsigned';
  return /^Signature=adhoc$/m.test(out) ? 'ad-hoc' : 'Developer ID';
}
/** Runs `fn(dir)` with a fresh temporary directory, always removed afterwards. */
async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function plist(key) {
  const { status, out } = run('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')]);
  return status === 0 ? out : undefined;
}
/** The packaged app's environment: the caller's, minus anything that would change how Electron starts. */
function appEnv() {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS']) delete env[key];
  return env;
}
/**
 * Starts the packaged executable on a throwaway profile; resolves `{ code, stderr }` on exit, or
 * `{ alive: true }` after `ms`. The fresh `--user-data-dir` keeps the check independent of an
 * installed frost that may be running: on a shared profile the single-instance lock would make the
 * launched copy hand over to it and exit 0.
 */
function launch(argv, ms) {
  const profile = mkdtempSync(path.join(tmpdir(), 'frost-verify-profile-'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [`--user-data-dir=${profile}`, ...argv], { env: appEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.removeAllListeners('exit');
      child.once('exit', () => resolve({ alive: true, stderr }));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ alive: false, code, signal, stderr });
    });
  }).finally(() => rmSync(profile, { recursive: true, force: true }));
}

const mode = signingMode(appPath);
console.log(`verify-mac-package: ${appPath} (version ${version}, ${args.arch}, ${mode})`);

await check('bundle-identity', () => {
  assert(existsSync(appPath), `missing ${appPath}`);
  const expected = {
    CFBundleIdentifier: MAC_BUNDLE_ID,
    CFBundleName: MAC_PRODUCT_NAME,
    CFBundleDisplayName: MAC_PRODUCT_NAME,
    CFBundleExecutable: MAC_EXECUTABLE_NAME,
    LSApplicationCategoryType: MAC_APP_CATEGORY,
    NSRequiresAquaSystemAppearance: 'false',
    CFBundleShortVersionString: version,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert(plist(key) === value, `Info.plist ${key} = ${JSON.stringify(plist(key))}, expected ${JSON.stringify(value)}`);
  }
  assert(plist(MAC_MINIMUM_SYSTEM_VERSION_KEY), `Info.plist has no ${MAC_MINIMUM_SYSTEM_VERSION_KEY}`);
});

await check('bundle-arch', () => {
  const { status, out } = run('lipo', ['-archs', executable]);
  assert(status === 0, out);
  assert(out === args.arch, `${MAC_EXECUTABLE_NAME} archs: ${out}, expected ${args.arch}`);
});

await check('signature-verifies', () => {
  verifySignature(appPath);
  assert(mode !== 'unsigned', `codesign -dv found no signature on ${appPath}`);
});

await check('entitlements-as-specified', () => {
  const { status, stdout, out } = run('codesign', ['-d', '--entitlements', '-', '--xml', appPath]);
  assert(status === 0, out);
  const keys = [...stdout.matchAll(/<key>([^<]*)<\/key>/g)].map((m) => m[1]).sort();
  if (mode === 'ad-hoc') {
    assert(keys.length === 0, `ad-hoc build has entitlements: ${keys.join(', ')}`);
  } else {
    const expected = [...MAC_ENTITLEMENTS].sort();
    assert(keys.join() === expected.join(), `entitlements ${keys.join(', ') || '(none)'}, expected ${expected.join(', ')}`);
  }
});

await check('fuses-read-back', async () => {
  const wire = await getCurrentFuseWire(appPath);
  for (const [name, enabled] of Object.entries(PACKAGED_FUSES)) {
    const actual = wire[FuseV1Options[name]];
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    assert(actual === expected, `${name} is ${FuseState[actual] ?? actual}, expected ${FuseState[expected]}`);
  }
});

// The unpacked prebuild is sealed by the bundle signature (signature-verifies); these check what it is.
const resources = path.join(appPath, 'Contents/Resources');
const target = `darwin-${args.arch}`;
await check('unpacked-allowlist', () => assertUnpackedAllowlist(resources, { target, where: artifacts.app }));
await check('asar-node-modules-allowlist', () => assertAsarNodeModules(resources, { target, where: artifacts.app }));
await check('libsql-loads', () => {
  // The packaged Electron version: the bundled framework's Info.plist (CFBundleShortVersionString, or
  // CFBundleVersion where the framework sets only that), accepted only if it looks like a version.
  const framework = path.join(appPath, 'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist');
  const electronVersion = ['CFBundleShortVersionString', 'CFBundleVersion']
    .map((key) => run('plutil', ['-extract', key, 'raw', '-o', '-', framework]))
    .find((read) => read.status === 0 && /^\d+\.\d+\.\d+/.test(read.out.trim()))
    ?.out.trim();
  assert(electronVersion, `cannot read the Electron version from ${framework}`);
  return assertLibsqlLoads(resources, { target, where: artifacts.app, electronVersion });
});

await check('launches-and-stays-alive', async () => {
  const result = await launch([], MAC_LAUNCH_ALIVE_MS);
  assert(result.alive, `exited after <${MAC_LAUNCH_ALIVE_MS} ms (code ${result.code}, signal ${result.signal}): ${result.stderr.trim()}`);
});

// The packaged, re-signed executable loading the unpacked prebuild: this is where library
// validation under the hardened runtime would refuse it (specs/sync-package.feature.md).
await check('sync-replica-opens', async () => {
  const ms = await assertSyncReplicaOpens(executable, { where: artifacts.app });
  console.log(`INFO sync-replica-opens: the ${mode}-signed executable loaded libSQL's unpacked prebuild and opened the replica (local staging) in ${ms} ms`);
});

await check('refuses-remote-debugging', async () => {
  const probes = [...PACKAGED_FORBIDDEN_SWITCHES.flatMap((name) => [`--${name}=0`, `--${name}`]), '--inspect=0'];
  for (const arg of probes) {
    const result = await launch([arg], 30_000);
    assert(!result.alive, `${arg}: still running after 30 s`);
    assert(result.code === 1, `${arg}: exit code ${result.code} (signal ${result.signal}), expected 1`);
    assert(
      result.stderr.includes(PACKAGED_DEBUG_REFUSAL),
      `${arg}: stderr lacks "${PACKAGED_DEBUG_REFUSAL}": ${result.stderr.trim()}`,
    );
  }
});

// The intent classifier's native runtime (specs/intent-classifier.feature.md, Packaging): unpacked
// beside the archive, and loading and running in the packaged app's utility process (the self-test
// switch starts no window, reads no profile data and downloads nothing), which must not see main's
// environment (the self-test's canary, INTENT_ENV_CANARY).
await check('intent-runtime-loads', async () => {
  const unpacked = path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/darwin', args.arch);
  for (const file of INTENT_NATIVE_FILES[`darwin-${args.arch}`] ?? []) assert(existsSync(path.join(unpacked, file)), `missing ${path.join(unpacked, file)}`);
  const result = await launch([`--${INTENT_SELFTEST_SWITCH}`], INTENT_LIMITS.selftestTimeoutMs + 10_000);
  assert(!result.alive, `--${INTENT_SELFTEST_SWITCH}: still running after ${INTENT_LIMITS.selftestTimeoutMs + 10_000} ms`);
  assert(!result.stderr.includes(INTENT_SELFTEST_FAILED), result.stderr.trim());
  assert(result.code === 0, `--${INTENT_SELFTEST_SWITCH}: exit code ${result.code} (signal ${result.signal}): ${result.stderr.trim()}`);
  assert(result.stderr.includes(INTENT_SELFTEST_OK), `stderr lacks "${INTENT_SELFTEST_OK}": ${result.stderr.trim()}`);
  assert(/env isolated, \d+ variables/.test(result.stderr), `the utility process's environment is not reported isolated: ${result.stderr.trim()}`);
  console.log(`  ${result.stderr.trim().split('\n').find((line) => line.includes(INTENT_SELFTEST_OK))}`);
});

await check('zip-and-dmg-produced', () => {
  for (const artifact of [artifacts.zip, artifacts.dmg]) {
    const file = path.resolve(args.out, artifact);
    assert(existsSync(file) && statSync(file).size > 0, `missing or empty ${file}`);
  }
  const { status, out } = run('hdiutil', ['imageinfo', path.resolve(args.out, artifacts.dmg)]);
  assert(status === 0, out);
  const format = /^Format: (\S+)$/m.exec(out)?.[1];
  assert(format === MAC_DMG_FORMAT, `DMG format ${format}, expected ${MAC_DMG_FORMAT}`);
});

// The published artifacts, not just the build tree: what a user downloads must verify too.
await check('zip-app-verifies', () =>
  withTempDir('frost-zip-', (dir) => {
    const unzip = run('ditto', ['-x', '-k', path.resolve(args.out, artifacts.zip), dir]);
    assert(unzip.status === 0, unzip.out);
    verifySignature(path.join(dir, `${MAC_PRODUCT_NAME}.app`));
  }),
);

await check('dmg-app-verifies', () => {
  const mountpoint = mkdtempSync(path.join(tmpdir(), 'frost-dmg-'));
  const dmg = path.resolve(args.out, artifacts.dmg);
  const attach = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg]);
  try {
    assert(attach.status === 0, attach.out);
    verifySignature(path.join(mountpoint, `${MAC_PRODUCT_NAME}.app`));
  } finally {
    // Always detach; retry with -force (Spotlight or a lingering codesign can hold the volume).
    // The mountpoint is removed only once nothing is mounted on it.
    const detached =
      attach.status !== 0 ||
      run('hdiutil', ['detach', mountpoint]).status === 0 ||
      run('hdiutil', ['detach', '-force', mountpoint]).status === 0;
    if (!detached) throw new Error(`could not detach ${mountpoint}`);
    rmdirSync(mountpoint);
  }
});

console.log(failures === 0 ? 'verify-mac-package: all checks passed' : `verify-mac-package: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
