// Spec: docs/plans/phase-5-ai-agent.md (decision 5; threat model "A key leaks to the renderer, a log
// or the model") · specs/agent-proxy.spec.ts · Acceptance: specs/agent-host.feature.md (Key isolation)
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import { createModel, startRuntime, type RuntimePort } from '@app/agent-runtime';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { createAgent, type AgentChatEvent, type AgentElectron } from '../index';
import type { ProxyRequestInit } from '../model-proxy';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, createMemoryFs, type FakePort } from './fakes';

const KEY = 'sk-ant-never-leaves-main-0123456789';
const USER_DATA = '/user-data';

/** A scripted Anthropic Messages stream: one text block, then the end of the turn. */
const ANTHROPIC_SSE = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The title is too long.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

/** Every string inside `value` (byte arrays decoded as UTF-8), for searching. */
function texts(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value instanceof Uint8Array) out.push(new TextDecoder().decode(value));
  else if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) texts(item, out, seen);
  }
  return out;
}
const containsKey = (value: unknown) => texts(value).some((text) => text.includes(KEY) || text.includes(Buffer.from(KEY).toString('base64')));

describe('key isolation', () => {
  const consoleCalls: unknown[] = [];
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
    // The runtime and the proxy never reach a real network.
    vi.stubGlobal('fetch', () => {
      throw new Error('network used');
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('the fakes fit the real Electron types', () => {
    type RealElectron = { utilityProcess: typeof utilityProcess; MessageChannelMain: typeof MessageChannelMain; safeStorage: typeof safeStorage; session: typeof session };
    expectTypeOf<RealElectron>().toExtend<AgentElectron>();
  });

  test('key-never-leaves-main', async () => {
    // The real runtime, in-process, on the fake port main transfers.
    const runtimePorts: FakePort[] = [];
    const forks = createFakeFork((child) => {
      child.onPort = (port) => {
        runtimePorts.push(port);
        const runtimePort: RuntimePort = { post: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (event: { data: unknown }) => listener(event.data)) };
        startRuntime(runtimePort, { modelFactory: createModel, lockdown: { removed: ['fetch'], failed: [], permissionModel: false } });
      };
    });
    const mainPorts: FakePort[] = [];
    const memory = createMemoryFs();
    const fetchCalls: { url: string; init: ProxyRequestInit }[] = [];
    const logLines: string[] = [];
    const agent = createAgent({
      electron: {
        utilityProcess: { fork: forks.fork },
        MessageChannelMain: class {
          readonly port1: FakePort;
          readonly port2: FakePort;
          constructor() {
            const channel = createFakeChannel();
            this.port1 = channel.port1;
            this.port2 = channel.port2;
            mainPorts.push(channel.port1);
          }
        },
        safeStorage: createFakeSafeStorage().storage,
        session: {
          fromPartition: (partition) => {
            expect(partition).toBe('agent-model');
            return {
              fetch: async (url, init) => {
                fetchCalls.push({ url, init });
                return new Response(new TextEncoder().encode(ANTHROPIC_SSE), { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=1' } });
              },
            };
          },
        },
      },
      userData: USER_DATA,
      buildDir: '/app/.vite/build',
      packaged: true,
      fs: memory.fs,
      platform: 'darwin',
      log: (line) => void logLines.push(line),
    });

    // Every answer of the public API, recorded.
    const answers: unknown[] = [];
    const record = <T>(value: T): T => {
      answers.push(value);
      return value;
    };
    record(await agent.credentials.setKey('anthropic', KEY));
    record(await agent.credentials.hasKey('anthropic'));
    record(await agent.credentials.protection());
    record(await agent.settings.set({ route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' }));
    record(agent.settings.current());
    expect(record(await agent.start())).toBe(true);
    record(agent.host.lockdown());
    record(agent.host.status());

    const events: AgentChatEvent[] = [];
    agent.host.onChat((event) => events.push(event));
    const start: MainToRuntimeMessage = {
      type: 'chat.start',
      chatId: 'chat-1',
      messages: [{ role: 'user', content: 'What should I fix first?' }],
      systemPrompt: 'You are an SEO assistant.',
      modelId: 'anthropic/claude-sonnet-5-5',
      route: 'byok-anthropic',
      allowedTools: ['page_audit'],
    };
    expect(record(agent.host.send(start))).toBe(true);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'chat.finish' || event.type === 'chat.error')).toBe(true));

    // The turn went through main's proxy to the scripted stream and back.
    expect(events.filter((event) => event.type === 'chat.delta').map((event) => event.text).join('')).toBe('The title is too long.');
    expect(events.find((event) => event.type === 'chat.finish')).toMatchObject({ finishReason: 'stop' });
    record(events);
    record(agent.proxy.state());
    record(agent.host.stats());
    record(agent.host.activeChats());
    record(await agent.credentials.clearKey('openai'));

    // The key went out once, in the header main added, to the allowlisted URL only.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const keyHeaders = fetchCalls[0]!.init.headers.filter(([, value]) => value.includes(KEY));
    expect(keyHeaders).toEqual([['x-api-key', KEY]]);
    expect(fetchCalls[0]!.init.body).not.toContain(KEY);

    // Nowhere else: not in any message main posted to the runtime or the runtime posted to main,
    // not in any answer of the public API, not in a log line or console output, not in the file.
    const toRuntime = mainPorts.flatMap((port) => port.posted);
    const fromRuntime = runtimePorts.flatMap((port) => port.posted);
    expect(toRuntime.length).toBeGreaterThan(2);
    expect(fromRuntime.length).toBeGreaterThan(2);
    expect(containsKey(toRuntime)).toBe(false);
    expect(containsKey(fromRuntime)).toBe(false);
    expect(containsKey(forks.calls.map((call) => [call.modulePath, call.args, call.options, call.child.messages.map((m) => m.message)]))).toBe(false);
    expect(containsKey(answers)).toBe(false);
    expect(containsKey(logLines)).toBe(false);
    expect(containsKey(consoleCalls)).toBe(false);
    expect(memory.text(`${USER_DATA}/agent-credentials.json`)).not.toContain(KEY);
    expect(containsKey([...memory.files.values()].map((file) => file.data))).toBe(false);
    // The runtime never received a response header carrying a cookie.
    expect(texts(toRuntime).some((text) => text.includes('sid=1'))).toBe(false);
    // The settings page's view of the store cannot hand a key out.
    expect('withKey' in agent.credentials).toBe(false);

    agent.dispose();
    expect(agent.host.status()).toBe('stopped');
  });
});
