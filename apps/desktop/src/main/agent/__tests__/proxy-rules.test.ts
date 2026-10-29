// Spec: specs/agent-proxy.spec.ts (REQUEST_HEADER_ALLOWLIST, filterRequestHeaders, mainRequestHeaders,
// RESPONSE_HEADER_ALLOWLIST, filterResponseHeaders, sanitizeStatusText, BODY_FIELDS, checkModelRequestBody)
// Acceptance: specs/agent-host.feature.md (Proxy rules)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkModelRequestBody, filterRequestHeaders, filterResponseHeaders, mainRequestHeaders, MAX_OUTPUT_TOKENS, sanitizeStatusText } from '@app/specs/agent-proxy.spec';
import { ALLOWED_MODEL_IDS, MODEL_ROUTES, routeModelId, type ModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { captureProviderRequest } from './provider-capture';

const ANTHROPIC = { model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], stream: true };
const OPENAI = { model: 'gpt-5', max_output_tokens: 1024, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], store: false, stream: true };
const GATEWAY = { maxOutputTokens: 1024, prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }], providerOptions: { openai: { store: false } } };
const GATEWAY_HEADERS: [string, string][] = [['ai-language-model-id', 'anthropic/claude-sonnet-5-5']];

const body = (value: object) => JSON.stringify(value);
const reason = (route: ModelRoute, modelId: string, value: object, headers: [string, string][] = route === 'gateway' ? GATEWAY_HEADERS : []) => {
  const check = checkModelRequestBody(route, modelId, body(value), headers);
  return check.ok ? 'ok' : check.reason;
};

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

  describe('real provider requests', () => {
    beforeEach(() => {
      // A fallback to a real request fails the test.
      vi.stubGlobal('fetch', () => {
        throw new Error('network used');
      });
    });
    afterEach(() => vi.unstubAllGlobals());

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
            if (which === 2) expect(text).toMatch(route === 'byok-openai' || modelId.startsWith('openai/') ? /ZW5jcnlwdGVk/ : /c2lnbmF0dXJl/);
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
  });
});
