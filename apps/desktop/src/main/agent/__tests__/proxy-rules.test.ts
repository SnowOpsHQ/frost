// Spec: specs/agent-proxy.spec.ts (REQUEST_HEADER_ALLOWLIST, filterRequestHeaders, mainRequestHeaders,
// RESPONSE_HEADER_ALLOWLIST, filterResponseHeaders, sanitizeStatusText, BODY_FIELDS, checkModelRequestBody,
// GATEWAY_PROVIDER_OPTIONS and the gateway's part options: Gemini's `google` thought signature and
// `thinkingConfig`, Grok's `xai: {}`; checkModelRequest, GATEWAY_OPTIONS_KEY, PROXY_REFUSALS 'reasoning')
// · specs/agent-reasoning.spec.ts (REASONING_EFFORTS, MODEL_REASONING_SUPPORT, reasoningLevels,
// effectiveEffort, reasoningWire, reasoningFieldsOf, checkReasoning) · specs/agent-chatgpt.spec.ts
// (CHATGPT_ADVERTISED_EFFORTS) · specs/agent-tools.spec.ts (ALLOWED_MODEL_IDS, byProvider)
// Acceptance: specs/agent-host.feature.md (Proxy rules, Reasoning) · plan docs/plans/phase-8-ai-complete.md, Task 8a
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ADVERTISED_EFFORTS, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { checkModelRequest, checkModelRequestBody, filterRequestHeaders, filterResponseHeaders, GATEWAY_OPTIONS_KEY, GEMINI_THINKING_LEVELS, mainRequestHeaders, MAX_OUTPUT_TOKENS, PROXY_REFUSALS, sanitizeStatusText } from '@app/specs/agent-proxy.spec';
import { checkReasoning, effectiveEffort, MODEL_REASONING_SUPPORT, REASONING_EFFORTS, reasoningFieldsOf, reasoningLevels, reasoningWire, type ReasoningEffort } from '@app/specs/agent-reasoning.spec';
import { ALLOWED_MODEL_IDS, byProvider, MODEL_PROVIDERS, MODEL_ROUTES, modelProvider, routeModelId, type AgentModelId, type ModelId, type ModelProvider, type ModelRoute } from '@app/specs/agent-tools.spec';
import { captureProviderRequest, GEMINI_THOUGHT_SIGNATURE } from './provider-capture';

const ANTHROPIC = { model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], stream: true };
const OPENAI = { model: 'gpt-5', max_output_tokens: 1024, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], store: false, stream: true };
const GATEWAY = { maxOutputTokens: 1024, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], providerOptions: { openai: { store: false } } };
const GATEWAY_HEADERS: [string, string][] = [['ai-language-model-id', 'anthropic/claude-sonnet-5-5']];

const GEMINI = ALLOWED_MODEL_IDS.filter(byProvider('google'));
const GROK = ALLOWED_MODEL_IDS.filter(byProvider('spacexai'));
const gatewayHeaders = (modelId: string): [string, string][] => [['ai-language-model-id', modelId]];

const body = (value: object) => JSON.stringify(value);
const reason = (route: ModelRoute, modelId: string, value: object, headers: [string, string][] = route === 'gateway' ? GATEWAY_HEADERS : []) => {
  const check = checkModelRequestBody(route, modelId, body(value), headers);
  return check.ok ? 'ok' : check.reason;
};

// ---- Reasoning (Task 8a) -----------------------------------------------------------------------

const CHATGPT_MODEL = 'chatgpt/gpt-6.1-sol' as const;
const CHATGPT = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], store: false, stream: true };
/** The account's list with every level the route may advertise for the model. */
const CHATGPT_LISTED: readonly ChatgptModelView[] = [{ id: CHATGPT_MODEL, label: 'GPT-6.1 Sol', efforts: [...CHATGPT_ADVERTISED_EFFORTS] }];

/** The whole request check (structural, then reasoning) under `effort`, as the proxy runs it. */
const composite = (route: ModelRoute, modelId: string, effort: ReasoningEffort, value: object, headers: [string, string][] = route === 'gateway' ? gatewayHeaders(modelId) : []) => {
  const check = checkModelRequest(route, modelId, effort, body(value), headers);
  return check.ok ? 'ok' : check.reason;
};
/** The models each route serves (the ChatGPT route: one listed model). */
const modelsOf = (route: ModelRoute): readonly AgentModelId[] => (route === 'chatgpt' ? [CHATGPT_MODEL] : ALLOWED_MODEL_IDS.filter((id) => routeModelId(route, id) !== null));
const levelsOf = (route: ModelRoute, modelId: string) => (route === 'chatgpt' ? reasoningLevels(modelId, CHATGPT_LISTED) : MODEL_REASONING_SUPPORT[modelId as ModelId]);
/** A request with no reasoning field, as today's runtime sends it on `route`. */
const plainFor = (route: ModelRoute, modelId: string): Record<string, unknown> => {
  if (route === 'byok-anthropic') return { ...ANTHROPIC, model: routeModelId(route, modelId) };
  if (route === 'byok-openai') return { ...OPENAI, model: routeModelId(route, modelId) };
  if (route === 'chatgpt') return CHATGPT;
  return GATEWAY;
};
/**
 * What each provider writes for an effort (Decision 8's table, written out here from the installed
 * providers' request builders, not from the spec's mapping): Anthropic adaptive thinking with the
 * effort; OpenAI and the ChatGPT plan `reasoning.effort` (`off` → `minimal`, a summary beside it);
 * the gateway the provider options as given (with the runtime's `openai.store: false`).
 */
const sentFor = (route: ModelRoute, modelId: string, effort: ReasoningEffort): Record<string, unknown> => {
  const openai = effort === 'off' ? 'minimal' : effort;
  if (route === 'byok-anthropic') return { ...plainFor(route, modelId), thinking: { type: 'adaptive' }, output_config: { effort } };
  if (route === 'byok-openai' || route === 'chatgpt') return { ...plainFor(route, modelId), reasoning: { effort: openai, summary: 'detailed' } };
  const provider = modelProvider(modelId);
  const options =
    provider === 'anthropic'
      ? { anthropic: { thinking: { type: 'adaptive' }, effort } }
      : provider === 'openai'
        ? { openai: { store: false, reasoningEffort: openai } }
        : provider === 'google'
          ? { google: { thinkingConfig: { thinkingLevel: effort } } }
          : {};
  return { ...GATEWAY, providerOptions: { openai: { store: false }, ...options } };
};
const gatewayWith = (providerOptions: object) => ({ ...GATEWAY, providerOptions });

describe('proxy rules', () => {
  test('proxy-request-headers-allowlist', () => {
    const hostile: [string, string][] = [
      ['Host', 'evil.example'],
      ['Authorization', 'Bearer stolen'],
      ['X-Api-Key', 'stolen'],
      ['api-key', 'stolen'],
      ['Cookie', 'sid=1'],
      ['Proxy-Authorization', 'Basic x'],
      ['Transfer-Encoding', 'chunked'],
      ['Content-Length', '5'],
      ['Content-Type', 'text/plain'],
      ['OpenAI-Organization', 'org-1'],
      ['OpenAI-Project', 'proj-1'],
      ['x-vercel-ai-gateway-team', 'team'],
      ['ai-o11y-request-id', 'r'],
      ['ai-gateway-auth-method', 'oidc'],
      ['idempotency-key', 'k'],
      ['X-Forwarded-For', '1.2.3.4'],
    ];
    for (const route of MODEL_ROUTES) expect(filterRequestHeaders(route, hostile), route).toEqual([]);
    expect(
      filterRequestHeaders('byok-anthropic', [
        ['Anthropic-Version', '2023-06-01'],
        ['anthropic-beta', 'structured-outputs-2025-11-13, mcp-client-2025-04-04,files-api-2025-04-14'],
        ['user-agent', 'ai-sdk-anthropic/4.0.90 ai-sdk-provider-utils/5.0.70 node.js/24'],
        ['anthropic-version', '2099-01-01'],
      ]),
    ).toEqual([
      ['anthropic-version', '2023-06-01'],
      ['anthropic-beta', 'structured-outputs-2025-11-13'],
      ['user-agent', 'ai-sdk-anthropic/4.0.90 ai-sdk-provider-utils/5.0.70 node.js/24'],
    ]);
    expect(filterRequestHeaders('byok-anthropic', [['anthropic-beta', 'mcp-client-2025-04-04'], ['anthropic-version', '2024-01-01'], ['user-agent', 'curl/8']])).toEqual([]);
    // A repeated name: the first value is checked and sent, the second ignored.
    expect(filterRequestHeaders('gateway', [['ai-language-model-id', 'anthropic/claude-sonnet-5-5'], ['AI-Language-Model-Id', 'openai/gpt-5']])).toEqual([['ai-language-model-id', 'anthropic/claude-sonnet-5-5']]);
    expect(filterRequestHeaders('byok-openai', [['anthropic-version', '2023-06-01'], ['ai-language-model-id', 'openai/gpt-5']])).toEqual([]);
  });

  test('proxy-credential-injection', () => {
    expect(mainRequestHeaders('byok-anthropic', 'K')).toEqual([['content-type', 'application/json'], ['x-api-key', 'K']]);
    expect(mainRequestHeaders('byok-openai', 'K')).toEqual([['content-type', 'application/json'], ['authorization', 'Bearer K']]);
    expect(mainRequestHeaders('gateway', 'K')).toEqual([['content-type', 'application/json'], ['authorization', 'Bearer K'], ['ai-gateway-auth-method', 'api-key']]);
  });

  test('proxy-response-headers-filter', () => {
    expect(
      filterResponseHeaders([
        ['Content-Type', 'text/event-stream; charset=utf-8'],
        ['request-id', 'req_1'],
        ['x-request-id', 'abc'],
        ['retry-after', '3'],
        ['anthropic-ratelimit-tokens-remaining', '1000'],
        ['x-ratelimit-reset-requests', '1s'],
        ['set-cookie', 'sid=1'],
        ['anthropic-organization-id', 'org'],
        ['openai-organization', 'org'],
        ['openai-project', 'proj'],
        ['content-encoding', 'gzip'],
        ['content-length', '10'],
        ['server', 'x'],
        ['cf-ray', 'x'],
        ['x-request-id', 'bad\u0001value'],
        ['retry-after', 'x'.repeat(300)],
      ]),
    ).toEqual([
      ['content-type', 'text/event-stream; charset=utf-8'],
      ['request-id', 'req_1'],
      ['x-request-id', 'abc'],
      ['retry-after', '3'],
      ['anthropic-ratelimit-tokens-remaining', '1000'],
      ['x-ratelimit-reset-requests', '1s'],
    ]);
    expect(sanitizeStatusText('Too Many Requests')).toBe('Too Many Requests');
    expect(sanitizeStatusText('bad\r\nheader')).toBe('');
    expect(sanitizeStatusText('x'.repeat(65))).toBe('');
    expect(sanitizeStatusText(undefined)).toBe('');
  });

  test('proxy-body-model-mismatch', () => {
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', ANTHROPIC)).toBe('ok');
    expect(reason('byok-anthropic', 'anthropic/claude-opus-5-5', ANTHROPIC)).toBe('model');
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, model: 'anthropic/claude-sonnet-5-5' })).toBe('model');
    expect(reason('byok-anthropic', 'openai/gpt-5', ANTHROPIC)).toBe('model');
    expect(reason('byok-openai', 'openai/gpt-5', OPENAI)).toBe('ok');
    expect(reason('byok-openai', 'openai/gpt-5-mini', OPENAI)).toBe('model');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', GATEWAY)).toBe('ok');
    expect(reason('gateway', 'anthropic/claude-opus-5-5', GATEWAY)).toBe('model');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', GATEWAY, [])).toBe('model');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', GATEWAY, [...GATEWAY_HEADERS, ...GATEWAY_HEADERS])).toBe('model');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, model: 'x' })).toBe('body-field');
    expect(checkModelRequestBody('byok-anthropic', 'anthropic/claude-sonnet-5-5', 'not json')).toEqual({ ok: false, reason: 'body-json' });
    expect(checkModelRequestBody('byok-anthropic', 'anthropic/claude-sonnet-5-5', body(ANTHROPIC))).toEqual({ ok: true, body: body(ANTHROPIC) });
    expect(checkModelRequestBody('byok-anthropic', 'anthropic/claude-sonnet-5-5', '[1]')).toEqual({ ok: false, reason: 'body-json' });
  });

  test('proxy-server-tools-refused', () => {
    const plain = { name: 'page_text', description: 'd', input_schema: { type: 'object' } };
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, tools: [plain, { ...plain, type: 'custom' }] })).toBe('ok');
    for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825', 'computer_20250124', 'bash_20250124', 'text_editor_20250124', 'mcp_toolset']) {
      expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, tools: [{ ...plain, type }] }), type).toBe('tool');
    }
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, mcp_servers: [{ type: 'url', url: 'https://x.example', name: 'x' }] })).toBe('body-field');
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, container: 'c1' })).toBe('body-field');
    for (const type of ['web_search', 'web_search_preview', 'file_search', 'computer_use_preview', 'code_interpreter', 'image_generation', 'local_shell', 'mcp', 'custom']) {
      expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, tools: [{ type, name: 'x' }] }), type).toBe('tool');
    }
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, tools: [{ type: 'function', name: 'page_text', parameters: {} }], tool_choice: 'auto' })).toBe('ok');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, tool_choice: { type: 'file_search' } })).toBe('tool');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, tools: [{ type: 'provider', id: 'anthropic.web_search_20250305', name: 'web_search', args: {} }] })).toBe('tool');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, tools: [{ type: 'function', name: 'x', inputSchema: {}, providerOptions: { anthropic: {} } }] })).toBe('tool');
    const providerCall = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'web_search', input: {}, providerExecuted: true }] };
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, prompt: [...GATEWAY.prompt, providerCall] })).toBe('tool');
  });

  test('proxy-files-and-state-refused', () => {
    const anthropicWith = (block: object) => ({ ...ANTHROPIC, messages: [{ role: 'user', content: [block] }] });
    for (const block of [
      { type: 'image', source: { type: 'url', url: 'https://x.example/a.png' } },
      { type: 'document', source: { type: 'file', file_id: 'file_1' } },
      { type: 'container_upload', file_id: 'file_1' },
      { type: 'search_result', source: 'https://x.example', title: 't', content: [] },
      { type: 'server_tool_use', id: 's', name: 'web_search', input: {} },
      { type: 'mcp_tool_use', id: 'm', name: 'x', server_name: 's', input: {} },
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: 'https://x.example' } }] },
    ]) {
      expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', anthropicWith(block)), block.type).toBe('content');
    }
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', anthropicWith({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] }))).toBe('ok');
    const openaiWith = (item: object) => ({ ...OPENAI, input: [item] });
    for (const item of [
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://x.example/a.png' }] },
      { role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] },
      { type: 'item_reference', id: 'msg_1' },
      { type: 'web_search_call', id: 'w' },
      { type: 'function_call_output', call_id: 'c', output: [{ type: 'input_file', file_id: 'f' }] },
    ]) {
      expect(reason('byok-openai', 'openai/gpt-5', openaiWith(item)), JSON.stringify(item)).toBe('content');
    }
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, previous_response_id: 'resp_1' })).toBe('body-field');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, conversation: 'conv_1' })).toBe('body-field');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, include: ['file_search_call.results'] })).toBe('body-field');
    const gatewayWith = (message: object) => ({ ...GATEWAY, prompt: [message] });
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', gatewayWith({ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'https://x.example/a.png' }] }))).toBe('content');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', gatewayWith({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'content', value: [] } }] }))).toBe('content');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', gatewayWith({ role: 'user', content: [{ type: 'text', text: 'x', providerOptions: { gateway: { byok: {} } } }] }))).toBe('provider-options');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, providerOptions: { gateway: { order: ['x'] } } })).toBe('provider-options');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, providerOptions: { anthropic: { mcpServers: [] } } })).toBe('provider-options');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, providerOptions: { openai: { store: false, previousResponseId: 'r' } } })).toBe('provider-options');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, headers: { authorization: 'x' } })).toBe('body-field');
  });

  test('proxy-openai-store-required', () => {
    const { store: _store, ...withoutStore } = OPENAI;
    expect(reason('byok-openai', 'openai/gpt-5', withoutStore)).toBe('store');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, store: true })).toBe('store');
    const openaiHeaders: [string, string][] = [['ai-language-model-id', 'openai/gpt-5']];
    expect(reason('gateway', 'openai/gpt-5', GATEWAY, openaiHeaders)).toBe('ok');
    expect(reason('gateway', 'openai/gpt-5', { prompt: GATEWAY.prompt, maxOutputTokens: 1024 }, openaiHeaders)).toBe('store');
    expect(reason('gateway', 'openai/gpt-5', { ...GATEWAY, providerOptions: { openai: { store: true } } }, openaiHeaders)).toBe('store');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, providerOptions: { openai: { store: true } } })).toBe('store');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { prompt: GATEWAY.prompt, maxOutputTokens: 1024 })).toBe('ok');
  });

  test('proxy-duplicate-keys-canonical', () => {
    const raw = (route: ModelRoute, modelId: string, text: string, headers: [string, string][] = route === 'gateway' ? GATEWAY_HEADERS : []) => checkModelRequestBody(route, modelId, text, headers);
    const server = '{"name":"web_search","type":"web_search_20250305"}';
    // The last of a repeated key is what JSON.parse (and so the check) reads, and all that is sent.
    const anthropic = raw('byok-anthropic', 'anthropic/claude-sonnet-5-5', `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[],"tools":[${server}],"tools":[]}`);
    expect(anthropic).toEqual({ ok: true, body: '{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[],"tools":[]}' });
    expect(raw('byok-anthropic', 'anthropic/claude-sonnet-5-5', `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[],"tools":[],"tools":[${server}]}`)).toEqual({ ok: false, reason: 'tool' });
    expect(raw('byok-anthropic', 'anthropic/claude-sonnet-5-5', '{"model":"claude-opus-5-5","model":"claude-sonnet-5-5","max_tokens":64,"messages":[]}')).toMatchObject({ ok: true, body: expect.not.stringContaining('opus') });
    const openai = raw('byok-openai', 'openai/gpt-5', '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":true,"store":false}');
    expect(openai).toEqual({ ok: true, body: '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":false}' });
    expect(raw('byok-openai', 'openai/gpt-5', '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":false,"store":true}')).toEqual({ ok: false, reason: 'store' });
    // A repeated `type` in a block: the last one decides, and the block's other keys must fit it.
    const block = (inner: string) => raw('byok-anthropic', 'anthropic/claude-sonnet-5-5', `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[{"role":"user","content":[${inner}]}]}`);
    expect(block('{"type":"text","type":"image","source":{"type":"url","url":"https://x.example"}}')).toEqual({ ok: false, reason: 'content' });
    expect(block('{"type":"image","source":{"type":"url","url":"https://x.example"},"type":"text","text":"x"}')).toEqual({ ok: false, reason: 'content' });
    const gateway = raw('gateway', 'anthropic/claude-sonnet-5-5', '{"maxOutputTokens":64,"prompt":[],"providerOptions":{"gateway":{"order":["x"]}},"providerOptions":{"openai":{"store":false}}}');
    expect(gateway).toEqual({ ok: true, body: '{"maxOutputTokens":64,"prompt":[],"providerOptions":{"openai":{"store":false}}}' });
    expect(raw('gateway', 'anthropic/claude-sonnet-5-5', '{"maxOutputTokens":64,"prompt":[],"providerOptions":{"openai":{"store":false}},"providerOptions":{"gateway":{"order":["x"]}}}')).toEqual({ ok: false, reason: 'provider-options' });
  });

  test('proxy-nested-allowlist', () => {
    const anthropic = (role: 'user' | 'assistant', block: object) => reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, messages: [{ role, content: [block] }] });
    expect(anthropic('user', { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } })).toBe('ok');
    expect(anthropic('user', { type: 'text', text: 'x', citations: [{ type: 'web_search_result_location', url: 'https://x.example' }] })).toBe('content');
    expect(anthropic('assistant', { type: 'tool_use', id: 't', name: 'x', input: {}, caller: { type: 'code_execution_20250825', tool_id: 'srv' } })).toBe('content');
    expect(anthropic('assistant', { type: 'tool_use', id: 't', name: 'x', input: {}, caller: { type: 'direct' } })).toBe('ok');
    expect(anthropic('assistant', { type: 'tool_use', id: 't', name: 'x', input: {}, caller: { type: 'direct', tool_id: 'srv' } })).toBe('content');
    expect(anthropic('assistant', { type: 'tool_use', id: 't', name: 'x', input: {}, caller: {} })).toBe('content');
    expect(anthropic('user', { type: 'tool_use', id: 't', name: 'x', input: {} })).toBe('content');
    expect(anthropic('assistant', { type: 'tool_result', tool_use_id: 't', content: 'x' })).toBe('content');
    expect(anthropic('user', { type: 'thinking', thinking: 'x', signature: 's' })).toBe('content');
    expect(anthropic('assistant', { type: 'thinking', thinking: 'x', signature: 's' })).toBe('ok');
    expect(anthropic('assistant', { type: 'compaction', content: 'x' })).toBe('content');
    expect(anthropic('user', { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x', citations: [] }] })).toBe('content');
    const plain = { name: 'x', description: 'd', input_schema: { type: 'object' } };
    for (const extra of [{ defer_loading: true }, { allowed_callers: ['code_execution_20250825'] }, { input_examples: [{}] }]) {
      expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, tools: [{ ...plain, ...extra }] }), JSON.stringify(extra)).toBe('tool');
    }
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, messages: [{ role: 'user', content: 'x', extra: 1 }] })).toBe('content');
    expect(reason('byok-anthropic', 'anthropic/claude-sonnet-5-5', { ...ANTHROPIC, thinking: { type: 'enabled', budget_tokens: 1024, display: 'x' } })).toBe('body-field');

    const openai = (item: object) => reason('byok-openai', 'openai/gpt-5', { ...OPENAI, input: [item] });
    expect(openai({ type: 'reasoning', id: 'rs', encrypted_content: 'e', summary: [{ type: 'summary_text', text: 'x' }] })).toBe('ok');
    expect(openai({ type: 'reasoning', id: 'rs', encrypted_content: 'e', summary: [], status: 'x' })).toBe('content');
    expect(openai({ role: 'assistant', content: 'x', id: 'msg_1' })).toBe('content');
    expect(openai({ role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }] })).toBe('content');
    expect(openai({ type: 'function_call', call_id: 'c', name: 'x', arguments: '{}', namespace: 'n' })).toBe('content');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, tools: [{ type: 'function', name: 'x', parameters: {}, defer_loading: true }] })).toBe('tool');
    expect(reason('byok-openai', 'openai/gpt-5', { ...OPENAI, text: { format: { type: 'json_schema', schema: {} } } })).toBe('body-field');

    const gateway = (role: string, part: object) => reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, prompt: [{ role, content: [part] }] });
    expect(gateway('assistant', { type: 'reasoning', text: 'x', providerOptions: { anthropic: { signature: 's' } } })).toBe('ok');
    expect(gateway('assistant', { type: 'tool-result', toolCallId: 'c', toolName: 'x', output: { type: 'json', value: {} } })).toBe('content');
    expect(gateway('tool', { type: 'tool-result', toolCallId: 'c', toolName: 'x', output: { type: 'json', value: {} } })).toBe('ok');
    expect(gateway('user', { type: 'reasoning', text: 'x' })).toBe('content');
    expect(gateway('user', { type: 'text', text: 'x', extra: 1 })).toBe('content');
    expect(gateway('assistant', { type: 'text', text: 'x', providerOptions: { anthropic: { citations: { enabled: true } } } })).toBe('provider-options');
    expect(gateway('assistant', { type: 'tool-call', toolCallId: 'c', toolName: 'x', input: {}, providerOptions: { openai: { itemId: 'fc', approvalRequestId: 'a' } } })).toBe('provider-options');
    expect(gateway('assistant', { type: 'tool-call', toolCallId: 'c', toolName: 'x', input: {}, providerOptions: { anthropic: { caller: { type: 'direct' } } } })).toBe('ok');
    expect(gateway('assistant', { type: 'tool-call', toolCallId: 'c', toolName: 'x', input: {}, providerOptions: { anthropic: { caller: { type: 'code_execution_20260120', toolId: 'srv' } } } })).toBe('provider-options');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] })).toBe('ok');
    expect(reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, tools: [{ type: 'function', name: 'x', inputSchema: {}, inputExamples: [] }] })).toBe('tool');
  });

  test('proxy-gateway-option-values', () => {
    const options = (providerOptions: object, maxOutputTokens = 1024) => reason('gateway', 'anthropic/claude-sonnet-5-5', { ...GATEWAY, maxOutputTokens, providerOptions });
    expect(options({ openai: { store: false, reasoningEffort: 'low', reasoningSummary: 'auto', textVerbosity: 'low', parallelToolCalls: false } })).toBe('ok');
    expect(options({ anthropic: { sendReasoning: true, effort: 'medium', disableParallelToolUse: true } })).toBe('ok');
    for (const bad of [{ openai: { reasoningEffort: 'ultra' } }, { openai: { reasoningSummary: 1 } }, { openai: { parallelToolCalls: 'yes' } }, { openai: { textVerbosity: { x: 1 } } }, { anthropic: { effort: 'max' } }, { anthropic: { sendReasoning: 'true' } }]) {
      expect(options(bad), JSON.stringify(bad)).toBe('provider-options');
    }
    // The provider asks for maxOutputTokens + budgetTokens: a budget past the cap is refused.
    expect(options({ anthropic: { thinking: { type: 'enabled', budgetTokens: 200_000 } } })).toBe('output-cap');
    expect(options({ anthropic: { thinking: { type: 'enabled', budgetTokens: MAX_OUTPUT_TOKENS - 1024 } } })).toBe('ok');
    expect(options({ anthropic: { thinking: { type: 'enabled', budgetTokens: MAX_OUTPUT_TOKENS - 1023 } } })).toBe('output-cap');
    // No budget: the provider uses 1024.
    expect(options({ anthropic: { thinking: { type: 'enabled' } } }, MAX_OUTPUT_TOKENS)).toBe('output-cap');
    expect(options({ anthropic: { thinking: { type: 'enabled' } } }, MAX_OUTPUT_TOKENS - 1024)).toBe('ok');
    expect(options({ anthropic: { thinking: { type: 'disabled' } } })).toBe('ok');
    expect(options({ anthropic: { thinking: { type: 'adaptive', display: 'full' } } })).toBe('output-cap');
    expect(options({ anthropic: { thinking: { type: 'enabled', budgetTokens: 0 } } })).toBe('output-cap');

    // Through the whole request check (Task 8a): the shapes above are allowed, but no effort's
    // mapping produces them on an Anthropic model (OpenAI's `reasoningEffort`, `effort` without
    // `thinking`, `enabled` or `disabled` thinking), so they are refused `reasoning` under every effort.
    const sonnet = 'anthropic/claude-sonnet-5-5';
    const shapedOnly: [object, number][] = [
      [{ openai: { store: false, reasoningEffort: 'low', reasoningSummary: 'auto', textVerbosity: 'low', parallelToolCalls: false } }, 1024],
      [{ anthropic: { sendReasoning: true, effort: 'medium', disableParallelToolUse: true } }, 1024],
      [{ anthropic: { thinking: { type: 'enabled', budgetTokens: MAX_OUTPUT_TOKENS - 1024 } } }, 1024],
      [{ anthropic: { thinking: { type: 'enabled' } } }, MAX_OUTPUT_TOKENS - 1024],
      [{ anthropic: { thinking: { type: 'disabled' } } }, 1024],
    ];
    for (const [providerOptions, maxOutputTokens] of shapedOnly) {
      expect(options(providerOptions, maxOutputTokens), JSON.stringify(providerOptions)).toBe('ok');
      for (const effort of REASONING_EFFORTS) expect(composite('gateway', sonnet, effort, { ...GATEWAY, maxOutputTokens, providerOptions }), `${effort} ${JSON.stringify(providerOptions)}`).toBe('reasoning');
    }
    // A shape an effort does map to is accepted under that effort only.
    for (const effort of ['low', 'medium', 'high'] as const) {
      const adaptive = gatewayWith({ openai: { store: false }, anthropic: { thinking: { type: 'adaptive' }, effort } });
      expect(options({ openai: { store: false }, anthropic: { thinking: { type: 'adaptive' }, effort } })).toBe('ok');
      for (const other of REASONING_EFFORTS) expect(composite('gateway', sonnet, other, adaptive), `${effort} under ${other}`).toBe(other === effort ? 'ok' : 'reasoning');
    }
    // OpenAI's `reasoningEffort: 'low'` on an OpenAI model: only under `low`, never under `auto`.
    for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider('openai'))) {
      const low = gatewayWith({ openai: { store: false, reasoningEffort: 'low' } });
      expect(reason('gateway', modelId, low, gatewayHeaders(modelId))).toBe('ok');
      for (const effort of REASONING_EFFORTS) expect(composite('gateway', modelId, effort, low), `${modelId} ${effort}`).toBe(effort === 'low' ? 'ok' : 'reasoning');
    }
  });

  test('proxy-gemini-thought-signature-accepted', () => {
    const signature = { google: { thoughtSignature: GEMINI_THOUGHT_SIGNATURE } };
    const call = (providerOptions: object) => ({ type: 'tool-call', toolCallId: 'c', toolName: 'page_audit', input: {}, providerOptions });
    const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'page_audit', output: { type: 'json', value: {} } }] };
    for (const modelId of GEMINI) {
      const turn = (assistant: object[]) => reason('gateway', modelId, { ...GATEWAY, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }, { role: 'assistant', content: assistant }, result] }, gatewayHeaders(modelId));
      // The signature goes back on the thought, the text and the call it came with.
      expect(turn([{ type: 'reasoning', text: 'x', providerOptions: signature }, { type: 'text', text: 'x', providerOptions: signature }, call(signature)]), modelId).toBe('ok');
      expect(turn([call(signature), call({})]), modelId).toBe('ok');
      // Only a string, only that key, only under `google`.
      for (const bad of [
        { google: { thoughtSignature: 1 } },
        { google: { thoughtSignature: { value: 's' } } },
        { google: { thoughtSignature: null } },
        { google: { thoughtSignature: 's', groundingMetadata: { webSearchQueries: ['x'] } } },
        { google: { thoughtSignature: 's', cachedContent: 'cachedContents/abc' } },
        { google: { functionCall: { name: 'x' } } },
        { google: 's' },
        { vertex: { thoughtSignature: 's' } },
        { gateway: { thoughtSignature: 's' } },
      ]) {
        expect(turn([call(bad)]), `${modelId} ${JSON.stringify(bad)}`).toBe('provider-options');
      }
      // The same rule on a message's own options.
      expect(reason('gateway', modelId, { ...GATEWAY, prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }], providerOptions: { google: { cachedContent: 'cachedContents/abc' } } }] }, gatewayHeaders(modelId))).toBe('provider-options');
    }
  });

  test('proxy-google-options-allowlisted', () => {
    for (const modelId of GEMINI) {
      const options = (google: unknown, maxOutputTokens = 1024) => reason('gateway', modelId, { ...GATEWAY, maxOutputTokens, providerOptions: { openai: { store: false }, google } }, gatewayHeaders(modelId));
      for (const thinkingLevel of ['low', 'medium', 'high']) expect(options({ thinkingConfig: { thinkingLevel } }), thinkingLevel).toBe('ok');
      expect(options({ thinkingConfig: { includeThoughts: true } })).toBe('ok');
      expect(options({ thinkingConfig: { thinkingLevel: 'high', includeThoughts: false } })).toBe('ok');
      const refused: [string, unknown][] = [
        ['not an object', 'high'],
        ['thinkingConfig not an object', { thinkingConfig: 'high' }],
        ['thinkingConfig null', { thinkingConfig: null }],
        ['an unknown thinkingLevel', { thinkingConfig: { thinkingLevel: 'max' } }],
        ['minimal (no listed model offers it)', { thinkingConfig: { thinkingLevel: 'minimal' } }],
        ['xhigh', { thinkingConfig: { thinkingLevel: 'xhigh' } }],
        ['an upper-case level', { thinkingConfig: { thinkingLevel: 'HIGH' } }],
        ['includeThoughts not a boolean', { thinkingConfig: { includeThoughts: 'true' } }],
        ['an unknown thinkingConfig key', { thinkingConfig: { thinkingLevel: 'low', display: 'full' } }],
        ['a budget over the cap', { thinkingConfig: { thinkingBudget: MAX_OUTPUT_TOKENS + 1 } }],
        ['a far larger budget', { thinkingConfig: { thinkingBudget: 200_000 } }],
        ['a dynamic budget', { thinkingConfig: { thinkingBudget: -1 } }],
        // No budget is allowed at all: the runtime maps reasoning to levels only.
        ['a budget within the cap', { thinkingConfig: { thinkingBudget: 1024 } }],
        ['cachedContent', { cachedContent: 'cachedContents/abc' }],
        ['safety settings', { safetySettings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }] }],
        ['a safety threshold', { threshold: 'BLOCK_NONE' }],
        ['search grounding', { useSearchGrounding: true }],
        ['dynamic retrieval', { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC', dynamicThreshold: 0 } }],
        ['retrieval config', { retrievalConfig: { latLng: { latitude: 0, longitude: 0 } } }],
        ['response modalities', { responseModalities: ['TEXT', 'IMAGE'] }],
        ['structured outputs', { structuredOutputs: false }],
        ['labels', { labels: { team: 'x' } }],
        ['media resolution', { mediaResolution: 'MEDIA_RESOLUTION_HIGH' }],
        ['an unknown key', { audioTimestamp: true }],
      ];
      for (const [what, google] of refused) expect(options(google), `${modelId} ${what}`).toBe('provider-options');
      // Google's options under another provider's key are refused too.
      expect(reason('gateway', modelId, { ...GATEWAY, providerOptions: { openai: { store: false }, vertex: { thinkingConfig: { thinkingLevel: 'low' } } } }, gatewayHeaders(modelId))).toBe('provider-options');
      // Search grounding as a provider tool is refused as a tool.
      expect(reason('gateway', modelId, { ...GATEWAY, tools: [{ type: 'provider', id: 'google.google_search', name: 'google_search', args: {} }] }, gatewayHeaders(modelId))).toBe('tool');
    }
  });

  test('proxy-xai-options-refused', () => {
    for (const modelId of GROK) {
      const options = (providerOptions: object) => reason('gateway', modelId, { ...GATEWAY, providerOptions: { openai: { store: false }, ...providerOptions } }, gatewayHeaders(modelId));
      // Nothing is allowed under `xai` until a capture shows a need: an empty object at most.
      expect(options({})).toBe('ok');
      expect(options({ xai: {} })).toBe('ok');
      for (const bad of [
        { xai: { reasoningEffort: 'high' } },
        { xai: { reasoningEffort: 'low' } },
        { xai: { searchParameters: { mode: 'on' } } },
        { xai: { parallel_function_calling: false } },
        { xai: { store: false } },
        { xai: 'high' },
        { xai: null },
        { spacexai: {} },
        { spacexai: { reasoningEffort: 'high' } },
      ]) {
        expect(options(bad), `${modelId} ${JSON.stringify(bad)}`).toBe('provider-options');
      }
      // And no part metadata under either key.
      const part = (providerOptions: object) => reason('gateway', modelId, { ...GATEWAY, prompt: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'x', providerOptions }] }] }, gatewayHeaders(modelId));
      expect(part({})).toBe('ok');
      for (const bad of [{ xai: { reasoningEncryptedContent: 'e' } }, { xai: { itemId: 'rs_1' } }, { spacexai: { itemId: 'rs_1' } }]) expect(part(bad), JSON.stringify(bad)).toBe('provider-options');
    }
  });

  test('proxy-output-cap', () => {
    const cases: [ModelRoute, string, object, string][] = [
      ['byok-anthropic', 'anthropic/claude-sonnet-5-5', ANTHROPIC, 'max_tokens'],
      ['byok-openai', 'openai/gpt-5', OPENAI, 'max_output_tokens'],
      ['gateway', 'anthropic/claude-sonnet-5-5', GATEWAY, 'maxOutputTokens'],
    ];
    for (const [route, modelId, value, field] of cases) {
      expect(reason(route, modelId, { ...value, [field]: MAX_OUTPUT_TOKENS }), route).toBe('ok');
      for (const bad of [undefined, 0, MAX_OUTPUT_TOKENS + 1, 1.5, '64', 128_000]) {
        expect(reason(route, modelId, { ...value, [field]: bad }), `${route} ${String(bad)}`).toBe('output-cap');
      }
    }
  });

  test('proxy-reasoning-must-match-settings', () => {
    expect(PROXY_REFUSALS).toContain('reasoning');
    for (const route of MODEL_ROUTES) {
      for (const modelId of modelsOf(route)) {
        const levels = levelsOf(route, modelId);
        const at = `${route} ${modelId}`;
        // `auto` sends nothing: a request with no reasoning field passes, and only under `auto`.
        expect(composite(route, modelId, 'auto', plainFor(route, modelId)), at).toBe('ok');
        expect(reasoningWire(route, modelId, 'auto'), at).toEqual({});
        for (const effort of levels.filter((level) => level !== 'auto')) {
          // The mapping of the settings' effort passes...
          expect(composite(route, modelId, effort, sentFor(route, modelId, effort)), `${at} ${effort}`).toBe('ok');
          // ...and under any other effort the settings could hold (`auto` included) it is refused.
          for (const other of levels.filter((level) => level !== effort)) {
            expect(composite(route, modelId, other, sentFor(route, modelId, effort)), `${at} ${effort} under ${other}`).toBe('reasoning');
          }
          // An effort the settings hold must be sent: nothing in its place is refused too.
          expect(composite(route, modelId, effort, plainFor(route, modelId)), `${at} nothing under ${effort}`).toBe('reasoning');
        }
      }
    }
    // Decision 8's table: every model offers `auto` first, its levels in `REASONING_EFFORTS` order.
    const offered: Readonly<Record<ModelProvider, readonly ReasoningEffort[]>> = {
      anthropic: ['auto', 'low', 'medium', 'high'],
      openai: REASONING_EFFORTS,
      google: ['auto', ...GEMINI_THINKING_LEVELS],
      spacexai: ['auto'],
    };
    for (const modelId of ALLOWED_MODEL_IDS) {
      const levels = MODEL_REASONING_SUPPORT[modelId];
      expect(levels[0], modelId).toBe('auto');
      expect(levels, modelId).toEqual(REASONING_EFFORTS.filter((level) => levels.includes(level)));
      expect(levels.every((level) => offered[modelProvider(modelId)!].includes(level)), modelId).toBe(true);
      expect(reasoningLevels(modelId, CHATGPT_LISTED), modelId).toBe(levels);
    }
    for (const provider of ['anthropic', 'openai', 'spacexai'] as const) {
      for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider(provider))) expect(MODEL_REASONING_SUPPORT[modelId], modelId).toEqual(offered[provider]);
    }
    // Each Gemini model offers the levels the gateway lists for it: `low` and `high` always; the
    // flash model has no `medium` (GEMINI_THINKING_LEVELS' doc comment).
    for (const modelId of GEMINI) expect(MODEL_REASONING_SUPPORT[modelId], modelId).toEqual(expect.arrayContaining(['auto', 'low', 'high']));
    const withoutMedium = GEMINI.filter((modelId) => !MODEL_REASONING_SUPPORT[modelId].includes('medium'));
    expect(withoutMedium.length).toBeGreaterThan(0);
    for (const modelId of withoutMedium) {
      // A stored `medium` acts as `auto` there (nothing sent), and a body carrying it is refused under every effort.
      expect(effectiveEffort({ modelId, reasoningEffort: 'medium' }, [])).toBe('auto');
      expect(reasoningWire('gateway', modelId, 'medium')).toEqual({});
      const medium = gatewayWith({ openai: { store: false }, google: { thinkingConfig: { thinkingLevel: 'medium' } } });
      expect(reason('gateway', modelId, medium, gatewayHeaders(modelId))).toBe('ok');
      for (const effort of REASONING_EFFORTS) expect(composite('gateway', modelId, effort, medium), `${modelId} ${effort}`).toBe('reasoning');
    }
    // `thinkingLevel` is bound to the effort, and the whole `thinkingConfig` is compared: no
    // `includeThoughts` the mapping doesn't send.
    for (const modelId of GEMINI) {
      expect(composite('gateway', modelId, 'high', gatewayWith({ openai: { store: false }, google: { thinkingConfig: { thinkingLevel: 'low' } } }))).toBe('reasoning');
      expect(composite('gateway', modelId, 'high', gatewayWith({ openai: { store: false }, google: { thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } } }))).toBe('reasoning');
      expect(composite('gateway', modelId, 'auto', gatewayWith({ openai: { store: false }, google: { thinkingConfig: { includeThoughts: true } } }))).toBe('reasoning');
    }
    // Grok offers `auto` only: any reasoning field is refused, whatever the settings hold.
    for (const modelId of GROK) {
      for (const effort of REASONING_EFFORTS) {
        expect(effectiveEffort({ modelId, reasoningEffort: effort }, [])).toBe('auto');
        expect(composite('gateway', modelId, effort, GATEWAY), `${modelId} ${effort}`).toBe('ok');
        expect(composite('gateway', modelId, effort, gatewayWith({ openai: { store: false, reasoningEffort: 'high' } })), `${modelId} ${effort}`).toBe('reasoning');
      }
    }
    // The ChatGPT route: `auto` plus the levels the account's list advertises for the model; none → `auto` only.
    expect(reasoningLevels(CHATGPT_MODEL, [{ id: CHATGPT_MODEL, label: 'x' }])).toEqual(['auto']);
    expect(reasoningLevels(CHATGPT_MODEL, [{ id: CHATGPT_MODEL, label: 'x', efforts: ['low', 'high'] }])).toEqual(['auto', 'low', 'high']);
    expect(reasoningLevels(CHATGPT_MODEL, [])).toEqual(['auto']);
    expect(effectiveEffort({ modelId: CHATGPT_MODEL, reasoningEffort: 'high' }, [{ id: CHATGPT_MODEL, label: 'x' }])).toBe('auto');
    expect(effectiveEffort({ modelId: CHATGPT_MODEL, reasoningEffort: 'high' }, [{ id: CHATGPT_MODEL, label: 'x', efforts: ['high'] }])).toBe('high');
    expect(effectiveEffort({ modelId: CHATGPT_MODEL }, CHATGPT_LISTED)).toBe('auto');
    expect(effectiveEffort({ modelId: CHATGPT_MODEL, reasoningEffort: 'ultra' as 'high' }, CHATGPT_LISTED)).toBe('auto');
    // `reasoning.summary` and `include` are not reasoning-bearing: not compared.
    expect(composite('byok-openai', 'openai/gpt-5', 'auto', { ...OPENAI, reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'] })).toBe('ok');
    expect(composite('chatgpt', CHATGPT_MODEL, 'high', { ...CHATGPT, reasoning: { effort: 'high', summary: 'concise' }, include: ['reasoning.encrypted_content'] })).toBe('ok');
    // The fields each route's body carries, as compared.
    expect(reasoningFieldsOf('byok-anthropic', sentFor('byok-anthropic', 'anthropic/claude-sonnet-5-5', 'low'))).toEqual({ thinking: { type: 'adaptive' }, 'output_config.effort': 'low' });
    expect(reasoningFieldsOf('byok-openai', sentFor('byok-openai', 'openai/gpt-5', 'off'))).toEqual({ 'reasoning.effort': 'minimal' });
    expect(reasoningFieldsOf('gateway', { providerOptions: { openai: { store: false }, google: { thinkingConfig: { thinkingLevel: 'low' } } } })).toEqual({ 'providerOptions.google.thinkingConfig': { thinkingLevel: 'low' } });
    expect(reasoningFieldsOf('gateway', GATEWAY)).toEqual({});
    expect(reasoningFieldsOf('gateway', null)).toEqual({});
    expect(checkReasoning('byok-openai', 'openai/gpt-5', 'auto', 'not json')).toBe(false);
    // The structural check comes first: its reason wins.
    expect(composite('byok-openai', 'openai/gpt-5', 'low', { ...sentFor('byok-openai', 'openai/gpt-5', 'low'), store: true })).toBe('store');
    expect(composite('byok-openai', 'openai/gpt-5', 'low', { ...sentFor('byok-openai', 'openai/gpt-5', 'low'), max_output_tokens: MAX_OUTPUT_TOKENS + 1 })).toBe('output-cap');
    expect(composite('byok-openai', 'openai/gpt-5-mini', 'low', sentFor('byok-openai', 'openai/gpt-5', 'low'))).toBe('model');
    // The bytes answered are the structural check's (the parsed object written back out).
    expect(checkModelRequest('byok-openai', 'openai/gpt-5', 'low', '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":false,"reasoning":{"effort":"high"},"reasoning":{"effort":"low"}}', [])).toEqual({
      ok: true,
      body: '{"model":"gpt-5","max_output_tokens":64,"input":"Hi","store":false,"reasoning":{"effort":"low"}}',
    });
  });

  test('proxy-reasoning-off-maps-to-minimal-on-openai', () => {
    const openaiModels: [ModelRoute, string][] = [
      ...ALLOWED_MODEL_IDS.filter(byProvider('openai')).flatMap((modelId) => [['byok-openai', modelId] as [ModelRoute, string], ['gateway', modelId] as [ModelRoute, string]]),
      ['chatgpt', CHATGPT_MODEL],
    ];
    for (const [route, modelId] of openaiModels) {
      expect(levelsOf(route, modelId), `${route} ${modelId}`).toContain('off');
      expect(reasoningWire(route, modelId, 'off'), `${route} ${modelId}`).toEqual({ openai: { reasoningEffort: 'minimal' } });
      const minimal = sentFor(route, modelId, 'off');
      expect(JSON.stringify(minimal)).toContain('"minimal"');
      for (const effort of REASONING_EFFORTS) expect(composite(route, modelId, effort, minimal), `${route} ${modelId} ${effort}`).toBe(effort === 'off' ? 'ok' : 'reasoning');
      // `off` is a level the request carries, not the provider's default: nothing in its place is refused.
      expect(composite(route, modelId, 'off', plainFor(route, modelId))).toBe('reasoning');
    }
    // `off` itself is never a wire value: the structural allowlist refuses it.
    expect(composite('byok-openai', 'openai/gpt-5', 'off', { ...OPENAI, reasoning: { effort: 'off' } })).toBe('body-field');
    expect(composite('chatgpt', CHATGPT_MODEL, 'off', { ...CHATGPT, reasoning: { effort: 'none' } })).toBe('body-field');
    expect(composite('gateway', 'openai/gpt-5', 'off', gatewayWith({ openai: { store: false, reasoningEffort: 'off' } }))).toBe('provider-options');
    // No other provider offers `off`; its mapping there is nothing.
    for (const modelId of ALLOWED_MODEL_IDS.filter((id) => modelProvider(id) !== 'openai')) {
      expect(MODEL_REASONING_SUPPORT[modelId], modelId).not.toContain('off');
      expect(reasoningWire('gateway', modelId, 'off'), modelId).toEqual({});
    }
  });

  test('proxy-anthropic-adaptive-thinking-within-cap', () => {
    for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider('anthropic'))) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        // Adaptive thinking (thinking within the output) plus the effort: the output cap is the only budget.
        expect(reasoningWire('byok-anthropic', modelId, effort)).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort } });
        expect(reasoningWire('gateway', modelId, effort)).toEqual({ anthropic: { thinking: { type: 'adaptive' }, effort } });
        const byok = sentFor('byok-anthropic', modelId, effort);
        const gateway = sentFor('gateway', modelId, effort);
        expect(composite('byok-anthropic', modelId, effort, { ...byok, max_tokens: MAX_OUTPUT_TOKENS }), `${modelId} ${effort}`).toBe('ok');
        expect(composite('gateway', modelId, effort, { ...gateway, maxOutputTokens: MAX_OUTPUT_TOKENS }), `${modelId} ${effort}`).toBe('ok');
        // Past the cap: the structural check refuses first.
        expect(composite('byok-anthropic', modelId, effort, { ...byok, max_tokens: MAX_OUTPUT_TOKENS + 1 })).toBe('output-cap');
        expect(composite('gateway', modelId, effort, { ...gateway, maxOutputTokens: MAX_OUTPUT_TOKENS + 1 })).toBe('output-cap');
        // A budget instead (`enabled`), the lowest setting (`between_tools`) or no thinking at all: not the mapping.
        expect(composite('byok-anthropic', modelId, effort, { ...byok, thinking: { type: 'enabled', budget_tokens: 1024 } })).toBe('reasoning');
        expect(composite('byok-anthropic', modelId, effort, { ...byok, thinking: { type: 'between_tools' } })).toBe('reasoning');
        expect(composite('byok-anthropic', modelId, effort, { ...byok, thinking: undefined })).toBe('reasoning');
        expect(composite('gateway', modelId, effort, gatewayWith({ openai: { store: false }, anthropic: { thinking: { type: 'enabled', budgetTokens: 1024 }, effort } }))).toBe('reasoning');
        expect(composite('gateway', modelId, effort, gatewayWith({ openai: { store: false }, anthropic: { effort } }))).toBe('reasoning');
        // Extra thinking keys stay refused by the structural check.
        expect(composite('byok-anthropic', modelId, effort, { ...byok, thinking: { type: 'adaptive', display: 'summarized' } })).toBe('body-field');
        expect(composite('gateway', modelId, effort, gatewayWith({ openai: { store: false }, anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort } }))).toBe('output-cap');
      }
    }
  });

  test('proxy-gateway-options-follow-the-model', () => {
    // Each gateway model's request carries its own provider's options and part metadata only, plus
    // the runtime's `openai: { store: false }` (sent on every turn, a no-op for other providers).
    const own: Readonly<Record<ModelProvider, { readonly request: object; readonly part: object | null }>> = {
      anthropic: { request: { anthropic: { sendReasoning: true } }, part: { anthropic: { signature: 's' } } },
      openai: { request: { openai: { store: false, parallelToolCalls: false } }, part: { openai: { itemId: 'rs_1' } } },
      google: { request: { google: {} }, part: { google: { thoughtSignature: 's' } } },
      spacexai: { request: { xai: {} }, part: null },
    };
    expect(Object.keys(GATEWAY_OPTIONS_KEY).sort()).toEqual([...MODEL_PROVIDERS].sort());
    for (const modelId of ALLOWED_MODEL_IDS) {
      const provider = modelProvider(modelId)!;
      const withPart = (providerOptions: object) => ({ ...GATEWAY, prompt: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'x', providerOptions }] }] });
      const onMessage = (providerOptions: object) => ({ ...GATEWAY, prompt: [{ role: 'user', content: [{ type: 'text', text: 'x' }], providerOptions }] });
      expect(composite('gateway', modelId, 'auto', GATEWAY), modelId).toBe('ok');
      expect(composite('gateway', modelId, 'auto', { prompt: GATEWAY.prompt, maxOutputTokens: 1024 }), modelId).toBe(provider === 'openai' ? 'store' : 'ok');
      for (const other of MODEL_PROVIDERS) {
        const expected = other === provider ? 'ok' : 'provider-options';
        const { request, part } = own[other];
        expect(reason('gateway', modelId, gatewayWith({ openai: { store: false }, ...request }), gatewayHeaders(modelId)), `${modelId} ${other} structural`).toBe('ok');
        expect(composite('gateway', modelId, 'auto', gatewayWith({ ...request, openai: { store: false, ...('openai' in request ? (request.openai as object) : {}) } })), `${modelId} ${other} options`).toBe(expected);
        if (part !== null) {
          expect(reason('gateway', modelId, withPart(part), gatewayHeaders(modelId)), `${modelId} ${other} part structural`).toBe('ok');
          expect(composite('gateway', modelId, 'auto', withPart(part)), `${modelId} ${other} part`).toBe(expected);
          expect(composite('gateway', modelId, 'auto', onMessage(part)), `${modelId} ${other} message`).toBe(expected);
        }
      }
      // An empty options object under another provider's key is still another provider's key.
      for (const key of ['anthropic', 'google', 'xai'].filter((key) => key !== GATEWAY_OPTIONS_KEY[provider])) {
        expect(composite('gateway', modelId, 'auto', gatewayWith({ openai: { store: false }, [key]: {} })), `${modelId} ${key}`).toBe('provider-options');
        expect(composite('gateway', modelId, 'auto', withPart({ [key]: {} })), `${modelId} part ${key}`).toBe('provider-options');
      }
    }
  });

  /** What a turn's second request carries back from the scripted first step, per provider. */
  const SECOND_STEP_MARK: Readonly<Record<ModelProvider, string>> = {
    anthropic: 'c2lnbmF0dXJl',
    openai: 'ZW5jcnlwdGVk',
    google: `"providerOptions":{"google":{"thoughtSignature":"${GEMINI_THOUGHT_SIGNATURE}"}}`,
    // Grok's step attaches no metadata: the reasoning text comes back as a part.
    spacexai: '{"type":"reasoning","text":"The audit comes first."}',
  };

  describe('real provider requests', () => {
    beforeEach(() => {
      // A fallback to a real request fails the test.
      vi.stubGlobal('fetch', () => {
        throw new Error('network used');
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    test('proxy-accepts-real-provider-requests (chatgpt: namespaced tools and calls, no output cap)', async () => {
      const modelId = 'chatgpt/gpt-6.1-sol';
      for (const which of [1, 2] as const) {
        // The second request carries the first step's encrypted reasoning and its two calls in the `frost` namespace.
        const request = await captureProviderRequest('chatgpt', modelId, which);
        const headers = filterRequestHeaders('chatgpt', request.headers);
        const sentNames = request.headers.map(([name]) => name.toLowerCase()).filter((name) => name !== 'content-type' && name !== 'authorization');
        expect(headers.map(([name]) => name).sort()).toEqual([...sentNames].sort());
        const text = request.body as string;
        expect(checkModelRequestBody('chatgpt', modelId, text, headers), `request ${which}`).toEqual({ ok: true, body: text });
        const body = JSON.parse(text) as { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
        expect(body.tools).toEqual([expect.objectContaining({ type: 'namespace', name: 'frost' })]);
        expect(body.input.some((item) => item.role === 'system')).toBe(false);
        const calls = body.input.filter((item) => item.type === 'function_call');
        expect(calls.length).toBe(which === 1 ? 2 : 4);
        expect(calls.every((call) => call.namespace === 'frost')).toBe(true);
        if (which === 2) expect(text).toMatch(/ZW5jcnlwdGVk/);
        // Not a request the user's OpenAI key route would send, nor the reverse.
        expect(checkModelRequestBody('byok-openai', 'openai/gpt-5', text).ok).toBe(false);
        expect(checkModelRequestBody('chatgpt', 'chatgpt/gpt-6.1-mini', text, headers)).toEqual({ ok: false, reason: 'model' });
      }
    });

    test('proxy-accepts-real-provider-requests (chatgpt: MCP tools are inside the frost namespace too)', async () => {
      const modelId = 'chatgpt/gpt-6.1-sol';
      const mcp = { name: 'mcp__docs__search', description: 'Untrusted tool from Docs: Searches the docs.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
      const request = await captureProviderRequest('chatgpt', modelId, 1, [mcp as never]);
      const text = request.body as string;
      expect(checkModelRequestBody('chatgpt', modelId, text, filterRequestHeaders('chatgpt', request.headers))).toEqual({ ok: true, body: text });
      const body = JSON.parse(text) as { tools: { type: string; name: string; tools?: { type: string; name: string }[] }[] };
      // One group, the `frost` namespace, holding frost's tools and the MCP tool; nothing at the top level.
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]).toMatchObject({ type: 'namespace', name: 'frost' });
      expect(body.tools[0]!.tools!.map((tool) => [tool.type, tool.name])).toEqual(expect.arrayContaining([['function', 'page_audit'], ['function', mcp.name]]));
      expect(body.tools.some((tool) => tool.name === mcp.name)).toBe(false);
    });

    test('proxy-accepts-real-provider-requests', async () => {
      for (const route of MODEL_ROUTES) {
        for (const modelId of ALLOWED_MODEL_IDS) {
          if (routeModelId(route, modelId) === null) continue;
          for (const which of [1, 2] as const) {
            // The second request carries the first step's reasoning (thinking and its signature,
            // redacted thinking, encrypted reasoning, item ids) and its two tool calls with results.
            const request = await captureProviderRequest(route, modelId, which);
            const headers = filterRequestHeaders(route, request.headers);
            // Every header the provider sends that isn't main's own job is kept as it was sent.
            const sentNames = request.headers.map(([name]) => name.toLowerCase()).filter((name) => name !== 'content-type' && name !== 'ai-gateway-auth-method');
            expect(headers.map(([name]) => name).sort(), `${route} ${modelId}`).toEqual([...sentNames].sort());
            expect(typeof request.body).toBe('string');
            const text = request.body as string;
            if (which === 2) expect(text).toContain(SECOND_STEP_MARK[route === 'byok-openai' ? 'openai' : modelProvider(modelId)!]);
            // The Anthropic provider passes a response's `caller` back on the next step.
            if (which === 2 && modelId.startsWith('anthropic/')) expect(text).toContain('"caller":{"type":"direct"}');
            // Accepted, and sent exactly as the provider wrote it (it writes no repeated key).
            expect(checkModelRequestBody(route, modelId, text, headers), `${route} ${modelId} request ${which}`).toEqual({ ok: true, body: text });
            // The same request is refused under another configured model.
            const other = ALLOWED_MODEL_IDS.find((id) => id !== modelId && routeModelId(route, id) !== null)!;
            expect(checkModelRequestBody(route, other, text, headers)).toEqual({ ok: false, reason: 'model' });
          }
        }
      }
    });

    test('proxy-reasoning-must-match-settings (real requests: today\'s runtime sends no reasoning, so they pass at auto only)', async () => {
      const targets: [ModelRoute, AgentModelId][] = MODEL_ROUTES.flatMap((route) => modelsOf(route).map((modelId) => [route, modelId] as [ModelRoute, AgentModelId]));
      for (const [route, modelId] of targets) {
        for (const which of [1, 2] as const) {
          const request = await captureProviderRequest(route, modelId, which);
          const headers = filterRequestHeaders(route, request.headers);
          const text = request.body as string;
          expect(checkModelRequest(route, modelId, 'auto', text, headers), `${route} ${modelId} request ${which}`).toEqual({ ok: true, body: text });
          for (const effort of levelsOf(route, modelId).filter((level) => level !== 'auto')) {
            expect(checkModelRequest(route, modelId, effort, text, headers), `${route} ${modelId} ${effort}`).toEqual({ ok: false, reason: 'reasoning' });
          }
        }
      }
    });
  });
});
