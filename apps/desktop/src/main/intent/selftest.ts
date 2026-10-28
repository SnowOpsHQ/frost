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

/** The parts of Electron's `app` the self-test uses. */
export interface SelftestApp {
  readonly commandLine: { hasSwitch(name: string): boolean };
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
}

/** Runs the self-test if the switch is present (then returns `true`: main must not start); otherwise returns `false`. */
export function runIntentSelfTestIfAsked(app: SelftestApp, options: SelftestOptions = {}): boolean {
  if (!app.commandLine.hasSwitch(INTENT_SELFTEST_SWITCH)) return false;
  const write = options.write ?? ((line: string) => console.error(line));
  const env = options.env ?? process.env;
  let done = false;
  const finish = (ok: boolean, detail: string): void => {
    if (done) return;
    done = true;
    write(`frost: ${ok ? INTENT_SELFTEST_OK : INTENT_SELFTEST_FAILED} (${detail})`);
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
