import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { INTENT_ENV_CANARY, INTENT_LIMITS, INTENT_SELFTEST_FAILED, INTENT_SELFTEST_OK, INTENT_SELFTEST_SWITCH } from '@app/specs/intent-classifier.spec';
import { createIntentHost, utilityIntentChild, type UtilityFork } from './host';
import { defaultIntentWorkerPath } from './setup';

// The packaged self-test (spec `intent-classifier.spec.ts`, `INTENT_SELFTEST_SWITCH`; acceptance
// `intent-classifier.feature.md`, Self-test; run by `scripts/verify-mac-package.mjs`). With
// `--frost-intent-selftest`, main does nothing else: no window, no profile data, no network. Once the
// app is ready it forks the intent utility process exactly as the classifier would, asks it to load
// ONNX Runtime and run its built-in model, prints one line to stderr, and exits 0 (ok) or 1. A
// deadline (`INTENT_LIMITS.selftestTimeoutMs`) bounds the whole run. It also proves the process does
// not inherit main's environment: `INTENT_ENV_CANARY` is set in main's just before the fork, and a
// process that sees it fails the self-test (`env-inherited`).
//
// It runs before main claims the single-instance lock, so it must never share a live profile:
// before anything touches the profile it points `userData` at a fresh temporary directory
// (`INTENT_SELFTEST_PROFILE_PREFIX` under the OS temp directory), and removes that directory just
// before it exits, whatever the outcome.

/** The self-test's throwaway profile directory name prefix (under the OS temp directory). */
export const INTENT_SELFTEST_PROFILE_PREFIX = 'frost-intent-selftest-';

/** The parts of Electron's `app` the self-test uses. */
export interface SelftestApp {
  readonly commandLine: { hasSwitch(name: string): boolean };
  /** Electron's `app.setPath`; called for `userData` before the app is ready. */
  setPath(name: 'userData', path: string): void;
  whenReady(): Promise<unknown>;
  exit(code: number): void;
}

export interface SelftestOptions {
  readonly fork?: UtilityFork;
  readonly workerPath?: string;
  /** Where the result line goes (default: stderr). */
  readonly write?: (line: string) => void;
  /** Main's environment, where the canary is set (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the throwaway profile is made (default: the OS temp directory). */
  readonly tempRoot?: string;
}

/** Runs the self-test if the switch is present (then returns `true`: main must not start); otherwise returns `false`. */
export function runIntentSelfTestIfAsked(app: SelftestApp, options: SelftestOptions = {}): boolean {
  if (!app.commandLine.hasSwitch(INTENT_SELFTEST_SWITCH)) return false;
  const write = options.write ?? ((line: string) => console.error(line));
  const env = options.env ?? process.env;
  let profile: string | null = null;
  const removeProfile = (): void => {
    if (profile === null) return;
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Best effort: the directory is under the OS temp directory either way.
    }
  };
  try {
    profile = mkdtempSync(path.join(options.tempRoot ?? tmpdir(), INTENT_SELFTEST_PROFILE_PREFIX));
    app.setPath('userData', profile);
  } catch (error) {
    removeProfile();
    write(`frost: ${INTENT_SELFTEST_FAILED} (profile: ${error instanceof Error ? error.message : String(error)})`);
    app.exit(1);
    return true;
  }
  let done = false;
  const finish = (ok: boolean, detail: string): void => {
    if (done) return;
    done = true;
    write(`frost: ${ok ? INTENT_SELFTEST_OK : INTENT_SELFTEST_FAILED} (${detail})`);
    removeProfile();
    app.exit(ok ? 0 : 1);
  };
  const deadline = setTimeout(() => finish(false, 'timeout'), INTENT_LIMITS.selftestTimeoutMs);
  void app
    .whenReady()
    .then(async () => {
      const host = createIntentHost({
        fork: utilityIntentChild(options.fork ?? utilityProcess.fork, options.workerPath ?? defaultIntentWorkerPath(), write),
        engine: 'onnx',
        loadModel: async () => ({ ok: false, reason: 'model-missing' }),
        log: () => {},
      });
      env[INTENT_ENV_CANARY] = '1';
      let answer;
      try {
        answer = await host.selftest();
      } finally {
        delete env[INTENT_ENV_CANARY];
      }
      host.dispose();
      clearTimeout(deadline);
      if (!answer.ok) return finish(false, answer.reason);
      if (answer.env.canary) return finish(false, `env-inherited: the utility process sees ${INTENT_ENV_CANARY}`);
      finish(true, `provider ${answer.provider}; backends ${answer.backends.join(', ')}; env isolated, ${answer.env.variables} variables`);
    })
    .catch((error: unknown) => {
      clearTimeout(deadline);
      finish(false, error instanceof Error ? error.message : String(error));
    });
  return true;
}
