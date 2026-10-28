// Spec: specs/intent-classifier.spec.ts (Least privilege; INTENT_LIMITS, INTENT_SERVICE_NAME) ·
// specs/intent-classifier.schema.ts (IntentRequestSchema, IntentResponseSchema) · Acceptance:
// specs/intent-classifier.feature.md (Host); review focus intent-host-protocol-is-closed
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { INTENT_FAKE_MODEL, INTENT_LIMITS, INTENT_MODEL, INTENT_SERVICE_NAME, type IntentResult } from '@app/specs/intent-classifier.spec';
import { IntentRequestSchema } from '@app/specs/intent-classifier.schema';
import { createIntentHost, intentForkOptions, utilityIntentChild, type IntentChild, type IntentHostOptions } from '../host';
import type { ModelLoadResult } from '../model-store';

const RESULT = (model: IntentResult['model'] = INTENT_MODEL.id): IntentResult => ({
  label: 'commercial',
  confidence: 0.7,
  scores: { informational: 0.1, navigational: 0.1, commercial: 0.7, transactional: 0.1 },
  model,
});

type Behaviour = (message: { type: string; id: number }, child: FakeChild) => void;

/** Answers every request as a healthy utility process would. */
const healthy: Behaviour = (message, child) => {
  if (message.type === 'load') child.reply({ type: 'loaded', id: message.id, model: INTENT_MODEL.id, provider: 'cpu' });
  if (message.type === 'load-fake') child.reply({ type: 'loaded', id: message.id, model: INTENT_FAKE_MODEL, provider: 'fake' });
  if (message.type === 'classify') child.reply({ type: 'result', id: message.id, result: RESULT(child.model) });
  if (message.type === 'ping') child.reply({ type: 'pong', id: message.id });
  if (message.type === 'selftest') child.reply({ type: 'selftest', id: message.id, backends: ['cpu'], provider: 'cpu' });
};

class FakeChild implements IntentChild {
  readonly received: { type: string; id: number }[] = [];
  killed = false;
  model: IntentResult['model'] = INTENT_MODEL.id;
  private readonly messages: ((data: unknown) => void)[] = [];
  private readonly exits: ((code: number) => void)[] = [];
  constructor(private readonly behaviour: Behaviour) {}
  postMessage(message: unknown): void {
    // Everything main posts is a valid request.
    expect(IntentRequestSchema.safeParse(message).success).toBe(true);
    const request = message as { type: string; id: number };
    this.received.push(request);
    if (request.type === 'load-fake') this.model = INTENT_FAKE_MODEL;
    queueMicrotask(() => this.behaviour(request, this));
  }
  onMessage(listener: (data: unknown) => void): void {
    this.messages.push(listener);
  }
  onExit(listener: (code: number) => void): void {
    this.exits.push(listener);
  }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.exit(-1));
  }
  reply(data: unknown): void {
    for (const listener of this.messages) listener(data);
  }
  exit(code: number): void {
    for (const listener of this.exits) listener(code);
  }
}

const MODEL_FILES: ModelLoadResult = { ok: true, model: new Uint8Array([9, 9, 9]), vocab: '[CLS]\n[SEP]\n[UNK]\n' };

function harness(options: { behaviour?: Behaviour; engine?: 'onnx' | 'fake'; loadModel?: () => Promise<ModelLoadResult> } = {}) {
  const children: FakeChild[] = [];
  const loadModel = vi.fn(options.loadModel ?? (async () => MODEL_FILES));
  const hostOptions: IntentHostOptions = {
    fork: () => {
      const child = new FakeChild(options.behaviour ?? healthy);
      children.push(child);
      return child;
    },
    engine: options.engine ?? 'onnx',
    loadModel,
    log: () => {},
  };
  return { host: createIntentHost(hostOptions), children, loadModel };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('intent host', () => {
  test('intent-host-env-is-minimal', () => {
    // An empty environment, no execArgv, its own service name, stdin and stdout closed, stderr kept (capped) for the log.
    const options = intentForkOptions();
    expect(options).toEqual({ env: {}, serviceName: INTENT_SERVICE_NAME, stdio: ['ignore', 'ignore', 'pipe'] });
    expect('execArgv' in options).toBe(false);

    const stderr = new EventEmitter();
    const process = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(() => true), stderr });
    const fork = vi.fn(() => process);
    const lines: string[] = [];
    const child = utilityIntentChild(fork as never, '/app/.vite/build/intent-worker.cjs', (line) => lines.push(line))();
    expect(fork).toHaveBeenCalledWith('/app/.vite/build/intent-worker.cjs', [], intentForkOptions());
    // Messages arrive as their data; posts and kills go to the process.
    const received: unknown[] = [];
    child.onMessage((data) => received.push(data));
    process.emit('message', { type: 'pong', id: 1 });
    expect(received).toEqual([{ type: 'pong', id: 1 }]);
    child.postMessage({ type: 'ping', id: 2 });
    expect(process.postMessage).toHaveBeenCalledWith({ type: 'ping', id: 2 });
    // stderr is drained, kept up to the cap, and logged when the process exits.
    stderr.emit('data', Buffer.from('x'.repeat(INTENT_LIMITS.maxStderrChars + 500)));
    const exits: number[] = [];
    child.onExit((code) => exits.push(code));
    process.emit('exit', 3);
    expect(exits).toEqual([3]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(INTENT_LIMITS.maxStderrChars + 100);
    child.kill();
    expect(process.kill).toHaveBeenCalled();
  });

  test('intent-host-loads-verified-bytes', async () => {
    const { host, children, loadModel } = harness();
    expect(children).toHaveLength(0); // forked lazily
    const answer = await host.classify('best running shoes');
    expect(answer).toEqual({ ok: true, result: RESULT() });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
    const [load, classify] = children[0]!.received as unknown as [{ type: string; model: Uint8Array; vocab: string }, { type: string; query: string }];
    expect(load.type).toBe('load');
    expect([...load.model]).toEqual([9, 9, 9]);
    expect(load.vocab).toBe(MODEL_FILES.ok ? MODEL_FILES.vocab : '');
    expect(classify).toMatchObject({ type: 'classify', query: 'best running shoes' });
    // Loaded once per process.
    await host.classify('another');
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);

    // A model that no longer verifies is model-missing; nothing is forked.
    const missing = harness({ loadModel: async () => ({ ok: false, reason: 'model-missing' }) });
    expect(await missing.host.classify('x')).toEqual({ ok: false, reason: 'model-missing' });
    expect(missing.children).toHaveLength(0);
  });

  test('intent-host-protocol-is-closed (malformed and unknown responses are dropped)', async () => {
    const garbage: Behaviour = (message, child) => {
      if (message.type === 'load') return healthy(message, child);
      if (message.type !== 'classify') return;
      child.reply(null);
      child.reply('result');
      child.reply({ type: 'result', id: message.id + 1000, result: RESULT() }); // unknown id
      child.reply({ type: 'result', id: message.id, result: { ...RESULT(), confidence: 2 } }); // invalid
      child.reply({ type: 'result', id: message.id, result: { ...RESULT(), scores: { informational: 1, navigational: 1, commercial: 1, transactional: 1 } } });
      child.reply({ type: 'result', id: message.id, result: RESULT(), extra: 1 });
      child.reply({ type: 'result', id: message.id, result: RESULT(INTENT_FAKE_MODEL) }); // not this engine's model
      child.reply({ type: 'shell', id: message.id, command: 'x' });
    };
    const { host, children } = harness({ behaviour: garbage });
    const pending = host.classify('x');
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.requestTimeoutMs);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    expect(children[0]!.killed).toBe(true);

    // A late answer from a process that is gone is ignored too.
    const late = harness();
    const first = await late.host.classify('x');
    expect(first.ok).toBe(true);
    const old = late.children[0]!;
    old.exit(1);
    old.reply({ type: 'result', id: 99, result: RESULT() });
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.restartBackoffMs);
    expect(await late.host.classify('y')).toEqual({ ok: true, result: RESULT() });
  });

  test('intent-host-times-out', async () => {
    const silent: Behaviour = (message, child) => {
      if (message.type === 'load') healthy(message, child);
    };
    const { host, children } = harness({ behaviour: silent });
    const pending = host.classify('x');
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.requestTimeoutMs - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    // The hung process is killed.
    expect(children[0]!.killed).toBe(true);

    // A load that never answers ends unavailable too.
    const neverLoads = harness({ behaviour: () => undefined });
    const loading = neverLoads.host.classify('x');
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.loadTimeoutMs);
    expect(await loading).toEqual({ ok: false, reason: 'unavailable' });
    expect(neverLoads.children[0]!.killed).toBe(true);
  });

  test('intent-host-restarts-after-crash', async () => {
    let crash = true;
    const crashing: Behaviour = (message, child) => {
      if (message.type === 'classify' && crash) return child.exit(139);
      healthy(message, child);
    };
    const { host, children } = harness({ behaviour: crashing });
    // A crash ends the request in flight.
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children).toHaveLength(1);
    // Within the backoff: unavailable at once, nothing forked.
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children).toHaveLength(1);
    // After it: started again, once.
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.restartBackoffMs);
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children).toHaveLength(2);
    // The second consecutive failure doubles the wait.
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.restartBackoffMs);
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.restartBackoffMs);
    crash = false;
    expect(await host.classify('x')).toEqual({ ok: true, result: RESULT() });
    expect(children).toHaveLength(3);
    // A success resets the count: the next crash waits the base backoff again.
    crash = true;
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.restartBackoffMs);
    crash = false;
    expect(await host.classify('x')).toEqual({ ok: true, result: RESULT() });
    expect(children).toHaveLength(4);
  });

  test('intent-host-load-error-is-unavailable', async () => {
    const refusing: Behaviour = (message, child) => {
      if (message.type === 'load') child.reply({ type: 'error', id: message.id, reason: 'load-failed' });
    };
    const { host, children } = harness({ behaviour: refusing });
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children[0]!.killed).toBe(true);
    // Not restarted before the backoff.
    expect(await host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
    expect(children).toHaveLength(1);
  });

  test('intent-host-caps-pending-requests', async () => {
    const slow: Behaviour = (message, child) => {
      if (message.type === 'load') healthy(message, child);
      if (message.type === 'classify') setTimeout(() => healthy(message, child), 10);
    };
    const { host } = harness({ behaviour: slow });
    const answers = Array.from({ length: INTENT_LIMITS.maxPending + 1 }, (_, index) => host.classify(`q${index}`));
    await vi.advanceTimersByTimeAsync(20);
    const settled = await Promise.all(answers);
    expect(settled.filter((answer) => answer.ok)).toHaveLength(INTENT_LIMITS.maxPending);
    expect(settled.at(-1)).toEqual({ ok: false, reason: 'unavailable' });
  });

  test('intent-host-fake-engine', async () => {
    const { host, children, loadModel } = harness({ engine: 'fake' });
    expect(await host.classify('buy shoes')).toEqual({ ok: true, result: RESULT(INTENT_FAKE_MODEL) });
    expect(loadModel).not.toHaveBeenCalled();
    expect(children[0]!.received.map((message) => message.type)).toEqual(['load-fake', 'classify']);
  });

  test('intent-host-selftest-and-dispose', async () => {
    const { host, children } = harness();
    expect(await host.selftest()).toEqual({ ok: true, backends: ['cpu'], provider: 'cpu' });
    expect(children[0]!.received.map((message) => message.type)).toEqual(['selftest']);

    const broken = harness({ behaviour: (message, child) => child.reply({ type: 'error', id: message.id, reason: 'selftest-failed' }) });
    expect(await broken.host.selftest()).toEqual({ ok: false, reason: 'selftest-failed' });
    const silent = harness({ behaviour: () => undefined });
    const pending = silent.host.selftest();
    await vi.advanceTimersByTimeAsync(INTENT_LIMITS.selftestTimeoutMs);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });

    // dispose ends what is in flight and kills the process.
    const disposed = harness({ behaviour: (message, child) => (message.type === 'load' ? healthy(message, child) : undefined) });
    const inFlight = disposed.host.classify('x');
    await vi.advanceTimersByTimeAsync(0);
    disposed.host.dispose();
    expect(await inFlight).toEqual({ ok: false, reason: 'unavailable' });
    expect(disposed.children[0]!.killed).toBe(true);
    expect(await disposed.host.classify('x')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
