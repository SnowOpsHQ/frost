// Spec: specs/agent-proxy.spec.ts (AGENT_HOST_LIMITS, restartDelayMs, MAX_MODEL_REQUESTS_PER_CHECK) ·
// specs/agent-protocol.schema.ts (check.start, check.stop, check.finish, check.error, fetch.request.checkId) ·
// specs/ai-checks.spec.ts (AI_CHECK_LIMITS)
// Acceptance: specs/agent-host.feature.md (Host, Checks)
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_HOST_LIMITS, MAX_MODEL_REQUESTS_PER_CHECK, MAX_MODEL_REQUESTS_PER_TURN, restartDelayMs } from '@app/specs/agent-proxy.spec';
import { AI_CHECK_LIMITS } from '@app/specs/ai-checks.spec';
import { AGENT_CRASHED_MESSAGE, createAgentHost, type AgentChatEvent, type AgentFetchEvent, type AgentHostDeps } from '../host';
import { anthropicReply, createCheckHarness } from './check-harness';
import { createFakeChannel, createFakeFork, FakePort, type FakeChild } from './fakes';

const BUILD = path.join(path.sep, 'app', '.vite', 'build');
const LOCKDOWN = { removed: ['fetch', 'WebSocket'] as const, failed: [] as const, permissionModel: false };
const ready = (protocolVersion = AGENT_PROTOCOL_VERSION) => ({ type: 'ready', protocolVersion, lockdown: { removed: [...LOCKDOWN.removed], failed: [], permissionModel: false } });
const chatStart = (chatId = 'chat-1'): MainToRuntimeMessage => ({
  type: 'chat.start',
  chatId,
  messages: [{ role: 'user', content: 'Hello' }],
  systemPrompt: '',
  modelId: 'anthropic/claude-sonnet-5-5',
  route: 'gateway',
  allowedTools: [],
  mcpTools: [],
  reasoningEffort: 'auto',
});

/** A host whose forks give the test the runtime's end of each port (`runtimes`, in fork order). */
function setup(overrides: Partial<AgentHostDeps> = {}) {
  const runtimes: FakePort[] = [];
  const children: FakeChild[] = [];
  const forks = createFakeFork((child) => {
    children.push(child);
    child.onPort = (port) => runtimes.push(port);
  });
  const log = vi.fn<(line: string) => void>();
  const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: BUILD, packaged: false, log, ...overrides });
  const chat: AgentChatEvent[] = [];
  host.onChat((event) => chat.push(event));
  return { host, forks, runtimes, children, log, chat };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('agent host', () => {
  test('host-lazy-fork', async () => {
    const { host, forks, runtimes } = setup();
    expect(forks.calls.length).toBe(0);
    expect(host.status()).toBe('stopped');
    void host.start();
    expect(forks.calls.length).toBe(1);
    const call = forks.calls[0]!;
    expect(call.modulePath).toBe(path.join(BUILD, 'agent-runtime.cjs'));
    expect(call.args).toEqual([]);
    expect(call.options).toEqual({ serviceName: 'frost agent', env: { NODE_ENV: 'production' }, execArgv: ['--permission', `--allow-fs-read=${BUILD}`], stdio: 'inherit' });
    expect(call.child.messages).toEqual([{ message: null, transfer: [expect.anything()] }]);
    expect(runtimes.length).toBe(1);
    expect(host.status()).toBe('starting');
    // A second start while starting forks nothing more.
    void host.start();
    expect(forks.calls.length).toBe(1);

    const packaged = setup({ packaged: true, nodeEnv: 'development' });
    void packaged.host.start();
    expect(packaged.forks.calls[0]!.options.stdio).toBe('ignore');
    expect(packaged.forks.calls[0]!.options.env).toEqual({ NODE_ENV: 'development' });
  });

  test('host-ready', async () => {
    const { host, runtimes } = setup();
    expect(host.lockdown()).toBeNull();
    const started = host.start();
    runtimes[0]!.postMessage(ready());
    await expect(started).resolves.toBe(true);
    expect(host.status()).toBe('ready');
    expect(host.lockdown()).toEqual({ removed: ['fetch', 'WebSocket'], failed: [], permissionModel: false });
    await expect(host.start()).resolves.toBe(true);
  });

  test('host-drops-invalid', async () => {
    const { host, runtimes, chat } = setup();
    const fetches: unknown[] = [];
    host.onFetch((event) => fetches.push(event));
    const started = host.start();
    const runtime = runtimes[0]!;
    // Before ready: even a valid message is dropped.
    runtime.postMessage({ type: 'fetch.abort', requestId: 'r1' });
    runtime.postMessage(ready());
    await started;
    for (const bad of [
      'hello',
      null,
      { type: 'approve', callId: 'c1' },
      { type: 'chat.start', chatId: 'x' },
      { type: 'fetch.abort', requestId: 'r1', extra: true },
      { type: 'fetch.abort', requestId: 'has space' },
      ready(),
    ]) {
      runtime.postMessage(bad);
    }
    await flush();
    expect(fetches).toEqual([]);
    expect(chat).toEqual([]);
    expect(host.stats().inboundDropped).toBe(8);
    runtime.postMessage({ type: 'fetch.abort', requestId: 'r1' });
    await flush();
    expect(fetches).toEqual([{ type: 'fetch.abort', requestId: 'r1' }]);
  });

  test('host-fetch-needs-a-turn', async () => {
    const { host, runtimes, log } = setup();
    const fetches: string[] = [];
    host.onFetch((event) => fetches.push(`${event.type} ${event.requestId}`));
    const started = host.start();
    const runtime = runtimes[0]!;
    const answers: { type: string; requestId?: string; code?: string }[] = [];
    runtime.on('message', (event: { data: unknown }) => answers.push(event.data as { type: string }));
    runtime.postMessage(ready());
    await started;
    const fetchRequest = (requestId: string) => ({ type: 'fetch.request', requestId, url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: [], body: '{}' });
    // No turn running: refused here, never handed to the proxy.
    runtime.postMessage(fetchRequest('early'));
    await flush();
    expect(fetches).toEqual([]);
    expect(answers).toEqual([{ type: 'fetch.error', requestId: 'early', code: 'refused', message: 'frost refused this model request.' }]);
    // A turn running: up to its budget, then refused.
    host.send(chatStart());
    for (let i = 0; i < MAX_MODEL_REQUESTS_PER_TURN; i += 1) runtime.postMessage(fetchRequest(`r${i}`));
    runtime.postMessage(fetchRequest('over'));
    runtime.postMessage({ type: 'fetch.abort', requestId: 'r0' });
    await flush();
    expect(fetches.length).toBe(MAX_MODEL_REQUESTS_PER_TURN + 1);
    expect(fetches.at(-1)).toBe('fetch.abort r0');
    expect(answers.filter((answer) => answer.type === 'fetch.error').map((answer) => answer.requestId)).toEqual(['early', 'over']);
    // The turn ends: nothing more.
    runtime.postMessage({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
    runtime.postMessage(fetchRequest('after'));
    await flush();
    expect(fetches.length).toBe(MAX_MODEL_REQUESTS_PER_TURN + 1);
    expect(host.stats().fetchesRefused).toBe(3);
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.includes('refused'))).toEqual(['agent proxy: refused a model request (no-chat)', 'agent proxy: refused a model request (turn-budget)']);
  });

  test('host-flood-restarts', async () => {
    const { host, runtimes, children, forks, log } = setup();
    const started = host.start();
    runtimes[0]!.postMessage(ready());
    await started;
    // Strikes spread over windows are fine.
    for (let i = 0; i < AGENT_HOST_LIMITS.maxStrikesPerWindow; i += 1) runtimes[0]!.postMessage({ type: 'nonsense' });
    await flush();
    expect(children[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(AGENT_HOST_LIMITS.floodWindowMs);
    for (let i = 0; i < AGENT_HOST_LIMITS.maxStrikesPerWindow; i += 1) host.strike();
    expect(children[0]!.killed).toBe(false);
    // One more in the same window: killed, and another started after the backoff.
    runtimes[0]!.postMessage({ type: 'nonsense' });
    await flush();
    expect(children[0]!.killed).toBe(true);
    expect(host.lastFailure()).toBe('misbehaved');
    expect(host.status()).toBe('crashed');
    expect(log.mock.calls.flat().join('\n')).toContain('too many invalid or refused messages');
    await vi.advanceTimersByTimeAsync(restartDelayMs(1));
    expect(forks.calls.length).toBe(2);
    runtimes[1]!.postMessage(ready());
    await vi.advanceTimersByTimeAsync(0);
    expect(host.status()).toBe('ready');
    // A flood of valid messages is cut off too.
    for (let i = 0; i <= AGENT_HOST_LIMITS.maxInboundPerWindow; i += 1) runtimes[1]!.postMessage({ type: 'fetch.abort', requestId: 'r' });
    await flush();
    expect(children[1]!.killed).toBe(true);
    expect(host.lastFailure()).toBe('misbehaved');
  });

  test('host-chat-ids', async () => {
    const { host, runtimes, chat } = setup();
    const invokes: unknown[] = [];
    host.onToolInvoke((invoke) => invokes.push(invoke));
    const started = host.start();
    const runtime = runtimes[0]!;
    runtime.postMessage(ready());
    await started;
    runtime.postMessage({ type: 'chat.delta', chatId: 'chat-1', text: 'unasked' });
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-1', callId: 'c1', toolName: 'page_text', input: {} });
    await flush();
    expect(chat).toEqual([]);
    expect(invokes).toEqual([]);
    expect(host.send(chatStart())).toBe(true);
    expect(host.activeChats()).toEqual(['chat-1']);
    runtime.postMessage({ type: 'chat.delta', chatId: 'chat-1', text: 'Hi' });
    runtime.postMessage({ type: 'tool.invoke', chatId: 'chat-1', callId: 'c1', toolName: 'page_text', input: {} });
    runtime.postMessage({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
    runtime.postMessage({ type: 'chat.delta', chatId: 'chat-1', text: 'late' });
    await flush();
    expect(chat.map((event) => event.type)).toEqual(['chat.delta', 'chat.finish']);
    expect(invokes.length).toBe(1);
    expect(host.activeChats()).toEqual([]);
  });

  test('host-send-validated', async () => {
    const { host, runtimes } = setup();
    expect(host.send(chatStart())).toBe(false);
    const started = host.start();
    const runtime = runtimes[0]!;
    const received: unknown[] = [];
    runtime.on('message', (event: { data: unknown }) => received.push(event.data));
    expect(host.send(chatStart())).toBe(false);
    runtime.postMessage(ready());
    await started;
    expect(host.send({ type: 'fetch.end', requestId: 'r 1' } as MainToRuntimeMessage)).toBe(false);
    expect(host.send({ type: 'chat.stop', chatId: 'c', extra: 1 } as unknown as MainToRuntimeMessage)).toBe(false);
    expect(host.send({ ...chatStart(), modelId: 'other/model' } as unknown as MainToRuntimeMessage)).toBe(false);
    expect(host.send(chatStart())).toBe(true);
    expect(host.send(chatStart())).toBe(false);
    expect(host.send({ type: 'chat.stop', chatId: 'chat-1' })).toBe(true);
    await flush();
    expect(received.map((message) => (message as { type: string }).type)).toEqual(['chat.start', 'chat.stop']);
    expect(host.stats().outboundRefused).toBe(6);
  });

  test('host-ready-timeout-restarts', async () => {
    const { host, forks, children, runtimes, log } = setup();
    const started = host.start();
    await vi.advanceTimersByTimeAsync(AGENT_HOST_LIMITS.readyTimeoutMs);
    expect(children[0]!.killed).toBe(true);
    expect(host.status()).toBe('crashed');
    expect(host.lastFailure()).toBe('ready-timeout');
    expect(forks.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(restartDelayMs(1));
    expect(forks.calls.length).toBe(2);
    runtimes[1]!.postMessage(ready());
    await expect(started).resolves.toBe(true);
    expect(host.lastFailure()).toBeNull();
    expect(host.stats().restarts).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('did not start in time');
  });

  test('host-fork-failed', async () => {
    // Audit #25: a `fork` that threw left both ports open; a hand-over that threw left the child
    // running, and its later exit counted a second failure (failing the next runtime's chats).
    const channels: { port1: FakePort; port2: FakePort }[] = [];
    // The failing starts get unlinked ports (closing one end does not close the other, so each must
    // be closed itself); the restart after them gets a working pair.
    const createChannel = () => {
      const channel = channels.length < 2 ? { port1: new FakePort(), port2: new FakePort() } : createFakeChannel();
      channels.push(channel);
      return channel;
    };
    const throwing = setup({
      createChannel,
      fork: () => {
        throw new Error('ENOENT agent-runtime.cjs');
      },
    });
    void throwing.host.start();
    expect(throwing.host.lastFailure()).toBe('fork-failed');
    expect(throwing.host.status()).toBe('crashed');
    expect(channels[0]!.port1.closed).toBe(true);
    expect(channels[0]!.port2.closed).toBe(true);
    throwing.host.dispose();

    const children: FakeChild[] = [];
    const runtimes: FakePort[] = [];
    const forks = createFakeFork((child) => {
      children.push(child);
      child.onPort = (port) => runtimes.push(port);
      if (children.length > 1) return;
      // The hand-over throws; the child stays up until killed (and a real one exits later still).
      child.postMessage = () => {
        throw new Error('the child is gone');
      };
      child.kill = () => {
        child.killed = true;
        return true;
      };
    });
    const { host, chat } = setup({ createChannel, fork: forks.fork });
    const started = host.start();
    expect(host.lastFailure()).toBe('fork-failed');
    expect(children[0]!.killed).toBe(true);
    expect(channels[1]!.port1.closed).toBe(true);
    expect(channels[1]!.port2.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(restartDelayMs(1));
    expect(forks.calls.length).toBe(2);
    runtimes[0]!.postMessage(ready());
    await expect(started).resolves.toBe(true);
    host.send(chatStart('chat-a'));
    // The first child exits late, and its ready deadline passes: nothing more is counted, and the
    // running runtime is untouched.
    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(AGENT_HOST_LIMITS.readyTimeoutMs);
    expect(host.status()).toBe('ready');
    expect(host.lastFailure()).toBeNull();
    expect(host.activeChats()).toEqual(['chat-a']);
    expect(chat).toEqual([]);
    expect(host.stats().restarts).toBe(1);
  });

  test('host-protocol-mismatch', async () => {
    const { host, forks, children, runtimes } = setup();
    const started = host.start();
    runtimes[0]!.postMessage(ready(AGENT_PROTOCOL_VERSION + 1));
    await expect(started).resolves.toBe(false);
    expect(children[0]!.killed).toBe(true);
    expect(host.status()).toBe('stopped');
    expect(host.lastFailure()).toBe('protocol-mismatch');
    expect(host.lockdown()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forks.calls.length).toBe(1);
  });

  test('host-restart-on-request', async () => {
    // Task 6a review: the session restarts a runtime that ignored Stop past its deadline.
    const { host, forks, children, runtimes, chat } = setup();
    host.restart();
    expect(forks.calls.length).toBe(0);
    const started = host.start();
    runtimes[0]!.postMessage(ready());
    await started;
    host.send(chatStart('chat-a'));
    host.restart();
    expect(children[0]!.killed).toBe(true);
    expect(chat).toEqual([{ type: 'chat.error', chatId: 'chat-a', message: AGENT_CRASHED_MESSAGE }]);
    expect(host.activeChats()).toEqual([]);
    expect(host.lastFailure()).toBe('unresponsive');
    await vi.advanceTimersByTimeAsync(restartDelayMs(1));
    expect(forks.calls.length).toBe(2);
  });

  test('host-crash-fails-chats', async () => {
    const { host, forks, children, runtimes, chat } = setup();
    const started = host.start();
    runtimes[0]!.postMessage(ready());
    await started;
    host.send(chatStart('chat-a'));
    host.send(chatStart('chat-b'));
    children[0]!.exit(1);
    expect(chat).toEqual([
      { type: 'chat.error', chatId: 'chat-a', message: AGENT_CRASHED_MESSAGE },
      { type: 'chat.error', chatId: 'chat-b', message: AGENT_CRASHED_MESSAGE },
    ]);
    expect(host.status()).toBe('crashed');
    expect(host.activeChats()).toEqual([]);
    expect(host.send(chatStart('chat-c'))).toBe(false);

    // Each failure in a row waits longer, up to the cap; then the host stops until the next use.
    const waits: number[] = [];
    for (let failures = 1; failures < AGENT_HOST_LIMITS.maxConsecutiveFailures; failures += 1) {
      const before = forks.calls.length;
      await vi.advanceTimersByTimeAsync(restartDelayMs(failures) - 1);
      expect(forks.calls.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(forks.calls.length).toBe(before + 1);
      waits.push(restartDelayMs(failures));
      children.at(-1)!.exit(1);
    }
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(restartDelayMs(99)).toBe(AGENT_HOST_LIMITS.restartBackoffMs.at(-1));
    const given = forks.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(forks.calls.length).toBe(given);
    expect(host.status()).toBe('crashed');

    const again = host.start();
    expect(forks.calls.length).toBe(given + 1);
    runtimes.at(-1)!.postMessage(ready());
    await expect(again).resolves.toBe(true);
  });

  test('host-dispose', async () => {
    const { host, forks, children } = setup();
    void host.start();
    children[0]!.exit(1);
    host.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(forks.calls.length).toBe(1);
    expect(host.status()).toBe('stopped');
    await expect(host.start()).resolves.toBe(false);

    const running = setup();
    const started = running.host.start();
    running.runtimes[0]!.postMessage(ready());
    await started;
    running.host.dispose();
    expect(running.children[0]!.killed).toBe(true);
    expect(running.host.status()).toBe('stopped');
  });
});

// ---- AI checks (Phase 9 Task 9, Decision 15) --------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_HEADERS: [string, string][] = [
  ['anthropic-version', '2023-06-01'],
  ['content-type', 'application/json'],
];
/** A check's body, as the runtime sends it on the Anthropic key route (`auto`: no reasoning field). */
const CHECK_BODY = { model: 'claude-sonnet-5-5', max_tokens: AI_CHECK_LIMITS.maxOutputTokens, messages: [{ role: 'user', content: 'Judge this page.' }], stream: true };
/** A turn's body at High (Anthropic's adaptive thinking with the effort). */
const TURN_HIGH_BODY = { model: 'claude-sonnet-5-5', max_tokens: 16_384, messages: [{ role: 'user', content: 'Hello' }], stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'high' } };
const HIGH = { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' } as const;

const fetchRequest = (requestId: string, body: object, checkId?: string) => ({
  type: 'fetch.request',
  requestId,
  url: ANTHROPIC_URL,
  method: 'POST',
  headers: ANTHROPIC_HEADERS,
  body: JSON.stringify(body),
  ...(checkId === undefined ? {} : { checkId }),
});
const checkStart = (checkId = 'check-1') => ({ checkId, systemPrompt: 'Answer with JSON only.', input: 'Judge this page.', modelId: 'anthropic/claude-sonnet-5-5', route: 'byok-anthropic' }) as const;
const turnStart = (chatId = 'chat-1'): MainToRuntimeMessage => ({ ...chatStart(chatId), route: 'byok-anthropic', reasoningEffort: 'high' }) as MainToRuntimeMessage;
const refusedHere = (answers: readonly MainToRuntimeMessage[]) => answers.length === 1 && answers[0]!.type === 'fetch.error' && answers[0]!.code === 'refused';

describe('agent host: AI checks', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test('check-request-budget-one', async () => {
    expect(MAX_MODEL_REQUESTS_PER_CHECK).toBe(1);
    const h = await createCheckHarness({ settings: HIGH });
    expect(h.host.startCheck(checkStart())).toBe(true);
    expect(h.host.activeChecks()).toEqual(['check-1']);
    await h.flush();
    expect(h.toRuntime.at(-1)).toEqual({ type: 'check.start', ...checkStart() });
    h.runtime.post(fetchRequest('r1', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetchCalls[0]!.body).toEqual(CHECK_BODY);
    // A second request on the same check: refused here, never handed to the proxy, and counted.
    h.runtime.post(fetchRequest('r2', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(refusedHere(h.answersTo('r2'))).toBe(true);
    expect(h.host.stats()).toMatchObject({ fetchesRefused: 1, strikes: 1 });
    expect(h.log.mock.calls.flat()).toContain('agent proxy: refused a model request (check-budget)');
    // The first is answered as usual.
    h.fetchCalls[0]!.stream.push(anthropicReply('{"pageType":"product"}'));
    h.fetchCalls[0]!.stream.close();
    await h.flush();
    expect(h.answersTo('r1').map((message) => message.type)).toEqual(expect.arrayContaining(['fetch.response-start', 'fetch.end']));
    // A check id already live is refused, and so is anything before `ready` or out of bounds.
    expect(h.host.startCheck(checkStart())).toBe(false);
    expect(h.host.startCheck({ ...checkStart('check-2'), modelId: 'other/model' } as never)).toBe(false);
    expect(h.host.startCheck({ ...checkStart('check-2'), reasoningEffort: 'high' } as never)).toBe(false);
    expect(h.host.activeChecks()).toEqual(['check-1']);
  });

  test('no-request-without-live-check-or-turn', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.runtime.post(fetchRequest('r1', CHECK_BODY));
    h.runtime.post(fetchRequest('r2', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(refusedHere(h.answersTo('r1'))).toBe(true);
    expect(refusedHere(h.answersTo('r2'))).toBe(true);
    // A check and a turn that have ended leave nothing behind.
    h.host.startCheck(checkStart());
    h.host.send(turnStart());
    h.runtime.post({ type: 'check.finish', checkId: 'check-1', text: '{}' });
    h.runtime.post({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
    await h.flush();
    expect(h.host.activeChecks()).toEqual([]);
    expect(h.host.activeChats()).toEqual([]);
    h.runtime.post(fetchRequest('r3', CHECK_BODY));
    h.runtime.post(fetchRequest('r4', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(refusedHere(h.answersTo('r3'))).toBe(true);
    expect(refusedHere(h.answersTo('r4'))).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.host.stats().fetchesRefused).toBe(4);
  });

  test('check-and-turn-budgets-separate', async () => {
    const h = await createCheckHarness({ settings: HIGH, withProxy: false });
    const emitted: AgentFetchEvent[] = [];
    h.host.onFetch((event) => emitted.push(event));
    // A live check lets no untagged request through (no turn runs).
    h.host.startCheck(checkStart());
    h.runtime.post(fetchRequest('untagged', TURN_HIGH_BODY));
    await h.flush();
    expect(emitted).toEqual([]);
    expect(refusedHere(h.answersTo('untagged'))).toBe(true);
    // A running turn lets no unknown check id through.
    h.host.send(turnStart());
    h.runtime.post(fetchRequest('unknown', CHECK_BODY, 'check-unknown'));
    await h.flush();
    expect(emitted).toEqual([]);
    // The check's request is the check's; the turn's whole budget is still there.
    h.runtime.post(fetchRequest('c1', CHECK_BODY, 'check-1'));
    for (let i = 0; i < MAX_MODEL_REQUESTS_PER_TURN; i += 1) h.runtime.post(fetchRequest(`t${i}`, TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('t-over', TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('c2', CHECK_BODY, 'check-1'));
    await h.flush();
    const requests = emitted.filter((event) => event.type === 'fetch.request');
    expect(requests.length).toBe(MAX_MODEL_REQUESTS_PER_TURN + 1);
    // Main resolved the check's route and model; a turn's request carries none.
    expect(requests[0]).toMatchObject({ requestId: 'c1', check: { checkId: 'check-1', route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' } });
    expect(requests.slice(1).every((event) => event.type === 'fetch.request' && event.check === undefined)).toBe(true);
    for (const id of ['t-over', 'c2', 'unknown']) expect(refusedHere(h.answersTo(id)), id).toBe(true);
    expect(h.host.stats().fetchesRefused).toBe(4);
    // The check ending leaves the turn as it was (its budget spent by its own requests alone).
    h.runtime.post({ type: 'check.finish', checkId: 'check-1', text: '{}' });
    await h.flush();
    expect(h.host.activeChats()).toEqual(['chat-1']);
  });

  test('check-and-turn-concurrent', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.host.send(turnStart());
    h.host.startCheck(checkStart());
    h.runtime.post(fetchRequest('turn', TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('check', CHECK_BODY, 'check-1'));
    await h.flush();
    // The turn's at High on the turn path; the check's at `auto` on its own: both sent, neither counted.
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetchCalls.map((call) => call.body)).toEqual([TURN_HIGH_BODY, CHECK_BODY]);
    expect(h.fetchCalls.every((call) => call.url === ANTHROPIC_URL && call.init.headers.some(([name, value]) => name === 'x-api-key' && value.length > 0))).toBe(true);
    expect(h.toRuntime.filter((message) => message.type === 'fetch.error')).toEqual([]);
    expect(h.host.stats().strikes).toBe(0);
    expect(h.proxy!.state().active).toBe(2);
    // The same check body on the turn path is refused `reasoning` there (the settings say High), and counted.
    h.runtime.post(fetchRequest('turn-plain', CHECK_BODY));
    await h.flush();
    expect(refusedHere(h.answersTo('turn-plain'))).toBe(true);
    expect(h.proxy!.state().lastRefusal).toBe('reasoning');
    expect(h.host.stats().strikes).toBe(1);
  });

  test('unknown-or-spent-checkId-refused-and-counted', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    // A turn running, so the refusals below are the check id's alone.
    h.host.send(turnStart());
    h.runtime.post(fetchRequest('never', CHECK_BODY, 'check-never-started'));
    h.host.startCheck(checkStart('check-a'));
    h.runtime.post({ type: 'check.finish', checkId: 'check-a', text: '{}' });
    await h.flush();
    h.runtime.post(fetchRequest('finished', CHECK_BODY, 'check-a'));
    h.host.startCheck(checkStart('check-b'));
    h.runtime.post(fetchRequest('first', CHECK_BODY, 'check-b'));
    h.runtime.post(fetchRequest('second', CHECK_BODY, 'check-b'));
    await h.flush();
    for (const id of ['never', 'finished', 'second']) expect(refusedHere(h.answersTo(id)), id).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.host.stats()).toMatchObject({ fetchesRefused: 3, strikes: 3 });
    // Every one is a strike: a flood of them restarts the runtime like any other misbehaviour.
    for (let i = 0; i < AGENT_HOST_LIMITS.maxStrikesPerWindow; i += 1) h.runtime.post(fetchRequest(`flood-${i}`, CHECK_BODY, 'check-b'));
    await h.flush();
    expect(h.host.lastFailure()).toBe('misbehaved');
  });

  test('chat-ends-while-check-streams', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.host.send(turnStart());
    h.host.startCheck(checkStart('check-1'));
    h.host.startCheck(checkStart('check-2'));
    h.runtime.post(fetchRequest('turn', TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('check', CHECK_BODY, 'check-1'));
    await h.flush();
    const [turn, check] = h.fetchCalls;
    check!.stream.push(anthropicReply('{"pageType":').slice(0, 200));
    await h.flush();
    // The last chat finishes: its request is stopped, the check's goes on.
    h.runtime.post({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
    await h.flush();
    expect(turn!.init.signal.aborted).toBe(true);
    expect(check!.init.signal.aborted).toBe(false);
    expect(h.host.activeChecks()).toEqual(['check-1', 'check-2']);
    // A live check keeps its budget with no chat left.
    h.runtime.post(fetchRequest('check-2-request', CHECK_BODY, 'check-2'));
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    check!.stream.push(anthropicReply('{"pageType":').slice(200));
    check!.stream.close();
    await h.flush();
    expect(h.answersTo('check').at(-1)).toEqual({ type: 'fetch.end', requestId: 'check' });
    h.runtime.post({ type: 'check.finish', checkId: 'check-1', text: '{"pageType":"product"}' });
    await h.flush();
    expect(h.checks).toEqual([{ type: 'check.finish', checkId: 'check-1', text: '{"pageType":"product"}' }]);
    expect(h.fetchCalls[2]!.init.signal.aborted).toBe(false);
    expect(h.host.stats().strikes).toBe(0);
  });

  test('check-ends-while-chat-continues', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.host.send(turnStart());
    h.host.startCheck(checkStart());
    h.runtime.post(fetchRequest('turn-1', TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('check', CHECK_BODY, 'check-1'));
    await h.flush();
    const [turn, check] = h.fetchCalls;
    check!.stream.push(anthropicReply('{}'));
    check!.stream.close();
    await h.flush();
    h.runtime.post({ type: 'check.finish', checkId: 'check-1', text: '{}' });
    await h.flush();
    expect(h.checks.map((event) => event.type)).toEqual(['check.finish']);
    // The turn's request is untouched, and its budget too: it completes and asks again.
    expect(turn!.init.signal.aborted).toBe(false);
    turn!.stream.push(anthropicReply('Hello.'));
    turn!.stream.close();
    await h.flush();
    expect(h.answersTo('turn-1').at(-1)).toEqual({ type: 'fetch.end', requestId: 'turn-1' });
    h.runtime.post(fetchRequest('turn-2', TURN_HIGH_BODY));
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.runtime.post({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 2, usage: { input: 1, output: 1 } });
    await h.flush();
    expect(h.chats.map((event) => event.type)).toEqual(['chat.finish']);
    expect(h.host.stats().strikes).toBe(0);
  });

  test('check-cancelled-before-its-request', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.host.startCheck(checkStart());
    expect(h.host.stopCheck('check-1')).toBe(true);
    expect(h.host.stopCheck('check-1')).toBe(false);
    expect(h.host.stopCheck('check-never')).toBe(false);
    await h.flush();
    expect(h.toRuntime.at(-1)).toEqual({ type: 'check.stop', checkId: 'check-1' });
    // Main's answer comes at once; the budget is gone.
    expect(h.checks).toEqual([{ type: 'check.error', checkId: 'check-1', code: 'aborted' }]);
    expect(h.host.activeChecks()).toEqual([]);
    h.runtime.post(fetchRequest('late', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(refusedHere(h.answersTo('late'))).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
    // The runtime's own answer to the stop is let through once, quietly; a second is dropped.
    const dropped = h.host.stats().inboundDropped;
    h.runtime.post({ type: 'check.error', checkId: 'check-1', code: 'aborted' });
    await h.flush();
    expect(h.host.stats().inboundDropped).toBe(dropped);
    expect(h.checks.length).toBe(1);
    h.runtime.post({ type: 'check.error', checkId: 'check-1', code: 'aborted' });
    await h.flush();
    expect(h.host.stats().inboundDropped).toBe(dropped + 1);
  });

  test('check-cancelled-before-its-request (stopped in flight: its request is aborted)', async () => {
    const h = await createCheckHarness({ settings: HIGH });
    h.host.send(turnStart());
    h.host.startCheck(checkStart());
    h.runtime.post(fetchRequest('turn', TURN_HIGH_BODY));
    h.runtime.post(fetchRequest('check', CHECK_BODY, 'check-1'));
    await h.flush();
    h.host.stopCheck('check-1');
    await h.flush();
    expect(h.fetchCalls[1]!.init.signal.aborted).toBe(true);
    expect(h.fetchCalls[0]!.init.signal.aborted).toBe(false);
    expect(h.host.activeChats()).toEqual(['chat-1']);
  });

  test('runtime-failure-cleans-up-chats-and-checks', async () => {
    vi.useFakeTimers();
    const h = await createCheckHarness({ settings: HIGH });
    h.host.send(turnStart());
    h.host.startCheck(checkStart());
    h.host.startCheck(checkStart('check-idle'));
    h.runtime.post(fetchRequest('check', CHECK_BODY, 'check-1'));
    await h.flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.forks.calls[0]!.child.exit(1);
    await h.flush();
    expect(h.chats).toEqual([{ type: 'chat.error', chatId: 'chat-1', message: AGENT_CRASHED_MESSAGE }]);
    expect(h.checks).toEqual([
      { type: 'check.error', checkId: 'check-1', code: 'crashed' },
      { type: 'check.error', checkId: 'check-idle', code: 'crashed' },
    ]);
    expect(h.fetchCalls[0]!.init.signal.aborted).toBe(true);
    expect(h.host.activeChecks()).toEqual([]);
    expect(h.host.activeChats()).toEqual([]);
    expect(h.host.startCheck(checkStart('check-while-down'))).toBe(false);
    // The next runtime inherits no budget: neither the checks' nor the turn's.
    await vi.advanceTimersByTimeAsync(restartDelayMs(1));
    expect(h.forks.calls.length).toBe(2);
    h.runtime.ready();
    await h.flush();
    expect(h.host.status()).toBe('ready');
    h.runtime.post(fetchRequest('after-1', CHECK_BODY, 'check-idle'));
    h.runtime.post(fetchRequest('after-2', TURN_HIGH_BODY));
    await h.flush();
    expect(refusedHere(h.answersTo('after-1'))).toBe(true);
    expect(refusedHere(h.answersTo('after-2'))).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    // The old runtime's late answers are not taken for the new one's.
    h.runtime.post({ type: 'check.finish', checkId: 'check-1', text: '{}' });
    await h.flush();
    expect(h.checks.length).toBe(2);
  });
});

