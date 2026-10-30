// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_ENDPOINTS, CHATGPT_ERROR_CODE_REASONS, chatgptAnswerFailure,
// chatgptStreamFailure, CHATGPT_DETAIL_STATUS_REASONS, CHATGPT_LIMITS.maxErrorBodyBytes), specs/agent-proxy.spec.ts
// (REQUEST_HEADER_ALLOWLIST.chatgpt, mainRequestHeaders, checkModelRequestBody, PROXY_REFUSALS 'plan-paused'),
// specs/agent-tools.spec.ts (MODEL_REQUESTS.chatgpt)
// Acceptance: specs/agent-chatgpt.feature.md (Through the proxy) · plan docs/plans/agent-chatgpt-plan.md, Task 3
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ENDPOINTS, CHATGPT_SCOPE, CHATGPT_TOOL_NAMESPACE, type ChatgptFailure, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { MainToRuntimeMessageSchema, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import type { AgentModelSettings } from '@app/specs/agent-proxy.spec';
import { createCredentialStore } from '../credentials';
import type { AgentChatEvent, AgentFetchEvent } from '../host';
import { createModelProxy, type ModelProxyChatgpt, type ProxyFetchFunction, type ProxyRequestInit } from '../model-proxy';
import { createAgentSettings } from '../settings';
import { createHarness } from '../chatgpt/__tests__/harness';
import { createFakeSafeStorage, createMemoryFs, streamOf } from './fakes';

const MODEL = 'chatgpt/gpt-5' as const;
const LISTED: readonly ChatgptModelView[] = [{ id: MODEL, label: 'GPT-5' }];
const OPENAI_KEY = 'sk-openai-key-0123456789';
const URL_ = CHATGPT_ENDPOINTS.responses;

type FetchRequest = Extract<AgentFetchEvent, { type: 'fetch.request' }>;

/** A body the runtime sends on the route (Task 4): store off, streaming, tools in the `frost` namespace. */
const chatgptBody = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: 'gpt-5',
    input: [{ role: 'developer', content: 'You are frost.' }, { role: 'user', content: [{ type: 'input_text', text: 'Audit this page' }] }],
    store: false,
    stream: true,
    tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description, tools: [{ type: 'function', name: 'page_audit', description: 'Read', parameters: { type: 'object' }, strict: false }] }],
    ...changes,
  });
/** What the runtime sends on `byok-openai` for `openai/gpt-5` (same URL, same slug). */
const byokBody = JSON.stringify({ model: 'gpt-5', max_output_tokens: 1024, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], store: false, stream: true });

const request = (overrides: Partial<FetchRequest> = {}): FetchRequest => ({
  type: 'fetch.request',
  requestId: 'req-1',
  url: URL_,
  method: 'POST',
  headers: [
    ['authorization', 'Bearer frost-placeholder-key'],
    ['openai-organization', 'org-1'],
    ['openai-project', 'proj-1'],
    ['content-type', 'application/json'],
    ['user-agent', 'ai-sdk-openai/4.0.104'],
    ['cookie', 'sid=1'],
  ],
  body: chatgptBody(),
  ...overrides,
});

const sse = (events: readonly unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
const json = (status: number, value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'req_9', ...headers } });
const okStream = () => new Response(streamOf([sse([{ type: 'response.created' }, { type: 'response.completed' }])]), { status: 200, headers: { 'content-type': 'text/event-stream' } });

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.auth.dispose();
    await h.close();
  }
});

async function setup(options: { settings?: AgentModelSettings; models?: readonly ChatgptModelView[]; fetch?: ProxyFetchFunction; signIn?: boolean; scope?: string; chatgpt?: Partial<ModelProxyChatgpt> } = {}) {
  const h = createHarness();
  harnesses.push(h);
  if (options.scope !== undefined) h.server.scope = options.scope;
  if (options.signIn !== false) expect((await h.signIn()).state).toBe('signed-in');
  const sent: MainToRuntimeMessage[] = [];
  const fetchListeners: ((event: AgentFetchEvent) => void)[] = [];
  const chatListeners: ((event: AgentChatEvent) => void)[] = [];
  const settingsListeners: ((settings: AgentModelSettings, previous: AgentModelSettings) => void)[] = [];
  const chats = { active: ['chat-1'] as string[] };
  const strike = vi.fn();
  const host = {
    strike,
    activeChats: () => chats.active,
    onChat: (listener: (event: AgentChatEvent) => void) => (chatListeners.push(listener), () => undefined),
    send: (message: MainToRuntimeMessage) => {
      expect(MainToRuntimeMessageSchema.safeParse(message).success, JSON.stringify(message).slice(0, 200)).toBe(true);
      sent.push(message);
      return true;
    },
    onFetch: (listener: (event: AgentFetchEvent) => void) => (fetchListeners.push(listener), () => undefined),
    onStatus: () => () => undefined,
  };
  const memory = createMemoryFs();
  const credentials = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: '/u/agent-credentials.json', fs: memory.fs, platform: 'darwin' });
  await credentials.setKey('openai', OPENAI_KEY);
  let current: AgentModelSettings = options.settings ?? { route: 'chatgpt', modelId: MODEL };
  const settings = {
    current: () => current,
    load: async () => undefined,
    onChange: (listener: (settings: AgentModelSettings, previous: AgentModelSettings) => void) => (settingsListeners.push(listener), () => undefined),
    chatgptModels: () => options.models ?? LISTED,
  };
  const switchTo = (next: AgentModelSettings) => {
    const previous = current;
    current = next;
    for (const listener of settingsListeners) listener(next, previous);
  };
  const fetch = vi.fn<ProxyFetchFunction>(options.fetch ?? (async () => okStream()));
  const reported: ChatgptFailure[] = [];
  const log = vi.fn<(line: string) => void>();
  const proxy = createModelProxy({ host, credentials, settings, fetch, log, chatgpt: { withAccessToken: (fn, opts) => h.auth.withAccessToken(fn, opts), report: (failure) => void reported.push(failure), ...options.chatgpt } });
  const emit = (event: AgentFetchEvent) => {
    for (const listener of fetchListeners) listener(event);
  };
  const chatEvent = (event: AgentChatEvent) => {
    for (const listener of chatListeners) listener(event);
  };
  const of = <T extends MainToRuntimeMessage['type']>(type: T) => sent.filter((message): message is Extract<MainToRuntimeMessage, { type: T }> => message.type === type);
  const ended = (requestId = 'req-1') => vi.waitFor(() => expect(sent.some((message) => 'requestId' in message && message.requestId === requestId && (message.type === 'fetch.end' || message.type === 'fetch.error'))).toBe(true));
  /** Every text the runtime and the log could see. */
  const outward = () => JSON.stringify([sent.map((message) => (message.type === 'fetch.chunk' ? new TextDecoder().decode(message.bytes) : message)), log.mock.calls, reported]);
  return { h, proxy, sent, fetch, log, emit, of, ended, strike, chats, chatEvent, switchTo, reported, outward };
}

describe('model proxy: the ChatGPT plan route', () => {
  test('chatgpt-proxy-token-injection (Bearer only, no organisation or project, no redirect)', async () => {
    const s = await setup();
    s.emit(request());
    await s.ended();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetch.mock.calls[0]! as [string, ProxyRequestInit];
    expect(url).toBe(CHATGPT_ENDPOINTS.responses);
    expect(init.headers).toEqual([
      ['user-agent', 'ai-sdk-openai/4.0.104'],
      ['content-type', 'application/json'],
      ['authorization', 'Bearer access-token-1'],
    ]);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(JSON.parse(init.body)).toMatchObject({ store: false, stream: true });
    expect(s.of('fetch.response-start')[0]).toMatchObject({ status: 200 });
    expect(s.of('fetch.chunk').length).toBeGreaterThan(0);
    // The access token (and the OpenAI key on the other route) appears nowhere the runtime or a log can see.
    expect(s.outward()).not.toContain('access-token');
    expect(s.outward()).not.toContain(OPENAI_KEY);
    expect(s.reported).toEqual([]);
    expect(s.proxy.state()).toMatchObject({ key: 'set', lastRefusal: null });
  });

  test('chatgpt-proxy-redirect-refused', async () => {
    const s = await setup({ fetch: async () => Promise.reject(new Error("Attempted to redirect, but redirect policy was 'error'")) });
    s.emit(request());
    await s.ended();
    expect(s.of('fetch.error')[0]).toMatchObject({ code: 'refused' });
    expect(s.proxy.state().lastRefusal).toBe('redirect');
    expect(s.strike).not.toHaveBeenCalled();
  });

  test('chatgpt-proxy-401-refresh-retry (refreshed once, retried once)', async () => {
    const statuses = [401, 200];
    const s = await setup({ fetch: async () => (statuses.shift() === 401 ? json(401, { error: { code: 'invalid_api_key', message: 'Bearer access-token-1 refused' } }) : okStream()) });
    s.emit(request());
    await s.ended();
    expect(s.fetch.mock.calls.map(([, init]) => (init.headers as [string, string][]).find(([name]) => name === 'authorization')![1])).toEqual(['Bearer access-token-1', 'Bearer access-token-2']);
    expect(s.h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.token).map((r) => r.form!.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    // The runtime sees only the retry's answer.
    expect(s.of('fetch.response-start').map((message) => message.status)).toEqual([200]);
    expect(s.outward()).not.toContain('access-token');

    // Two 401s: no third request, no second refresh; the runtime gets the 401 (no body).
    const twice = await setup({ fetch: async () => json(401, { error: { code: 'invalid_api_key', message: 'no' } }) });
    twice.emit(request());
    await twice.ended();
    expect(twice.fetch).toHaveBeenCalledTimes(2);
    expect(twice.h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.token)).toHaveLength(2);
    expect(twice.of('fetch.response-start').map((message) => message.status)).toEqual([401]);
    expect(twice.of('fetch.chunk')).toEqual([]);
    expect(twice.reported).toEqual([]);
  });

  test('chatgpt-proxy-401-refresh-refused (the sign-in ended: signed-out)', async () => {
    const s = await setup({ fetch: async () => json(401, { error: { code: 'invalid_api_key' } }) });
    s.h.server.token = () => s.h.json(400, { error: 'invalid_grant' });
    s.emit(request());
    await s.ended();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.of('fetch.error')[0]).toMatchObject({ code: 'refused' });
    expect(s.reported).toEqual([{ reason: 'signed-out' }]);
    expect(s.h.auth.view().state).toBe('expired');
    expect(s.strike).not.toHaveBeenCalled();
  });

  test.each([
    ['subscription_sharing_usage_limit_exceeded', 429, { reason: 'usage-limit' }],
    ['subscription_sharing_usage_unavailable', 503, { reason: 'plan-unavailable' }],
    ['subscription_sharing_user_unavailable', 503, { reason: 'plan-unavailable' }],
    ['subscription_sharing_user_not_eligible', 403, { reason: 'not-eligible' }],
    ['chatpass_v2_scope_not_authorized', 403, { reason: 'plan-usage-off' }],
    ['chatpass_v2_invalid_authorization_context', 403, { reason: 'plan-usage-off' }],
    ['subscription_sharing_unsupported_capability', 400, { reason: 'unsupported', param: 'tools[0].tools[0].strict' }],
    ['subscription_sharing_route_not_supported', 403, { reason: 'unsupported', param: 'tools[0].tools[0].strict' }],
  ] as const)('chatgpt-proxy-error-codes (%s)', async (code, status, failure) => {
    const s = await setup({ fetch: async () => json(status, { error: { code, param: 'tools[0].tools[0].strict', message: 'secret account detail ada@example.com', type: 'invalid_request_error' } }, { 'retry-after': '3' }) });
    s.emit(request());
    await s.ended();
    expect(s.reported).toEqual([failure]);
    // The runtime gets the status and the allowlisted headers, never the body.
    expect(s.sent).toEqual([
      { type: 'fetch.response-start', requestId: 'req-1', status, statusText: '', headers: [['content-type', 'application/json'], ['retry-after', '3'], ['x-request-id', 'req_9']] },
      { type: 'fetch.end', requestId: 'req-1' },
    ]);
    expect(s.outward()).not.toContain('secret account detail');
    expect(s.log).toHaveBeenCalledWith(`agent proxy: the ChatGPT plan refused a request (${failure.reason})`);
    expect(s.strike).not.toHaveBeenCalled();
  });

  test.each([
    [403, 'not-eligible'],
    [503, 'plan-unavailable'],
    [401, 'plan-usage-off'],
  ] as const)('chatgpt-proxy-error-codes (direct admission %i { detail })', async (status, reason) => {
    const s = await setup({ fetch: async () => json(status, { detail: 'Region blocked for ada@example.com' }) });
    s.emit(request());
    await s.ended();
    expect(s.reported).toEqual([{ reason }]);
    expect(s.outward()).not.toContain('ada@example.com');
    // A 401 is retried once with a refreshed token first.
    expect(s.fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
  });

  test('chatgpt-proxy-error-codes (an oversized or unparsable error body is an ordinary failure)', async () => {
    const big = await setup({ fetch: async () => new Response(`{"error":{"code":"subscription_sharing_usage_limit_exceeded","pad":"${'x'.repeat(20_000)}"}}`, { status: 429 }) });
    big.emit(request());
    await big.ended();
    expect(big.reported).toEqual([]);
    expect(big.of('fetch.response-start')[0]).toMatchObject({ status: 429 });
    const garbled = await setup({ fetch: async () => new Response('<html>busy</html>', { status: 503 }) });
    garbled.emit(request());
    await garbled.ended();
    expect(garbled.reported).toEqual([]);
  });

  test('chatgpt-proxy-stream-failure (a response.failed after streaming began)', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.failed', response: { id: 'resp_1', status: 'failed', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
    ];
    const bytes = sse(events);
    // Split mid-event, so the scanner sees it across chunks.
    const s = await setup({ fetch: async () => new Response(streamOf([bytes.slice(0, 70), bytes.slice(70)]), { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
    s.emit(request());
    await s.ended();
    expect(s.reported).toEqual([{ reason: 'usage-limit' }]);
    // The stream itself reaches the runtime unchanged (the provider reports the failure too).
    expect(new TextDecoder().decode(Buffer.concat(s.of('fetch.chunk').map((chunk) => chunk.bytes)))).toBe(new TextDecoder().decode(bytes));
    expect(s.of('fetch.end')).toHaveLength(1);
  });

  test('chatgpt-proxy-plan-paused (no request on the plan again until the turn ends)', async () => {
    const s = await setup({ fetch: async () => json(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } }) });
    s.emit(request());
    await s.ended();
    // The SDK's retry: refused here, not sent.
    s.emit(request({ requestId: 'req-2' }));
    await s.ended('req-2');
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.of('fetch.error')[0]).toMatchObject({ requestId: 'req-2', code: 'refused' });
    expect(s.proxy.state().lastRefusal).toBe('plan-paused');
    expect(s.strike).not.toHaveBeenCalled();
    // The turn ends: the next turn may ask again.
    s.chats.active = [];
    s.chatEvent({ type: 'chat.error', chatId: 'chat-1', message: 'x' });
    s.chats.active = ['chat-2'];
    s.emit(request({ requestId: 'req-3' }));
    await s.ended('req-3');
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  test('chatgpt-proxy-signed-out and plan usage off (no request, the reason reported)', async () => {
    const out = await setup({ signIn: false });
    out.emit(request());
    await out.ended();
    expect(out.fetch).not.toHaveBeenCalled();
    expect(out.reported).toEqual([{ reason: 'signed-out' }]);
    expect(out.proxy.state()).toMatchObject({ key: 'no-key', lastRefusal: 'no-key' });
    expect(out.strike).not.toHaveBeenCalled();
    const off = await setup({ scope: 'openid profile email offline_access' });
    off.emit(request());
    await off.ended();
    expect(off.fetch).not.toHaveBeenCalled();
    expect(off.reported).toEqual([{ reason: 'plan-usage-off' }]);
    expect(CHATGPT_SCOPE).toContain('chatgpt.tokens.use.direct');
  });

  test('chatgpt-proxy-model-listed (a ChatGPT model the last list lacks is refused)', async () => {
    const s = await setup({ models: [{ id: 'chatgpt/gpt-6', label: 'GPT-6' }] });
    s.emit(request());
    await s.ended();
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.proxy.state().lastRefusal).toBe('model');
    expect(s.strike).not.toHaveBeenCalled();
  });

  test('chatgpt-proxy-route-switch-mid-turn (same URL, same slug: refused as the old route, no strike)', async () => {
    // From the plan to the user's own OpenAI key while a turn runs: its next plan-shaped request is not sent with the key.
    const toKey = await setup();
    toKey.switchTo({ route: 'byok-openai', modelId: 'openai/gpt-5' });
    toKey.emit(request());
    await toKey.ended();
    expect(toKey.fetch).not.toHaveBeenCalled();
    expect(toKey.proxy.state().lastRefusal).toBe('model');
    expect(toKey.strike).not.toHaveBeenCalled();
    // From the key to the plan: the key-shaped request (with its output cap) is not sent with the token.
    const toPlan = await setup({ settings: { route: 'byok-openai', modelId: 'openai/gpt-5' } });
    toPlan.switchTo({ route: 'chatgpt', modelId: MODEL });
    toPlan.emit(request({ body: byokBody }));
    await toPlan.ended();
    expect(toPlan.fetch).not.toHaveBeenCalled();
    expect(toPlan.proxy.state().lastRefusal).toBe('model');
    expect(toPlan.strike).not.toHaveBeenCalled();
    // Once no turn runs, the old route is forgotten: the same request is the runtime's fault.
    toPlan.chats.active = [];
    toPlan.chatEvent({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: null, output: null } });
    toPlan.chats.active = ['chat-2'];
    toPlan.emit(request({ requestId: 'req-2', body: byokBody }));
    await toPlan.ended('req-2');
    expect(toPlan.proxy.state().lastRefusal).toBe('body-field');
    expect(toPlan.strike).toHaveBeenCalledTimes(1);
    // And a plan request after the switch back goes out with the token, not the key.
    const back = await setup({ settings: { route: 'byok-openai', modelId: 'openai/gpt-5' } });
    back.switchTo({ route: 'chatgpt', modelId: MODEL });
    back.emit(request());
    await back.ended();
    expect((back.fetch.mock.calls[0]![1].headers as [string, string][]).at(-1)).toEqual(['authorization', 'Bearer access-token-1']);
  });

  test('chatgpt-proxy-route-switch-mid-turn (the turn\'s route is the loaded settings\', not the defaults)', async () => {
    // The proxy is made before the settings file is read (as `createAgent` does); the stored route is
    // the user's OpenAI key. A switch to the plan mid-turn must remember that route, not the gateway default.
    const memory = createMemoryFs();
    const file = '/user-data/agent-settings.json';
    await memory.fs.writeFile(file, JSON.stringify({ route: 'byok-openai', modelId: 'openai/gpt-5', chatgptModels: LISTED }), { mode: 0o600, flag: 'wx', flush: true });
    const settings = createAgentSettings({ file, fs: memory.fs });
    const h = createHarness();
    harnesses.push(h);
    expect((await h.signIn()).state).toBe('signed-in');
    const sent: MainToRuntimeMessage[] = [];
    let onFetch: ((event: AgentFetchEvent) => void) | null = null;
    const strike = vi.fn();
    const fetch = vi.fn<ProxyFetchFunction>(async () => okStream());
    const credentials = createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: '/u/agent-credentials.json', fs: createMemoryFs().fs, platform: 'darwin' });
    await credentials.setKey('openai', OPENAI_KEY);
    const proxy = createModelProxy({
      host: { strike, activeChats: () => ['chat-1'], onChat: () => () => undefined, onStatus: () => () => undefined, onFetch: (listener) => ((onFetch = listener), () => undefined), send: (message) => (sent.push(message), true) },
      credentials,
      settings,
      fetch,
      chatgpt: { withAccessToken: (fn, opts) => h.auth.withAccessToken(fn, opts), report: () => undefined },
    });
    await settings.load();
    expect(settings.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5' });
    expect(await settings.set({ route: 'chatgpt', modelId: MODEL })).toBe(true);
    onFetch!(request({ body: byokBody }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'fetch.error', code: 'refused' });
    // Made for the route the turn began on: `model`, no strike (not `body-field` against the runtime).
    expect(proxy.state().lastRefusal).toBe('model');
    expect(strike).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    proxy.dispose();
  });

  test('chatgpt-proxy-plan-paused (a token failure after the turn ended does not pause the next turn)', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const s = await setup({
      chatgpt: {
        withAccessToken: async (fn, opts) => {
          calls++;
          if (calls > 1) return s.h.auth.withAccessToken(fn, opts);
          // The first request's token: a refresh that hangs, then is refused (the sign-in ended).
          await new Promise<void>((resolve) => (release = resolve));
          return { ok: false, reason: 'expired' };
        },
      },
    });
    s.emit(request());
    await vi.waitFor(() => expect(release).not.toBeNull());
    // The turn ends (the user stopped it): the request is settled, the plan unpaused.
    s.chats.active = [];
    s.chatEvent({ type: 'chat.error', chatId: 'chat-1', message: 'stopped' });
    release!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The late failure is not reported for a turn that is over, and pauses nothing.
    expect(s.reported).toEqual([]);
    s.chats.active = ['chat-2'];
    s.emit(request({ requestId: 'req-2' }));
    await s.ended('req-2');
    expect(s.proxy.state().lastRefusal).not.toBe('plan-paused');
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  test('chatgpt-proxy-plan-paused (cleared when the ChatGPT account changes)', async () => {
    const accountListeners: (() => void)[] = [];
    const s = await setup({
      fetch: async () => json(403, { error: { code: 'chatpass_v2_scope_not_authorized' } }),
      chatgpt: { onAccountChange: (listener) => (accountListeners.push(listener), () => undefined) },
    });
    s.emit(request());
    await s.ended();
    expect(s.reported).toEqual([{ reason: 'plan-usage-off' }]);
    s.emit(request({ requestId: 'req-2' }));
    await s.ended('req-2');
    expect(s.proxy.state().lastRefusal).toBe('plan-paused');
    // The user turned plan usage on (re-consent) while the turn runs: the plan is asked again.
    for (const listener of accountListeners) listener();
    s.emit(request({ requestId: 'req-3' }));
    await s.ended('req-3');
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  test('chatgpt-proxy-401-refresh-retry (not retried when the first attempt already ended)', async () => {
    let answer: ((response: Response) => void) | null = null;
    const s = await setup({ fetch: () => new Promise<Response>((resolve) => (answer = resolve)) });
    s.emit(request());
    await vi.waitFor(() => expect(answer).not.toBeNull());
    // The runtime gave up on the request (an abort; a timeout ends it the same way) before the 401 arrived.
    s.emit({ type: 'fetch.abort', requestId: 'req-1' });
    answer!(json(401, { error: { code: 'invalid_api_key' } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.token).map((r) => r.form!.get('grant_type'))).toEqual(['authorization_code']);
    expect(s.sent).toEqual([]);
  });

  test('chatgpt-proxy-no-service (without the ChatGPT service the route has no credential)', async () => {
    const sent: MainToRuntimeMessage[] = [];
    let listener: ((event: AgentFetchEvent) => void) | null = null;
    const fetch = vi.fn<ProxyFetchFunction>();
    const memory = createMemoryFs();
    createModelProxy({
      host: { strike: vi.fn(), activeChats: () => ['c'], onChat: () => () => undefined, onStatus: () => () => undefined, onFetch: (l) => ((listener = l), () => undefined), send: (m) => (sent.push(m), true) },
      credentials: createCredentialStore({ safeStorage: createFakeSafeStorage().storage, file: '/u/c.json', fs: memory.fs, platform: 'darwin' }),
      settings: { current: () => ({ route: 'chatgpt', modelId: MODEL }), load: async () => undefined, chatgptModels: () => LISTED },
      fetch,
    });
    listener!(request());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: 'fetch.error', code: 'refused' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
