// Spec: specs/ai-checks.spec.ts (AI_CHECK_LIMITS, AI_CHECK_ERROR_CODES) · specs/agent-protocol.schema.ts
// (check.start, check.stop, check.finish, check.error, fetch.request.checkId) · specs/agent-proxy.spec.ts
// (MAX_MODEL_REQUESTS_PER_CHECK) · Acceptance: specs/agent-runtime.feature.md (Checks). Driven by
// MockLanguageModelV4 and the real providers on the proxied fetch (no network).
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { MAX_MODEL_REQUESTS_PER_CHECK } from '@app/specs/agent-proxy.spec';
import { AI_CHECK_LIMITS } from '@app/specs/ai-checks.spec';
import type { ModelRoute } from '@app/specs/agent-tools.spec';
import { CHECK_MAX_RETRIES, checkCallOptions } from '../check';
import { CHAT_PROVIDER_OPTIONS, CHATGPT_PROVIDER_OPTIONS } from '../chat';
import { createModel } from '../provider';
import { chatStart, settle, startHarness, stubNetworkGlobals, textStep, toolStep } from './harness';

type CheckStart = Extract<MainToRuntimeMessage, { type: 'check.start' }>;

const checkStart = (overrides: Partial<CheckStart> = {}): CheckStart => ({
  type: 'check.start',
  checkId: 'check-1',
  systemPrompt: 'Answer with one JSON object only.',
  input: 'Task: judge the page type. Untrusted page data: {"title":"Running shoes"}',
  modelId: 'anthropic/claude-sonnet-5-5',
  route: 'byok-anthropic',
  ...overrides,
});

/** A model stream that waits until its call is aborted. */
const hangingModel = () =>
  new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason));
        },
      }),
    }),
  });

beforeEach(() => stubNetworkGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('AI checks in the runtime', () => {
  test('check-is-toolless-single-request', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['{"pageType":', '"product"}']), textStep(['never asked'])] });
    const factory = vi.fn(() => model);
    const h = startHarness({ modelFactory: factory });
    h.send(checkStart());
    expect(await h.next('check.finish')).toEqual({ type: 'check.finish', checkId: 'check-1', text: '{"pageType":"product"}' });
    // One call, on the check's own route and model, with no tool and no reasoning option.
    expect(model.doStreamCalls.length).toBe(1);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]!.slice(0, 2)).toEqual(['byok-anthropic', 'anthropic/claude-sonnet-5-5']);
    const call = model.doStreamCalls[0]!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.prompt).toEqual([
      { role: 'system', content: 'Answer with one JSON object only.' },
      { role: 'user', content: [{ type: 'text', text: checkStart().input }] },
    ]);
    expect(call.maxOutputTokens).toBe(AI_CHECK_LIMITS.maxOutputTokens);
    expect(call.temperature).toBeUndefined();
    expect(call.providerOptions).toEqual(CHAT_PROVIDER_OPTIONS);
    expect(JSON.stringify(call.providerOptions)).not.toMatch(/reasoning|thinking|effort/i);
    expect(h.of('check.error')).toEqual([]);
    expect(h.of('chat.delta')).toEqual([]);
    // The ChatGPT plan's options: no output cap, no sampling field, store off, a developer message.
    for (const route of ['byok-anthropic', 'byok-openai', 'gateway'] as const satisfies readonly ModelRoute[]) {
      expect(checkCallOptions(route)).toEqual({ maxOutputTokens: AI_CHECK_LIMITS.maxOutputTokens, providerOptions: CHAT_PROVIDER_OPTIONS });
    }
    expect(checkCallOptions('chatgpt')).toEqual({ providerOptions: CHATGPT_PROVIDER_OPTIONS });
    expect(AI_CHECK_LIMITS.maxOutputChars).toBe(2_000);
    expect(AI_CHECK_LIMITS.maxOutputTokens).toBe(1_024);
    expect(AI_CHECK_LIMITS.requestTimeoutMs).toBe(60_000);

    // Through a real provider on the proxied fetch: its one `fetch.request` carries the check's id.
    const real = startHarness({ modelFactory: createModel });
    real.send(checkStart({ checkId: 'check-real' }));
    const request = await real.next('fetch.request');
    expect(request.checkId).toBe('check-real');
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_tokens).toBe(AI_CHECK_LIMITS.maxOutputTokens);
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    real.send({ type: 'fetch.error', requestId: request.requestId, code: 'refused', message: 'frost refused this model request.' });
    expect(await real.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-real', code: 'refused' });
    expect(real.of('fetch.request').length).toBe(MAX_MODEL_REQUESTS_PER_CHECK);
    // A chat's request is untagged, beside it.
    real.send(chatStart());
    const turn = await real.next('fetch.request', (message) => message.requestId !== request.requestId);
    expect(turn.checkId).toBeUndefined();
  });

  test('check-is-toolless-single-request (an answer over the cap is too-large)', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['{"a":"', 'x'.repeat(AI_CHECK_LIMITS.maxOutputChars), '"}'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(checkStart());
    expect(await h.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-1', code: 'too-large' });
    expect(h.of('check.finish')).toEqual([]);
    // A tool call the model makes anyway is never invoked (no tool is offered).
    const tooly = new MockLanguageModelV4({ doStream: [toolStep('call-1', 'page_text', {})] });
    const t = startHarness({ modelFactory: () => tooly });
    t.send(checkStart({ checkId: 'check-2' }));
    await vi.waitFor(() => expect(t.of('check.finish').length + t.of('check.error').length).toBe(1));
    expect(t.of('tool.invoke')).toEqual([]);
    expect(tooly.doStreamCalls.length).toBe(1);
  });

  test('check-sets-maxRetries-0', async () => {
    expect(CHECK_MAX_RETRIES).toBe(0);
    // A retryable failure (HTTP 500) is not retried, and the check answers `check.error`.
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({ message: 'overloaded', url: 'https://api.anthropic.com/v1/messages', requestBodyValues: {}, statusCode: 500, isRetryable: true });
      },
    });
    const h = startHarness({ modelFactory: () => model });
    h.send(checkStart());
    expect(await h.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-1', code: 'failed' });
    await settle();
    expect(model.doStreamCalls.length).toBe(1);

    // A real provider answered 529 (retryable): one `fetch.request`, never a second.
    const real = startHarness({ modelFactory: createModel });
    real.send(checkStart({ checkId: 'check-529' }));
    const request = await real.next('fetch.request');
    real.send({ type: 'fetch.response-start', requestId: request.requestId, status: 529, statusText: '', headers: [['content-type', 'application/json']] });
    real.send({ type: 'fetch.end', requestId: request.requestId });
    expect(await real.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-529', code: 'failed' });
    await settle();
    expect(real.of('fetch.request').length).toBe(1);
    // A network failure main reports is `network`.
    const net = startHarness({ modelFactory: createModel });
    net.send(checkStart({ checkId: 'check-net', route: 'gateway', modelId: 'openai/gpt-5-mini' }));
    const gatewayRequest = await net.next('fetch.request');
    net.send({ type: 'fetch.error', requestId: gatewayRequest.requestId, code: 'network', message: 'The model request failed.' });
    expect(await net.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-net', code: 'network' });
    expect(net.of('fetch.request').length).toBe(1);
  });

  test('check-stop-aborts', async () => {
    const model = hangingModel();
    const h = startHarness({ modelFactory: () => model });
    h.send(checkStart());
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    // A stop for another id changes nothing.
    h.send({ type: 'check.stop', checkId: 'check-other' });
    await settle();
    expect(h.of('check.error')).toEqual([]);
    h.send({ type: 'check.stop', checkId: 'check-1' });
    expect(await h.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-1', code: 'aborted' });
    expect(model.doStreamCalls[0]!.abortSignal?.aborted).toBe(true);
    await settle();
    expect(h.of('check.finish')).toEqual([]);
    expect(h.runtime.activeChecks).toEqual([]);

    // Through the proxied fetch: the request is withdrawn (`fetch.abort`).
    const real = startHarness({ modelFactory: createModel });
    real.send(checkStart({ checkId: 'check-real' }));
    const request = await real.next('fetch.request');
    real.send({ type: 'check.stop', checkId: 'check-real' });
    expect(await real.next('fetch.abort')).toEqual({ type: 'fetch.abort', requestId: request.requestId });
    expect(await real.next('check.error')).toEqual({ type: 'check.error', checkId: 'check-real', code: 'aborted' });

    // A second start for a running check is ignored: the running one goes on.
    const again = hangingModel();
    const twice = startHarness({ modelFactory: () => again });
    twice.send(checkStart());
    await vi.waitFor(() => expect(again.doStreamCalls.length).toBe(1));
    twice.send(checkStart());
    await settle();
    expect(again.doStreamCalls.length).toBe(1);
    expect(twice.of('check.error')).toEqual([]);
    expect(twice.runtime.activeChecks).toEqual(['check-1']);
  });
});
