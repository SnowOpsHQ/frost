// Spec: specs/agent-tools.spec.ts (AGENT_TOOLS, isMcpToolName, toolRisk, isGrantable, the caps,
// ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, MODEL_PROVIDERS, GATEWAY_ONLY_PROVIDERS, byProvider, routeModelId,
// MODEL_REQUESTS, isAllowedModelRequest, isCanonicalUrl)
// Acceptance: specs/agent-protocol.feature.md (Catalogue)
import { describe, expect, test } from 'vitest';
import {
  AGENT_TOOL_INPUT_LIMITS,
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  ALLOWED_MODEL_IDS,
  BYOK_ROUTE_PROVIDER,
  byProvider,
  CHAT_MAX_MESSAGES,
  DEFAULT_MODEL_ID,
  EXECUTE_JS_MAX_RESULT_BYTES,
  EXECUTE_JS_MAX_SOURCE_CHARS,
  EXECUTE_JS_TIMEOUT_MS,
  GATEWAY_ONLY_PROVIDERS,
  isAgentToolName,
  isAllowedModelId,
  isAllowedModelRequest,
  isCanonicalUrl,
  isGrantable,
  isMcpToolName,
  MAX_TOOL_STEPS,
  MODEL_PROVIDERS,
  MODEL_REQUESTS,
  MODEL_ROUTES,
  routeModelId,
  TOOL_NAME_PATTERN,
  TOOL_RESULT_MAX_CHARS,
  toolRisk,
} from '@app/specs/agent-tools.spec';

describe('agent tool catalogue', () => {
  test('catalogue-risk-classes', () => {
    expect(Object.keys(AGENT_TOOLS).sort()).toStrictEqual([...AGENT_TOOL_NAMES].sort());
    for (const name of AGENT_TOOL_NAMES) {
      const tool = AGENT_TOOLS[name];
      expect(tool.name).toBe(name);
      expect(name).toMatch(TOOL_NAME_PATTERN);
      expect(tool.label.trim()).not.toBe('');
      expect(tool.label).not.toContain('\n');
      expect(toolRisk(name)).toBe(tool.risk);
      expect(isGrantable(name)).toBe(tool.grantable);
      if (tool.risk === 'read' || name === 'navigate' || name === 'click' || name === 'run_visibility_probes') expect(tool.grantable).toBe(true);
      else expect(tool.grantable).toBe(false);
    }
    // An AI answer engine gets model-chosen text and may fetch URLs: it asks every call.
    expect(AGENT_TOOLS.run_ai_search.risk).toBe('act');
    expect(AGENT_TOOLS.run_ai_search.grantable).toBe(false);
    expect(isGrantable('run_ai_search')).toBe(false);
    expect(AGENT_TOOLS.navigate.risk).toBe('act');
    expect(AGENT_TOOLS.click.risk).toBe('act');
    expect(AGENT_TOOLS.execute_javascript.risk).toBe('execute');
    expect(AGENT_TOOLS.execute_javascript.grantable).toBe(false);
    // Running the probes fetches the page as crawlers would: it asks unless a grant for the page's origin exists.
    expect(AGENT_TOOLS.run_visibility_probes.risk).toBe('act');
    for (const name of ['page_audit', 'page_data', 'page_text', 'serp_results', 'search_intent', 'gsc_performance', 'visibility_probes'] as const) {
      expect(AGENT_TOOLS[name].risk).toBe('read');
    }
    expect(Object.values(AGENT_TOOLS).some((tool) => tool.risk === 'external')).toBe(false);
  });

  test('mcp-tools-are-external', () => {
    for (const name of ['mcp__docs__search', 'mcp__my-server__get_page', 'mcp__a1__b']) {
      expect(isMcpToolName(name)).toBe(true);
      expect(isAgentToolName(name)).toBe(false);
      expect(toolRisk(name)).toBe('external');
      expect(isGrantable(name)).toBe(false);
    }
    for (const name of ['mcp__', 'mcp____x', 'mcp__server', 'mcp__a b__c', 'mcp__a__', `mcp__s__${'x'.repeat(60)}`, 'page_text', 'shell', '', 42, null]) {
      expect(isMcpToolName(name)).toBe(false);
    }
    expect(toolRisk('shell')).toBeNull();
    expect(toolRisk('toString')).toBeNull();
    expect(toolRisk('__proto__')).toBeNull();
    expect(isGrantable('shell')).toBe(false);
    expect(isGrantable('constructor')).toBe(false);
  });

  test('caps-are-sane', () => {
    for (const cap of [EXECUTE_JS_TIMEOUT_MS, EXECUTE_JS_MAX_RESULT_BYTES, EXECUTE_JS_MAX_SOURCE_CHARS, TOOL_RESULT_MAX_CHARS, MAX_TOOL_STEPS, CHAT_MAX_MESSAGES]) {
      expect(Number.isInteger(cap) && cap > 0).toBe(true);
    }
    for (const limit of Object.values(AGENT_TOOL_INPUT_LIMITS)) expect(Number.isInteger(limit) && limit > 0).toBe(true);
    expect(AGENT_TOOL_INPUT_LIMITS.defaultPageTextChars).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(AGENT_TOOL_INPUT_LIMITS.defaultGscDays).toBeLessThanOrEqual(AGENT_TOOL_INPUT_LIMITS.maxGscDays);
    expect(isAllowedModelId(DEFAULT_MODEL_ID)).toBe(true);
    expect(DEFAULT_MODEL_ID).toBe('anthropic/claude-sonnet-5-5');
    expect(ALLOWED_MODEL_IDS).toContain('anthropic/claude-opus-5-5');
    for (const id of ALLOWED_MODEL_IDS) expect(id).toMatch(new RegExp(`^(${MODEL_PROVIDERS.join('|')})/[a-z0-9.-]+$`));
    // Every provider has models, and the list is grouped by provider in `MODEL_PROVIDERS` order.
    expect(MODEL_PROVIDERS.flatMap((provider) => ALLOWED_MODEL_IDS.filter(byProvider(provider)))).toStrictEqual([...ALLOWED_MODEL_IDS]);
    for (const provider of MODEL_PROVIDERS) expect(ALLOWED_MODEL_IDS.filter(byProvider(provider)).length, provider).toBeGreaterThan(0);
  });

  test('route-model-id', () => {
    expect(routeModelId('gateway', 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
    expect(routeModelId('gateway', 'openai/gpt-5')).toBe('openai/gpt-5');
    expect(routeModelId('byok-anthropic', 'anthropic/claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(routeModelId('byok-anthropic', 'anthropic/claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(routeModelId('byok-openai', 'openai/gpt-5')).toBe('gpt-5');
    expect(routeModelId('byok-openai', 'anthropic/claude-sonnet-5-5')).toBeNull();
    expect(routeModelId('byok-anthropic', 'openai/gpt-5')).toBeNull();
    expect(routeModelId('gateway', 'anthropic/claude-unknown')).toBeNull();
    expect(routeModelId('gateway', 'claude-sonnet-5-5')).toBeNull();
    expect(routeModelId('byok-anthropic', 'claude-sonnet-5-5')).toBeNull();
    expect(routeModelId('other' as never, 'anthropic/claude-sonnet-5-5')).toBeNull();
  });

  test('route-model-id-gateway-only-providers', () => {
    expect([...GATEWAY_ONLY_PROVIDERS].sort()).toStrictEqual(['google', 'spacexai']);
    // No bring-your-own-key route serves a gateway-only provider.
    for (const provider of Object.values(BYOK_ROUTE_PROVIDER)) expect((GATEWAY_ONLY_PROVIDERS as readonly string[]).includes(provider)).toBe(false);
    for (const provider of GATEWAY_ONLY_PROVIDERS) {
      const ids = ALLOWED_MODEL_IDS.filter(byProvider(provider));
      expect(ids.length, provider).toBe(2);
      for (const id of ids) {
        // Passed through as is on the gateway, refused on both key routes and the ChatGPT plan.
        expect(routeModelId('gateway', id)).toBe(id);
        expect(routeModelId('byok-anthropic', id), id).toBeNull();
        expect(routeModelId('byok-openai', id), id).toBeNull();
        expect(routeModelId('chatgpt', id), id).toBeNull();
        // Without the prefix, it is no id at all.
        expect(routeModelId('gateway', id.slice(provider.length + 1))).toBeNull();
      }
    }
    // An id of a provider frost doesn't list (xAI's old prefix, a Vertex alias) is refused everywhere.
    for (const route of MODEL_ROUTES) {
      for (const id of ALLOWED_MODEL_IDS.filter(byProvider('spacexai'))) expect(routeModelId(route, `xai/${id.slice('spacexai/'.length)}`), route).toBeNull();
      for (const id of ALLOWED_MODEL_IDS.filter(byProvider('google'))) expect(routeModelId(route, `vertex/${id.slice('google/'.length)}`), route).toBeNull();
    }
  });

  test('model-request-allowlist', () => {
    expect(Object.keys(MODEL_REQUESTS).sort()).toStrictEqual([...MODEL_ROUTES].sort());
    const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
    const OPENAI = 'https://api.openai.com/v1/responses';
    const GATEWAY = 'https://ai-gateway.vercel.sh/v4/ai/language-model';
    expect(isAllowedModelRequest('byok-anthropic', 'POST', ANTHROPIC)).toBe(true);
    expect(isAllowedModelRequest('byok-openai', 'POST', OPENAI)).toBe(true);
    expect(isAllowedModelRequest('gateway', 'POST', GATEWAY)).toBe(true);
    for (const route of MODEL_ROUTES) for (const target of MODEL_REQUESTS[route]) expect(isCanonicalUrl(target.url)).toBe(true);

    const refused: [string, unknown, unknown][] = [
      ['byok-anthropic', 'GET', ANTHROPIC],
      ['byok-anthropic', 'post', ANTHROPIC],
      ['byok-anthropic', 'DELETE', ANTHROPIC],
      ['byok-anthropic', undefined, ANTHROPIC],
      ['byok-anthropic', 'POST', OPENAI],
      ['byok-anthropic', 'POST', GATEWAY],
      ['byok-openai', 'POST', ANTHROPIC],
      ['gateway', 'POST', ANTHROPIC],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com/v1/models'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com/v1/messages/batches'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com/v1/files'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com/v1/messages/'],
      ['byok-openai', 'POST', 'https://api.openai.com/v1/files'],
      ['byok-openai', 'POST', 'https://api.openai.com/v1/chat/completions'],
      ['gateway', 'POST', 'https://ai-gateway.vercel.sh/v4/ai/config'],
      ['byok-anthropic', 'POST', `${ANTHROPIC}?beta=true`],
      ['byok-anthropic', 'POST', `${ANTHROPIC}#frag`],
      ['byok-anthropic', 'POST', 'http://api.anthropic.com/v1/messages'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com:8443/v1/messages'],
      ['byok-anthropic', 'POST', 'https://user:pass@api.anthropic.com/v1/messages'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com.evil.test/v1/messages'],
      ['byok-anthropic', 'POST', 'https://api.anthropic.com./v1/messages'],
      ['byok-anthropic', 'POST', 'https://evil.test/https://api.anthropic.com/v1/messages'],
      ['byok-anthropic', 'POST', 'not a url'],
      ['byok-anthropic', 'POST', ''],
      ['byok-anthropic', 'POST', 42],
      ['other', 'POST', ANTHROPIC],
      ['__proto__', 'POST', ANTHROPIC],
    ];
    for (const [route, method, url] of refused) expect(isAllowedModelRequest(route as never, method, url), `${route} ${String(method)} ${String(url)}`).toBe(false);
  });

  test('model-url-canonical', () => {
    expect(isCanonicalUrl('https://api.anthropic.com/v1/messages')).toBe(true);
    const rewritten = [
      'https://api.anthropic.com\\v1\\messages',
      'https://api.anthropic.com/v1\\messages',
      'https://api.anthropic.com/v1/mes\tsages',
      'https://api.anthropic.com/v1/mes\nsages',
      'https://api.anthropic.com/v1/messages\n',
      ' https://api.anthropic.com/v1/messages',
      'https:api.anthropic.com/v1/messages',
      'https:/api.anthropic.com/v1/messages',
      'https://api．anthropic．com/v1/messages',
      'https://api.anthropic.com/v1/mes sages',
      'https://api.anthropic.com/v1/messages\u0000',
      'https://API.anthropic.com/v1/messages',
      'HTTPS://api.anthropic.com/v1/messages',
      'https://api.anthropic.com:443/v1/messages',
      'https://api.anthropic.com/v1/../v1/messages',
      'https://api.anthropic.com/v1/%2e%2e/v1/messages',
      'https://api.anthropic.com/v1/./messages',
      'https://api.anthropic.com',
    ];
    for (const url of rewritten) {
      expect(isCanonicalUrl(url), JSON.stringify(url)).toBe(false);
      expect(isAllowedModelRequest('byok-anthropic', 'POST', url), JSON.stringify(url)).toBe(false);
    }
    // An internationalised look-alike (Cyrillic `а`) is another host: refused as written and as its
    // canonical punycode form.
    const lookalike = 'https://аpi.anthropic.com/v1/messages';
    expect(isCanonicalUrl(lookalike)).toBe(false);
    const punycode = new URL(lookalike).href;
    expect(punycode).toMatch(/^https:\/\/xn--/);
    expect(isAllowedModelRequest('byok-anthropic', 'POST', punycode)).toBe(false);
    for (const value of [undefined, null, 42, {}, 'not a url', '']) expect(isCanonicalUrl(value)).toBe(false);
  });
});
