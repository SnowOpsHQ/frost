import type { ForkOptions, UtilityProcess } from 'electron';
import { INTENT_FAKE_MODEL, INTENT_LIMITS, INTENT_MODEL, INTENT_SERVICE_NAME, type IntentResult } from '@app/specs/intent-classifier.spec';
import { IntentResponseSchema, type IntentRequest, type IntentResponse } from '@app/specs/intent-classifier.schema';
import type { ModelLoadResult } from './model-store';

// The intent utility process, from main's side (spec `intent-classifier.spec.ts`, Least privilege;
// protocol `intent-classifier.schema.ts`; acceptance `intent-classifier.feature.md`, Host; review
// focus `intent-host-protocol-is-closed`). The process is forked lazily, on the first request, with
// an empty environment, no `execArgv` and its stdout closed (`intentForkOptions`); main reads and
// checks the model (`loadModel`, `model-store.ts`) and posts its bytes in `load`. Requests are
// numbered; every answer is validated with `IntentResponseSchema` and matched to its request by id,
// and anything else (malformed, an unknown id, a model that is not this engine's, a stale process) is
// dropped. A request past its deadline, or in flight when the process exits, ends `unavailable`; the
// process is then killed, and started again on a later request once the restart backoff
// (`INTENT_LIMITS.restartBackoffMs`, doubling per consecutive failure) has passed.

/** The parts of a utility process the host uses (`utilityIntentChild` adapts Electron's). */
export interface IntentChild {
  postMessage(message: unknown): void;
  /** Each message's data, as the process sent it (unvalidated). */
  onMessage(listener: (data: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

/** Which engine the process runs: the model, or the deterministic fake (the e2e seam). */
export type IntentEngine = 'onnx' | 'fake';

export interface IntentHostOptions {
  /** Starts a utility process running `intent-worker.cjs` (main: `utilityIntentChild`). */
  readonly fork: () => IntentChild;
  readonly engine: IntentEngine;
  /** Reads and checks the model and vocabulary (`ModelStore.load`); not called for the fake. */
  readonly loadModel: () => Promise<ModelLoadResult>;
  /** The clock for the restart backoff (default `Date.now`). */
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** A classification, or why there is none: the process could not answer (`unavailable`), or the model no longer verifies (`model-missing`). */
export type HostAnswer = { readonly ok: true; readonly result: IntentResult } | { readonly ok: false; readonly reason: 'unavailable' | 'model-missing' };

/** The self-test's answer: the runtime's backends and the provider that ran the built-in model, or why not. */
export type SelftestAnswer = { readonly ok: true; readonly backends: readonly string[]; readonly provider: string } | { readonly ok: false; readonly reason: string };

export interface IntentHost {
  /** Classifies one query (already trimmed and cut). Never rejects. */
  classify(query: string): Promise<HostAnswer>;
  /** Forks the process (if none runs) and asks it to load ONNX Runtime and run its built-in model. Never rejects. */
  selftest(): Promise<SelftestAnswer>;
  /** Ends what is in flight and kills the process; later requests are `unavailable`. */
  dispose(): void;
}

/**
 * How the process is forked: an empty environment (nothing of main's, no `ELECTRON_RUN_AS_NODE`,
 * proxies or tokens), no `execArgv` (Electron's default is none), its service name, and stdio
 * `['ignore', 'ignore', 'pipe']`: no stdin (Electron's only option), stdout closed (the process
 * answers through its port only), stderr piped and kept (capped) for main's log, so a native crash
 * message is not lost and is never written to a terminal the app does not own.
 */
export function intentForkOptions(): ForkOptions {
  return { env: {}, serviceName: INTENT_SERVICE_NAME, stdio: ['ignore', 'ignore', 'pipe'] };
}

/** Electron's `utilityProcess.fork`, as far as the host uses it. */
export type UtilityFork = (modulePath: string, args: string[], options: ForkOptions) => Pick<UtilityProcess, 'postMessage' | 'kill' | 'on' | 'stderr'>;

/**
 * The real child: `fork(modulePath, [], intentForkOptions())`. stderr is drained as it comes and the
 * first `INTENT_LIMITS.maxStderrChars` of it are logged, in one line, when the process exits.
 */
export function utilityIntentChild(fork: UtilityFork, modulePath: string, log: (message: string) => void = () => {}): () => IntentChild {
  return () => {
    const child = fork(modulePath, [], intentForkOptions());
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < INTENT_LIMITS.maxStderrChars) stderr = (stderr + chunk.toString()).slice(0, INTENT_LIMITS.maxStderrChars);
    });
    return {
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => void child.on('message', (data: unknown) => listener(data)),
      onExit: (listener) =>
        void child.on('exit', (code: number) => {
          if (stderr.trim() !== '') log(`intent: the utility process said: ${stderr.trim().replace(/\s+/g, ' ')}`);
          stderr = '';
          listener(code);
        }),
      kill: () => void child.kill(),
    };
  };
}

type Settle = (response: IntentResponse | 'timeout' | 'exit') => void;

interface Running {
  readonly child: IntentChild;
  /** Requests posted to this process, by id. */
  readonly pending: Map<number, Settle>;
  loaded: boolean;
}

export function createIntentHost(options: IntentHostOptions): IntentHost {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const expectedModel = options.engine === 'fake' ? INTENT_FAKE_MODEL : INTENT_MODEL.id;
  let running: Running | null = null;
  let starting: Promise<Running | 'unavailable' | 'model-missing'> | null = null;
  let nextId = 1;
  let failures = 0;
  let failedAt = 0;
  let inFlight = 0;
  let disposed = false;

  const backoffMs = (): number => Math.min(INTENT_LIMITS.maxRestartBackoffMs, INTENT_LIMITS.restartBackoffMs * 2 ** Math.max(0, failures - 1));
  const inBackoff = (): boolean => failures > 0 && now() < failedAt + backoffMs();

  /** Ends the process `proc` (if it is still the one running): every request on it ends, and it counts as a failure. */
  const stop = (proc: Running, why: string): void => {
    if (running !== proc) return;
    running = null;
    failures += 1;
    failedAt = now();
    log(`intent: the utility process stopped (${why}); restarting no sooner than ${backoffMs()} ms from now`);
    for (const settle of proc.pending.values()) settle('exit');
    proc.pending.clear();
    proc.child.kill();
  };

  function spawn(): Running | null {
    let child: IntentChild;
    try {
      child = options.fork();
    } catch (error) {
      failures += 1;
      failedAt = now();
      log(`intent: the utility process could not start: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    const proc: Running = { child, pending: new Map(), loaded: false };
    child.onMessage((data) => {
      if (running !== proc) return;
      const parsed = IntentResponseSchema.safeParse(data);
      if (!parsed.success) return log('intent: dropped a malformed message from the utility process');
      const response = parsed.data;
      if (response.id === undefined) return response.type === 'error' ? stop(proc, response.reason) : undefined;
      if ((response.type === 'result' && response.result.model !== expectedModel) || (response.type === 'loaded' && response.model !== expectedModel)) {
        return log('intent: dropped an answer from another engine');
      }
      const settle = proc.pending.get(response.id);
      if (!settle) return log('intent: dropped an answer to an unknown request');
      proc.pending.delete(response.id);
      settle(response);
    });
    child.onExit((code) => stop(proc, `exit ${code}`));
    running = proc;
    return proc;
  }

  /** Posts `request` (built with its id) to `proc`; resolves with its answer, `timeout` or `exit`. */
  function request(proc: Running, build: (id: number) => IntentRequest, timeoutMs: number): Promise<IntentResponse | 'timeout' | 'exit'> {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        resolve('timeout');
        stop(proc, 'no answer in time');
      }, timeoutMs);
      proc.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      try {
        proc.child.postMessage(build(id));
      } catch {
        proc.pending.delete(id);
        clearTimeout(timer);
        resolve('exit');
        stop(proc, 'the message could not be posted');
      }
    });
  }

  /** The loaded process, starting (and loading) one if none runs and the backoff allows. */
  async function start(): Promise<Running | 'unavailable' | 'model-missing'> {
    if (running?.loaded) return running;
    if (disposed || inBackoff()) return 'unavailable';
    let load: ModelLoadResult | null = null;
    if (options.engine === 'onnx') {
      load = await options.loadModel().catch((): ModelLoadResult => ({ ok: false, reason: 'model-missing' }));
      if (!load.ok) return 'model-missing';
    }
    if (disposed) return 'unavailable';
    const proc = running ?? spawn();
    if (proc === null) return 'unavailable';
    const files = load;
    const answer = await request(proc, (id) => (files?.ok ? { type: 'load', id, model: files.model, vocab: files.vocab } : { type: 'load-fake', id }), INTENT_LIMITS.loadTimeoutMs);
    if (typeof answer === 'object' && answer.type === 'loaded') {
      proc.loaded = true;
      log(`intent: ${answer.model} loaded on ${answer.provider}`);
      return proc;
    }
    if (typeof answer === 'object') stop(proc, answer.type === 'error' ? answer.reason : `unexpected ${answer.type}`);
    return 'unavailable';
  }

  async function classify(query: string): Promise<HostAnswer> {
    if (disposed || inFlight >= INTENT_LIMITS.maxPending) return { ok: false, reason: 'unavailable' };
    inFlight += 1;
    try {
      starting ??= start().finally(() => {
        starting = null;
      });
      const proc = await starting;
      if (proc === 'unavailable' || proc === 'model-missing') return { ok: false, reason: proc };
      const answer = await request(proc, (id) => ({ type: 'classify', id, query }), INTENT_LIMITS.requestTimeoutMs);
      if (typeof answer === 'object' && answer.type === 'result') {
        failures = 0;
        return { ok: true, result: answer.result };
      }
      if (typeof answer === 'object') log(`intent: the utility process could not classify (${answer.type === 'error' ? answer.reason : answer.type})`);
      return { ok: false, reason: 'unavailable' };
    } finally {
      inFlight -= 1;
    }
  }

  return {
    classify,
    async selftest() {
      if (disposed) return { ok: false, reason: 'disposed' };
      const proc = running ?? spawn();
      if (proc === null) return { ok: false, reason: 'fork-failed' };
      const answer = await request(proc, (id) => ({ type: 'selftest', id }), INTENT_LIMITS.selftestTimeoutMs);
      if (answer === 'timeout' || answer === 'exit') return { ok: false, reason: answer === 'exit' ? 'crashed' : 'timeout' };
      if (answer.type === 'selftest') return { ok: true, backends: answer.backends, provider: answer.provider };
      return { ok: false, reason: answer.type === 'error' ? answer.reason : `unexpected ${answer.type}` };
    },
    dispose() {
      disposed = true;
      if (running) stop(running, 'disposed');
    },
  };
}
