// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_ENDPOINTS, CHATGPT_SCOPE, isChatgptRedirectUri,
// isChatgptModelId, chatgptErrorReason, CHATGPT_REFRESH_FAILURE_CODES, planUsageOf,
// CHATGPT_FORBIDDEN_BODY_FIELDS), specs/agent-chatgpt.schema.ts (ChatgptStoredStateSchema,
// ChatgptTokenAnswerSchema, earliestRefreshAtMs), specs/agent-tools.spec.ts (MODEL_ROUTES, routeModelId,
// MODEL_REQUESTS), specs/agent-proxy.spec.ts (REQUEST_HEADER_ALLOWLIST, BODY_FIELDS,
// checkModelRequestBody, mainRequestHeaders, routeCredentialSlot), specs/agent-ipc.schema.ts
// · specs/agent-chatgpt.spec.ts (CHATGPT_ADVERTISED_EFFORTS, CHATGPT_ADVERTISED_EFFORTS_FIELD,
// CHATGPT_EFFORTS_ENTRY_MAX_BYTES, advertisedEfforts, isChatgptModelView), specs/agent-chatgpt.schema.ts
// (ChatgptModelEntrySchema), specs/agent-reasoning.spec.ts (REASONING_EFFORTS): Phase 8 Task 8a
// Acceptance: specs/agent-chatgpt.feature.md (Route) · plan docs/plans/agent-chatgpt-plan.md, Task 1
import { describe, expect, test } from 'vitest';
import {
  advertisedEfforts,
  CHATGPT_ADVERTISED_EFFORTS,
  CHATGPT_ADVERTISED_EFFORTS_FIELD,
  CHATGPT_EFFORTS_ENTRY_MAX_BYTES,
  CHATGPT_ENDPOINTS,
  CHATGPT_ERROR_CODE_REASONS,
  CHATGPT_FORBIDDEN_BODY_FIELDS,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_REFRESH_FAILURE_CODES,
  CHATGPT_SCOPE,
  CHATGPT_TOOL_NAMESPACE,
  chatgptAnswerFailure,
  chatgptErrorReason,
  chatgptFailureMessage,
  chatgptModelId,
  chatgptStreamFailure,
  CHATGPT_ERROR_MESSAGES,
  isChatgptModelView,
  isChatgptAuthorizeUrl,
  isChatgptHostId,
  isChatgptModelId,
  isChatgptRedirectUri,
  isIssuedClientId,
  isRefreshFailureCode,
  planUsageOf,
} from '@app/specs/agent-chatgpt.spec';
import { ChatgptModelEntrySchema, ChatgptStoredStateSchema, ChatgptTokenAnswerSchema, EMPTY_CHATGPT_STATE, earliestRefreshAtMs } from '@app/specs/agent-chatgpt.schema';
import { REASONING_EFFORTS } from '@app/specs/agent-reasoning.spec';
import { AgentChatgptSignInInputSchema, AgentSetModelInputSchema } from '@app/specs/agent-ipc.schema';
import { AGENT_ROUTE_LABELS } from '@app/specs/agent-panel.spec';
import { BODY_FIELDS, checkModelRequestBody, filterRequestHeaders, isUsableModelSettings, isValidModelSettings, mainRequestHeaders, REQUEST_HEADER_ALLOWLIST, routeCredentialSlot } from '@app/specs/agent-proxy.spec';
import { historyBudgetChars, modelContextWindow, DEFAULT_CONTEXT_WINDOW_TOKENS } from '@app/specs/agent-session.spec';
import { AGENT_PROTOCOL_VERSION, ChatStartMessageSchema } from '@app/specs/agent-protocol.schema';
import { isAgentModelId, isAllowedModelRequest, isCanonicalUrl, KEY_ROUTES, MODEL_REQUESTS, MODEL_ROUTES, routeModelId } from '@app/specs/agent-tools.spec';

const MODEL = 'chatgpt/gpt-6.1-sol';

/** A body the runtime would send on the route (Task 4 builds it): store off, streaming, one namespaced tool. */
function body(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-6.1-sol',
    input: [
      { role: 'developer', content: 'You are frost.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Audit this page' }] },
      { type: 'function_call', call_id: 'c1', name: 'page_audit', arguments: '{}', namespace: 'frost' },
      { type: 'function_call_output', call_id: 'c1', output: '{"untrusted":true}' },
    ],
    store: false,
    stream: true,
    tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description, tools: [{ type: 'function', name: 'page_audit', description: 'Read', parameters: { type: 'object' }, strict: false }] }],
    tool_choice: 'auto',
    ...changes,
  });
}

describe('chatgpt spec', () => {
  test('chatgpt-route-endpoint', () => {
    for (const url of Object.values(CHATGPT_ENDPOINTS)) expect(isCanonicalUrl(url) || url === CHATGPT_ENDPOINTS.issuer, url).toBe(true);
    expect(MODEL_ROUTES).toContain('chatgpt');
    expect(KEY_ROUTES).not.toContain('chatgpt');
    expect(MODEL_REQUESTS.chatgpt).toEqual([{ method: 'POST', url: CHATGPT_ENDPOINTS.responses }]);
    expect(isAllowedModelRequest('chatgpt', 'POST', CHATGPT_ENDPOINTS.responses)).toBe(true);
    expect(isAllowedModelRequest('chatgpt', 'GET', CHATGPT_ENDPOINTS.models)).toBe(false);
    expect(isAllowedModelRequest('chatgpt', 'POST', 'https://chatgpt.com/backend-api/codex/responses')).toBe(false);
    expect(AGENT_ROUTE_LABELS.chatgpt).toBe('ChatGPT plan');
    expect(routeCredentialSlot('chatgpt')).toBeNull();
    expect(routeCredentialSlot('byok-openai')).toBe('openai');
  });

  test('chatgpt-authorize-constants', () => {
    expect(CHATGPT_SCOPE).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(isChatgptRedirectUri('http://127.0.0.1:1455/auth/callback')).toBe(true);
    for (const uri of ['http://localhost:1455/auth/callback', 'http://127.0.0.1:1455/callback', 'https://127.0.0.1:1455/auth/callback', 'http://127.0.0.1:80/auth/callback', 'http://127.0.0.1:1455/auth/callback?x=1', 'http://127.0.0.1:01455/auth/callback']) {
      expect(isChatgptRedirectUri(uri), uri).toBe(false);
    }
    expect(isChatgptHostId('urn:uuid:3f1c2a9e-8b7d-4c6e-9f1a-0b2c3d4e5f60')).toBe(true);
    expect(isChatgptHostId('urn:uuid:3F1C2A9E-8B7D-4C6E-9F1A-0B2C3D4E5F60')).toBe(false);
    expect(isChatgptHostId('urn:uuid:3f1c2a9e-8b7d-1c6e-9f1a-0b2c3d4e5f60')).toBe(false);
    expect(isIssuedClientId('oaiapp_EHBV7pzdMtehZ7j6Ypgyje-F')).toBe(true);
    expect(isIssuedClientId('dynamic_agent_client')).toBe(false);
    expect(isIssuedClientId('oaiapp bad')).toBe(false);
  });

  test('chatgpt-route-model-ids', () => {
    expect(isChatgptModelId(MODEL)).toBe(true);
    expect(chatgptModelId('gpt-6.1-sol')).toBe(MODEL);
    for (const bad of ['chatgpt/', 'chatgpt/-x', 'chatgpt/a b', 'chatgpt/a/b', 'openai/gpt-5', `chatgpt/${'a'.repeat(65)}`, 42, null]) expect(isChatgptModelId(bad), String(bad)).toBe(false);
    expect(chatgptModelId('../x')).toBeNull();
    expect(routeModelId('chatgpt', MODEL)).toBe('gpt-6.1-sol');
    expect(routeModelId('chatgpt', 'openai/gpt-5')).toBeNull();
    for (const route of KEY_ROUTES) expect(routeModelId(route, MODEL), route).toBeNull();
    expect(isAgentModelId(MODEL)).toBe(true);
    expect(isAgentModelId('anthropic/claude-opus-5-5')).toBe(true);
    expect(isAgentModelId('chatgpt/../x')).toBe(false);
    expect(isValidModelSettings({ route: 'chatgpt', modelId: MODEL })).toBe(true);
    expect(isValidModelSettings({ route: 'chatgpt', modelId: 'openai/gpt-5' })).toBe(false);
    expect(isValidModelSettings({ route: 'byok-openai', modelId: MODEL })).toBe(false);
    expect(isValidModelSettings({ route: 'codex', modelId: MODEL })).toBe(false);
    // A ChatGPT model has no published window: the default is assumed.
    expect(modelContextWindow(MODEL)).toBeNull();
    expect(historyBudgetChars(MODEL)).toBe(historyBudgetChars('openai/gpt-5'));
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBeGreaterThan(0);
  });

  test('chatgpt-route-headers', () => {
    expect(Object.keys(REQUEST_HEADER_ALLOWLIST.chatgpt).sort()).toEqual(Object.keys(REQUEST_HEADER_ALLOWLIST['byok-openai']).sort());
    const kept = filterRequestHeaders('chatgpt', [
      ['User-Agent', 'ai-sdk-openai/4.0.104'],
      ['OpenAI-Organization', 'org-1'],
      ['OpenAI-Project', 'proj-1'],
      ['Authorization', 'Bearer stolen'],
      ['Cookie', 'a=b'],
    ]);
    expect(kept).toEqual([['user-agent', 'ai-sdk-openai/4.0.104']]);
    expect(mainRequestHeaders('chatgpt', 'access-token')).toEqual([
      ['content-type', 'application/json'],
      ['authorization', 'Bearer access-token'],
    ]);
  });

  test('chatgpt-route-body', () => {
    for (const field of CHATGPT_FORBIDDEN_BODY_FIELDS) expect(BODY_FIELDS.chatgpt, field).not.toContain(field);
    const ok = checkModelRequestBody('chatgpt', MODEL, body());
    expect(ok.ok).toBe(true);
    expect(checkModelRequestBody('chatgpt', 'chatgpt/other', body())).toEqual({ ok: false, reason: 'model' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ store: true }))).toEqual({ ok: false, reason: 'store' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ store: undefined }))).toEqual({ ok: false, reason: 'store' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ stream: false }))).toEqual({ ok: false, reason: 'body-field' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ stream: undefined }))).toEqual({ ok: false, reason: 'body-field' });
    for (const field of CHATGPT_FORBIDDEN_BODY_FIELDS) expect(checkModelRequestBody('chatgpt', MODEL, body({ [field]: 1 })), field).toEqual({ ok: false, reason: 'body-field' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: 'hello' }))).toEqual({ ok: false, reason: 'content' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: [{ role: 'system', content: 'x' }] }))).toEqual({ ok: false, reason: 'content' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: [{ type: 'function_call', call_id: 'c', name: 'n', arguments: '{}', namespace: 'other' }] }))).toEqual({ ok: false, reason: 'content' });
    // Tools: only namespace groups, only `frost`, only plain function tools inside.
    const fn = { type: 'function', name: 'page_audit', description: 'd', parameters: { type: 'object' } };
    expect(checkModelRequestBody('chatgpt', MODEL, body({ tools: [fn] }))).toEqual({ ok: false, reason: 'tool' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ tools: [{ type: 'namespace', name: 'other', description: 'd', tools: [fn] }] }))).toEqual({ ok: false, reason: 'tool' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ tools: [{ type: 'namespace', name: 'frost', description: 'd', tools: [{ type: 'web_search' }] }] }))).toEqual({ ok: false, reason: 'tool' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ tools: [{ type: 'mcp', server_url: 'https://x' }] }))).toEqual({ ok: false, reason: 'tool' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ tool_choice: { type: 'function', name: 'page_audit' } }))).toEqual({ ok: false, reason: 'tool' });
    // A byok-openai body (with its output cap) is not a ChatGPT body.
    expect(checkModelRequestBody('chatgpt', MODEL, body({ max_output_tokens: 1000 }))).toEqual({ ok: false, reason: 'body-field' });
  });

  test('chatgpt-route-body (a byok-openai body and a chatgpt body never pass each other\'s checks)', () => {
    // Both routes share one URL and may share a slug (`openai/gpt-5`, `chatgpt/gpt-5`). The rules keep
    // them apart by shape: the key route requires an output cap, the plan forbids one.
    expect(BODY_FIELDS.chatgpt).not.toContain('max_output_tokens');
    expect(BODY_FIELDS['byok-openai']).toContain('max_output_tokens');
    const fn = { type: 'function', name: 'page_audit', description: 'd', parameters: { type: 'object' }, strict: false };
    const namespaced = [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description, tools: [fn] }];
    const user = { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] };
    const variants = {
      max_output_tokens: [undefined, 1024],
      stream: [undefined, true, false],
      tools: [undefined, [], [fn], namespaced],
      input: ['Hi', [user], [{ role: 'system', content: 'x' }, user], [{ role: 'developer', content: 'x' }, user]],
      tool_choice: [undefined, 'auto', { type: 'function', name: 'page_audit' }],
      include: [undefined, ['reasoning.encrypted_content']],
    } as const;
    const keys = Object.keys(variants) as (keyof typeof variants)[];
    let combos: Record<string, unknown>[] = [{ model: 'gpt-5', store: false }];
    for (const key of keys) combos = combos.flatMap((combo) => variants[key].map((value) => (value === undefined ? combo : { ...combo, [key]: value })));
    let byok = 0;
    let plan = 0;
    for (const combo of combos) {
      const text = JSON.stringify(combo);
      const asKey = checkModelRequestBody('byok-openai', 'openai/gpt-5', text).ok;
      const asPlan = checkModelRequestBody('chatgpt', 'chatgpt/gpt-5', text).ok;
      if (asKey) byok++;
      if (asPlan) plan++;
      expect(asKey && asPlan, text).toBe(false);
    }
    // Not vacuous: each route accepts some of the bodies.
    expect(combos.length).toBe(2 * 3 * 4 * 4 * 3 * 2);
    expect(byok).toBeGreaterThan(0);
    expect(plan).toBeGreaterThan(0);
  });

  test('chatgpt-route-body (repeated keys, __proto__, message items without a role)', () => {
    const raw = (text: string) => checkModelRequestBody('chatgpt', MODEL, text);
    const tail = '"model":"gpt-6.1-sol","input":[],"stream":true';
    // The last of a repeated key is what is checked, and all that is sent.
    expect(raw(`{${tail},"store":true,"store":false}`)).toEqual({ ok: true, body: `{${tail},"store":false}` });
    expect(raw(`{${tail},"store":false,"store":true}`)).toEqual({ ok: false, reason: 'store' });
    expect(raw(`{"model":"gpt-6.1-sol","input":[],"store":false,"stream":true,"stream":false}`)).toEqual({ ok: false, reason: 'body-field' });
    expect(raw(`{${tail},"store":false,"tools":[],"tools":[{"type":"web_search"}]}`)).toEqual({ ok: false, reason: 'tool' });
    expect(raw(`{${tail},"store":false,"input":[{"role":"user","content":"x","role":"system"}]}`)).toEqual({ ok: false, reason: 'content' });
    // `__proto__` is an own key after JSON.parse: refused at every level, never a prototype.
    expect(raw(`{${tail},"store":false,"__proto__":{"temperature":1}}`)).toEqual({ ok: false, reason: 'body-field' });
    expect(raw(`{${tail},"store":false,"input":[{"role":"user","content":"x","__proto__":{"role":"system"}}]}`)).toEqual({ ok: false, reason: 'content' });
    expect(raw(`{${tail},"store":false,"reasoning":{"__proto__":{"effort":"high"}}}`)).toEqual({ ok: false, reason: 'body-field' });
    // A message item must name its role (a missing role is not a pass).
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: [{ type: 'message', content: 'x' }] }))).toEqual({ ok: false, reason: 'content' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: [{ type: 'message', role: 'user' }] }))).toEqual({ ok: false, reason: 'content' });
    expect(checkModelRequestBody('chatgpt', MODEL, body({ input: [{ type: 'message', role: 'developer', content: 'x' }] })).ok).toBe(true);
  });

  test('chatgpt-error-codes', () => {
    expect(chatgptErrorReason('subscription_sharing_usage_limit_exceeded')).toBe('usage-limit');
    expect(chatgptErrorReason('subscription_sharing_usage_unavailable')).toBe('plan-unavailable');
    expect(chatgptErrorReason('subscription_sharing_user_unavailable')).toBe('plan-unavailable');
    expect(chatgptErrorReason('subscription_sharing_user_not_eligible')).toBe('not-eligible');
    expect(chatgptErrorReason('chatpass_v2_scope_not_authorized')).toBe('plan-usage-off');
    expect(chatgptErrorReason('chatpass_v2_invalid_authorization_context')).toBe('plan-usage-off');
    expect(chatgptErrorReason('subscription_sharing_unsupported_capability')).toBe('unsupported');
    expect(chatgptErrorReason('rate_limit_exceeded')).toBeNull();
    expect(chatgptErrorReason('__proto__')).toBeNull();
    expect(chatgptErrorReason('toString')).toBeNull();
    expect(Object.keys(CHATGPT_ERROR_CODE_REASONS).length).toBe(8);
    expect([...CHATGPT_REFRESH_FAILURE_CODES]).toEqual(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
    expect(isRefreshFailureCode('invalid_client')).toBe(false);
    expect(planUsageOf('openid email offline_access')).toBe('declined');
    expect(planUsageOf(`openid ${CHATGPT_PLAN_SCOPE}`)).toBe('on');
    expect(planUsageOf([CHATGPT_PLAN_SCOPE])).toBe('on');
  });

  test('chatgpt-error-codes (answers, streamed failures, direct admission)', () => {
    // Each documented code, at its documented status.
    const cases: [string, number, string][] = [
      ['subscription_sharing_usage_limit_exceeded', 429, 'usage-limit'],
      ['subscription_sharing_usage_unavailable', 503, 'plan-unavailable'],
      ['subscription_sharing_user_unavailable', 503, 'plan-unavailable'],
      ['subscription_sharing_user_not_eligible', 403, 'not-eligible'],
      ['chatpass_v2_scope_not_authorized', 403, 'plan-usage-off'],
      ['chatpass_v2_invalid_authorization_context', 403, 'plan-usage-off'],
      ['subscription_sharing_unsupported_capability', 400, 'unsupported'],
      ['subscription_sharing_route_not_supported', 403, 'unsupported'],
    ];
    for (const [code, status, reason] of cases) {
      expect(chatgptAnswerFailure(status, { error: { code, message: 'details', type: 'invalid_request_error' } }), code).toEqual({ reason });
      expect(chatgptStreamFailure({ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code, message: 'x' } } }), code).toEqual({ reason });
      expect(chatgptStreamFailure({ type: 'error', code, message: 'x' }), code).toEqual({ reason });
      expect(chatgptStreamFailure({ type: 'error', error: { code, message: 'x' } }), code).toEqual({ reason });
    }
    // `unsupported` carries a well-formed `param` (the bug report needs it); nothing else does.
    expect(chatgptAnswerFailure(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type' } })).toEqual({ reason: 'unsupported', param: 'tools[0].type' });
    expect(chatgptAnswerFailure(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'a b\u202e' } })).toEqual({ reason: 'unsupported' });
    expect(chatgptAnswerFailure(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'x'.repeat(129) } })).toEqual({ reason: 'unsupported' });
    // `param` is a field path only: letters, digits, `_`, `.`, `[`, `]` (128 at most); no quote, URL, space or value.
    for (const param of ['input.3.content', 'tools[0].tools[1].strict', 'parallel_tool_calls', 'x'.repeat(128)]) {
      expect(chatgptAnswerFailure(400, { error: { code: 'subscription_sharing_unsupported_capability', param } }), param).toEqual({ reason: 'unsupported', param });
    }
    for (const param of ['https://evil.example/x', 'a"b', "it's", 'tools[0] ', '<b>x</b>', 'model=gpt-5', 'a/b', '', 'café']) {
      expect(chatgptAnswerFailure(400, { error: { code: 'subscription_sharing_unsupported_capability', param } }), param).toEqual({ reason: 'unsupported' });
    }
    expect(chatgptAnswerFailure(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'model' } })).toEqual({ reason: 'usage-limit' });
    expect(chatgptFailureMessage({ reason: 'unsupported', param: 'tools[0].type' })).toBe(`${CHATGPT_ERROR_MESSAGES.unsupported} (tools[0].type)`);
    expect(chatgptFailureMessage({ reason: 'usage-limit' })).toBe(CHATGPT_ERROR_MESSAGES['usage-limit']);
    // Direct admission (`{ detail }`, no code): by status; the text is never used.
    expect(chatgptAnswerFailure(401, { detail: 'Unauthorized' })).toEqual({ reason: 'plan-usage-off' });
    expect(chatgptAnswerFailure(403, { detail: 'Region not supported' })).toEqual({ reason: 'not-eligible' });
    expect(chatgptAnswerFailure(503, { detail: 'Direct routing unavailable' })).toEqual({ reason: 'plan-unavailable' });
    expect(chatgptAnswerFailure(500, { detail: 'oops' })).toBeNull();
    // Anything else: an ordinary failure.
    for (const [status, body] of [
      [429, { error: { code: 'rate_limit_exceeded' } }],
      [400, { error: { code: '__proto__' } }],
      [401, { error: { code: 'subscription_sharing_invalid_user' } }],
      [403, { error: 'subscription_sharing_user_not_eligible' }],
      [200, { error: { code: 'subscription_sharing_usage_limit_exceeded' } }],
      [403, 'subscription_sharing_user_not_eligible'],
      [403, null],
      [403, [{ error: { code: 'subscription_sharing_user_not_eligible' } }]],
    ] as const) {
      expect(chatgptAnswerFailure(status, body), JSON.stringify([status, body])).toBeNull();
    }
    for (const event of [{ type: 'response.completed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }, { type: 'response.failed' }, { type: 'response.failed', response: { error: null } }, null, 'error']) {
      expect(chatgptStreamFailure(event), JSON.stringify(event)).toBeNull();
    }
  });

  test('chatgpt-model-list-persisted (entries and usable settings)', () => {
    const listed = [{ id: MODEL, label: 'GPT-6.1 Sol' }] as const;
    expect(isChatgptModelView(listed[0])).toBe(true);
    for (const bad of [{ id: MODEL }, { id: MODEL, label: '' }, { id: MODEL, label: ' padded ' }, { id: MODEL, label: 'a\u202eb' }, { id: MODEL, label: 'x'.repeat(201) }, { id: 'openai/gpt-5', label: 'x' }, { id: MODEL, label: 'x', extra: 1 }, [MODEL, 'x'], null]) {
      expect(isChatgptModelView(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isUsableModelSettings({ route: 'chatgpt', modelId: MODEL }, listed)).toBe(true);
    expect(isUsableModelSettings({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' }, listed)).toBe(false);
    expect(isUsableModelSettings({ route: 'chatgpt', modelId: MODEL }, [])).toBe(false);
    expect(isUsableModelSettings({ route: 'byok-openai', modelId: 'openai/gpt-5' }, [])).toBe(true);
    expect(isUsableModelSettings({ route: 'byok-openai', modelId: MODEL }, listed)).toBe(false);
  });

  test('chatgpt-schemas', () => {
    expect(ChatgptStoredStateSchema.parse(EMPTY_CHATGPT_STATE)).toEqual(EMPTY_CHATGPT_STATE);
    expect(ChatgptStoredStateSchema.safeParse({ ...EMPTY_CHATGPT_STATE, extra: 1 }).success).toBe(false);
    expect(ChatgptStoredStateSchema.safeParse({ ...EMPTY_CHATGPT_STATE, clientId: 'dynamic_agent_client' }).success).toBe(false);
    const answer = ChatgptTokenAnswerSchema.safeParse({ access_token: 'a', refresh_token: 'r', id_token: 'i', token_type: 'Bearer', expires_in: 3600, scope: CHATGPT_SCOPE, earliest_refresh_at: 1_790_000_000, other: true });
    expect(answer.success).toBe(true);
    expect(ChatgptTokenAnswerSchema.safeParse({ access_token: 'a b', token_type: 'Bearer', expires_in: 3600 }).success).toBe(false);
    expect(ChatgptTokenAnswerSchema.safeParse({ access_token: 'a', token_type: 'mac', expires_in: 3600 }).success).toBe(false);
    expect(earliestRefreshAtMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(earliestRefreshAtMs('2026-10-29T12:00:00Z')).toBe(Date.parse('2026-10-29T12:00:00Z'));
    expect(earliestRefreshAtMs('soon')).toBeNull();
    expect(earliestRefreshAtMs(undefined)).toBeNull();
  });

  test('chatgpt-ipc-and-protocol-inputs', () => {
    expect(AgentChatgptSignInInputSchema.safeParse({}).success).toBe(true);
    expect(AgentChatgptSignInInputSchema.safeParse({ reconsent: true }).success).toBe(true);
    expect(AgentChatgptSignInInputSchema.safeParse({ reconsent: true, clientId: 'x' }).success).toBe(false);
    expect(AgentChatgptSignInInputSchema.safeParse({ differentAccount: true }).success).toBe(true);
    expect(AgentChatgptSignInInputSchema.safeParse({ differentAccount: 'yes' }).success).toBe(false);
    // Main opens only the authorize page with a query, never another URL.
    expect(isChatgptAuthorizeUrl(`${CHATGPT_ENDPOINTS.authorize}?response_type=code`)).toBe(true);
    for (const url of [CHATGPT_ENDPOINTS.authorize, `${CHATGPT_ENDPOINTS.authorize}/x?y`, `${CHATGPT_ENDPOINTS.authorize}#x`, 'https://chatgpt.com/settings/usage', `https://auth.openai.com.evil.example/api/accounts/authorize?x`, `${CHATGPT_ENDPOINTS.authorize}?${'a'.repeat(9000)}`, null]) {
      expect(isChatgptAuthorizeUrl(url), String(url).slice(0, 80)).toBe(false);
    }
    expect(AgentSetModelInputSchema.safeParse({ route: 'chatgpt', modelId: MODEL }).success).toBe(true);
    expect(AgentSetModelInputSchema.safeParse({ route: 'chatgpt', modelId: 'openai/gpt-5' }).success).toBe(false);
    expect(AgentSetModelInputSchema.safeParse({ route: 'gateway', modelId: MODEL }).success).toBe(false);
    expect(AgentSetModelInputSchema.safeParse({ route: 'chatgpt', modelId: `chatgpt/${'a'.repeat(200)}` }).success).toBe(false);
    const start = { type: 'chat.start', chatId: 'c1', messages: [{ role: 'user', content: 'hi' }], systemPrompt: 's', modelId: MODEL, route: 'chatgpt', allowedTools: [], mcpTools: [], reasoningEffort: 'auto' };
    const parsed = ChatStartMessageSchema.safeParse(start);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // `chat.start` accepts the `chatgpt` route and `chatgpt/<slug>` ids since version 7 (8 added the
    // reasoning level, Phase 8 Task 8b): a runtime from before them is refused.
    expect(AGENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
  });

  test('chatgpt-model-entry-efforts-parsed', () => {
    // The levels the route may advertise, in order: not `auto` (always implied, never stored) and not
    // `off` (its wire value, `minimal`, is dropped by the installed OpenAI provider for GPT-6 slugs,
    // so the request would carry no level and be refused every time; Task 8a fix round 1).
    expect(CHATGPT_ADVERTISED_EFFORTS).toEqual(REASONING_EFFORTS.filter((effort) => effort !== 'auto' && effort !== 'off'));
    expect(CHATGPT_ADVERTISED_EFFORTS).toEqual(['low', 'medium', 'high']);
    expect(CHATGPT_ADVERTISED_EFFORTS_FIELD).toBe('supported_reasoning_levels');
    const entry = { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' };
    const parse = (value: unknown) => {
      const parsed = ChatgptModelEntrySchema.safeParse({ ...entry, [CHATGPT_ADVERTISED_EFFORTS_FIELD]: value });
      expect(parsed.success, JSON.stringify(value)).toBe(true);
      return parsed.data!;
    };
    // Known values kept, in `REASONING_EFFORTS` order; duplicates, `auto` and unknown values dropped.
    expect(parse(['high', 'low', 'high', 'auto', 'xhigh', 'medium', 'off', 'minimal', 'none', 'LOW'])).toEqual({ ...entry, efforts: ['low', 'medium', 'high'] });
    // An entry advertising `off` keeps no `off`.
    expect(parse(['off', { effort: 'off' }])).toEqual(entry);
    expect(parse(['off', 'low']).efforts).toEqual(['low']);
    // Entries as objects with an `effort` string are read too; anything else is skipped.
    expect(parse([{ effort: 'medium', description: 'Balanced' }, { effort: 'low' }, { effort: 3 }, { level: 'off' }, 'high', null, 7, ['off']]).efforts).toEqual(['low', 'medium', 'high']);
    // At most 3, however long the list.
    expect(parse(Array.from({ length: 1000 }, (_, i) => REASONING_EFFORTS[i % REASONING_EFFORTS.length])).efforts).toEqual(['low', 'medium', 'high']);
    // Empty, absent, only unknown or malformed: no `efforts` key (Auto only), and the entry is still kept.
    for (const value of [[], ['auto'], ['xhigh', 'none'], 'high', { low: true }, null, 42]) expect(parse(value), JSON.stringify(value)).toEqual(entry);
    const absent = ChatgptModelEntrySchema.safeParse(entry);
    expect(absent.success).toBe(true);
    expect(absent.data).toEqual(entry);
    expect(advertisedEfforts(undefined)).toEqual([]);
    expect(advertisedEfforts(['medium', 'off', 'low'])).toEqual(['low', 'medium']);

    // The view: 2 keys, or 3 when `efforts` is a non-empty list of distinct advertised levels in order.
    const id = MODEL;
    expect(isChatgptModelView({ id, label: 'Sol' })).toBe(true);
    expect(isChatgptModelView({ id, label: 'Sol', efforts: ['low', 'high'] })).toBe(true);
    expect(isChatgptModelView({ id, label: 'Sol', efforts: [...CHATGPT_ADVERTISED_EFFORTS] })).toBe(true);
    for (const efforts of [['low', 'low'], ['low', 'xhigh'], ['auto', 'low'], ['off'], ['off', 'low', 'medium', 'high'], ['low', 'medium', 'high', 'high'], [], ['high', 'low'], 'low', [1], null, { 0: 'low' }]) {
      expect(isChatgptModelView({ id, label: 'Sol', efforts }), JSON.stringify(efforts)).toBe(false);
    }
    expect(isChatgptModelView({ id, label: 'Sol', efforts: ['low'], extra: 1 })).toBe(false);
    expect(isChatgptModelView({ id, efforts: ['low'] })).toBe(false);
    // The worst case fits the per-entry room the settings file keeps for it.
    const worst = JSON.stringify({ id, label: 'Sol', efforts: CHATGPT_ADVERTISED_EFFORTS }).length - JSON.stringify({ id, label: 'Sol' }).length;
    expect(worst).toBe(',"efforts":["low","medium","high"]'.length);
    expect(worst).toBeLessThanOrEqual(CHATGPT_EFFORTS_ENTRY_MAX_BYTES);
  });
});
