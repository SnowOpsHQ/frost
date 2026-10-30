// Spec: specs/agent-tools.spec.ts (MODEL_REQUESTS, isAllowedModelRequest, routeModelId, ALLOWED_MODEL_IDS,
// byProvider) · specs/agent-chatgpt.spec.ts (CHATGPT_TOOL_NAMESPACE, CHATGPT_FORBIDDEN_BODY_FIELDS) ·
// specs/agent-proxy.spec.ts (checkModelRequestBody, filterRequestHeaders, the gateway's `google` part
// options) · Acceptance: specs/agent-runtime.feature.md (Providers), specs/agent-chatgpt.feature.md
// (Runtime). Proves the installed providers' endpoint paths are the ones main's proxy allows: each
// model's request is captured by the proxied fetch, never sent.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { CHATGPT_FORBIDDEN_BODY_FIELDS, CHATGPT_TOOL_NAMESPACE } from '@app/specs/agent-chatgpt.spec';
import { checkModelRequestBody, filterRequestHeaders, MAX_OUTPUT_TOKENS } from '@app/specs/agent-proxy.spec';
import { ALLOWED_MODEL_IDS, byProvider, GATEWAY_ONLY_PROVIDERS, isAllowedModelRequest, MODEL_REQUESTS, MODEL_ROUTES, routeModelId, type AgentModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { createModel, ModelNotAllowedError, PLACEHOLDER_API_KEY } from '../provider';
import { CREDENTIAL_HEADERS, createProxyFetch } from '../proxy-fetch';
import { chatStart, startHarness, stubNetworkGlobals } from './harness';

const CHATGPT_MODEL = 'chatgpt/gpt-6.1-sol';
const MODEL_FOR_ROUTE: Record<ModelRoute, AgentModelId> = {
  'byok-anthropic': 'anthropic/claude-sonnet-5-5',
  'byok-openai': 'openai/gpt-5',
  gateway: 'anthropic/claude-sonnet-5-5',
  chatgpt: CHATGPT_MODEL,
};

/** Streams one request from `route`'s model and answers it `refused`; returns what was posted. */
async function capture(route: ModelRoute, modelId: string) {
  const posted: RuntimeToMainMessage[] = [];
  const proxy = createProxyFetch((message) => {
    posted.push(message);
    if (message.type === 'fetch.request') queueMicrotask(() => proxy.handle({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' }));
    return true;
  });
  const model = createModel(route, modelId, proxy.fetch);
  await expect(model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })).rejects.toBeDefined();
  const requests = posted.filter((message) => message.type === 'fetch.request');
  return requests;
}

describe('providers', () => {
  beforeEach(stubNetworkGlobals);
  afterEach(() => vi.unstubAllGlobals());

  test.each(MODEL_ROUTES)('provider-endpoints-match-allowlist (%s)', async (route) => {
    const requests = await capture(route, MODEL_FOR_ROUTE[route]);
    expect(requests.length).toBe(1);
    const request = requests[0]!;
    expect({ method: request.method, url: request.url }).toEqual(MODEL_REQUESTS[route][0]);
    expect(isAllowedModelRequest(route, request.method, request.url)).toBe(true);
    // No credential header, and the placeholder key appears nowhere.
    for (const [name, value] of request.headers) {
      expect(CREDENTIAL_HEADERS.has(name.toLowerCase())).toBe(false);
      expect(value).not.toContain(PLACEHOLDER_API_KEY);
    }
    expect(typeof request.body === 'string' ? request.body : '').not.toContain(PLACEHOLDER_API_KEY);
  });

  test('provider-endpoints-match-allowlist (every allowed model on its routes)', async () => {
    for (const route of MODEL_ROUTES) {
      for (const modelId of ALLOWED_MODEL_IDS) {
        if (routeModelId(route, modelId) === null) continue;
        const [request] = await capture(route, modelId);
        expect(isAllowedModelRequest(route, request?.method, request?.url), `${route} ${modelId}`).toBe(true);
      }
    }
  });

  test.each(MODEL_ROUTES)('provider-proxy-errors-not-retried (%s)', async (route) => {
    const h = startHarness({ modelFactory: createModel });
    h.onMessage((message) => {
      if (message.type === 'fetch.request') h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'not on the allowlist' });
    });
    h.send(chatStart({ route, modelId: MODEL_FOR_ROUTE[route] }));
    const error = await h.next('chat.error');
    expect(error.message).toBe('frost refused to send this model request.');
    expect(h.of('fetch.request').length).toBe(1);
  });

  test('provider-proxy-errors-not-retried (an HTTP 429 is retried once)', async () => {
    const h = startHarness({ modelFactory: createModel });
    let calls = 0;
    h.onMessage((message) => {
      if (message.type !== 'fetch.request') return;
      calls += 1;
      if (calls === 1) {
        h.send({ type: 'fetch.response-start', requestId: message.requestId, status: 429, statusText: 'Too Many Requests', headers: [['retry-after-ms', '1'], ['content-type', 'application/json']] });
        h.send({ type: 'fetch.chunk', requestId: message.requestId, bytes: new TextEncoder().encode('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}') });
        h.send({ type: 'fetch.end', requestId: message.requestId });
        return;
      }
      h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'enough' });
    });
    h.send(chatStart());
    await h.next('chat.error');
    expect(calls).toBe(2);
  });

  test('provider-openai-store-off', async () => {
    for (const [route, modelId] of [
      ['byok-openai', 'openai/gpt-5'],
      ['gateway', 'openai/gpt-5-mini'],
    ] as const) {
      const h = startHarness({ modelFactory: createModel });
      h.onMessage((message) => {
        if (message.type === 'fetch.request') h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
      });
      h.send(chatStart({ route, modelId }));
      const request = await h.next('fetch.request');
      expect(typeof request.body).toBe('string');
      const body = JSON.parse(request.body as string) as { store?: unknown; providerOptions?: { openai?: { store?: unknown } } };
      expect(route === 'byok-openai' ? body.store : body.providerOptions?.openai?.store, route).toBe(false);
      await h.next('chat.error');
    }
  });

  test.each(MODEL_ROUTES)('provider-output-capped (%s)', async (route) => {
    const h = startHarness({ modelFactory: createModel });
    h.onMessage((message) => {
      if (message.type === 'fetch.request') h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
    });
    h.send(chatStart({ route, modelId: MODEL_FOR_ROUTE[route] }));
    const request = await h.next('fetch.request');
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    // The ChatGPT plan takes no output cap (`max_output_tokens` is refused there): none is sent.
    if (route === 'chatgpt') expect(body).not.toHaveProperty('max_output_tokens');
    else expect(body[route === 'byok-anthropic' ? 'max_tokens' : route === 'byok-openai' ? 'max_output_tokens' : 'maxOutputTokens']).toBe(MAX_OUTPUT_TOKENS);
    await h.next('chat.error');
  });

  test('provider-refuses-other-models', () => {
    const fetch = createProxyFetch(() => true).fetch;
    expect(() => createModel('byok-anthropic', 'openai/gpt-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-openai', 'anthropic/claude-opus-5-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('gateway', 'mistral/large', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-anthropic', 'claude-sonnet-5-5', fetch)).toThrow(ModelNotAllowedError);
    // The ChatGPT route serves only `chatgpt/<slug>` ids, and a ChatGPT id no other route.
    expect(() => createModel('chatgpt', 'openai/gpt-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-openai', 'chatgpt/gpt-5', fetch)).toThrow(ModelNotAllowedError);
    // Gemini and Grok (gateway only): refused on the key routes before any request is made.
    const posted: unknown[] = [];
    const counting = createProxyFetch((message) => posted.push(message) > 0).fetch;
    for (const provider of GATEWAY_ONLY_PROVIDERS) {
      for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider(provider))) {
        for (const route of ['byok-anthropic', 'byok-openai', 'chatgpt'] as const) expect(() => createModel(route, modelId, counting), `${route} ${modelId}`).toThrow(ModelNotAllowedError);
        expect(() => createModel('gateway', modelId, counting)).not.toThrow();
      }
    }
    expect(posted).toEqual([]);
  });

  test('provider-chatgpt-request (namespaced tools, store off, streaming, no output cap, no system item)', async () => {
    const h = startHarness({ modelFactory: createModel });
    h.onMessage((message) => {
      if (message.type === 'fetch.request') h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
    });
    const mcp = { name: 'mcp__docs__search', description: 'Untrusted tool from Docs: Searches the docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
    h.send(
      chatStart({
        route: 'chatgpt',
        modelId: CHATGPT_MODEL,
        allowedTools: ['page_audit', 'page_text', mcp.name],
        mcpTools: [mcp as never],
        messages: [
          { role: 'user', content: 'Audit this page.' },
          { role: 'assistant', content: 'Reading it.', toolCalls: [{ callId: 'call-1', toolName: 'page_audit', input: {} }] },
          { role: 'tool', callId: 'call-1', toolName: 'page_audit', result: { ok: true, output: { untrusted: true, source: 'page_audit', data: { score: 80 } } } },
          { role: 'user', content: 'Go on.' },
        ],
      }),
    );
    const request = await h.next('fetch.request');
    expect({ method: request.method, url: request.url }).toEqual(MODEL_REQUESTS.chatgpt[0]);
    const text = request.body as string;
    const body = JSON.parse(text) as Record<string, unknown> & { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
    expect(body.model).toBe('gpt-6.1-sol');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    for (const field of [...CHATGPT_FORBIDDEN_BODY_FIELDS, 'max_output_tokens', 'temperature', 'top_p']) expect(body, field).not.toHaveProperty(field);
    // Every tool, frost's and MCP's, inside the one `frost` namespace; nothing outside it.
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description });
    expect((body.tools[0]!.tools as { type: string; name: string }[]).map((tool) => [tool.type, tool.name])).toEqual([
      ['function', 'page_audit'],
      ['function', 'page_text'],
      ['function', mcp.name],
    ]);
    // `input` is an array with no system item: the system prompt is a developer message.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input.some((item) => item.role === 'system')).toBe(false);
    expect(body.input[0]).toEqual({ role: 'developer', content: 'You are frost’s SEO assistant.' });
    // A function call from the history names the namespace its tool is in.
    expect(body.input.find((item) => item.type === 'function_call')).toMatchObject({ call_id: 'call-1', name: 'page_audit', namespace: 'frost' });
    // And main's rules for the route accept it as sent.
    expect(checkModelRequestBody('chatgpt', CHATGPT_MODEL, text)).toEqual({ ok: true, body: text });
    // No credential, and the placeholder key nowhere.
    for (const [name, value] of request.headers) {
      expect(CREDENTIAL_HEADERS.has(name.toLowerCase())).toBe(false);
      expect(value).not.toContain(PLACEHOLDER_API_KEY);
    }
    await h.next('chat.error');
  });

  test('provider-chatgpt-request (a namespaced call round-trips through a two-step turn)', async () => {
    const h = startHarness({ modelFactory: createModel });
    const sse = (events: readonly unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    let requests = 0;
    h.onMessage((message) => {
      if (message.type === 'tool.invoke') {
        h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: { ok: true, output: { untrusted: true, source: message.toolName, data: { score: 80 } } } });
        return;
      }
      if (message.type !== 'fetch.request') return;
      requests += 1;
      if (requests > 1) {
        h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
        return;
      }
      // The model calls `page_audit` in the `frost` namespace.
      h.send({ type: 'fetch.response-start', requestId: message.requestId, status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] });
      h.send({
        type: 'fetch.chunk',
        requestId: message.requestId,
        bytes: sse([
          { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-6.1-sol' } },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_ns', name: 'page_audit', namespace: 'frost', arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{}' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_ns', name: 'page_audit', namespace: 'frost', arguments: '{}', status: 'completed' } },
          { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 10, output_tokens: 5 } } },
        ]),
      });
      h.send({ type: 'fetch.end', requestId: message.requestId });
    });
    h.send(chatStart({ route: 'chatgpt', modelId: CHATGPT_MODEL, allowedTools: ['page_audit'] }));
    const invoke = await h.next('tool.invoke');
    expect(invoke).toMatchObject({ callId: 'call_ns', toolName: 'page_audit' });
    const second = await h.next('fetch.request', () => requests >= 2);
    const text = h.of('fetch.request')[1]!.body as string;
    const body = JSON.parse(text) as { input: Record<string, unknown>[] };
    // The call goes back with its namespace, followed by its output.
    const call = body.input.findIndex((item) => item.type === 'function_call');
    expect(body.input[call]).toMatchObject({ type: 'function_call', call_id: 'call_ns', name: 'page_audit', namespace: 'frost', arguments: '{}' });
    expect(body.input[call + 1]).toMatchObject({ type: 'function_call_output', call_id: 'call_ns' });
    expect(checkModelRequestBody('chatgpt', CHATGPT_MODEL, text)).toEqual({ ok: true, body: text });
    expect(second.url).toBe(MODEL_REQUESTS.chatgpt[0]!.url);
    await h.next('chat.error');
  });

  test('gateway-gemini-tool-turn-round-trips', async () => {
    // A Gemini step through the gateway, as its stream parts arrive (SDK-derived, Open question 3:
    // the AI SDK's Google provider puts the thought signature in the call's `providerMetadata.google`).
    const signature = 'Z2VtaW5pLXRob3VnaHQtc2lnbmF0dXJl';
    const sse = (events: readonly unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider('google'))) {
      const h = startHarness({ modelFactory: createModel });
      let requests = 0;
      h.onMessage((message) => {
        if (message.type === 'tool.invoke') {
          h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: { ok: true, output: { untrusted: true, source: message.toolName, data: { score: 80 } } } });
          return;
        }
        if (message.type !== 'fetch.request') return;
        requests += 1;
        if (requests > 1) {
          h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
          return;
        }
        h.send({ type: 'fetch.response-start', requestId: message.requestId, status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] });
        h.send({
          type: 'fetch.chunk',
          requestId: message.requestId,
          bytes: sse([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call_g1', toolName: 'page_audit', input: '{}', providerMetadata: { google: { thoughtSignature: signature } } },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'STOP' }, usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } } },
          ]),
        });
        h.send({ type: 'fetch.end', requestId: message.requestId });
      });
      h.send(chatStart({ route: 'gateway', modelId, allowedTools: ['page_audit'] }));
      expect(await h.next('tool.invoke')).toMatchObject({ callId: 'call_g1', toolName: 'page_audit' });
      await h.next('fetch.request', () => requests >= 2);
      const [first, second] = h.of('fetch.request');
      for (const request of [first!, second!]) {
        expect({ method: request.method, url: request.url }).toEqual(MODEL_REQUESTS.gateway[0]);
        expect(request.headers).toContainEqual(['ai-language-model-id', modelId]);
      }
      const text = second!.body as string;
      const body = JSON.parse(text) as { prompt: { role: string; content: Record<string, unknown>[] | string }[] };
      // The call goes back with its signature, followed by its result.
      const assistant = body.prompt.findLast((message) => message.role === 'assistant')!;
      expect(assistant.content).toContainEqual({ type: 'tool-call', toolCallId: 'call_g1', toolName: 'page_audit', input: {}, providerOptions: { google: { thoughtSignature: signature } } });
      expect(body.prompt.at(-1)).toMatchObject({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_g1', toolName: 'page_audit' }] });
      // And main's rules for the gateway accept both requests as sent.
      for (const request of [first!, second!]) {
        const sent = request.body as string;
        expect(checkModelRequestBody('gateway', modelId, sent, filterRequestHeaders('gateway', request.headers)), modelId).toEqual({ ok: true, body: sent });
      }
      await h.next('chat.error');
    }
  });

  test('provider-chatgpt-request (a refused request speaks of the sign-in, not a key)', async () => {
    for (const [route, expected] of [
      ['chatgpt', 'ChatGPT refused the request (HTTP 401). Check the ChatGPT sign-in in the agent settings.'],
      ['byok-openai', 'The model provider refused the key (HTTP 401). Check the key in the agent settings.'],
    ] as const) {
      const h = startHarness({ modelFactory: createModel });
      h.onMessage((message) => {
        if (message.type !== 'fetch.request') return;
        h.send({ type: 'fetch.response-start', requestId: message.requestId, status: 401, statusText: '', headers: [['content-type', 'application/json']] });
        h.send({ type: 'fetch.end', requestId: message.requestId });
      });
      h.send(chatStart({ route, modelId: MODEL_FOR_ROUTE[route] }));
      expect((await h.next('chat.error')).message, route).toBe(expected);
    }
  });
});
