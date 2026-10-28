#!/usr/bin/env node
// Checks a built Linux package against specs/linux-package.spec.ts (acceptance:
// specs/linux-package.feature.md, "Built packages"): the packaged tree, the deb and the AppImage.
// Run on Linux after `pnpm make:linux`, with a display (`xvfb-run -a` on a headless machine):
//
//   node apps/desktop/scripts/verify-linux-package.mjs [--out <apps/desktop/out>] [--arch x64]
//
// Each scenario prints `PASS <name>` or `FAIL <name>: <reason>` (and `INFO <name>: …` for stated
// facts); any failure exits 1. Needs `dpkg-deb` for the deb checks and `unzip` for the zip, and the
// repository's `electron` dev dependency (libsql-loads runs it as Node).
//
// Only the packaged tree (`out/frost-linux-x64`) is launched. The deb, AppImage and zip trees are
// extracted as an unprivileged user (so the deb's setuid `chrome-sandbox` is not root-owned there)
// and checked statically: same resources, same fuses.
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  LINUX_APPIMAGE_APP_DIR,
  LINUX_APPIMAGE_RUNTIME,
  LINUX_ARCHS,
  LINUX_DEB_APP_DIR,
  LINUX_DEB_ARCH,
  LINUX_DEB_BIN_LINK,
  LINUX_DEB_DESKTOP_FILE,
  LINUX_DEB_INSTALL_PATHS,
  LINUX_DEB_OPTIONS,
  LINUX_DEB_SETUID_FILES,
  LINUX_EXECUTABLE_NAME,
  LINUX_LAUNCH_ALIVE_MS,
  LINUX_PACKAGE_NAME,
  PACKAGED_ASAR_TOP_LEVEL,
  PACKAGED_RESOURCES_ALLOWLIST,
  linuxArtifacts,
} from '../../../specs/linux-package.spec.ts';
import {
  appEnv,
  assert,
  assertAsarNodeModules,
  assertLaunchesAndStaysAlive,
  assertLibsqlLoads,
  assertPackagedFuses,
  assertPackagedResources,
  assertRefusesRemoteDebugging,
  assertSyncReplicaOpens,
  assertUnpackedAllowlist,
  createChecks,
  fuseState,
  packagedElectronVersion,
  run,
  withTempDir,
} from './verify-package-common.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(DESKTOP, 'out') },
    arch: { type: 'string', default: LINUX_ARCHS[0] },
  },
});
if (process.platform !== 'linux') {
  console.error('verify-linux-package: Linux only');
  process.exit(2);
}
if (!LINUX_ARCHS.includes(args.arch)) {
  console.error(`verify-linux-package: --arch must be one of ${LINUX_ARCHS.join(', ')}`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const artifacts = linuxArtifacts(version, args.arch);
const packaged = path.resolve(args.out, artifacts.packaged);
const executable = path.join(packaged, LINUX_EXECUTABLE_NAME);
const deb = path.resolve(args.out, artifacts.deb);
const appImage = path.resolve(args.out, artifacts.appImage);
const zip = path.resolve(args.out, artifacts.zip);
const resourceRules = { allowlist: PACKAGED_RESOURCES_ALLOWLIST, asarTopLevel: PACKAGED_ASAR_TOP_LEVEL };
const target = `linux-${args.arch}`;
const resources = path.join(packaged, 'resources');

/**
 * The resource, libSQL and fuse checks of one app tree (the packaged dir, or the deb / AppImage /
 * zip extracted).
 */
async function assertAppTree(appDir, where) {
  const binary = path.join(appDir, LINUX_EXECUTABLE_NAME);
  assert(existsSync(binary), `${where}: missing ${binary}`);
  const treeResources = path.join(appDir, 'resources');
  assertPackagedResources(treeResources, { ...resourceRules, where });
  assertUnpackedAllowlist(treeResources, { target, where });
  assertAsarNodeModules(treeResources, { target, where });
  // Every tree is the same build: compared with the packaged tree's Electron (the nupkg has no `version` file).
  await assertLibsqlLoads(treeResources, { target, where, electronVersion: packagedElectronVersion(packaged) });
  await assertPackagedFuses(binary).catch((error) => {
    throw new Error(`${where}: ${error.message}`);
  });
}

/** SHA-256 (hex) of the first `bytes` bytes of `file`. */
function sha256Prefix(file, bytes) {
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(file, 'r');
  try {
    assert(readSync(fd, buffer, 0, bytes, 0) === bytes, `${file} is shorter than ${bytes} bytes`);
  } finally {
    closeSync(fd);
  }
  return createHash('sha256').update(buffer).digest('hex');
}

const checks = createChecks('verify-linux-package');
console.log(`verify-linux-package: ${packaged} (version ${version}, ${args.arch}, unsigned)`);

await checks.check('fuses-read-back', async () => {
  assert(existsSync(executable), `missing ${executable}`);
  await assertPackagedFuses(executable);
});

await checks.check('asar-integrity', async () => {
  // The fuse is set like on every platform, but Electron validates ASAR integrity only on macOS
  // and Windows: Packager embeds no integrity data in a Linux build. Said plainly, then the fuse
  // that does hold on Linux: the app loads only from app.asar.
  const integrity = await fuseState(executable, 'EnableEmbeddedAsarIntegrityValidation');
  assert(integrity === 'ENABLE', `EnableEmbeddedAsarIntegrityValidation is ${integrity}, expected ENABLE`);
  checks.info(
    'asar-integrity',
    'EnableEmbeddedAsarIntegrityValidation is on, but Electron does not enforce ASAR integrity on Linux ' +
      '(a known platform gap; app.asar is not hash-checked at startup)',
  );
  const onlyAsar = await fuseState(executable, 'OnlyLoadAppFromAsar');
  assert(onlyAsar === 'ENABLE', `OnlyLoadAppFromAsar is ${onlyAsar}, expected ENABLE`);
});

await checks.check('no-stray-files', () => assertPackagedResources(resources, { ...resourceRules, where: artifacts.packaged }));

await checks.check('unpacked-allowlist', () => assertUnpackedAllowlist(resources, { target, where: artifacts.packaged }));

await checks.check('asar-node-modules-allowlist', () => assertAsarNodeModules(resources, { target, where: artifacts.packaged }));

await checks.check('libsql-loads', async () => {
  const electronVersion = packagedElectronVersion(packaged);
  await assertLibsqlLoads(resources, { target, where: artifacts.packaged, electronVersion });
  checks.info(
    'libsql-loads',
    `loaded from app.asar under the repository's Electron ${electronVersion} as Node (the packaged binary's RunAsNode fuse ` +
      'is off; sync-replica-opens covers the packaged executable)',
  );
});

await checks.check('launches-and-stays-alive', () => assertLaunchesAndStaysAlive(executable, LINUX_LAUNCH_ALIVE_MS));

await checks.check('sync-replica-opens', async () => {
  const ms = await assertSyncReplicaOpens(executable, { where: artifacts.packaged });
  checks.info('sync-replica-opens', `the packaged executable loaded libSQL's unpacked prebuild and opened the replica (local staging) in ${ms} ms`);
});

await checks.check('refuses-remote-debugging', () => assertRefusesRemoteDebugging(executable));

await checks.check('deb-metadata', async () => {
  assert(existsSync(deb) && statSync(deb).size > 0, `missing or empty ${deb}`);

  const fields = run('dpkg-deb', ['-f', deb]);
  assert(fields.status === 0, fields.out);
  const control = Object.fromEntries([...fields.stdout.matchAll(/^([\w-]+): (.*)$/gm)].map(([, key, value]) => [key, value]));
  const expected = {
    Package: LINUX_PACKAGE_NAME,
    Version: version,
    Architecture: LINUX_DEB_ARCH[args.arch],
    Section: LINUX_DEB_OPTIONS.section,
    Maintainer: LINUX_DEB_OPTIONS.maintainer,
    Homepage: LINUX_DEB_OPTIONS.homepage,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert(control[key] === value, `control ${key} = ${JSON.stringify(control[key])}, expected ${JSON.stringify(value)}`);
  }

  // The control archive holds the control file only: no maintainer scripts.
  const info = run('dpkg-deb', ['-I', deb]);
  assert(info.status === 0, info.out);
  const members = [...info.stdout.matchAll(/^\s+\d+ bytes,\s+\d+ lines\s+(?:\*\s+)?(\S+)/gm)].map((m) => m[1]);
  assert(members.join() === 'control', `control archive holds ${members.join(', ')}, expected control only`);

  const contents = run('dpkg-deb', ['-c', deb]);
  assert(contents.status === 0, contents.out);
  const files = contents.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+\.(\/\S*?)(?: -> (\S+))?$/.exec(line);
      assert(match, `unparsed dpkg-deb -c line: ${line}`);
      const [, mode, owner, file, target] = match;
      return { mode, owner, file, target };
    });
  const byPath = new Map(files.map((f) => [f.file.replace(/\/$/, ''), f]));
  for (const { file } of files) {
    // A directory entry above an install path (`./`, `./usr/`, `./usr/share/` …) is fine; anything
    // else is an install path, or lies under one that is a directory.
    const above = file.endsWith('/') && LINUX_DEB_INSTALL_PATHS.some((allowed) => allowed.startsWith(file));
    const allowed = LINUX_DEB_INSTALL_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
    assert(above || allowed, `${file} is not in LINUX_DEB_INSTALL_PATHS`);
  }
  const appExecutable = `${LINUX_DEB_APP_DIR}/${LINUX_EXECUTABLE_NAME}`;
  assert(byPath.get(appExecutable)?.mode.startsWith('-rwx'), `no executable ${appExecutable}`);
  const link = byPath.get(LINUX_DEB_BIN_LINK);
  const linkTarget = `../lib/${LINUX_PACKAGE_NAME}/${LINUX_EXECUTABLE_NAME}`;
  assert(link?.target === linkTarget, `${LINUX_DEB_BIN_LINK} -> ${link?.target}, expected ${linkTarget}`);
  assert(byPath.has(LINUX_DEB_DESKTOP_FILE), `no ${LINUX_DEB_DESKTOP_FILE}`);
  for (const { owner, file } of files) assert(owner === 'root/root', `${file} is owned by ${owner}, expected root/root`);
  const setuid = files.filter((f) => /^.{3}[sS]|^.{6}[sS]/.test(f.mode)).map((f) => f.file);
  assert(
    setuid.join() === LINUX_DEB_SETUID_FILES.join(),
    `setuid/setgid files: ${setuid.join(', ') || '(none)'}, expected ${LINUX_DEB_SETUID_FILES.join(', ')}`,
  );

  await withTempDir('frost-deb-', async (dir) => {
    const extract = run('dpkg-deb', ['-x', deb, dir]);
    assert(extract.status === 0, extract.out);
    await assertAppTree(path.join(dir, LINUX_DEB_APP_DIR), `deb ${LINUX_DEB_APP_DIR}`);
  });
});

await checks.check('appimage-contents', async () => {
  assert(existsSync(appImage) && statSync(appImage).size > 0, `missing or empty ${appImage}`);
  accessSync(appImage, constants.X_OK);
  // Checked before the AppImage is run at all: its runtime is exactly the pinned one.
  const runtime = LINUX_APPIMAGE_RUNTIME[args.arch];
  const prefix = sha256Prefix(appImage, runtime.bytes);
  assert(prefix === runtime.sha256, `runtime (first ${runtime.bytes} bytes) has SHA-256 ${prefix}, expected ${runtime.sha256}`);
  const offset = run(appImage, ['--appimage-offset'], { env: appEnv() });
  const offsetOk = offset.status === 0 && offset.stdout.trim() === String(runtime.bytes);
  assert(offsetOk, `--appimage-offset: ${offset.out}, expected ${runtime.bytes}`);

  await withTempDir('frost-appimage-', async (dir) => {
    const extract = run(appImage, ['--appimage-extract'], { cwd: dir, env: appEnv() });
    assert(extract.status === 0, `--appimage-extract exited ${extract.status}: ${extract.out.slice(-500)}`);
    const root = path.join(dir, 'squashfs-root');
    const appDir = path.join(root, LINUX_APPIMAGE_APP_DIR);
    const appRun = realpathSync(path.join(root, 'AppRun'));
    const appExecutable = realpathSync(path.join(appDir, LINUX_EXECUTABLE_NAME));
    assert(appRun === appExecutable, `AppRun resolves to ${appRun}, expected ${appExecutable}`);
    await assertAppTree(appDir, `AppImage ${LINUX_APPIMAGE_APP_DIR}`);
  });
});

// Not uploaded by CI, but published by `make:linux` all the same: its tree must hold up too.
await checks.check('zip-contents', async () => {
  assert(existsSync(zip) && statSync(zip).size > 0, `missing or empty ${zip}`);
  await withTempDir('frost-zip-', async (dir) => {
    const unzip = run('unzip', ['-q', zip, '-d', dir]);
    assert(unzip.status === 0, `unzip exited ${unzip.status}: ${unzip.out.slice(-500)}`);
    const entries = readdirSync(dir);
    assert(entries.join() === artifacts.packaged, `zip holds ${entries.join(', ')}, expected ${artifacts.packaged}/ only`);
    await assertAppTree(path.join(dir, artifacts.packaged), `zip ${artifacts.packaged}`);
  });
});

checks.finish();
