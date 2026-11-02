// The agent host and model proxy wired together over fakes (no Electron, no network), for the AI
// checks' tests (Phase 9 Task 9): a real host on a fake fork, the real proxy on a memory key store
// and a scripted `fetch`, and either the test playing the runtime on its port (`runtime.post`) or the
// real runtime in-process on it (`modelFactory`).
import path from 'node:path';
import { vi } from 'vitest';
import { startRuntime, type ModelFactory, type RuntimePort } from '@app/agent-runtime';
import { AGENT_PROTOCOL_VERSION, type MainToRuntimeMessage, type RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import type { AgentModelSettings } from '@app/specs/agent-proxy.spec';
import type { ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { createCredentialStore } from '../credentials';
import { createAgentHost, type AgentChatEvent, type AgentCheckEvent } from '../host';
import { createModelProxy, type ModelProxyChatgpt, type ProxyRequestInit } from '../model-proxy';
import { createFakeChannel, createFakeFork, createFakeSafeStorage, createMemoryFs, type FakePort } from './fakes';

export const HARNESS_KEY = 'sk-check-harness-key-0123456789';

/** One call the proxy made: what it sent, and the response body's controller (the test streams it). */
export interface FetchCall {
  readonly url: string;
  readonly init: ProxyRequestInit;
  readonly body: Record<string, unknown>;
  /** Enqueue SSE text, then `close()`; the request's signal aborts it. */
  readonly stream: { push(text: string): void; close(): void };
}

export async function createCheckHarness(options: {
  settings: AgentModelSettings;
  modelFactory?: ModelFactory;
  chatgptModels?: readonly ChatgptModelView[];
  chatgpt?: ModelProxyChatgpt;
  /** `false`: the host alone (its `onFetch` events are the test's to count). */
  withProxy?: boolean;
}) {
  let runtimePort: FakePort | null = null;
  /** What main posted to the runtime (every runtime it started). */
  const toRuntime: MainToRuntimeMessage[] = [];
  const forks = createFakeFork((child) => {
    child.onPort = (port) => {
      runtimePort = port;
      port.on('message', (event: { data: unknown }) => toRuntime.push(event.data as MainToRuntimeMessage));
      if (options.modelFactory === undefined) return;
      const wrapped: RuntimePort = { post: (message) => port.postMessage(message), onMessage: (listener) => port.on('message', (event: { data: unknown }) => listener(event.data)) };
      startRuntime(wrapped, { modelFactory: options.modelFactory });
    };
  });
  const log = vi.fn<(line: string) => void>();
  const host = createAgentHost({ fork: forks.fork, createChannel: createFakeChannel, buildDir: path.join(path.sep, 'app'), packaged: false, log });
  const memory = createMemoryFs();
  const credentials = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: '/u/agent-credentials.json', fs: memory.fs, platform: 'darwin' });
  for (const slot of ['anthropic', 'openai', 'gateway'] as const) await credentials.setKey(slot, HARNESS_KEY);
  let current = options.settings;
  const settingsListeners: ((next: AgentModelSettings, before: AgentModelSettings) => void)[] = [];
  const settings = {
    current: () => current,
    load: async () => undefined,
    onChange: (listener: (next: AgentModelSettings, before: AgentModelSettings) => void) => (settingsListeners.push(listener), () => undefined),
    chatgptModels: () => options.chatgptModels ?? [],
  };
  const fetchCalls: FetchCall[] = [];
  const fetch = vi.fn(async (url: string, init: ProxyRequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    fetchCalls.push({
      url,
      init,
      body: JSON.parse(init.body) as Record<string, unknown>,
      stream: { push: (text) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close() },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const proxy = options.withProxy === false ? null : createModelProxy({ host, credentials, settings, fetch, log, ...(options.chatgpt ? { chatgpt: options.chatgpt } : {}) });
  const chats: AgentChatEvent[] = [];
  const checks: AgentCheckEvent[] = [];
  host.onChat((event) => chats.push(event));
  host.onCheck((event) => checks.push(event));

  const port = () => {
    if (runtimePort === null) throw new Error('no runtime port yet');
    return runtimePort;
  };
  /** The test's runtime says it is ready (the in-process one does so itself). */
  const ready = () => port().postMessage({ type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION, lockdown: { removed: [], failed: [], permissionModel: false } });
  const started = host.start();
  if (options.modelFactory === undefined) ready();
  if (!(await started)) throw new Error('the host did not become ready');

  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    host,
    proxy,
    forks,
    log,
    fetch,
    fetchCalls,
    chats,
    checks,
    toRuntime,
    /** Main's answers about `requestId`. */
    answersTo: (requestId: string) => toRuntime.filter((message) => 'requestId' in message && message.requestId === requestId),
    /** The runtime's side: posts `message` to main as the runtime. */
    runtime: { post: (message: RuntimeToMainMessage | Record<string, unknown>) => port().postMessage(message), port, ready },
    /** The user changes the settings (with the value it replaced). */
    switchTo(next: AgentModelSettings) {
      const before = current;
      current = next;
      for (const listener of settingsListeners) listener(next, before);
    },
    flush,
  };
}

const sse = (events: readonly (readonly [string, unknown])[]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

/** A whole Anthropic Messages stream answering `text`. */
export const anthropicReply = (text: string) =>
  sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
