// Spec: specs/agent-proxy.spec.ts (AGENT_HOST_LIMITS, restartDelayMs) · specs/agent-protocol.schema.ts
// Acceptance: specs/agent-host.feature.md (Host)
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_HOST_LIMITS, MAX_MODEL_REQUESTS_PER_TURN, restartDelayMs } from '@app/specs/agent-proxy.spec';
import { AGENT_CRASHED_MESSAGE, createAgentHost, type AgentChatEvent, type AgentHostDeps } from '../host';
import { createFakeChannel, createFakeFork, type FakeChild, type FakePort } from './fakes';

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
