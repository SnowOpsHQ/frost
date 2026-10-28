// Checks shared by the Linux and Windows package verifiers (verify-linux-package.mjs,
// verify-windows-package.mjs): the check runner, process helpers, and the checks every packaged
// build must pass whatever the platform: the fuse wire (PACKAGED_FUSES, specs/macos-package.spec.ts),
// the `resources/` and `app.asar` allowlists, libSQL's unpacked prebuild and runtime packages and
// that they load (specs/sync-package.spec.ts), launching on a throwaway profile, the packaged
// executable opening the sync replica through libSQL (`sync-replica-opens`), and refusing remote
// debugging (specs/security-policy.spec.ts). The macOS verifier uses the libSQL checks too.
//
// The specs are plain erasable TypeScript, loaded with Node's built-in type stripping (Node >= 22.18).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { getRawHeader, listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { PACKAGED_FUSES } from '../../../specs/macos-package.spec.ts';
import {
  LIBSQL_PREBUILD_FILE,
  LIBSQL_SQLITE_VERSION,
  PACKAGED_ASAR_NODE_MODULES,
  PACKAGED_UNPACKED_ALLOWLIST,
  PACKAGED_UNPACKED_DIR,
  SYNC_CONFIG_FILE_NAME,
  SYNC_PACKAGED_PROBE_CONFIG,
  SYNC_REPLICA_FILE_NAME,
  SYNC_REPLICA_OPENS_MS,
  SYNC_STATE_TABLE,
  libsqlPrebuildPackage,
} from '../../../specs/sync-package.spec.ts';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '../../../specs/security-policy.spec.ts';

/**
 * A check runner: `check` prints `PASS <name>` or `FAIL <name>: <reason>`, `info` prints
 * `INFO <name>: <message>` (a fact worth stating that is neither a pass nor a failure), and
 * `finish` prints a summary and exits 1 if any check failed.
 */
export function createChecks(label) {
  let failures = 0;
  return {
    async check(name, fn) {
      try {
        await fn();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    info(name, message) {
      console.log(`INFO ${name}: ${message}`);
    },
    finish() {
      console.log(failures === 0 ? `${label}: all checks passed` : `${label}: ${failures} check(s) failed`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** How long one `run` command may take before it is killed and its check fails. */
export const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * `out` is stdout + stderr (for messages); `stdout` alone for parsing. A command still running
 * after `RUN_TIMEOUT_MS` is killed and throws, so a hung tool fails its check instead of the job.
 */
export function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: RUN_TIMEOUT_MS, ...options });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${command} ${argv.join(' ')}: killed after ${RUN_TIMEOUT_MS / 1000} s`);
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * Removes a temporary tree. Retries for a few seconds: on Windows a just-exited app's child
 * processes can hold files in its profile for a moment (EBUSY / EPERM).
 */
export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

/** Runs `fn(dir)` with a fresh temporary directory, always removed afterwards. */
export async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    removeTree(dir);
  }
}

/** The packaged app's environment: the caller's, minus anything that would change how Electron starts. */
export function appEnv() {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS']) delete env[key];
  return env;
}

/**
 * Starts a packaged executable on a throwaway profile; resolves `{ code, signal, stderr }` on exit,
 * or `{ alive: true }` after `ms` (then it is terminated, by its PID only). The fresh
 * `--user-data-dir` keeps the check independent of an installed frost that may be running: on a
 * shared profile the single-instance lock would make the launched copy hand over to it and exit 0.
 * `profileLast` puts `--user-data-dir` after `argv`, for a check whose first argument must be
 * `argv[1]` (Squirrel's events).
 */
export function launch(executable, argv, ms, { profileLast = false } = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'frost-verify-profile-'));
  const profileArg = `--user-data-dir=${profile}`;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, profileLast ? [...argv, profileArg] : [profileArg, ...argv], { env: appEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.removeAllListeners('exit');
      child.once('exit', () => resolve({ alive: true, stderr }));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, ms);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ alive: false, code, signal, stderr });
    });
  }).finally(() => removeTree(profile));
}

/** The state of one fuse (`FuseV1Options` name) in an Electron binary, as `ENABLE` / `DISABLE` / …. */
export async function fuseState(binary, name) {
  const wire = await getCurrentFuseWire(binary);
  const state = wire[FuseV1Options[name]];
  return FuseState[state] ?? String(state);
}

/** `fuses-read-back`: every `PACKAGED_FUSES` entry has its configured state in `binary`. */
export async function assertPackagedFuses(binary) {
  const wire = await getCurrentFuseWire(binary);
  for (const [name, enabled] of Object.entries(PACKAGED_FUSES)) {
    const actual = wire[FuseV1Options[name]];
    const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE;
    assert(actual === expected, `${name} is ${FuseState[actual] ?? actual}, expected ${FuseState[expected]}`);
  }
}

/** Every entry of `app.asar`'s header, as `{ path, entry }` (`path` relative to the archive, `/`-separated). */
function asarEntries(asar) {
  const found = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const entryPath = prefix === '' ? name : `${prefix}/${name}`;
      found.push({ path: entryPath, entry });
      if (entry.files) walk(entry, entryPath);
    }
  };
  walk(getRawHeader(asar).header, '');
  return found;
}

/**
 * `no-stray-files`: `resources/` holds exactly `allowlist`, and `app.asar` holds exactly the
 * `asarTopLevel` entries at its root. `where` names the tree in failure messages. What is unpacked
 * and what is in `node_modules/` are `unpacked-allowlist` and `asar-node-modules-allowlist`.
 */
export function assertPackagedResources(resourcesDir, { allowlist, asarTopLevel, where }) {
  const entries = readdirSync(resourcesDir).sort();
  const expected = [...allowlist].sort();
  assert(
    entries.join() === expected.join(),
    `${where} resources/ holds ${entries.join(', ') || '(nothing)'}, expected ${expected.join(', ')}`,
  );

  const asar = path.join(resourcesDir, 'app.asar');
  const topLevel = [...new Set(listPackage(asar, { isPack: false }).map((entry) => entry.split(/[\\/]/)[1]))].sort();
  const expectedTop = [...asarTopLevel].sort();
  assert(topLevel.join() === expectedTop.join(), `${where} app.asar holds ${topLevel.join(', ')}, expected ${expectedTop.join(', ')}`);
}

/** Every file under `dir`, relative to `base`, `/`-separated; a symlink or other non-file fails. */
function filesUnder(dir, base) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join('/');
    if (lstatSync(full).isSymbolicLink()) throw new Error(`${relative} is a symlink`);
    if (entry.isDirectory()) found.push(...filesUnder(full, base));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`${relative} is not a regular file`);
  }
  return found;
}

/**
 * `unpacked-allowlist`: the entries `app.asar`'s header marks unpacked, and the files in
 * `resources/app.asar.unpacked/`, are each exactly `PACKAGED_UNPACKED_ALLOWLIST[target]`. Off
 * macOS, each unpacked file also has the size and SHA-256 the header records (Electron itself never
 * checks an unpacked file's bytes; this build-time comparison is the only one). On macOS signing
 * may rewrite the Mach-O after the header was written, so its bytes are left to the bundle seal
 * (`signature-verifies`; specs/sync-package.spec.ts, Integrity).
 */
export function assertUnpackedAllowlist(resourcesDir, { target, where }) {
  const expected = [...PACKAGED_UNPACKED_ALLOWLIST[target]].sort();
  const marked = asarEntries(path.join(resourcesDir, 'app.asar'))
    .filter(({ entry }) => entry.unpacked)
    .map(({ path: entryPath, entry }) => ({ file: `${PACKAGED_UNPACKED_DIR}/${entryPath}${entry.files ? '/' : ''}`, entry }));
  const markedFiles = marked.map(({ file }) => file).sort();
  assert(
    markedFiles.join() === expected.join(),
    `${where} app.asar marks unpacked: ${markedFiles.join(', ') || '(nothing)'}, expected ${expected.join(', ')}`,
  );
  let onDisk;
  try {
    onDisk = filesUnder(path.join(resourcesDir, PACKAGED_UNPACKED_DIR), resourcesDir).sort();
  } catch (error) {
    throw new Error(`${where} ${PACKAGED_UNPACKED_DIR}/: ${error.message}`);
  }
  assert(onDisk.join() === expected.join(), `${where} ${PACKAGED_UNPACKED_DIR}/ holds ${onDisk.join(', ') || '(nothing)'}, expected ${expected.join(', ')}`);
  if (target.startsWith('darwin-')) return;
  for (const { file, entry } of marked) {
    const bytes = readFileSync(path.join(resourcesDir, ...file.split('/')));
    assert(bytes.length === entry.size, `${where} ${file} is ${bytes.length} bytes, the asar header says ${entry.size}`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert(entry.integrity?.algorithm === 'SHA256' && entry.integrity.hash === hash, `${where} ${file} has SHA-256 ${hash}, the asar header says ${JSON.stringify(entry.integrity)}`);
  }
}

/**
 * `asar-node-modules-allowlist`: `app.asar/node_modules/` holds exactly the packages
 * `PACKAGED_ASAR_NODE_MODULES[target]`, flat (no nested `node_modules/`), and no `.node` file is
 * packed inside the archive (a native module is only ever the unpacked prebuild).
 */
export function assertAsarNodeModules(resourcesDir, { target, where }) {
  const entries = asarEntries(path.join(resourcesDir, 'app.asar'));
  const packages = entries
    .map(({ path: entryPath }) => /^node_modules\/((?:@[^/]+\/)?[^/@][^/]*)$/.exec(entryPath)?.[1])
    .filter((name) => name !== undefined)
    .sort();
  const expected = [...PACKAGED_ASAR_NODE_MODULES[target]].sort();
  assert(packages.join() === expected.join(), `${where} app.asar/node_modules holds ${packages.join(', ') || '(nothing)'}, expected ${expected.join(', ')}`);
  const scopes = entries.filter(({ path: entryPath }) => /^node_modules\/[^/]+$/.test(entryPath) && !packages.some((name) => name === entryPath.slice(13) || name.startsWith(`${entryPath.slice(13)}/`)));
  assert(scopes.length === 0, `${where} app.asar/node_modules holds ${scopes.map((e) => e.path).join(', ')}, which is no allowed package`);
  const nested = entries.filter(({ path: entryPath }) => /.\/node_modules(\/|$)/.test(entryPath));
  assert(nested.length === 0, `${where} app.asar has nested node_modules: ${nested.map((e) => e.path).slice(0, 5).join(', ')}`);
  const packedNative = entries.filter(({ path: entryPath, entry }) => entryPath.endsWith('.node') && !entry.unpacked && !entry.files);
  assert(packedNative.length === 0, `${where} app.asar packs native modules: ${packedNative.map((e) => e.path).join(', ')}`);
}

/**
 * The libsql-loads probe, run as `<electron> <probe> <resources> <db file>` with
 * ELECTRON_RUN_AS_NODE=1: it requires `@libsql/client/sqlite3` exactly as the packaged main does
 * (resolved from `app.asar/.vite/build/main.cjs`, Electron reading the archive and loading the
 * unpacked prebuild), opens a `file:` database, and prints the SQLite version and every module it
 * loaded.
 */
const LIBSQL_PROBE = `'use strict';
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const [resources, dbFile] = process.argv.slice(2);
const requireFromMain = createRequire(path.join(resources, 'app.asar', '.vite', 'build', 'main.cjs'));
const { createClient } = requireFromMain('@libsql/client/sqlite3');
const client = createClient({ url: pathToFileURL(dbFile).href.replace(/^file:\\/\\/\\/([A-Za-z]:)/, 'file:$1') });
client.execute('SELECT sqlite_version() AS version').then(
  (result) => {
    client.close();
    const modules = Object.keys(requireFromMain.cache).filter((file) => file !== __filename);
    process.stdout.write(JSON.stringify({ version: result.rows[0].version, electron: process.versions.electron, modules }));
  },
  (error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exit(1);
  },
);
`;

/**
 * The Electron version of a packaged Linux or Windows tree: its `version` file (Electron's own,
 * kept by Packager). The macOS verifier reads the bundled framework's Info.plist instead.
 */
export function packagedElectronVersion(appDir) {
  return readFileSync(path.join(appDir, 'version'), 'utf8').trim().replace(/^v/, '');
}

/**
 * `libsql-loads`: the repository's Electron as Node (the packaged binary's RunAsNode fuse is off,
 * so it cannot run this) loads `@libsql/client/sqlite3` from the packaged `resources/app.asar`,
 * opens a temporary `file:` database and reads `SELECT sqlite_version()` = `LIBSQL_SQLITE_VERSION`.
 * That Electron is exactly `electronVersion`, the packaged app's. Every module it loaded lies inside
 * that `app.asar` (nothing resolved from the repository's `node_modules`), and the native module is
 * the target's prebuild. This proves the packaged files are complete and load under the packaged
 * Electron version; not that the packaged executable loads them (specs/sync-package.spec.ts).
 */
export function assertLibsqlLoads(resourcesDir, { target, where, electronVersion }) {
  assert(typeof electronVersion === 'string' && electronVersion !== '', `${where}: the packaged app's Electron version is unknown`);
  const electron = createRequire(import.meta.url)('electron');
  return withTempDir('frost-libsql-', (dir) => {
    const probe = path.join(dir, 'probe.cjs');
    writeFileSync(probe, LIBSQL_PROBE);
    const env = appEnv();
    for (const key of ['NODE_PATH', 'LIBSQL_JS_DEV']) delete env[key];
    env.ELECTRON_RUN_AS_NODE = '1';
    const result = run(electron, [probe, path.resolve(resourcesDir), path.join(dir, 'probe.db')], { env, cwd: dir });
    assert(result.status === 0, `${where}: the libSQL probe exited ${result.status}: ${result.out.slice(-800)}`);
    const { version, electron: probeElectron, modules } = JSON.parse(result.stdout);
    assert(
      probeElectron === electronVersion,
      `${where}: the probe ran Electron ${probeElectron}, but the packaged app is Electron ${electronVersion}; reinstall so they match`,
    );
    assert(version === LIBSQL_SQLITE_VERSION, `${where}: sqlite_version() is ${version}, expected ${LIBSQL_SQLITE_VERSION}`);
    // Module paths are resolved through realpath (e.g. macOS /var -> /private/var), so the prefix is too.
    const asar = `${realpathSync(path.resolve(resourcesDir, 'app.asar'))}${path.sep}`;
    const outside = modules.filter((file) => !file.startsWith(asar));
    assert(outside.length === 0, `${where}: the probe loaded modules from outside app.asar: ${outside.slice(0, 5).join(', ')}`);
    const native = modules.filter((file) => file.endsWith('.node'));
    const prebuild = path.join(asar, 'node_modules', ...libsqlPrebuildPackage(target).split('/'), LIBSQL_PREBUILD_FILE);
    assert(native.join() === prebuild, `${where}: native modules loaded: ${native.join(', ') || '(none)'}, expected ${prebuild}`);
  });
}

/** Whether `file` is a SQLite database holding `SYNC_STATE_TABLE` (read-only; `false` while it is still being written). */
function hasSyncStateTable(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 1_000 });
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(SYNC_STATE_TABLE) !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * `sync-replica-opens` (specs/sync-package.feature.md): the packaged executable itself, with its
 * fuses (and on macOS its re-signed bundle), loads libSQL's unpacked prebuild. A throwaway profile
 * gets `SYNC_PACKAGED_PROBE_CONFIG` (local staging: no endpoint, no token, so neither the network nor
 * `safeStorage` is involved) as `SYNC_CONFIG_FILE_NAME`; the app is started on it, and within
 * `SYNC_REPLICA_OPENS_MS` `SYNC_REPLICA_FILE_NAME` must appear there holding `SYNC_STATE_TABLE`
 * (read with Node's `node:sqlite`), with mode 0600 on POSIX, while the app keeps running. The app is
 * then terminated by its PID and the profile removed. Answers how long the replica took (ms).
 */
export async function assertSyncReplicaOpens(executable, { where }) {
  const profile = mkdtempSync(path.join(tmpdir(), 'frost-verify-sync-'));
  try {
    writeFileSync(path.join(profile, SYNC_CONFIG_FILE_NAME), `${JSON.stringify(SYNC_PACKAGED_PROBE_CONFIG)}\n`);
    const replica = path.join(profile, SYNC_REPLICA_FILE_NAME);
    const started = Date.now();
    const child = spawn(executable, [`--user-data-dir=${profile}`], { env: appEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    let exited = null;
    let spawnError = null;
    const gone = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        exited = { code, signal };
        resolve();
      });
      child.once('error', (error) => {
        spawnError = error;
        resolve();
      });
    });
    let openedAfter = null;
    try {
      while (exited === null && spawnError === null && Date.now() - started < SYNC_REPLICA_OPENS_MS) {
        if (existsSync(replica) && hasSyncStateTable(replica)) {
          openedAfter = Date.now() - started;
          break;
        }
        await sleep(250);
      }
      const tail = () => stderr.trim().slice(-800);
      assert(spawnError === null, `${where}: could not start ${executable}: ${spawnError?.message}`);
      assert(exited === null, `${where}: the app exited (code ${exited?.code}, signal ${exited?.signal}) before opening ${SYNC_REPLICA_FILE_NAME}: ${tail()}`);
      assert(
        openedAfter !== null,
        `${where}: no ${SYNC_STATE_TABLE} in ${SYNC_REPLICA_FILE_NAME} after ${SYNC_REPLICA_OPENS_MS / 1000} s ` +
          `(${existsSync(replica) ? 'the file exists' : 'no file'}; the packaged main may not have loaded libSQL): ${tail()}`,
      );
      if (process.platform !== 'win32') {
        const mode = statSync(replica).mode & 0o777;
        assert(mode === 0o600, `${where}: ${SYNC_REPLICA_FILE_NAME} has mode ${mode.toString(8)}, expected 600`);
      }
      // Still running a moment later: opening the replica did not crash main.
      await sleep(1_000);
      assert(exited === null, `${where}: the app exited (code ${exited?.code}, signal ${exited?.signal}) after opening ${SYNC_REPLICA_FILE_NAME}: ${tail()}`);
      return openedAfter;
    } finally {
      if (exited === null && spawnError === null) {
        // By its PID only: nothing else named frost is touched.
        process.kill(child.pid, 'SIGTERM');
        const killer = setTimeout(() => exited === null && process.kill(child.pid, 'SIGKILL'), 5_000);
        await gone;
        clearTimeout(killer);
      }
    }
  } finally {
    removeTree(profile);
  }
}

/** `launches-and-stays-alive`: no arguments but a throwaway profile; still running after `ms`. */
export async function assertLaunchesAndStaysAlive(executable, ms) {
  const result = await launch(executable, [], ms);
  assert(result.alive, `exited after <${ms} ms (code ${result.code}, signal ${result.signal}): ${result.stderr.trim()}`);
}

/**
 * `refuses-remote-debugging`: started with `--<name>=0` and `--<name>` for every
 * `PACKAGED_FORBIDDEN_SWITCHES` name, and with `--inspect=0`, it exits with code 1 and prints
 * `PACKAGED_DEBUG_REFUSAL` to stderr.
 */
export async function assertRefusesRemoteDebugging(executable) {
  const probes = [...PACKAGED_FORBIDDEN_SWITCHES.flatMap((name) => [`--${name}=0`, `--${name}`]), '--inspect=0'];
  for (const arg of probes) {
    const result = await launch(executable, [arg], 30_000);
    assert(!result.alive, `${arg}: still running after 30 s`);
    assert(result.code === 1, `${arg}: exit code ${result.code} (signal ${result.signal}), expected 1`);
    assert(result.stderr.includes(PACKAGED_DEBUG_REFUSAL), `${arg}: stderr lacks "${PACKAGED_DEBUG_REFUSAL}": ${result.stderr.trim()}`);
  }
}
