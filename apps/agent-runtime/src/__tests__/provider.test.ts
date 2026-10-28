// Spec: specs/agent-tools.spec.ts (MODEL_REQUESTS, isAllowedModelRequest, routeModelId) · Acceptance:
// specs/agent-runtime.feature.md (Providers). Proves the installed providers' endpoint paths are the
// ones main's proxy allows: each model's request is captured by the proxied fetch, never sent.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { ALLOWED_MODEL_IDS, isAllowedModelRequest, MODEL_REQUESTS, MODEL_ROUTES, routeModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { createModel, ModelNotAllowedError, PLACEHOLDER_API_KEY } from '../provider';
import { CREDENTIAL_HEADERS, createProxyFetch } from '../proxy-fetch';
import { chatStart, startHarness, stubNetworkGlobals } from './harness';

const MODEL_FOR_ROUTE: Record<ModelRoute, (typeof ALLOWED_MODEL_IDS)[number]> = {
  'byok-anthropic': 'anthropic/claude-sonnet-5-5',
  'byok-openai': 'openai/gpt-5',
  gateway: 'anthropic/claude-sonnet-5-5',
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

  test('provider-refuses-other-models', () => {
    const fetch = createProxyFetch(() => true).fetch;
    expect(() => createModel('byok-anthropic', 'openai/gpt-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-openai', 'anthropic/claude-opus-5-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('gateway', 'mistral/large', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-anthropic', 'claude-sonnet-5-5', fetch)).toThrow(ModelNotAllowedError);
  });
});
