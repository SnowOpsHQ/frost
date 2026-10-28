#!/usr/bin/env node
// Checks a built Windows package against specs/windows-package.spec.ts (acceptance:
// specs/windows-package.feature.md, "Built packages"): the packaged tree, the Squirrel installer
// and its package, and the zip. Run on Windows after `pnpm make:win`:
//
//   node apps/desktop/scripts/verify-windows-package.mjs [--out <apps/desktop/out>] [--arch x64] [--static]
//
// Each scenario prints `PASS <name>` or `FAIL <name>: <reason>` (and `INFO <name>: …` for stated
// facts); any failure exits 1.
//
// `--static` runs only the checks that read files (fuses-read-back, asar-integrity,
// no-stray-files, unsigned-as-documented) on the packaged tree, so they also run off Windows
// against `electron-forge package --platform win32 --arch x64` output (Packager writes the PE
// resources itself; no Wine needed). Without `--static` the verifier runs on Windows only.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getRawHeader } from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';
import {
  PACKAGED_ASAR_TOP_LEVEL,
  PACKAGED_RESOURCES_ALLOWLIST,
  WIN_ARCHS,
  WIN_ASAR_INTEGRITY_RESOURCE,
  WIN_EXECUTABLE,
  WIN_LAUNCH_ALIVE_MS,
  WIN_NUPKG_APP_DIR,
  WIN_SQUIRREL_OBSOLETE_EXIT_MS,
  WIN_TAMPER_EXIT_MS,
  winArtifacts,
} from '../../../specs/windows-package.spec.ts';
import {
  assert,
  assertLaunchesAndStaysAlive,
  assertPackagedFuses,
  assertPackagedResources,
  assertRefusesRemoteDebugging,
  createChecks,
  fuseState,
  launch,
  run,
  withTempDir,
} from './verify-package-common.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(DESKTOP, 'out') },
    arch: { type: 'string', default: WIN_ARCHS[0] },
    static: { type: 'boolean', default: false },
  },
});
if (process.platform !== 'win32' && !args.static) {
  console.error('verify-windows-package: Windows only (use --static for the file checks elsewhere)');
  process.exit(2);
}
if (!WIN_ARCHS.includes(args.arch)) {
  console.error(`verify-windows-package: --arch must be one of ${WIN_ARCHS.join(', ')}`);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const artifacts = winArtifacts(version, args.arch);
const packaged = path.resolve(args.out, artifacts.packaged);
const executable = path.join(packaged, WIN_EXECUTABLE);
const setupExe = path.resolve(args.out, artifacts.setupExe);
const nupkg = path.resolve(args.out, artifacts.nupkg);
const releases = path.resolve(args.out, artifacts.releases);
const zip = path.resolve(args.out, artifacts.zip);
const resourceRules = { allowlist: PACKAGED_RESOURCES_ALLOWLIST, asarTopLevel: PACKAGED_ASAR_TOP_LEVEL };

/** The PE resources of `exe` (resedit; a signed file is read too, so a signature is reported, not thrown). */
function peResources(exe) {
  return NtExecutableResource.from(NtExecutable.from(readFileSync(exe), { ignoreCert: true })).entries;
}

/**
 * The Authenticode certificate table of a PE file: the optional header's data directory entry 4
 * (IMAGE_DIRECTORY_ENTRY_SECURITY), `{ offset, size }`; both 0 when the file is unsigned.
 */
function peCertificateTable(file) {
  const pe = readFileSync(file);
  assert(pe.length > 0x40 && pe.toString('latin1', 0, 2) === 'MZ', `${file} is not a PE file (no MZ header)`);
  const header = pe.readUInt32LE(0x3c);
  assert(pe.toString('latin1', header, header + 4) === 'PE\0\0', `${file} is not a PE file (no PE signature)`);
  const optional = header + 4 + 20;
  const magic = pe.readUInt16LE(optional);
  assert(magic === 0x10b || magic === 0x20b, `${file}: unknown optional header magic 0x${magic.toString(16)}`);
  // PE32 (0x10b) and PE32+ (0x20b) differ in the size of the fields before the data directories.
  const count = pe.readUInt32LE(optional + (magic === 0x20b ? 108 : 92));
  if (count <= 4) return { offset: 0, size: 0 };
  const entry = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  return { offset: pe.readUInt32LE(entry), size: pe.readUInt32LE(entry + 4) };
}

/** `unsigned-as-documented` for one file: no certificate table at all. */
function assertUnsigned(file) {
  const { offset, size } = peCertificateTable(file);
  assert(
    offset === 0 && size === 0,
    `${path.basename(file)} carries an Authenticode certificate table (${size} bytes at ${offset}); frost is documented ` +
      'as unsigned: update specs/windows-package.spec.ts, windows-package.feature.md and the README before shipping a signed build',
  );
}

/**
 * `asar-integrity`: the fuses that make Electron check `app.asar` are on, and the exe's
 * `Integrity`/`ElectronAsar` resource holds exactly one record: `resources\app.asar`, SHA256,
 * the SHA-256 of the archive's header.
 */
async function assertAsarIntegrity(appDir, where) {
  const exe = path.join(appDir, WIN_EXECUTABLE);
  for (const fuse of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
    const state = await fuseState(exe, fuse);
    assert(state === 'ENABLE', `${where}: ${fuse} is ${state}, expected ENABLE`);
  }
  const { type, name, file, alg } = WIN_ASAR_INTEGRITY_RESOURCE;
  const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  const found = peResources(exe).filter((entry) => same(entry.type, type) && same(entry.id, name));
  assert(found.length === 1, `${where}: ${found.length} ${type}/${name} resources in ${WIN_EXECUTABLE}, expected 1`);
  const records = JSON.parse(Buffer.from(found[0].bin).toString('utf8'));
  assert(Array.isArray(records) && records.length === 1, `${where}: ${type}/${name} holds ${JSON.stringify(records)}, expected one record`);
  const [record] = records;
  const { headerString } = getRawHeader(path.join(appDir, 'resources', 'app.asar'));
  const expected = { file, alg, value: createHash('sha256').update(headerString).digest('hex') };
  assert(
    record.file === expected.file && record.alg === expected.alg && record.value === expected.value,
    `${where}: ${type}/${name} is ${JSON.stringify(record)}, expected ${JSON.stringify(expected)}`,
  );
}

/** The fuse, resource, integrity and signature checks of one app tree (the packaged dir, the zip's, the nupkg's). */
async function assertAppTree(appDir, where) {
  const exe = path.join(appDir, WIN_EXECUTABLE);
  assert(existsSync(exe), `${where}: missing ${exe}`);
  assertPackagedResources(path.join(appDir, 'resources'), { ...resourceRules, where });
  await assertPackagedFuses(exe).catch((error) => {
    throw new Error(`${where}: ${error.message}`);
  });
  await assertAsarIntegrity(appDir, where);
  assertUnsigned(exe);
}

/**
 * Extracts a zip (the win32 zip, or a `.nupkg`) with Windows' own bsdtar: `tar` on the PATH of a
 * Git Bash shell is GNU tar, which does not read zip files.
 */
function extractZip(file, dir) {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const result = run(tar, ['-xf', file, '-C', dir]);
  assert(result.status === 0, `tar -xf ${path.basename(file)} exited ${result.status}: ${result.out.slice(-500)}`);
}

/**
 * Changes one letter of a renderer file's name inside the JSON header of `asar`, in place, keeping
 * its length (so only the header hash changes, not the archive layout). A renamed renderer asset
 * would not stop the app from starting, so a copy that still starts means integrity is not
 * enforced. Returns the renamed entry, for messages.
 */
function tamperAsarHeader(asar) {
  const { header, headerString } = getRawHeader(asar);
  const renderer = header.files?.['.vite']?.files?.['renderer']?.files?.['main_window'];
  const assets = renderer?.files?.['assets']?.files ?? {};
  const target = Object.keys(assets).find((name) => /[a-z]/.test(name) && !assets[name].files);
  assert(target, 'no renderer asset in app.asar to rename');
  const key = `"${target}":`;
  const at = headerString.indexOf(key);
  assert(at !== -1 && headerString.indexOf(key, at + 1) === -1, `"${target}" is not a unique key in the asar header`);
  const letter = at + 1 + target.search(/[a-z]/);
  const bytes = readFileSync(asar);
  // The header string follows the two 8-byte pickle headers (sizes); check before writing.
  const start = 16;
  assert(bytes.toString('utf8', start, start + Buffer.byteLength(headerString)) === headerString, 'unexpected asar header layout');
  const offset = start + Buffer.byteLength(headerString.slice(0, letter));
  bytes[offset] = bytes[offset] === 0x61 ? 0x62 : 0x61; // 'a' <-> another lowercase letter
  writeFileSync(asar, bytes);
  return `.vite/renderer/main_window/assets/${target}`;
}

const checks = createChecks('verify-windows-package');
const mode = args.static ? 'static checks only' : 'all checks';
console.log(`verify-windows-package: ${packaged} (version ${version}, ${args.arch}, unsigned, ${mode})`);

await checks.check('fuses-read-back', async () => {
  assert(existsSync(executable), `missing ${executable}`);
  await assertPackagedFuses(executable);
});

await checks.check('asar-integrity', () => assertAsarIntegrity(packaged, artifacts.packaged));

await checks.check('no-stray-files', () =>
  assertPackagedResources(path.join(packaged, 'resources'), { ...resourceRules, where: artifacts.packaged }),
);

await checks.check('unsigned-as-documented', () => {
  assertUnsigned(executable);
  if (!args.static) assertUnsigned(setupExe);
});

if (args.static) {
  for (const name of [
    'asar-tamper-refused',
    'launches-and-stays-alive',
    'refuses-remote-debugging',
    'squirrel-obsolete-exits',
    'squirrel-artifacts',
    'zip-contents',
  ]) {
    checks.info(name, 'skipped (--static: needs Windows and the `make:win` artifacts)');
  }
  checks.info('unsigned-as-documented', `checked ${WIN_EXECUTABLE} only (--static: Setup.exe needs \`make:win\`)`);
  checks.finish();
}

await checks.check('asar-tamper-refused', () =>
  withTempDir('frost-tamper-', async (dir) => {
    const copy = path.join(dir, artifacts.packaged);
    cpSync(packaged, copy, { recursive: true });
    const renamed = tamperAsarHeader(path.join(copy, 'resources', 'app.asar'));
    const result = await launch(path.join(copy, WIN_EXECUTABLE), [], WIN_TAMPER_EXIT_MS);
    assert(!result.alive, `a copy with ${renamed} renamed in the asar header still runs after ${WIN_TAMPER_EXIT_MS / 1000} s`);
    assert(result.code !== 0, `a copy with ${renamed} renamed in the asar header exited 0, expected a failure`);
    checks.info('asar-tamper-refused', `exit code ${result.code}, signal ${result.signal}: ${result.stderr.trim().slice(-300)}`);
  }),
);

await checks.check('launches-and-stays-alive', () => assertLaunchesAndStaysAlive(executable, WIN_LAUNCH_ALIVE_MS));

await checks.check('refuses-remote-debugging', () => assertRefusesRemoteDebugging(executable));

// Squirrel's events are handled before anything starts (src/main/update/squirrel-events.ts): the
// one without side effects must exit 0 at once, not open frost. (Exiting in time is enough.)
await checks.check('squirrel-obsolete-exits', async () => {
  const result = await launch(executable, ['--squirrel-obsolete', version], WIN_SQUIRREL_OBSOLETE_EXIT_MS, {
    profileLast: true,
  });
  assert(!result.alive, `--squirrel-obsolete: still running after ${WIN_SQUIRREL_OBSOLETE_EXIT_MS / 1000} s`);
  assert(result.code === 0, `--squirrel-obsolete: exit code ${result.code} (signal ${result.signal}), expected 0`);
});

await checks.check('squirrel-artifacts', async () => {
  const squirrelDir = path.dirname(setupExe);
  const expected = [setupExe, nupkg, releases].map((file) => path.basename(file)).sort();
  const entries = readdirSync(squirrelDir).sort();
  // No .msi (`noMsi`) and no delta package (`noDelta`).
  assert(entries.join() === expected.join(), `${squirrelDir} holds ${entries.join(', ')}, expected ${expected.join(', ')}`);
  for (const file of [setupExe, nupkg, releases]) assert(statSync(file).size > 0, `empty ${file}`);

  // RELEASES: one `<SHA1> <file> <size>` line, for the full package, matching the file on disk.
  const lines = readFileSync(releases, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  assert(lines.length === 1, `RELEASES has ${lines.length} lines, expected 1: ${lines.join(' | ')}`);
  const match = /^([0-9A-Fa-f]{40}) (\S+) (\d+)$/.exec(lines[0].trim());
  assert(match, `unparsed RELEASES line: ${lines[0]}`);
  const [, sha1, file, size] = match;
  assert(file === path.basename(nupkg), `RELEASES lists ${file}, expected ${path.basename(nupkg)}`);
  const actualSha1 = createHash('sha1').update(readFileSync(nupkg)).digest('hex');
  assert(sha1.toLowerCase() === actualSha1, `RELEASES SHA1 ${sha1}, but ${file} has ${actualSha1}`);
  assert(Number(size) === statSync(nupkg).size, `RELEASES size ${size}, but ${file} is ${statSync(nupkg).size} bytes`);

  // What Setup.exe installs: the nupkg's app tree passes the same checks as the packaged tree.
  await withTempDir('frost-nupkg-', async (dir) => {
    extractZip(nupkg, dir);
    await assertAppTree(path.join(dir, ...WIN_NUPKG_APP_DIR.split('/')), `nupkg ${WIN_NUPKG_APP_DIR}`);
  });

  // Electron's exe declares itself Squirrel-aware, so Squirrel hands the install hooks to the app.
  const versionInfo = Resource.VersionInfo.fromEntries(peResources(executable))[0];
  const aware = versionInfo?.getAllLanguagesForStringValues().map((lang) => versionInfo.getStringValues(lang).SquirrelAwareVersion);
  checks.info(
    'squirrel-artifacts',
    `${WIN_EXECUTABLE} SquirrelAwareVersion ${aware?.join(', ') || '(none)'} (frost handles the --squirrel-* events itself)`,
  );
});

await checks.check('zip-contents', async () => {
  assert(existsSync(zip) && statSync(zip).size > 0, `missing or empty ${zip}`);
  await withTempDir('frost-zip-', async (dir) => {
    extractZip(zip, dir);
    // On Windows Forge's zip holds the packaged tree's contents at its root (no top folder).
    const entries = readdirSync(dir).sort();
    const expected = readdirSync(packaged).sort();
    assert(entries.join() === expected.join(), `zip holds ${entries.join(', ')}, expected the packaged tree: ${expected.join(', ')}`);
    await assertAppTree(dir, 'zip');
  });
});

checks.finish();
