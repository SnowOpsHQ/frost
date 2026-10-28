import { utilityProcess } from 'electron';
import { INTENT_LIMITS, INTENT_SELFTEST_FAILED, INTENT_SELFTEST_OK, INTENT_SELFTEST_SWITCH } from '@app/specs/intent-classifier.spec';
import { createIntentHost, utilityIntentChild, type UtilityFork } from './host';
import { defaultIntentWorkerPath } from './setup';

// The packaged self-test (spec `intent-classifier.spec.ts`, `INTENT_SELFTEST_SWITCH`; acceptance
// `intent-classifier.feature.md`, Self-test; run by `scripts/verify-mac-package.mjs`). With
// `--frost-intent-selftest`, main does nothing else: no window, no profile data, no network. Once the
// app is ready it forks the intent utility process exactly as the classifier would, asks it to load
// ONNX Runtime and run its built-in model, prints one line to stderr, and exits 0 (ok) or 1. A
// deadline (`INTENT_LIMITS.selftestTimeoutMs`) bounds the whole run.

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
}

/** Runs the self-test if the switch is present (then returns `true`: main must not start); otherwise returns `false`. */
export function runIntentSelfTestIfAsked(app: SelftestApp, options: SelftestOptions = {}): boolean {
  if (!app.commandLine.hasSwitch(INTENT_SELFTEST_SWITCH)) return false;
  const write = options.write ?? ((line: string) => console.error(line));
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
      const answer = await host.selftest();
      host.dispose();
      clearTimeout(deadline);
      finish(answer.ok, answer.ok ? `provider ${answer.provider}; backends ${answer.backends.join(', ')}` : answer.reason);
    })
    .catch((error: unknown) => {
      clearTimeout(deadline);
      finish(false, error instanceof Error ? error.message : String(error));
    });
  return true;
}
