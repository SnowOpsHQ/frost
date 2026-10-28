// Spec: specs/agent-proxy.spec.ts (AGENT_PROXY_LIMITS, PROXY_REFUSALS) · specs/agent-tools.spec.ts (MODEL_REQUESTS,
// isAllowedModelRequest) · specs/agent-protocol.schema.ts (AGENT_PROTOCOL_LIMITS)
// Acceptance: specs/agent-host.feature.md (Model proxy)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_LIMITS, MainToRuntimeMessageSchema, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_PROXY_LIMITS, type AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { MODEL_REQUESTS } from '@app/specs/agent-tools.spec';
import { createCredentialStore } from '../credentials';
import type { AgentChatEvent, AgentFetchEvent, AgentHostStatus } from '../host';
import { createModelProxy, type ProxyFetchFunction, type ProxyRequestInit } from '../model-proxy';
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

async function setup(options: { settings?: AgentModelSettings; fetch?: ProxyFetchFunction; key?: boolean; limits?: Partial<typeof AGENT_PROXY_LIMITS>; loadSettings?: () => Promise<void>; now?: () => number } = {}) {
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
  const settings = { current: () => options.settings ?? { route: 'byok-anthropic' as const, modelId: 'anthropic/claude-sonnet-5-5' as const }, load: options.loadSettings ?? (async () => undefined) };
  const fetch = vi.fn<ProxyFetchFunction>(
    options.fetch ??
      (async () =>
        new Response(streamOf([sse('event: message_start\ndata: {}\n\n')]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'set-cookie': 'sid=2', 'request-id': 'req_9', 'anthropic-organization-id': 'org-1' },
        })),
  );
  const log = vi.fn<(line: string) => void>();
  const proxy = createModelProxy({ host, credentials, settings, fetch, log, ...(options.limits ? { limits: options.limits } : {}), ...(options.now ? { now: options.now } : {}) });
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
  return { proxy, sent, fetch, log, emit, status, of, ended, strike, chats, chatEvent };
}

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

  test('proxy-refusal-logged-without-detail', async () => {
    const { emit, of, log } = await setup();
    emit(request({ url: 'https://evil.example/collect?token=abc123', headers: [['x-secret', 'shh']], body: '{"secret":"body"}' }));
    await vi.waitFor(() => expect(of('fetch.error').length).toBe(1));
    expect(log.mock.calls).toEqual([['agent proxy: refused a model request (endpoint)']]);
  });
});
