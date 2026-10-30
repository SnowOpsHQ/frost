// Spec: docs/plans/phase-5-ai-agent.md (decision 5; threat model "A key leaks to the renderer, a log
// or the model") · specs/agent-proxy.spec.ts · Acceptance: specs/agent-host.feature.md (Key isolation)
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import type { MessageChannelMain, safeStorage, session, utilityProcess } from 'electron';
import { createModel, startRuntime, type RuntimePort } from '@app/agent-runtime';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { CHATGPT_ENDPOINTS, CHATGPT_TOOL_NAMESPACE } from '@app/specs/agent-chatgpt.spec';
import type { AgentState } from '@app/specs/agent-session.spec';
import { createChatHistory, createMemoryChatsStore } from '../chat-history';
import type { ChatgptAuth } from '../chatgpt';
import { createHarness } from '../chatgpt/__tests__/harness';
import { createDefaultAgentEntitlements } from '../entitlements';
import { createAgent, type Agent, type AgentChatEvent, type AgentElectron } from '../index';
import type { ProxyRequestInit } from '../model-proxy';
import { createAgentSession } from '../session';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, createMemoryFs, type FakePort } from './fakes';

const KEY = 'sk-ant-never-leaves-main-0123456789';
const USER_DATA = '/user-data';
// Built as the store builds it (`path.join`: backslashes on Windows), so the memory fs finds it.
const CREDENTIALS = path.join(USER_DATA, 'agent-credentials.json');

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
function makeAgent(memory: ReturnType<typeof createMemoryFs>, safe: ReturnType<typeof createFakeSafeStorage>, respond: { next: Respond }, logLines: string[], chatgptAuth?: ChatgptAuth) {
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
              // The model proxy's session: only the proxy's own request shape reaches it.
              const sent = init as ProxyRequestInit;
              fetchCalls.push({ url, init: sent });
              return respond.next(sent);
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
    ...(chatgptAuth ? { chatgptAuth } : {}),
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
    mcpTools: [],
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

  test('key-never-leaves-main (the ChatGPT plan: no access, refresh or ID token outside main)', async () => {
    const h = createHarness();
    try {
      h.server.models = { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] };
      const memory = createMemoryFs();
      const safe = createFakeSafeStorage();
      const logLines: string[] = [];
      // A Responses stream with one text message (the plan's answer).
      const answer = [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-6.1-sol' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Fix the title.', logprobs: [] },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 10, output_tokens: 4 } } },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('');
      const respond: { next: Respond } = { next: async () => new Response(new TextEncoder().encode(answer), { status: 200, headers: { 'content-type': 'text/event-stream' } }) };
      const { agent, runtimePorts, mainPorts, fetchCalls } = makeAgent(memory, safe, respond, logLines, h.auth);
      const chats = createMemoryChatsStore();
      const session = createAgentSession({
        host: agent.host,
        approvals: agent.approvals,
        credentials: agent.credentials,
        settings: agent.settings,
        entitlements: createDefaultAgentEntitlements(),
        grants: agent.grants,
        start: () => agent.start(),
        activeTabId: () => 4,
        history: createChatHistory({ store: chats, now: () => 1, log: (line) => void logLines.push(line) }),
        chatgpt: agent.chatgpt,
        log: (line) => void logLines.push(line),
      });
      const states: AgentState[] = [];
      const record = () => void states.push(structuredClone(session.getState()));

      await agent.settings.load();
      await agent.chatgpt.start();
      await h.signIn();
      await vi.waitFor(() => expect(agent.chatgpt.view().models).toHaveLength(1));
      expect(await session.setModel('chatgpt', 'chatgpt/gpt-6.1-sol')).toBe(true);
      await session.refreshSetup();
      record();
      expect(session.getState().setup).toMatchObject({ route: 'chatgpt', ready: true, chatgpt: { account: { state: 'signed-in', planUsage: 'on' } } });
      expect(await session.send(null, 'What should I fix first?')).toBe('started');
      await vi.waitFor(() => expect(session.getState().running).toBe(false));
      record();
      expect(session.getState().active?.messages.at(-1)).toMatchObject({ text: 'Fix the title.' });
      // A refreshed token for the second turn: still nowhere but the header.
      h.clock.now += 3600_000;
      expect(await session.send(session.getState().active!.id, 'And then?')).toBe('started');
      await vi.waitFor(() => expect(session.getState().running).toBe(false));
      record();
      await vi.waitFor(() => expect(chats.heads.size).toBe(1));

      // The tokens went out only as main's Authorization header, to the plan's one URL.
      expect(fetchCalls.map((call) => call.url)).toEqual([CHATGPT_ENDPOINTS.responses, CHATGPT_ENDPOINTS.responses]);
      expect(fetchCalls.map((call) => call.init.headers.find(([name]) => name === 'authorization')![1])).toEqual(['Bearer access-token-1', 'Bearer access-token-2']);
      for (const call of fetchCalls) expect(call.init.body).not.toMatch(/access-token|refresh-token/);
      expect(JSON.parse(fetchCalls[0]!.init.body)).toMatchObject({ store: false, stream: true, tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name }] });

      const tokens = ['access-token-1', 'access-token-2', 'refresh-token-1', 'refresh-token-2', ...h.idTokens, 'auth-code-0123456789'];
      const leaks = (value: unknown) => texts(value).filter((text) => tokens.some((token) => text.includes(token)) || /access-token|refresh-token/.test(text));
      // Not in the panel's state (every state recorded, and the last one), the settings file, the chat record,
      // a message to or from the runtime, a log line or the console.
      expect(leaks(states)).toEqual([]);
      expect(leaks(session.getState())).toEqual([]);
      expect(leaks([...memory.files.values()].map((file) => file.data))).toEqual([]);
      expect(leaks([...chats.heads.values(), ...chats.rows.values()])).toEqual([]);
      expect(leaks(mainPorts.flatMap((port) => port.posted))).toEqual([]);
      expect(leaks(runtimePorts.flatMap((port) => port.posted))).toEqual([]);
      expect(leaks([logLines, h.logs, consoleCalls])).toEqual([]);
      // The stored settings hold the route, the model, the reasoning level and the list only.
      expect(Object.keys(JSON.parse(memory.text(path.join(USER_DATA, 'agent-settings.json')) ?? 'null') as object).sort()).toEqual(['chatgptModels', 'modelId', 'reasoningEffort', 'route']);
      // The sign-in's own file holds them, encrypted (the fake safe storage's sealed blob).
      expect(leaks([...h.memory.files.values()].map((file) => file.data))).toEqual([]);

      session.dispose();
      agent.dispose();
    } finally {
      await h.auth.dispose();
      await h.close();
    }
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
