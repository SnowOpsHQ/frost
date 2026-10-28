// Spec: specs/agent-tools.spec.ts (MODEL_REQUESTS, isAllowedModelRequest, routeModelId) · Acceptance:
// specs/agent-runtime.feature.md (Providers). Proves the installed providers' endpoint paths are the
// ones main's proxy allows: each model's request is captured by the proxied fetch, never sent.
import { describe, expect, test } from 'vitest';
import type { RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { ALLOWED_MODEL_IDS, isAllowedModelRequest, MODEL_REQUESTS, MODEL_ROUTES, routeModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { createModel, ModelNotAllowedError, PLACEHOLDER_API_KEY } from '../provider';
import { CREDENTIAL_HEADERS, createProxyFetch } from '../proxy-fetch';

const MODEL_FOR_ROUTE: Record<ModelRoute, string> = {
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

  test('provider-refuses-other-models', () => {
    const fetch = createProxyFetch(() => true).fetch;
    expect(() => createModel('byok-anthropic', 'openai/gpt-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-openai', 'anthropic/claude-opus-5-5', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('gateway', 'mistral/large', fetch)).toThrow(ModelNotAllowedError);
    expect(() => createModel('byok-anthropic', 'claude-sonnet-5-5', fetch)).toThrow(ModelNotAllowedError);
  });
});
