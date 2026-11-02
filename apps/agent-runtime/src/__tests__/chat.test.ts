// Spec: specs/agent-protocol.schema.ts, specs/agent-tools.spec.ts, specs/agent-reasoning.spec.ts
// (reasoningWire, effectiveEffort: chat.start.reasoningEffort) · Acceptance:
// specs/agent-runtime.feature.md (Chat loop). Driven by MockLanguageModelV4 with scripted streams.
import type { LanguageModelV4CallOptions, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_LIMITS, type ToolResult } from '@app/specs/agent-protocol.schema';
import { MAX_OUTPUT_TOKENS } from '@app/specs/agent-proxy.spec';
import { effectiveEffort, REASONING_EFFORTS, reasoningWire } from '@app/specs/agent-reasoning.spec';
import type { ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { ALLOWED_MODEL_IDS, MAX_TOOL_STEPS, routeModelId, type AgentModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { CHAT_PROVIDER_OPTIONS, chatCallOptions, CHATGPT_PROVIDER_OPTIONS, refuseDownload } from '../chat';
import { createModel } from '../provider';
import { chatStart, settle, startHarness, streamOf, stubNetworkGlobals, textStep, toolStep, usage } from './harness';

const pageTextResult: ToolResult = { ok: true, output: { untrusted: true, source: 'page_text https://example.com/', data: { text: 'Welcome to Example.' } } };

/** The tool results the model was given in a call's prompt. */
function toolOutputs(call: LanguageModelV4CallOptions | undefined) {
  return (call?.prompt ?? []).flatMap((message) => (message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : []));
}

describe('chat loop', () => {
  beforeEach(stubNetworkGlobals);
  afterEach(() => vi.unstubAllGlobals());

  test('chat-streams-text', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['The page ', 'looks ', 'healthy.'], 'stop', usage(42, 7))] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    const finish = await h.next('chat.finish');
    expect(h.of('chat.delta').map((message) => message.text)).toEqual(['The page ', 'looks ', 'healthy.']);
    expect(finish).toEqual({ type: 'chat.finish', chatId: 'chat-1', finishReason: 'stop', steps: 1, usage: { input: 42, output: 7 } });
    // Every delta came before the finish.
    expect(h.received.findIndex((message) => message.type === 'chat.finish')).toBe(h.received.length - 1);
    expect(h.of('chat.error')).toEqual([]);
  });

  test('chat-delta-split', async () => {
    const long = `${'a'.repeat(AGENT_PROTOCOL_LIMITS.maxDeltaChars - 1)}😀${'b'.repeat(10)}`;
    const model = new MockLanguageModelV4({ doStream: [textStep([long])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('chat.finish');
    const deltas = h.of('chat.delta').map((message) => message.text);
    expect(deltas.length).toBe(2);
    expect(deltas.every((text) => text.length <= AGENT_PROTOCOL_LIMITS.maxDeltaChars)).toBe(true);
    expect(deltas.join('')).toBe(long);
    // The emoji's surrogate pair was not split.
    expect(deltas[1]?.startsWith('😀')).toBe(true);
  });

  test('chat-tool-call-round-trip', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-1', 'page_text', { maxChars: 500 }), textStep(['It welcomes visitors.'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    const invoke = await h.next('tool.invoke');
    expect(invoke).toEqual({ type: 'tool.invoke', chatId: 'chat-1', callId: 'call-1', toolName: 'page_text', input: { maxChars: 500 } });
    expect(h.of('chat.tool-call')).toEqual([{ type: 'chat.tool-call', chatId: 'chat-1', callId: 'call-1', toolName: 'page_text', input: { maxChars: 500 } }]);
    // The card came before the request.
    expect(h.received.findIndex((message) => message.type === 'chat.tool-call')).toBeLessThan(h.received.findIndex((message) => message.type === 'tool.invoke'));
    expect(model.doStreamCalls.length).toBe(1);

    h.send({ type: 'tool.result', chatId: 'chat-1', callId: 'call-1', result: pageTextResult });
    const finish = await h.next('chat.finish');
    expect(finish).toMatchObject({ finishReason: 'stop', steps: 2, usage: { input: 30, output: 13 } });
    expect(h.of('chat.delta').map((message) => message.text)).toEqual(['It welcomes visitors.']);
    expect(model.doStreamCalls.length).toBe(2);
    expect(toolOutputs(model.doStreamCalls[1])).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', toolName: 'page_text', output: { type: 'json', value: pageTextResult.output } }),
    ]);
  });

  test('chat-denied-tool-continues', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-9', 'page_audit', {}), textStep(['Understood, I will not read it.'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('tool.invoke');
    h.send({ type: 'tool.result', chatId: 'chat-1', callId: 'call-9', result: { ok: false, error: { code: 'denied', message: 'The user did not allow this.' } } });
    const finish = await h.next('chat.finish');
    expect(finish.finishReason).toBe('stop');
    expect(toolOutputs(model.doStreamCalls[1])).toEqual([
      expect.objectContaining({ toolCallId: 'call-9', output: { type: 'error-json', value: { error: 'denied', message: 'The user did not allow this.' } } }),
    ]);
    expect(h.of('chat.error')).toEqual([]);
  });

  test('chat-stop-aborts', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-2', 'page_audit', {}), textStep(['never streamed'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('tool.invoke');
    h.send({ type: 'chat.stop', chatId: 'chat-1' });
    const finish = await h.next('chat.finish');
    expect(finish).toMatchObject({ chatId: 'chat-1', finishReason: 'aborted' });
    // The pending call was rejected: a late result matches nothing and the model is not called again.
    h.send({ type: 'tool.result', chatId: 'chat-1', callId: 'call-2', result: pageTextResult });
    await settle();
    expect(model.doStreamCalls.length).toBe(1);
    expect(h.runtime.stats.toolResultsUnmatched).toBe(1);
    expect(h.of('chat.delta')).toEqual([]);
    expect(h.runtime.activeChats).toEqual([]);
  });

  test('chat-stop-aborts mid-stream', async () => {
    // A stream that sends one delta and then hangs until the turn is stopped.
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't1' });
            controller.enqueue({ type: 'text-delta', id: 't1', delta: 'Partial' });
            abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason));
          },
        }),
      }),
    });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('chat.delta');
    h.send({ type: 'chat.stop', chatId: 'chat-1' });
    const finish = await h.next('chat.finish');
    expect(finish.finishReason).toBe('aborted');
    expect(h.of('chat.error')).toEqual([]);
  });

  test('chat-step-limit', async () => {
    let n = 0;
    const model = new MockLanguageModelV4({ doStream: async () => toolStep(`call-${(n += 1)}`, 'page_audit', {}) });
    const h = startHarness({ modelFactory: () => model });
    h.onMessage((message) => {
      if (message.type === 'tool.invoke') h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: pageTextResult });
    });
    h.send(chatStart());
    const finish = await h.next('chat.finish');
    expect(model.doStreamCalls.length).toBe(MAX_TOOL_STEPS);
    expect(finish).toMatchObject({ finishReason: 'step-limit', steps: MAX_TOOL_STEPS });
    expect(h.of('tool.invoke').length).toBe(MAX_TOOL_STEPS);
  });

  test('chat-offers-allowed-tools-only', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart({ allowedTools: ['page_audit'] }));
    await h.next('chat.finish');
    const offered = (model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(['page_audit']);
    expect(offered).not.toContain('navigate');
    expect(offered).not.toContain('execute_javascript');
  });

  test('chat-offers-allowed-tools-only (a call to another tool is not run)', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-x', 'navigate', { url: 'https://example.com/' }), textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart({ allowedTools: ['page_audit'] }));
    await h.next('chat.finish');
    expect(h.of('tool.invoke')).toEqual([]);
    expect(h.of('chat.tool-call')).toEqual([]);
  });

  test('chat-history-converted', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['Done.'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(
      chatStart({
        messages: [
          { role: 'user', content: 'Read the page.' },
          { role: 'assistant', content: 'Reading it.', toolCalls: [{ callId: 'c1', toolName: 'page_text', input: {} }] },
          { role: 'tool', callId: 'c1', toolName: 'page_text', result: pageTextResult },
          { role: 'assistant', content: 'It welcomes visitors.', toolCalls: [] },
          { role: 'user', content: 'Thanks. Anything else?' },
        ],
      }),
    );
    await h.next('chat.finish');
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    expect(prompt[0]).toMatchObject({ role: 'system', content: 'You are frost’s SEO assistant.' });
    expect(prompt[2]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Reading it.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'page_text', input: {} }] });
    expect(toolOutputs(model.doStreamCalls[0])).toEqual([expect.objectContaining({ toolCallId: 'c1', output: { type: 'json', value: pageTextResult.output } })]);
  });

  test('chat-unanswered-call-synthesized', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(
      chatStart({
        messages: [
          { role: 'user', content: 'Click the first link.' },
          // Stopped during the approval of c1; c2 answered.
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { callId: 'c1', toolName: 'click', input: { text: 'Pricing' } },
              { callId: 'c2', toolName: 'page_text', input: {} },
            ],
          },
          { role: 'tool', callId: 'c2', toolName: 'page_text', result: pageTextResult },
          { role: 'user', content: 'Never mind. Read the title.' },
        ],
      }),
    );
    await h.next('chat.finish');
    expect(model.doStreamCalls[0]?.prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(toolOutputs(model.doStreamCalls[0])).toEqual([
      expect.objectContaining({ toolCallId: 'c1', toolName: 'click', output: { type: 'error-json', value: expect.objectContaining({ error: 'aborted' }) } }),
      expect.objectContaining({ toolCallId: 'c2', output: { type: 'json', value: pageTextResult.output } }),
    ]);
  });

  test('chat-orphan-result-dropped', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(
      chatStart({
        messages: [
          { role: 'user', content: 'Read the page.' },
          { role: 'tool', callId: 'ghost', toolName: 'page_text', result: pageTextResult },
          { role: 'assistant', content: 'Reading.', toolCalls: [{ callId: 'c1', toolName: 'page_text', input: {} }] },
          { role: 'tool', callId: 'c1', toolName: 'page_text', result: pageTextResult },
          { role: 'tool', callId: 'c7', toolName: 'page_audit', result: pageTextResult },
          { role: 'user', content: 'And now?' },
        ],
      }),
    );
    await h.next('chat.finish');
    expect(model.doStreamCalls[0]?.prompt.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(toolOutputs(model.doStreamCalls[0]).map((part) => part.toolCallId)).toEqual(['c1']);
  });

  test('chat-step-posted', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-1', 'page_text', { maxChars: 500 }), textStep(['It welcomes ', 'visitors.'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('tool.invoke');
    h.send({ type: 'tool.result', chatId: 'chat-1', callId: 'call-1', result: pageTextResult });
    await h.next('chat.finish');
    expect(h.of('chat.step')).toEqual([
      { type: 'chat.step', chatId: 'chat-1', step: 1, text: '', toolCalls: [{ callId: 'call-1', toolName: 'page_text', input: { maxChars: 500 } }], usage: { input: 20, output: 8 } },
      { type: 'chat.step', chatId: 'chat-1', step: 2, text: 'It welcomes visitors.', toolCalls: [], usage: { input: 10, output: 5 } },
    ]);
    // Each step is posted before the turn's end.
    expect(h.received.at(-1)?.type).toBe('chat.finish');
  });

  test('chat-step-posted (a call to a tool not offered is left out)', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        streamOf([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Opening it.' },
          { type: 'text-end', id: 't1' },
          { type: 'tool-call', toolCallId: 'bad-1', toolName: 'navigate', input: '{"url":"https://example.com/"}' },
          { type: 'tool-call', toolCallId: 'bad-2', toolName: 'page_text', input: '{"maxChars":"lots"}' },
          { type: 'tool-call', toolCallId: 'good-1', toolName: 'page_audit', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usage(1, 1) },
        ]),
        textStep(['ok']),
      ],
    });
    const h = startHarness({ modelFactory: () => model });
    h.onMessage((message) => {
      if (message.type === 'tool.invoke') h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: pageTextResult });
    });
    h.send(chatStart());
    await h.next('chat.finish');
    expect(h.of('tool.invoke').map((message) => message.callId)).toEqual(['good-1']);
    expect(h.of('chat.step')[0]).toEqual({ type: 'chat.step', chatId: 'chat-1', step: 1, text: 'Opening it.', toolCalls: [{ callId: 'good-1', toolName: 'page_audit', input: {} }], usage: { input: 1, output: 1 } });
  });

  test('chat-step-posted (a step cut by Stop)', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-2', 'page_audit', {}), textStep(['never'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('tool.invoke');
    h.send({ type: 'chat.stop', chatId: 'chat-1' });
    await h.next('chat.finish');
    // Cut short: no usage of its own.
    expect(h.of('chat.step')).toEqual([{ type: 'chat.step', chatId: 'chat-1', step: 1, text: '', toolCalls: [{ callId: 'call-2', toolName: 'page_audit', input: {} }] }]);
    expect(h.received.findIndex((message) => message.type === 'chat.step')).toBeLessThan(h.received.findIndex((message) => message.type === 'chat.finish'));
  });

  test('chat-step-posted (text cut at maxMessageChars)', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['x'.repeat(AGENT_PROTOCOL_LIMITS.maxMessageChars), 'yz'])] });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    await h.next('chat.finish');
    expect(h.of('chat.step')[0]?.text.length).toBe(AGENT_PROTOCOL_LIMITS.maxMessageChars);
  });

  test('chat-no-download', async () => {
    await expect(refuseDownload([{ url: new URL('https://example.com/a.png'), isUrlSupportedByModel: false }])).rejects.toThrow(/download/);
    await expect(refuseDownload([{ url: new URL('https://example.com/a.png'), isUrlSupportedByModel: true }])).rejects.toThrow(/download/);
    expect(await refuseDownload([])).toEqual([]);
  });

  test('chat-error-bounded', async () => {
    const secret = 'request-body-echo: Read the page. x-api-key=sk-should-not-appear';
    const h = startHarness({ modelFactory: createModel });
    h.onMessage((message) => {
      if (message.type !== 'fetch.request') return;
      const body = new TextEncoder().encode(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: secret } }));
      h.send({ type: 'fetch.response-start', requestId: message.requestId, status: 401, statusText: 'Unauthorized', headers: [['content-type', 'application/json']] });
      h.send({ type: 'fetch.chunk', requestId: message.requestId, bytes: body });
      h.send({ type: 'fetch.end', requestId: message.requestId });
    });
    h.send(chatStart());
    const error = await h.next('chat.error');
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.message.length).toBeLessThanOrEqual(AGENT_PROTOCOL_LIMITS.maxErrorChars);
    expect(error.message).not.toContain('sk-should');
    expect(error.message).not.toContain('Read the page');
    expect(error.message).not.toMatch(/\n\s+at /);
    expect(h.of('chat.finish')).toEqual([]);
  });

  test('chat-error-bounded (a refused proxy request)', async () => {
    const h = startHarness({ modelFactory: createModel });
    h.onMessage((message) => {
      if (message.type === 'fetch.request') h.send({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'not on the allowlist' });
    });
    h.send(chatStart());
    const error = await h.next('chat.error');
    expect(error.message).toBe('frost refused to send this model request.');
    expect(h.of('fetch.request').length).toBe(1);
  });

  test('chat-streams-text (a model stream error part)', async () => {
    const model = new MockLanguageModelV4({
      doStream: [streamOf([{ type: 'stream-start', warnings: [] }, { type: 'error', error: Object.assign(new Error('upstream said: secret'), { statusCode: 529 }) }])] as LanguageModelV4StreamResult[],
    });
    const h = startHarness({ modelFactory: () => model });
    h.send(chatStart());
    const error = await h.next('chat.error');
    expect(error.message).toBe('The model provider answered with an error (HTTP 529).');
  });
});

// Spec: specs/agent-mcp.schema.ts (McpToolDefinitionSchema), specs/agent-protocol.schema.ts (chat.start.mcpTools)
// Acceptance: specs/agent-mcp.feature.md (Runtime)
describe('MCP tools in the chat loop', () => {
  const definition = {
    name: 'mcp__docs__search',
    description: 'Untrusted tool from Docs: Searches the docs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'] },
  } as const;

  test('mcp-tools-offered-with-their-schema', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('call-m', 'mcp__docs__search', { query: 'robots' }), textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    h.onMessage((message) => {
      if (message.type === 'tool.invoke') h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: pageTextResult });
    });
    h.send(chatStart({ allowedTools: ['page_audit', definition.name], mcpTools: [definition] }));
    await h.next('chat.finish');
    const offered = model.doStreamCalls[0]?.tools ?? [];
    expect(offered.map((tool) => tool.name)).toEqual(['page_audit', definition.name]);
    const mcp = offered.find((tool) => tool.name === definition.name) as { description?: string; inputSchema?: unknown } | undefined;
    expect(mcp?.description).toBe(definition.description);
    expect(mcp?.inputSchema).toEqual(definition.inputSchema);
    // Its execute is a request to main, like every tool's.
    expect(h.of('tool.invoke')).toEqual([{ type: 'tool.invoke', chatId: 'chat-1', callId: 'call-m', toolName: definition.name, input: { query: 'robots' } }]);
  });

  test('mcp-name-without-definition-refused', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep(['ok'])] });
    const h = startHarness({ modelFactory: () => model });
    // The protocol refuses a chat.start whose MCP names and definitions differ: no turn starts.
    h.send(chatStart({ allowedTools: ['page_audit', definition.name] }));
    h.send(chatStart({ chatId: 'chat-2', allowedTools: ['page_audit'], mcpTools: [definition] }));
    h.send(chatStart({ chatId: 'chat-3', allowedTools: ['page_audit', definition.name], mcpTools: [{ ...definition, inputSchema: { type: 'object', $ref: '#/x' } as never }] }));
    await settle();
    expect(model.doStreamCalls).toEqual([]);
    expect(h.of('chat.finish')).toEqual([]);
  });
});

// Acceptance: specs/agent-runtime.feature.md (Chat loop: chat-call-options-carry-reasoning)
describe('reasoning level in the call options (Phase 8 Task 8b)', () => {
  const CHATGPT_MODEL = 'chatgpt/gpt-6.1-sol' as const;
  /** Every route and the models it serves (each gateway provider's included), and a ChatGPT slug. */
  const servedModels = (route: ModelRoute): readonly AgentModelId[] => (route === 'chatgpt' ? [CHATGPT_MODEL] : ALLOWED_MODEL_IDS.filter((id) => routeModelId(route, id) !== null));
  const ROUTES = ['byok-anthropic', 'byok-openai', 'gateway', 'chatgpt'] as const satisfies readonly ModelRoute[];

  test('chat-call-options-carry-reasoning', async () => {
    // What each route's call carries for a level: written out, not derived.
    expect(chatCallOptions('byok-anthropic', 'anthropic/claude-opus-5-5', 'high')).toEqual({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: { openai: { store: false }, anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
    });
    expect(chatCallOptions('byok-openai', 'openai/gpt-5', 'off')).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS, providerOptions: { openai: { store: false, reasoningEffort: 'minimal' } } });
    expect(chatCallOptions('gateway', 'openai/gpt-5-mini', 'low')).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS, providerOptions: { openai: { store: false, reasoningEffort: 'low' } } });
    expect(chatCallOptions('gateway', 'anthropic/claude-sonnet-5-5', 'medium')).toEqual({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: { openai: { store: false }, anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' } },
    });
    expect(chatCallOptions('gateway', 'google/gemini-4-argon', 'medium')).toEqual({
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      providerOptions: { openai: { store: false }, google: { thinkingConfig: { thinkingLevel: 'medium' } } },
    });
    // Grok has no mapping: a level sends nothing, as `auto` does.
    expect(chatCallOptions('gateway', 'spacexai/grok-4.7', 'high')).toEqual({ maxOutputTokens: MAX_OUTPUT_TOKENS, providerOptions: CHAT_PROVIDER_OPTIONS });
    // The ChatGPT plan: still no output cap; the level with `forceReasoning`, so the provider writes
    // `reasoning.effort` for a slug it doesn't take for a reasoning model too.
    expect(chatCallOptions('chatgpt', CHATGPT_MODEL, 'low')).toEqual({ providerOptions: { openai: { store: false, systemMessageMode: 'developer', reasoningEffort: 'low', forceReasoning: true } } });
    expect(chatCallOptions('chatgpt', CHATGPT_MODEL, 'high')).not.toHaveProperty('maxOutputTokens');
    // `off` is never offered there (Task 8a): it maps to nothing, and nothing is forced.
    expect(chatCallOptions('chatgpt', CHATGPT_MODEL, 'off')).toEqual({ providerOptions: CHATGPT_PROVIDER_OPTIONS });

    // Every route, served model and level, through a turn: the model's call carries the route's
    // options with `reasoningWire` merged in, `auto` exactly the route's options and nothing else.
    for (const route of ROUTES) {
      for (const modelId of servedModels(route)) {
        const chatgptModels: ChatgptModelView[] = route === 'chatgpt' ? [{ id: CHATGPT_MODEL, label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] }] : [];
        for (const stored of REASONING_EFFORTS) {
          // What main sends: the effective level (a level the model lacks is `auto`).
          const reasoningEffort = effectiveEffort({ modelId, reasoningEffort: stored }, chatgptModels);
          const model = new MockLanguageModelV4({ doStream: [textStep(['ok'])] });
          const h = startHarness({ modelFactory: () => model });
          h.send(chatStart({ route, modelId, reasoningEffort }));
          await h.next('chat.finish');
          const call = model.doStreamCalls[0]!;
          const label = `${route} ${modelId} ${stored} → ${reasoningEffort}`;
          const base = route === 'chatgpt' ? CHATGPT_PROVIDER_OPTIONS : CHAT_PROVIDER_OPTIONS;
          const wire = reasoningWire(route, modelId, reasoningEffort);
          if (reasoningEffort === 'auto') expect(call.providerOptions, label).toEqual(base);
          expect(call.providerOptions, label).toEqual({
            ...base,
            ...wire,
            openai: { ...base.openai, ...wire.openai, ...(route === 'chatgpt' && wire.openai !== undefined ? { forceReasoning: true } : {}) },
          });
          expect(call.maxOutputTokens, label).toBe(route === 'chatgpt' ? undefined : MAX_OUTPUT_TOKENS);
          // No sampling option on any route, whatever the level.
          for (const option of ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty'] as const) expect(call[option], `${label} ${option}`).toBeUndefined();
        }
      }
    }
  });
});
