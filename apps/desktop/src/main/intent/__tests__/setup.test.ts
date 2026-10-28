// Spec: specs/intent-classifier.spec.ts (INTENT_E2E_FAKE_SWITCH, INTENT_SELFTEST_SWITCH,
// INTENT_SELFTEST_OK, INTENT_SELFTEST_FAILED, INTENT_MODEL_DIR); specs/security-policy.spec.ts
// (PACKAGED_FORBIDDEN_SWITCHES) · Acceptance: specs/intent-classifier.feature.md (Setup, Self-test)
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { INTENT_CHILD_ENV, INTENT_E2E_FAKE_SWITCH, INTENT_ENV_CANARY, INTENT_FAKE_MODEL, INTENT_LIMITS, INTENT_SELFTEST_FAILED, INTENT_SELFTEST_OK, INTENT_SELFTEST_SWITCH } from '@app/specs/intent-classifier.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { runIntentSelfTestIfAsked } from '../selftest';
import { createIntent, intentEngine } from '../setup';

// Every test passes its own fork; Electron's must never be reached.
vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('Electron utilityProcess in a unit test');
    },
  },
}));

/**
 * A utility process `fork` whose processes answer like the real one would, recording what was
 * posted. Each process's environment follows Electron's rule: the `env` given, or main's whole
 * environment when that map is empty (or `inherit` forces it, a leak).
 */
function fakeUtilityFork(answer: (message: { type: string; id: number }, env: Readonly<Record<string, string | undefined>>) => unknown, options: { inherit?: boolean } = {}) {
  const posted: { type: string; id: number }[] = [];
  const fork = vi.fn((_path: string, _args: string[], forkOptions: { env?: Record<string, string> }) => {
    const given = forkOptions.env ?? {};
    const env = options.inherit || Object.keys(given).length === 0 ? { ...process.env } : { ...given };
    const utility = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill: vi.fn(() => {
        queueMicrotask(() => utility.emit('exit', 0));
        return true;
      }),
      postMessage: (message: { type: string; id: number }) => {
        posted.push(message);
        const reply = answer(message, env);
        if (reply !== undefined) queueMicrotask(() => utility.emit('message', reply));
      },
    });
    return utility;
  });
  return { fork, posted };
}

const fakeEngine = (message: { type: string; id: number }) =>
  message.type === 'load-fake'
    ? { type: 'loaded', id: message.id, model: INTENT_FAKE_MODEL, provider: 'fake' }
    : message.type === 'classify'
      ? { type: 'result', id: message.id, result: { label: 'transactional', confidence: 0.7, scores: { informational: 0.1, navigational: 0.1, commercial: 0.1, transactional: 0.7 }, model: INTENT_FAKE_MODEL } }
      : undefined;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('intent setup', () => {
  test('intent-e2e-fake-switch-unpackaged-only', async () => {
    const has = (name: string) => name === INTENT_E2E_FAKE_SWITCH;
    expect(intentEngine({ isPackaged: false, switches: { has } })).toBe('fake');
    expect(intentEngine({ isPackaged: true, switches: { has } })).toBe('onnx');
    expect(intentEngine({ isPackaged: false, switches: { has: () => false } })).toBe('onnx');
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(INTENT_E2E_FAKE_SWITCH);
    expect(PACKAGED_FORBIDDEN_SWITCHES).not.toContain(INTENT_SELFTEST_SWITCH);

    // Under the switch: ready at once, the fake engine in the real utility process, nothing downloaded.
    const { fork, posted } = fakeUtilityFork(fakeEngine);
    const fetcher = { fetch: vi.fn(), load: () => ({ running: 0, queued: 0 }) };
    const intent = createIntent({ userData: '/nonexistent', fetcher, isPackaged: false, switches: { has }, fork: fork as never, workerPath: '/w/intent-worker.cjs' });
    expect(await intent.classify('buy shoes')).toMatchObject({ state: 'ready', result: { model: INTENT_FAKE_MODEL } });
    expect(posted.map((message) => message.type)).toEqual(['load-fake', 'classify']);
    expect(fork).toHaveBeenCalledWith('/w/intent-worker.cjs', [], expect.objectContaining({ env: INTENT_CHILD_ENV }));
    expect(await intent.ensureModel()).toBe('ready');
    expect(fetcher.fetch).not.toHaveBeenCalled();
    intent.dispose();
  });

  test('intent-setup-real-classifier', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'frost-intent-setup-'));
    cleanups.push(() => rm(userData, { recursive: true, force: true }));
    const { fork } = fakeUtilityFork(() => undefined);
    const intent = createIntent({ userData, fetcher: null, isPackaged: true, switches: { has: () => true }, fork: fork as never, workerPath: '/w/intent-worker.cjs' });
    // Nothing on disk: the model is missing; nothing is forked or fetched until the user enables it.
    expect(await intent.classify('x')).toEqual({ state: 'model-missing' });
    expect(fork).not.toHaveBeenCalled();
    // No fetcher: downloads are disabled.
    expect(await intent.ensureModel()).toBe('disabled');
    intent.dispose();
  });

  test('intent-selftest-switch', async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const app = (switchOn: boolean) => ({
      commandLine: { hasSwitch: (name: string) => switchOn && name === INTENT_SELFTEST_SWITCH },
      whenReady: async () => undefined,
      exit: (code: number) => void exits.push(code),
    });
    // Without the switch it does nothing (main starts as usual).
    expect(runIntentSelfTestIfAsked(app(false), { fork: vi.fn() as never, workerPath: '/w', write: (line) => lines.push(line) })).toBe(false);
    expect(lines).toEqual([]);

    // The process reports what its environment holds, as the real one does.
    const selftestAnswer = (message: { type: string; id: number }, env: Readonly<Record<string, string | undefined>>) =>
      message.type === 'selftest' ? { type: 'selftest', id: message.id, backends: ['cpu', 'webgpu'], provider: 'cpu', env: { variables: Object.keys(env).length, canary: INTENT_ENV_CANARY in env } } : undefined;
    const ok = fakeUtilityFork(selftestAnswer);
    expect(runIntentSelfTestIfAsked(app(true), { fork: ok.fork as never, workerPath: '/w', write: (line) => lines.push(line) })).toBe(true);
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(lines).toEqual([`frost: ${INTENT_SELFTEST_OK} (provider cpu; backends cpu, webgpu; env isolated, ${Object.keys(INTENT_CHILD_ENV).length} variables)`]);
    expect(ok.posted.map((message) => message.type)).toEqual(['selftest']);
    // The canary was set in main's environment only for the fork.
    expect(process.env).not.toHaveProperty(INTENT_ENV_CANARY);

    // A process that sees main's environment fails the self-test.
    lines.length = 0;
    exits.length = 0;
    const leaky = fakeUtilityFork(selftestAnswer, { inherit: true });
    runIntentSelfTestIfAsked(app(true), { fork: leaky.fork as never, workerPath: '/w', write: (line) => lines.push(line) });
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(lines).toEqual([`frost: ${INTENT_SELFTEST_FAILED} (env-inherited: the utility process sees ${INTENT_ENV_CANARY})`]);
    expect(process.env).not.toHaveProperty(INTENT_ENV_CANARY);

    lines.length = 0;
    exits.length = 0;
    const failed = fakeUtilityFork((message) => ({ type: 'error', id: message.id, reason: 'selftest-failed' }));
    runIntentSelfTestIfAsked(app(true), { fork: failed.fork as never, workerPath: '/w', write: (line) => lines.push(line) });
    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(lines).toEqual([`frost: ${INTENT_SELFTEST_FAILED} (selftest-failed)`]);

    // A process that never answers fails within the self-test's deadline.
    vi.useFakeTimers();
    lines.length = 0;
    exits.length = 0;
    const silent = fakeUtilityFork(() => undefined);
    runIntentSelfTestIfAsked(app(true), { fork: silent.fork as never, workerPath: '/w', write: (line) => lines.push(line) });
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.selftestTimeoutMs);
    expect(exits).toEqual([1]);
    expect(lines).toEqual([`frost: ${INTENT_SELFTEST_FAILED} (timeout)`]);
  });
});
