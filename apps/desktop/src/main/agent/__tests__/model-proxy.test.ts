// Spec: specs/agent-proxy.spec.ts (AGENT_PROXY_LIMITS, PROXY_REFUSALS, checkModelRequest) · specs/agent-tools.spec.ts (MODEL_REQUESTS,
// isAllowedModelRequest) · specs/agent-protocol.schema.ts (AGENT_PROTOCOL_LIMITS) · specs/agent-reasoning.spec.ts
// (effectiveEffort, MODEL_REASONING_SUPPORT) · specs/agent-chatgpt.spec.ts (CHATGPT_TOOL_NAMESPACE, ChatgptModelView)
// Acceptance: specs/agent-host.feature.md (Model proxy, Reasoning) · plan docs/plans/phase-8-ai-complete.md, Task 8a
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_TOOL_NAMESPACE, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { AGENT_PROTOCOL_LIMITS, MainToRuntimeMessageSchema, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_PROXY_LIMITS, type AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { MODEL_REASONING_SUPPORT } from '@app/specs/agent-reasoning.spec';
import { ALLOWED_MODEL_IDS, byProvider, MODEL_REQUESTS } from '@app/specs/agent-tools.spec';
import { createCredentialStore } from '../credentials';
import type { AgentChatEvent, AgentFetchEvent, AgentHostStatus } from '../host';
import { createModelProxy, type ModelProxyChatgpt, type ProxyFetchFunction, type ProxyRequestInit } from '../model-proxy';
import { createFakeSafeStorage, createMemoryFs, streamOf } from './fakes';

const KEY = 'sk-proxy-test-key-0123456789';
const ANTHROPIC_URL = MODEL_REQUESTS['byok-anthropic'][0]!.url;
const ANTHROPIC_BODY = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }], stream: true });

type FetchRequest = Extract<AgentFetchEvent, { type: 'fetch.request' }>;

const request = (overrides: Partial<FetchRequest> = {}): FetchRequest => ({
  type: 'fetch.request',
  requestId: 'req-1',
  url: ANTHROPIC_URL,
  method: 'POST',
  headers: [
    ['anthropic-version', '2023-06-01'],
    ['content-type', 'application/json'],
    ['x-api-key', 'frost-placeholder-key'],
    ['cookie', 'sid=1'],
  ],
  body: ANTHROPIC_BODY,
  ...overrides,
});

const sse = (text: string) => new TextEncoder().encode(text);

async function setup(
  options: {
    settings?: AgentModelSettings;
    fetch?: ProxyFetchFunction;
    key?: boolean;
    limits?: Partial<typeof AGENT_PROXY_LIMITS>;
    loadSettings?: () => Promise<void>;
    now?: () => number;
    chatgptModels?: readonly ChatgptModelView[];
    chatgpt?: ModelProxyChatgpt;
  } = {},
) {
  const sent: MainToRuntimeMessage[] = [];
  const fetchListeners: ((event: AgentFetchEvent) => void)[] = [];
  const statusListeners: ((status: AgentHostStatus) => void)[] = [];
  const chatListeners: ((event: AgentChatEvent) => void)[] = [];
  const chats = { active: ['chat-1'] as string[] };
  const strike = vi.fn();
  const host = {
    strike,
    activeChats: () => chats.active,
    onChat: (listener: (event: AgentChatEvent) => void) => {
      chatListeners.push(listener);
      return () => undefined;
    },
    send: (message: MainToRuntimeMessage) => {
      // Every answer is a valid protocol message.
      expect(MainToRuntimeMessageSchema.safeParse(message).success, JSON.stringify(message).slice(0, 200)).toBe(true);
      sent.push(message);
      return true;
    },
    onFetch: (listener: (event: AgentFetchEvent) => void) => {
      fetchListeners.push(listener);
      return () => undefined;
    },
    onStatus: (listener: (status: AgentHostStatus) => void) => {
      statusListeners.push(listener);
      return () => undefined;
    },
  };
  const memory = createMemoryFs();
  const credentials = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: '/u/agent-credentials.json', fs: memory.fs, platform: 'darwin' });
  if (options.key !== false) {
    await credentials.setKey('anthropic', KEY);
    await credentials.setKey('openai', KEY);
    await credentials.setKey('gateway', KEY);
  }
  let current: AgentModelSettings = options.settings ?? { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' };
  const settingsListeners: ((settings: AgentModelSettings, previous: AgentModelSettings) => void)[] = [];
  const settings = {
    current: () => current,
    load: options.loadSettings ?? (async () => undefined),
    onChange: (listener: (settings: AgentModelSettings, previous: AgentModelSettings) => void) => (settingsListeners.push(listener), () => undefined),
    chatgptModels: () => options.chatgptModels ?? [],
  };
  /** The user changes the settings (the settings' own `onChange`, with the value it replaced). */
  const switchTo = (next: AgentModelSettings) => {
    const before = current;
    current = next;
    for (const listener of settingsListeners) listener(next, before);
  };
  const fetch = vi.fn<ProxyFetchFunction>(
    options.fetch ??
      (async () =>
        new Response(streamOf([sse('event: message_start\ndata: {}\n\n')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=2', 'request-id': 'req_9', 'anthropic-organization-id': 'org-1' },
        })),
  );
  const log = vi.fn<(line: string) => void>();
  const proxy = createModelProxy({ host, credentials, settings, fetch, log, ...(options.limits ? { limits: options.limits } : {}), ...(options.now ? { now: options.now } : {}), ...(options.chatgpt ? { chatgpt: options.chatgpt } : {}) });
  const emit = (event: AgentFetchEvent) => {
    for (const listener of fetchListeners) listener(event);
  };
  const status = (value: AgentHostStatus) => {
    for (const listener of statusListeners) listener(value);
  };
  const chatEvent = (event: AgentChatEvent) => {
    for (const listener of chatListeners) listener(event);
  };
  const of = <T extends MainToRuntimeMessage['type']>(type: T) => sent.filter((message): message is Extract<MainToRuntimeMessage, { type: T }> => message.type === type);
  const ended = (requestId = 'req-1') => vi.waitFor(() => expect(sent.some((message) => 'requestId' in message && message.requestId === requestId && (message.type === 'fetch.end' || message.type === 'fetch.error'))).toBe(true));
  /** The answer for `requestId`: `sent` (a fetch was made) or the refusal's reason (`proxy.state().lastRefusal`). */
  const outcome = async (requestId: string) => {
    await ended(requestId);
    return fetch.mock.calls.length > sentBefore(requestId) ? 'sent' : proxy.state().lastRefusal;
  };
  const fetchCounts = new Map<string, number>();
  const sentBefore = (requestId: string) => fetchCounts.get(requestId) ?? 0;
  /** Emits a request and answers how it ended (`sent`, or the refusal's reason). */
  const run = async (requestId: string, overrides: Partial<FetchRequest>) => {
    fetchCounts.set(requestId, fetch.mock.calls.length);
    emit(request({ requestId, ...overrides }));
    return outcome(requestId);
  };
  return { proxy, sent, fetch, log, emit, status, of, ended, strike, chats, chatEvent, switchTo, run };
}

/** The runtime's Anthropic request (key route) with the thinking the effort maps to (`auto`: none). */
const anthropicBody = (effort: 'auto' | 'low' | 'medium' | 'high', model = 'claude-sonnet-5-5') =>
  JSON.stringify({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }], stream: true, ...(effort === 'auto' ? {} : { thinking: { type: 'adaptive' }, output_config: { effort } }) });
const GATEWAY_URL = MODEL_REQUESTS.gateway[0]!.url;
/** A gateway request for `modelId` with these provider options (beside the runtime's `openai.store: false`). */
const gatewayRequest = (modelId: string, options: object = {}): Partial<FetchRequest> => ({
  url: GATEWAY_URL,
  headers: [['ai-language-model-id', modelId]],
  body: JSON.stringify({ maxOutputTokens: 64, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], providerOptions: { openai: { store: false }, ...options } }),
});
const turnEnds = (s: { chats: { active: string[] }; chatEvent: (event: AgentChatEvent) => void }) => {
  s.chats.active = [];
  s.chatEvent({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
  s.chats.active = ['chat-2'];
};

afterEach(() => {
  vi.useRealTimers();
});

describe('model proxy', () => {
  test('proxy-allowlist', async () => {
    const urls = [
      'https://api.anthropic.com/v1/messages?beta=true',
      'https://api.anthropic.com/v1/messages#x',
      'https://api.anthropic.com/v1/messages/',
      'https://api.anthropic.com/v1/files',
      'https://api.anthropic.com:8443/v1/messages',
      'http://api.anthropic.com/v1/messages',
      'https://evil.example/v1/messages',
      'https://api.anthropic.com.evil.example/v1/messages',
      'https://user@api.anthropic.com/v1/messages',
      'https://API.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/./messages',
      'https://api.anthropic.com\\v1\\messages',
      'https://api.anthropic.com:443/v1/messages',
      'wss://api.anthropic.com/v1/messages',
      'file:///etc/passwd',
      MODEL_REQUESTS['byok-openai'][0]!.url,
      MODEL_REQUESTS.gateway[0]!.url,
    ];
    const { emit, fetch, of, sent } = await setup();
    urls.forEach((url, index) => emit(request({ requestId: `u${index}`, url })));
    emit(request({ requestId: 'get', method: 'GET' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(urls.length + 1));
    expect(fetch).not.toHaveBeenCalled();
    expect(of('fetch.error').every((message) => message.code === 'refused' && message.message === 'frost refused this model request.')).toBe(true);
    expect(sent.length).toBe(urls.length + 1);

    // The route is the settings': the gateway's URL is fine when the gateway is configured, not otherwise.
    const gateway = await setup({ settings: { route: 'gateway', modelId: 'anthropic/claude-sonnet-5-5' } });
    gateway.emit(request({ url: ANTHROPIC_URL }));
    await gateway.ended();
    expect(gateway.of('fetch.error')[0]?.code).toBe('refused');
    expect(gateway.fetch).not.toHaveBeenCalled();
  });

  test('proxy-redirect-not-followed', async () => {
    const redirecting = vi.fn<ProxyFetchFunction>(async () => {
      throw new Error("Attempted to redirect, but redirect policy was 'error'");
    });
    const { emit, fetch, of, log } = await setup({ fetch: redirecting });
    emit(request());
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(1));
    expect(of('fetch.error')[0]).toEqual({ type: 'fetch.error', requestId: 'req-1', code: 'refused', message: 'frost refused this model request.' });
    expect(log).toHaveBeenCalledWith('agent proxy: refused a model request (redirect)');
    const init = fetch.mock.calls[0]![1];
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(fetch.mock.calls[0]![0]).toBe(ANTHROPIC_URL);
    // A plain network failure is `network`, with no upstream text.
    const failing = await setup({ fetch: async () => Promise.reject(new Error('net::ERR_CONNECTION_RESET https://api.anthropic.com/?q=secret')) });
    failing.emit(request());
    await failing.ended();
    expect(failing.of('fetch.error')[0]).toEqual({ type: 'fetch.error', requestId: 'req-1', code: 'network', message: 'The model request failed.' });
    expect(JSON.stringify(failing.log.mock.calls)).not.toContain('secret');
  });

  test('proxy-streams-response', async () => {
    const big = new Uint8Array(AGENT_PROTOCOL_LIMITS.maxChunkBytes * 2 + 10).fill(65);
    const { emit, fetch, of, sent, ended } = await setup({
      fetch: async () => new Response(streamOf([sse('event: a\n\n'), big]), { status: 200, statusText: 'OK', headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=2', 'request-id': 'req_9', 'anthropic-organization-id': 'org-1' } }),
    });
    emit(request());
    await ended();
    expect(sent[0]).toEqual({ type: 'fetch.response-start', requestId: 'req-1', status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream'], ['request-id', 'req_9']] });
    const chunks = of('fetch.chunk');
    expect(chunks.map((chunk) => chunk.bytes.byteLength)).toEqual([10, AGENT_PROTOCOL_LIMITS.maxChunkBytes, AGENT_PROTOCOL_LIMITS.maxChunkBytes, 10]);
    expect(sent.at(-1)).toEqual({ type: 'fetch.end', requestId: 'req-1' });
    // Header scrub and injection: the runtime's credential and cookie headers are gone; main's key is in.
    const init = fetch.mock.calls[0]![1] as ProxyRequestInit;
    expect(init.headers).toEqual([
      ['anthropic-version', '2023-06-01'],
      ['content-type', 'application/json'],
      ['x-api-key', KEY],
    ]);
    expect(init.body).toBe(ANTHROPIC_BODY);
  });

  test('proxy-error-body-withheld', async () => {
    const { emit, sent, ended, log } = await setup({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY.slice(0, 6)}****${KEY.slice(-4)}`, organization: 'org-1' } }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json', 'request-id': 'req_401', 'openai-organization': 'org-1' },
        }),
    });
    emit(request());
    await ended();
    expect(sent).toEqual([
      { type: 'fetch.response-start', requestId: 'req-1', status: 401, statusText: 'Unauthorized', headers: [['content-type', 'application/json'], ['request-id', 'req_401']] },
      { type: 'fetch.end', requestId: 'req-1' },
    ]);
    expect(log).toHaveBeenCalledWith('agent proxy: the model service answered 401');
  });

  test('proxy-credential-injection per route', async () => {
    const openai = await setup({ settings: { route: 'byok-openai', modelId: 'openai/gpt-5' } });
    openai.emit(request({ url: MODEL_REQUESTS['byok-openai'][0]!.url, headers: [['authorization', 'Bearer frost-placeholder-key'], ['openai-organization', 'org']], body: JSON.stringify({ model: 'gpt-5', max_output_tokens: 64, input: 'Hi', store: false }) }));
    await openai.ended();
    expect(openai.fetch.mock.calls[0]![1].headers).toEqual([['content-type', 'application/json'], ['authorization', `Bearer ${KEY}`]]);
    const gateway = await setup({ settings: { route: 'gateway', modelId: 'anthropic/claude-opus-5-5' } });
    gateway.emit(
      request({
        url: MODEL_REQUESTS.gateway[0]!.url,
        headers: [['ai-language-model-id', 'anthropic/claude-opus-5-5'], ['ai-gateway-auth-method', 'oidc'], ['authorization', 'Bearer x']],
        body: new TextEncoder().encode(JSON.stringify({ maxOutputTokens: 64, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] })),
      }),
    );
    await gateway.ended();
    expect(gateway.fetch.mock.calls[0]![1].headers).toEqual([
      ['ai-language-model-id', 'anthropic/claude-opus-5-5'],
      ['content-type', 'application/json'],
      ['authorization', `Bearer ${KEY}`],
      ['ai-gateway-auth-method', 'api-key'],
    ]);
  });

  test('proxy-body-checks', async () => {
    const { emit, fetch, of, log } = await setup();
    emit(request({ requestId: 'a', body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1, messages: [] }) }));
    emit(request({ requestId: 'a2', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 128_000, messages: [] }) }));
    emit(request({ requestId: 'b', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [], mcp_servers: [] }) }));
    emit(request({ requestId: 'c', body: null }));
    emit(request({ requestId: 'd', body: new Uint8Array([0xff, 0xfe]) }));
    emit(request({ requestId: 'e', body: 'x'.repeat(10) }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(6));
    expect(fetch).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => line)).toEqual(['model', 'output-cap', 'body-field', 'body-missing', 'body-encoding', 'body-json'].map((reason) => `agent proxy: refused a model request (${reason})`));
  });

  test('proxy-no-key', async () => {
    const { emit, fetch, of, proxy } = await setup({ key: false });
    expect(proxy.state().key).toBe('unknown');
    emit(request());
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(1));
    expect(of('fetch.error')[0]!.code).toBe('refused');
    expect(fetch).not.toHaveBeenCalled();
    expect(proxy.state()).toEqual({ key: 'no-key', active: 0, lastRefusal: 'no-key' });
  });

  test('proxy-caps: response size', async () => {
    const piece = new Uint8Array(AGENT_PROTOCOL_LIMITS.maxChunkBytes);
    const pieces = Array.from({ length: AGENT_PROTOCOL_LIMITS.maxResponseBytes / piece.byteLength + 1 }, () => piece);
    let signal: AbortSignal | undefined;
    const { emit, of, ended } = await setup({
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Response(streamOf(pieces, { keepOpen: true }), { status: 200 });
      },
    });
    emit(request());
    await ended();
    expect(of('fetch.error')).toEqual([{ type: 'fetch.error', requestId: 'req-1', code: 'too-large', message: "The model's answer was too large." }]);
    expect(of('fetch.chunk').reduce((total, chunk) => total + chunk.bytes.byteLength, 0)).toBe(AGENT_PROTOCOL_LIMITS.maxResponseBytes);
    expect(signal?.aborted).toBe(true);
  }, 30_000);

  test('proxy-caps: idle timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { emit, of, proxy } = await setup({
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Response(streamOf([sse('event: a\n\n')], { keepOpen: true }), { status: 200 });
      },
    });
    emit(request());
    await vi.advanceTimersByTimeAsync(AGENT_PROXY_LIMITS.idleTimeoutMs - 1);
    expect(of('fetch.error')).toEqual([]);
    expect(of('fetch.chunk').length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(of('fetch.error')).toEqual([{ type: 'fetch.error', requestId: 'req-1', code: 'timeout', message: 'The model took too long to answer.' }]);
    expect(signal?.aborted).toBe(true);
    expect(proxy.state().active).toBe(0);
    // A head that never comes times out too.
    const hanging = await setup({ fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    hanging.emit(request());
    await vi.advanceTimersByTimeAsync(AGENT_PROXY_LIMITS.idleTimeoutMs);
    expect(hanging.of('fetch.error').map((message) => message.code)).toEqual(['timeout']);
  });

  test('proxy-caps: concurrency and duplicate ids', async () => {
    const signals = new Map<string, AbortSignal>();
    let n = 0;
    const { emit, of, proxy, fetch } = await setup({
      fetch: (_url, init) => {
        signals.set(`f${(n += 1)}`, init.signal);
        return new Promise(() => undefined);
      },
    });
    for (let i = 0; i < AGENT_PROXY_LIMITS.maxConcurrentRequests; i += 1) emit(request({ requestId: `r${i}` }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(AGENT_PROXY_LIMITS.maxConcurrentRequests));
    emit(request({ requestId: 'one-too-many' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(1));
    expect(of('fetch.error')[0]).toMatchObject({ requestId: 'one-too-many', code: 'refused' });
    expect(proxy.state().lastRefusal).toBe('busy');
    // The same id again while live: both are stopped, one refusal answers the id.
    emit(request({ requestId: 'r0' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(2));
    expect(of('fetch.error')[1]).toMatchObject({ requestId: 'r0', code: 'refused' });
    expect(signals.get('f1')?.aborted).toBe(true);
    expect(proxy.state()).toMatchObject({ active: AGENT_PROXY_LIMITS.maxConcurrentRequests - 1, lastRefusal: 'duplicate-id' });
    expect(fetch).toHaveBeenCalledTimes(AGENT_PROXY_LIMITS.maxConcurrentRequests);
  });

  test('proxy-abort', async () => {
    let signal: AbortSignal | undefined;
    const { emit, sent, proxy, status, fetch } = await setup({
      fetch: async (_url, init) => {
        signal = init.signal;
        return new Response(streamOf([sse('event: a\n\n')], { keepOpen: true }), { status: 200 });
      },
    });
    emit(request());
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'fetch.chunk')).toBe(true));
    const before = sent.length;
    emit({ type: 'fetch.abort', requestId: 'req-1' });
    expect(signal?.aborted).toBe(true);
    expect(proxy.state().active).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.length).toBe(before);
    // The runtime going away aborts everything in flight, answering nothing.
    emit(request({ requestId: 'req-2' }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    status('crashed');
    expect(signal?.aborted).toBe(true);
    expect(proxy.state().active).toBe(0);
  });

  test('proxy-sends-the-checked-body', async () => {
    const { emit, fetch, ended } = await setup({ settings: { route: 'byok-openai', modelId: 'openai/gpt-5' } });
    emit(request({ url: MODEL_REQUESTS['byok-openai'][0]!.url, body: '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":true,"store":false}' }));
    await ended();
    expect(fetch.mock.calls[0]![1].body).toBe('{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":false}');
  });

  test('proxy-abort-before-settings-load', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const { emit, fetch, sent } = await setup({ loadSettings: () => loaded });
    emit(request());
    emit({ type: 'fetch.abort', requestId: 'req-1' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test('proxy-stops-when-no-turn-runs', async () => {
    let signal: AbortSignal | undefined;
    const { emit, fetch, proxy, chats, chatEvent } = await setup({
      fetch: (_url, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      },
    });
    emit(request());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    // Another chat still runs: nothing stops.
    chats.active = ['chat-2'];
    chatEvent({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 1, output: 1 } });
    expect(signal?.aborted).toBe(false);
    chats.active = [];
    chatEvent({ type: 'chat.error', chatId: 'chat-2', message: 'x' });
    expect(signal?.aborted).toBe(true);
    expect(proxy.state().active).toBe(0);
  });

  test('proxy-refusals-strike-and-coalesce', async () => {
    let at = 0;
    const { emit, of, log, strike } = await setup({ now: () => at });
    for (let i = 0; i < 10; i += 1) emit(request({ requestId: `e${i}`, url: 'https://evil.example/' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(10));
    expect(strike).toHaveBeenCalledTimes(10);
    expect(log.mock.calls).toEqual([['agent proxy: refused a model request (endpoint)']]);
    at = AGENT_PROXY_LIMITS.logWindowMs;
    emit(request({ requestId: 'late', url: 'https://evil.example/' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(11));
    expect(log.mock.calls.at(-1)).toEqual(['agent proxy: refused a model request (endpoint) (and 9 more like it before)']);
  });

  test('proxy-strikes-only-the-runtimes-refusals', async () => {
    // Main's side or upstream: no key, a redirect, the route or model just switched.
    const noKey = await setup({ key: false });
    noKey.emit(request());
    await noKey.ended();
    const redirect = await setup({ fetch: () => Promise.reject(new Error("Attempted to redirect, but redirect policy was 'error'")) });
    redirect.emit(request());
    await redirect.ended();
    const switched = await setup({ settings: { route: 'gateway', modelId: 'anthropic/claude-sonnet-5-5' } });
    switched.emit(request());
    await switched.ended();
    const model = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-opus-5-5' } });
    model.emit(request());
    await model.ended();
    for (const run of [noKey, redirect, switched, model]) {
      expect(run.of('fetch.error')[0]?.code).toBe('refused');
      expect(run.strike).not.toHaveBeenCalled();
    }
    expect([noKey, redirect, switched, model].map((run) => run.proxy.state().lastRefusal)).toEqual(['no-key', 'redirect', 'endpoint', 'model']);
    // The runtime's own doing: an endpoint no route has, a server tool.
    const runtime = await setup();
    runtime.emit(request({ requestId: 'a', url: 'https://evil.example/v1/messages' }));
    runtime.emit(request({ requestId: 'b', body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [], tools: [{ name: 'web_search', type: 'web_search_20250305' }] }) }));
    await vi.waitFor(() => expect(runtime.of('fetch.error').length).toBe(2));
    expect(runtime.strike).toHaveBeenCalledTimes(2);
  });

  test('proxy-refusal-logged-without-detail', async () => {
    const { emit, of, log } = await setup();
    emit(request({ url: 'https://evil.example/collect?token=abc123', headers: [['x-secret', 'shh']], body: '{"secret":"body"}' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(1));
    expect(log.mock.calls).toEqual([['agent proxy: refused a model request (endpoint)']]);
  });

  test('proxy-reasoning-change-mid-turn-is-not-the-runtimes-fault', async () => {
    const s = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' } });
    // A turn runs on High.
    expect(await s.run('a', { body: anthropicBody('high') })).toBe('sent');
    // The user switches High → Low: the turn's next step still carries High, and is sent, uncounted.
    s.switchTo({ route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'low' });
    expect(await s.run('b', { body: anthropicBody('high') })).toBe('sent');
    expect(JSON.parse(s.fetch.mock.calls.at(-1)![1].body)).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    // Low is already the settings': a body with it is sent too.
    expect(await s.run('c', { body: anthropicBody('low') })).toBe('sent');
    expect(s.strike).not.toHaveBeenCalled();
    // The next turn must carry Low: High is refused (`reasoning`) and counted.
    turnEnds(s);
    expect(await s.run('d', { body: anthropicBody('high') })).toBe('reasoning');
    expect(s.strike).toHaveBeenCalledTimes(1);
    expect(await s.run('e', { body: anthropicBody('low') })).toBe('sent');
    expect(s.fetch).toHaveBeenCalledTimes(4);
  });

  test('proxy-reasoning-matching-neither-refused', async () => {
    const s = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' } });
    s.switchTo({ route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'low' });
    // Neither the turn's level (High) nor the new one (Low): the runtime's fault.
    expect(await s.run('a', { body: anthropicBody('medium') })).toBe('reasoning');
    expect(await s.run('b', { body: anthropicBody('auto') })).toBe('reasoning');
    expect(s.strike).toHaveBeenCalledTimes(2);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.log).toHaveBeenCalledWith('agent proxy: refused a model request (reasoning)');
    // With no change at all, any level but the settings' is refused and counted.
    const still = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'medium' } });
    expect(await still.run('a', { body: anthropicBody('high') })).toBe('reasoning');
    expect(await still.run('b', { body: anthropicBody('auto') })).toBe('reasoning');
    expect(await still.run('c', { body: anthropicBody('medium') })).toBe('sent');
    expect(still.strike).toHaveBeenCalledTimes(2);
  });

  test('proxy-model-change-mid-turn-unchanged', async () => {
    const s = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' } });
    // The model changes too (and the level): a body made for the turn's model is today's `model`, not counted.
    s.switchTo({ route: 'byok-anthropic', modelId: 'anthropic/claude-opus-5-5', reasoningEffort: 'low' });
    expect(await s.run('a', { body: anthropicBody('high') })).toBe('model');
    expect(await s.run('b', { body: anthropicBody('low') })).toBe('model');
    expect(s.strike).not.toHaveBeenCalled();
    // The new model with the turn's level is not a previous-settings body: refused `reasoning`, counted.
    expect(await s.run('c', { body: anthropicBody('high', 'claude-opus-5-5') })).toBe('reasoning');
    expect(s.strike).toHaveBeenCalledTimes(1);
    expect(await s.run('d', { body: anthropicBody('low', 'claude-opus-5-5') })).toBe('sent');
    // A route change likewise.
    const routed = await setup({ settings: { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' } });
    routed.switchTo({ route: 'gateway', modelId: 'anthropic/claude-sonnet-5-5', reasoningEffort: 'high' });
    expect(await routed.run('a', { body: anthropicBody('high') })).toBe('endpoint');
    expect(routed.strike).not.toHaveBeenCalled();
  });

  test('proxy-unsupported-stored-effort-acts-as-auto', async () => {
    // A model that offers Auto only (Grok): a stored High sends nothing.
    for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider('spacexai'))) {
      expect(MODEL_REASONING_SUPPORT[modelId]).toEqual(['auto']);
      const s = await setup({ settings: { route: 'gateway', modelId, reasoningEffort: 'high' } });
      expect(await s.run('a', gatewayRequest(modelId)), modelId).toBe('sent');
      expect(await s.run('b', gatewayRequest(modelId, { openai: { store: false, reasoningEffort: 'high' } })), modelId).toBe('reasoning');
      // The same for the settings the turn began on: High → Low on that model, both act as Auto.
      s.switchTo({ route: 'gateway', modelId, reasoningEffort: 'low' });
      expect(await s.run('c', gatewayRequest(modelId)), modelId).toBe('sent');
      expect(await s.run('d', gatewayRequest(modelId, { openai: { store: false, reasoningEffort: 'high' } })), modelId).toBe('reasoning');
      expect(s.strike).toHaveBeenCalledTimes(2);
    }
    // A Gemini model without Medium: a stored Medium sends nothing.
    for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider('google')).filter((id) => !MODEL_REASONING_SUPPORT[id].includes('medium'))) {
      const s = await setup({ settings: { route: 'gateway', modelId, reasoningEffort: 'medium' } });
      expect(await s.run('a', gatewayRequest(modelId)), modelId).toBe('sent');
      expect(await s.run('b', gatewayRequest(modelId, { google: { thinkingConfig: { thinkingLevel: 'medium' } } })), modelId).toBe('reasoning');
      // Previous High (offered) → current Medium (Auto there): a High body from the turn is still sent.
      const p = await setup({ settings: { route: 'gateway', modelId, reasoningEffort: 'high' } });
      p.switchTo({ route: 'gateway', modelId, reasoningEffort: 'medium' });
      expect(await p.run('a', gatewayRequest(modelId, { google: { thinkingConfig: { thinkingLevel: 'high' } } })), modelId).toBe('sent');
      expect(await p.run('b', gatewayRequest(modelId)), modelId).toBe('sent');
      expect(await p.run('c', gatewayRequest(modelId, { google: { thinkingConfig: { thinkingLevel: 'medium' } } })), modelId).toBe('reasoning');
    }
    // A ChatGPT model the account advertises no level for: Auto only.
    const MODEL = 'chatgpt/gpt-6.1-sol' as const;
    const chatgpt: ModelProxyChatgpt = { withAccessToken: async (fn) => ({ ok: true, value: await fn('access-token') }), report: () => undefined };
    const chatgptRequest = (reasoning?: object): Partial<FetchRequest> => ({
      url: MODEL_REQUESTS.chatgpt[0]!.url,
      headers: [['user-agent', 'ai-sdk-openai/4.0.104']],
      body: JSON.stringify({
        model: 'gpt-6.1-sol',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
        store: false,
        stream: true,
        tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description, tools: [] }],
        ...(reasoning === undefined ? {} : { reasoning }),
      }),
    });
    const unadvertised = await setup({ settings: { route: 'chatgpt', modelId: MODEL, reasoningEffort: 'high' }, chatgptModels: [{ id: MODEL, label: 'Sol' }], chatgpt });
    expect(await unadvertised.run('a', chatgptRequest())).toBe('sent');
    expect(await unadvertised.run('b', chatgptRequest({ effort: 'high' }))).toBe('reasoning');
    unadvertised.switchTo({ route: 'chatgpt', modelId: MODEL, reasoningEffort: 'low' });
    expect(await unadvertised.run('c', chatgptRequest())).toBe('sent');
    expect(await unadvertised.run('d', chatgptRequest({ effort: 'high' }))).toBe('reasoning');
    // Advertised: the level is the settings'.
    const advertised = await setup({ settings: { route: 'chatgpt', modelId: MODEL, reasoningEffort: 'high' }, chatgptModels: [{ id: MODEL, label: 'Sol', efforts: ['low', 'high'] }], chatgpt });
    expect(await advertised.run('a', chatgptRequest({ effort: 'high', summary: 'detailed' }))).toBe('sent');
    expect(await advertised.run('b', chatgptRequest())).toBe('reasoning');
  });
});
