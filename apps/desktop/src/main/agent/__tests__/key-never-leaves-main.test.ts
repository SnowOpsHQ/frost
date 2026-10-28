// Spec: docs/plans/phase-5-ai-agent.md (decision 5; threat model "A key leaks to the renderer, a log
// or the model") · specs/agent-proxy.spec.ts · Acceptance: specs/agent-host.feature.md (Key isolation)
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import { createModel, startRuntime, type RuntimePort } from '@app/agent-runtime';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { createAgent, type Agent, type AgentChatEvent, type AgentElectron } from '../index';
import type { ProxyRequestInit } from '../model-proxy';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, createMemoryFs, type FakePort } from './fakes';

const KEY = 'sk-ant-never-leaves-main-0123456789';
const USER_DATA = '/user-data';
const CREDENTIALS = `${USER_DATA}/agent-credentials.json`;

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
  else if (value instanceof Error) out.push(value.message, String(value.stack));
  else if (typeof value === 'object' && value !== null && !seen.has(value)) {
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) texts(item, out, seen);
  }
  return out;
}
/** The key, its base64, or its last 8 characters (what a masked echo keeps). */
const containsKey = (value: unknown) => texts(value).some((text) => text.includes(KEY) || text.includes(Buffer.from(KEY).toString('base64')) || text.includes(KEY.slice(-8)));

type Respond = (init: ProxyRequestInit) => Promise<Response>;

/** The agent over fakes, with the real runtime in-process on the fake port main transfers. */
function makeAgent(memory: ReturnType<typeof createMemoryFs>, safe: ReturnType<typeof createFakeSafeStorage>, respond: { next: Respond }, logLines: string[]) {
  const runtimePorts: FakePort[] = [];
  const mainPorts: FakePort[] = [];
  const fetchCalls: { url: string; init: ProxyRequestInit }[] = [];
  const forks = createFakeFork((child) => {
    child.onPort = (port) => {
      runtimePorts.push(port);
      const runtimePort: RuntimePort = { post: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (event: { data: unknown }) => listener(event.data)) };
      startRuntime(runtimePort, { modelFactory: createModel, lockdown: { removed: ['fetch'], failed: [], permissionModel: false } });
    };
  });
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
      safeStorage: safe.storage,
      session: {
        fromPartition: (partition) => {
          expect(partition).toBe('agent-model');
          return {
            fetch: (url, init) => {
              fetchCalls.push({ url, init });
              return respond.next(init);
            },
          };
        },
      },
    },
    userData: USER_DATA,
    buildDir: '/app/.vite/build',
    packaged: true,
    fs: memory.fs,
    platform: 'linux',
    log: (line) => void logLines.push(line),
  });
  return { agent, runtimePorts, mainPorts, fetchCalls, forks };
}

let turn = 0;
/** Runs one turn and answers its chat events. */
async function runTurn(agent: Agent): Promise<AgentChatEvent[]> {
  const chatId = `chat-${(turn += 1)}`;
  const events: AgentChatEvent[] = [];
  const off = agent.host.onChat((event) => {
    if (event.chatId === chatId) events.push(event);
  });
  const start: MainToRuntimeMessage = {
    type: 'chat.start',
    chatId,
    messages: [{ role: 'user', content: 'What should I fix first?' }],
    systemPrompt: 'You are an SEO assistant.',
    modelId: 'anthropic/claude-sonnet-5-5',
    route: 'byok-anthropic',
    allowedTools: ['page_audit'],
  };
  expect(agent.host.send(start)).toBe(true);
  await vi.waitFor(() => expect(events.some((event) => event.type === 'chat.finish' || event.type === 'chat.error')).toBe(true));
  off();
  return events;
}

describe('key isolation', () => {
  const consoleCalls: unknown[] = [];
  beforeEach(() => {
    consoleCalls.length = 0;
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        consoleCalls.push(chunk);
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
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
    const memory = createMemoryFs();
    const safe = createFakeSafeStorage();
    const logLines: string[] = [];
    const respond: { next: Respond } = { next: async () => new Response(new TextEncoder().encode(ANTHROPIC_SSE), { status: 200, headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=1' } }) };
    const { agent, runtimePorts, mainPorts, fetchCalls, forks } = makeAgent(memory, safe, respond, logLines);

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

    // 1. A turn through main's proxy to the scripted stream and back.
    const ok = record(await runTurn(agent));
    expect(ok.filter((event) => event.type === 'chat.delta').map((event) => event.text).join('')).toBe('The title is too long.');
    expect(ok.find((event) => event.type === 'chat.finish')).toMatchObject({ finishReason: 'stop' });

    // 2. A 401 whose body quotes the key (some providers echo a masked one): the body is withheld.
    respond.next = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY} (…${KEY.slice(-8)})` } }), { status: 401, headers: { 'content-type': 'application/json' } });
    expect(record(await runTurn(agent)).at(-1)?.type).toBe('chat.error');

    // 3. A network error whose text quotes the request (as a header-value error would).
    respond.next = async () => {
      throw new TypeError(`Headers.append: "x-api-key: ${KEY}" is an invalid header value`);
    };
    expect(record(await runTurn(agent)).at(-1)?.type).toBe('chat.error');

    // 4. A redirect, its error quoting the key.
    respond.next = async () => {
      throw new Error(`Attempted to redirect, but redirect policy was 'error' (${KEY})`);
    };
    expect(record(await runTurn(agent)).at(-1)?.type).toBe('chat.error');

    // 5. A refusal: main's settings name another model than the runtime asks for.
    record(await agent.settings.set({ modelId: 'anthropic/claude-opus-5-5' }));
    const callsBefore = fetchCalls.length;
    expect(record(await runTurn(agent)).at(-1)?.type).toBe('chat.error');
    expect(fetchCalls.length).toBe(callsBefore);
    record(await agent.settings.set({ modelId: 'anthropic/claude-sonnet-5-5' }));

    // 6. The encryptor asks for the key to be encrypted again: the file is rewritten, still without it.
    const fileBefore = memory.text(CREDENTIALS);
    safe.state.reEncrypt = true;
    respond.next = async () => new Response(new TextEncoder().encode(ANTHROPIC_SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    expect(record(await runTurn(agent)).at(-1)?.type).toBe('chat.finish');
    safe.state.reEncrypt = false;
    expect(memory.text(CREDENTIALS)).not.toBe(fileBefore);

    record(agent.proxy.state());
    record(agent.host.stats());
    record(agent.host.activeChats());
    record(await agent.credentials.clearKey('openai'));

    // The key went out only in the header main added, to the allowlisted URL.
    expect(fetchCalls.length).toBe(5);
    for (const call of fetchCalls) {
      expect(call.url).toBe('https://api.anthropic.com/v1/messages');
      expect(call.init.headers.filter(([, value]) => value.includes(KEY))).toEqual([['x-api-key', KEY]]);
      expect(call.init.body).not.toContain(KEY);
    }

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
    expect(containsKey([...memory.files.values()].map((file) => file.data))).toBe(false);
    // The runtime never received a cookie header.
    expect(texts(toRuntime).some((text) => text.includes('sid=1'))).toBe(false);
    // The settings page's view of the store cannot hand a key out.
    expect('withKey' in agent.credentials).toBe(false);

    agent.dispose();
    expect(agent.host.status()).toBe('stopped');
  });

  test('key-never-leaves-main (a key that fails to decrypt)', async () => {
    const memory = createMemoryFs();
    const safe = createFakeSafeStorage();
    memory.files.set(CREDENTIALS, { data: new TextEncoder().encode(JSON.stringify({ version: 1, keys: { anthropic: Buffer.from(`v11${KEY}`).toString('base64') } })), mode: 0o600 });
    const logLines: string[] = [];
    const respond: { next: Respond } = { next: () => Promise.reject(new Error('never called')) };
    const { agent, mainPorts, fetchCalls } = makeAgent(memory, safe, respond, logLines);
    await agent.settings.set({ route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' });
    expect(await agent.credentials.hasKey('anthropic')).toBe(false);
    expect(await agent.start()).toBe(true);
    const events = await runTurn(agent);
    expect(events.at(-1)?.type).toBe('chat.error');
    expect(fetchCalls).toEqual([]);
    expect(agent.proxy.state().lastRefusal).toBe('key-unavailable');
    // The blob holds the key's bytes in the clear here, on purpose: none of them came out.
    expect(containsKey(mainPorts.flatMap((port) => port.posted))).toBe(false);
    expect(containsKey([logLines, consoleCalls, events])).toBe(false);
    agent.dispose();
  });
});
