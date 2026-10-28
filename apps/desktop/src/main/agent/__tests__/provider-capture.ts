// Captures the requests the installed providers really send, through the real runtime on in-memory
// ports (no network): a turn's first request, or the second request of a turn whose first step
// answered with reasoning (thinking, a signature, a redacted block, encrypted reasoning) and two tool
// calls (one with Anthropic's `caller: { type: 'direct' }`, which the provider sends back), so the
// history carries every shape a multi-step turn sends.
import { vi } from 'vitest';
import { createMemoryPortPair, createModel, startRuntime } from '@app/agent-runtime';
import type { MainToRuntimeMessage, RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import type { ModelId, ModelRoute } from '@app/specs/agent-tools.spec';

export type CapturedRequest = Extract<RuntimeToMainMessage, { type: 'fetch.request' }>;

const sse = (events: readonly (readonly [string | null, unknown])[]) => events.map(([event, data]) => `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`).join('');

/** Anthropic: a thinking block (with its signature), a redacted thinking block, text and two tool calls. */
const ANTHROPIC_STEP = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The audit comes first.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Reading the page.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'page_audit', input: {}, caller: { type: 'direct' } } }],
  ['content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 3 }],
  ['content_block_start', { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'toolu_2', name: 'page_text', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"maxChars":100}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 4 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
  ['message_stop', { type: 'message_stop' }],
]);

/** OpenAI Responses: a reasoning item (summary and encrypted content), a message and two function calls. */
const OPENAI_STEP = sse([
  [null, { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5' } }],
  [null, { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: null } }],
  [null, { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 0 }],
  [null, { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'The audit comes first.' }],
  [null, { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', output_index: 0, summary_index: 0 }],
  [null, { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ZW5jcnlwdGVk' } }],
  [null, { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } }],
  [null, { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Reading the page.', logprobs: [] }],
  [null, { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1' } }],
  [null, { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'page_audit', arguments: '' } }],
  [null, { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{}' }],
  [null, { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'page_audit', arguments: '{}', status: 'completed' } }],
  [null, { type: 'response.output_item.added', output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'page_text', arguments: '' } }],
  [null, { type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 3, delta: '{"maxChars":100}' }],
  [null, { type: 'response.output_item.done', output_index: 3, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'page_text', arguments: '{"maxChars":100}', status: 'completed' } }],
  [null, { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 10, output_tokens: 20 } } }],
]);

/** The gateway: the language model stream parts, with the provider metadata each provider attaches. */
const gatewayStep = (provider: 'anthropic' | 'openai') =>
  sse([
    [null, { type: 'stream-start', warnings: [] }],
    [null, { type: 'reasoning-start', id: 'r1', ...(provider === 'openai' ? { providerMetadata: { openai: { itemId: 'rs_1', reasoningEncryptedContent: null } } } : {}) }],
    [null, { type: 'reasoning-delta', id: 'r1', delta: 'The audit comes first.' }],
    [null, { type: 'reasoning-end', id: 'r1', providerMetadata: provider === 'openai' ? { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'ZW5jcnlwdGVk' } } : { anthropic: { signature: 'c2lnbmF0dXJl' } } }],
    ...(provider === 'anthropic'
      ? ([
          [null, { type: 'reasoning-start', id: 'r2', providerMetadata: { anthropic: { redactedData: 'cmVkYWN0ZWQ=' } } }],
          [null, { type: 'reasoning-end', id: 'r2' }],
        ] as const)
      : []),
    [null, { type: 'text-start', id: 't1', ...(provider === 'openai' ? { providerMetadata: { openai: { itemId: 'msg_1' } } } : {}) }],
    [null, { type: 'text-delta', id: 't1', delta: 'Reading the page.' }],
    [null, { type: 'text-end', id: 't1' }],
    [null, { type: 'tool-call', toolCallId: 'call_1', toolName: 'page_audit', input: '{}', providerMetadata: provider === 'openai' ? { openai: { itemId: 'fc_1' } } : { anthropic: { caller: { type: 'direct' } } } }],
    [null, { type: 'tool-call', toolCallId: 'call_2', toolName: 'page_text', input: '{"maxChars":100}', ...(provider === 'openai' ? { providerMetadata: { openai: { itemId: 'fc_2' } } } : {}) }],
    [null, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 20, text: 20 } } }],
  ]);

function firstStep(route: ModelRoute, modelId: ModelId): string {
  if (route === 'byok-anthropic') return ANTHROPIC_STEP;
  if (route === 'byok-openai') return OPENAI_STEP;
  return gatewayStep(modelId.startsWith('openai/') ? 'openai' : 'anthropic');
}

const START_HISTORY: Extract<MainToRuntimeMessage, { type: 'chat.start' }>['messages'] = [
  { role: 'user', content: 'Audit this page.' },
  { role: 'assistant', content: 'Reading it.', toolCalls: [{ callId: 'call-1', toolName: 'page_audit', input: {} }] },
  { role: 'tool', callId: 'call-1', toolName: 'page_audit', result: { ok: true, output: { untrusted: true, source: 'page_audit https://example.com/', data: { score: 80, file: 'x', url: 'https://example.com/' } } } },
  { role: 'assistant', content: '', toolCalls: [{ callId: 'call-2', toolName: 'navigate', input: { url: 'https://example.com/b' } }] },
  { role: 'tool', callId: 'call-2', toolName: 'navigate', result: { ok: false, error: { code: 'denied', message: 'The user said no.' } } },
  { role: 'user', content: 'Go on.' },
];

/**
 * The `request`th `fetch.request` (1 or 2) of a turn on `route` with `modelId`: with 2, the first is
 * answered with the scripted reasoning-and-two-tool-calls step and both calls get a result.
 */
export async function captureProviderRequest(route: ModelRoute, modelId: ModelId, request: 1 | 2 = 1): Promise<CapturedRequest> {
  const [main, runtimeEnd] = createMemoryPortPair();
  const requests: CapturedRequest[] = [];
  const post = (message: MainToRuntimeMessage) => main.post(message);
  main.onMessage((data) => {
    const message = data as RuntimeToMainMessage;
    if (message.type === 'tool.invoke') {
      post({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: { ok: true, output: { untrusted: true, source: message.toolName, data: { ok: true } } } });
      return;
    }
    if (message.type !== 'fetch.request') return;
    requests.push(message);
    if (request === 2 && requests.length === 1) {
      post({ type: 'fetch.response-start', requestId: message.requestId, status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] });
      post({ type: 'fetch.chunk', requestId: message.requestId, bytes: new TextEncoder().encode(firstStep(route, modelId)) });
      post({ type: 'fetch.end', requestId: message.requestId });
      return;
    }
    post({ type: 'fetch.error', requestId: message.requestId, code: 'refused', message: 'test' });
  });
  const runtime = startRuntime(runtimeEnd, { modelFactory: createModel });
  post({ type: 'chat.start', chatId: 'chat-1', route, modelId, systemPrompt: 'You are an SEO assistant.', allowedTools: ['page_audit', 'page_text', 'navigate'], messages: START_HISTORY });
  await vi.waitFor(() => {
    if (requests.length < request) throw new Error(`waiting for request ${request} (${requests.length} so far)`);
  });
  await runtime.whenIdle('chat-1');
  return requests[request - 1]!;
}
