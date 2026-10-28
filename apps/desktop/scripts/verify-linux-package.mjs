#!/usr/bin/env node
// Checks a built Linux package against specs/linux-package.spec.ts (acceptance:
// specs/linux-package.feature.md, "Built packages"): the packaged tree, the deb and the AppImage.
// Run on Linux after `pnpm make:linux`, with a display (`xvfb-run -a` on a headless machine):
//
//   node apps/desktop/scripts/verify-linux-package.mjs [--out <apps/desktop/out>] [--arch x64]
//
// Each scenario prints `PASS <name>` or `FAIL <name>: <reason>` (and `INFO <name>: …` for stated
// facts); any failure exits 1. Needs `dpkg-deb` for the deb checks.
//
// Only the packaged tree (`out/frost-linux-x64`) is launched. The deb and AppImage trees are
// extracted as an unprivileged user (so the deb's setuid `chrome-sandbox` is not root-owned there)
// and checked statically: same resources, same fuses.
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, openSync, readFileSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
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
  LINUX_DEB_INSTALL_ROOTS,
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
  assertLaunchesAndStaysAlive,
  assertPackagedFuses,
  assertPackagedResources,
  assertRefusesRemoteDebugging,
  createChecks,
  fuseState,
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
const resourceRules = { allowlist: PACKAGED_RESOURCES_ALLOWLIST, asarTopLevel: PACKAGED_ASAR_TOP_LEVEL };

/** The resource and fuse checks of one app tree (the packaged dir, or the deb / AppImage extracted). */
async function assertAppTree(appDir, where) {
  const binary = path.join(appDir, LINUX_EXECUTABLE_NAME);
  assert(existsSync(binary), `${where}: missing ${binary}`);
  assertPackagedResources(path.join(appDir, 'resources'), { ...resourceRules, where });
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
    'EnableEmbeddedAsarIntegrityValidation is on, but Electron does not enforce ASAR integrity on Linux (a known platform gap; app.asar is not hash-checked at startup)',
  );
  const onlyAsar = await fuseState(executable, 'OnlyLoadAppFromAsar');
  assert(onlyAsar === 'ENABLE', `OnlyLoadAppFromAsar is ${onlyAsar}, expected ENABLE`);
});

await checks.check('no-stray-files', () => assertPackagedResources(path.join(packaged, 'resources'), { ...resourceRules, where: artifacts.packaged }));

await checks.check('launches-and-stays-alive', () => assertLaunchesAndStaysAlive(executable, LINUX_LAUNCH_ALIVE_MS));

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
    // A directory entry above an install root (`./`, `./usr/`, `./usr/lib/`) is fine; anything else lies under one.
    const isParent = file.endsWith('/') && LINUX_DEB_INSTALL_ROOTS.some((root) => root.startsWith(file));
    assert(isParent || LINUX_DEB_INSTALL_ROOTS.some((root) => file.startsWith(root)), `${file} is outside ${LINUX_DEB_INSTALL_ROOTS.join(', ')}`);
  }
  assert(byPath.get(`${LINUX_DEB_APP_DIR}/${LINUX_EXECUTABLE_NAME}`)?.mode.startsWith('-rwx'), `no executable ${LINUX_DEB_APP_DIR}/${LINUX_EXECUTABLE_NAME}`);
  const link = byPath.get(LINUX_DEB_BIN_LINK);
  assert(link?.target === `../lib/${LINUX_PACKAGE_NAME}/${LINUX_EXECUTABLE_NAME}`, `${LINUX_DEB_BIN_LINK} -> ${link?.target}, expected the app`);
  assert(byPath.has(LINUX_DEB_DESKTOP_FILE), `no ${LINUX_DEB_DESKTOP_FILE}`);
  for (const { owner, file } of files) assert(owner === 'root/root', `${file} is owned by ${owner}, expected root/root`);
  const setuid = files.filter((f) => /^.{3}[sS]|^.{6}[sS]/.test(f.mode)).map((f) => f.file);
  assert(setuid.join() === LINUX_DEB_SETUID_FILES.join(), `setuid/setgid files: ${setuid.join(', ') || '(none)'}, expected ${LINUX_DEB_SETUID_FILES.join(', ')}`);

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
  assert(prefix === runtime.sha256, `runtime (first ${runtime.bytes} bytes) has SHA-256 ${prefix}, expected the pinned ${runtime.sha256}`);
  const offset = run(appImage, ['--appimage-offset'], { env: appEnv() });
  assert(offset.status === 0 && offset.stdout.trim() === String(runtime.bytes), `--appimage-offset: ${offset.out}, expected ${runtime.bytes}`);

  await withTempDir('frost-appimage-', async (dir) => {
    const extract = run(appImage, ['--appimage-extract'], { cwd: dir, env: appEnv() });
    assert(extract.status === 0, `--appimage-extract exited ${extract.status}: ${extract.out.slice(-500)}`);
    const root = path.join(dir, 'squashfs-root');
    const appDir = path.join(root, LINUX_APPIMAGE_APP_DIR);
    const appRun = realpathSync(path.join(root, 'AppRun'));
    assert(appRun === realpathSync(path.join(appDir, LINUX_EXECUTABLE_NAME)), `AppRun resolves to ${appRun}, expected the app's executable`);
    await assertAppTree(appDir, `AppImage ${LINUX_APPIMAGE_APP_DIR}`);
  });
});

checks.finish();
