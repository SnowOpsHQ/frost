// Checks shared by the Linux and Windows package verifiers (verify-linux-package.mjs,
// verify-windows-package.mjs): the check runner, process helpers, and the checks every packaged
// build must pass whatever the platform: the fuse wire (PACKAGED_FUSES, specs/macos-package.spec.ts),
// the `resources/` and `app.asar` allowlists, launching on a throwaway profile, and refusing remote
// debugging (specs/security-policy.spec.ts).
//
// The specs are plain erasable TypeScript, loaded with Node's built-in type stripping (Node >= 22.18).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRawHeader, listPackage } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { PACKAGED_FUSES } from '../../../specs/macos-package.spec.ts';
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

/** The paths of `app.asar` entries marked unpacked (they would live in `app.asar.unpacked/`). */
function unpackedEntries(asar) {
  const found = [];
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const entryPath = `${prefix}/${name}`;
      if (entry.unpacked) found.push(entryPath);
      if (entry.files) walk(entry, entryPath);
    }
  };
  walk(getRawHeader(asar).header, '');
  return found;
}

/**
 * `no-stray-files`: `resources/` holds exactly `allowlist`, and `app.asar` holds exactly the
 * `asarTopLevel` entries at its root with nothing marked unpacked. `where` names the tree in
 * failure messages.
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
  const unpacked = unpackedEntries(asar);
  assert(unpacked.length === 0, `${where} app.asar marks entries unpacked: ${unpacked.join(', ')}`);
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
