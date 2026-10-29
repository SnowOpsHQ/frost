// Spec: specs/agent-approvals.spec.ts (decide, decideFor, grantOriginFor, approvalOriginFor, runTargetFor, pageUrlOf,
// isPublicPage, isGrantOrigin, canGrant, isTabBound, isSafeInputJson, APPROVAL_DISPLAY_MAX_CHARS)
// · specs/agent-tools.spec.ts (AGENT_TOOLS, toolRisk, AGENT_TOOL_INPUT_LIMITS, EXECUTE_JS_MAX_SOURCE_CHARS)
// Acceptance: specs/agent-approvals.feature.md (Scenarios: policy)
import { describe, expect, test } from 'vitest';
import { getToolDefinition } from '@app/ai-skills';
import {
  APPROVAL_DISPLAY_MAX_CHARS,
  approvalOriginFor,
  canGrant,
  decide,
  decideFor,
  grantOriginFor,
  isGrantOrigin,
  isPublicPage,
  isSafeInputJson,
  isTabBound,
  pageUrlOf,
  runTargetFor,
  type DecideContext,
} from '@app/specs/agent-approvals.spec';
import { AGENT_TOOL_INPUT_LIMITS as L, AGENT_TOOL_NAMES, AGENT_TOOLS, EXECUTE_JS_MAX_SOURCE_CHARS, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';

const context = (overrides: Partial<DecideContext> = {}): DecideContext => ({ grantable: true, hasGrant: false, readToolsAllowed: true, privateOrigin: false, privatePage: false, ...overrides });
const bools = [true, false];
const every = (): DecideContext[] =>
  bools.flatMap((grantable) =>
    bools.flatMap((hasGrant) =>
      bools.flatMap((readToolsAllowed) => bools.flatMap((privateOrigin) => bools.map((privatePage) => ({ grantable, hasGrant, readToolsAllowed, privateOrigin, privatePage })))),
    ),
  );

describe('approval policy', () => {
  test('policy-read-runs', () => {
    expect(decide('read', context())).toBe('run');
    expect(decide('read', context({ readToolsAllowed: false }))).toBe('ask');
    // A page on a non-public host (a local service) asks.
    expect(decide('read', context({ privatePage: true }))).toBe('ask');
    // Grants and grant origins don't matter to a read tool.
    for (const c of every()) expect(decide('read', c)).toBe(c.readToolsAllowed && !c.privatePage ? 'run' : 'ask');
    for (const name of AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].risk === 'read')) expect(decideFor(name, context())).toBe('run');
    expect(isPublicPage('https://example.com/a')).toBe(true);
    expect(isPublicPage('http://example.com/a')).toBe(true);
    for (const url of ['http://localhost:3000/', 'http://192.168.1.1/', 'http://[::1]/', 'https://router/', 'https://nas.local/', 'app://frost/', null]) expect(isPublicPage(url), String(url)).toBe(false);
  });

  test('policy-act-needs-grant', () => {
    expect(decide('act', context())).toBe('ask');
    expect(decide('act', context({ hasGrant: true }))).toBe('run');
    expect(decide('act', context({ hasGrant: true, privateOrigin: true }))).toBe('ask');
    expect(decide('act', context({ hasGrant: true, grantable: false }))).toBe('ask');
    for (const c of every()) expect(decide('act', c)).toBe(c.grantable && c.hasGrant && !c.privateOrigin ? 'run' : 'ask');
    expect(decideFor('navigate', context({ hasGrant: true }))).toBe('run');
    expect(decideFor('click', context())).toBe('ask');
    // run_ai_search sends model-chosen text to an answer engine: act, never grantable, so it asks every call.
    expect(AGENT_TOOLS.run_ai_search).toMatchObject({ risk: 'act', grantable: false });
    for (const c of every()) expect(decideFor('run_ai_search', { ...c, grantable: false })).toBe('ask');
    expect(canGrant('run_ai_search', 'https://example.com')).toBe(false);
  });

  test('policy-execute-and-external-always-ask', () => {
    for (const c of every()) {
      expect(decide('execute', c)).toBe('ask');
      expect(decide('external', c)).toBe('ask');
      expect(decideFor('execute_javascript', c)).toBe('ask');
      expect(decideFor('mcp__files__read', c)).toBe('ask');
      expect(decideFor('shell', c)).toBe('ask');
    }
  });

  test('grant-origin-navigate-destination', () => {
    expect(grantOriginFor('navigate', { url: 'https://attacker.example.net/login?x=1' }, 'https://example.com/a')).toBe('https://attacker.example.net');
    expect(grantOriginFor('navigate', { url: 'HTTPS://Example.COM:443/x' }, null)).toBe('https://example.com');
    expect(grantOriginFor('navigate', { url: 'http://example.com:8080/' }, null)).toBe('http://example.com:8080');
    expect(grantOriginFor('navigate', { url: 'javascript:alert(1)' }, 'https://example.com/')).toBeNull();
    expect(grantOriginFor('navigate', { url: 'file:///etc/passwd' }, 'https://example.com/')).toBeNull();
    expect(grantOriginFor('navigate', {}, 'https://example.com/')).toBeNull();
    expect(grantOriginFor('navigate', null, 'https://example.com/')).toBeNull();
    expect(approvalOriginFor('navigate', { url: 'https://other.example.org/' }, 'https://example.com/')).toBe('https://other.example.org');
    // The run must find the destination: the URL the tab loads, fragment kept.
    expect(runTargetFor('navigate', { url: 'HTTPS://Docs.Example.org/a b#top' }, 'https://example.com/')).toEqual({ expectedOrigin: 'https://docs.example.org', expectedUrl: 'https://docs.example.org/a%20b#top' });
  });

  test('grant-origin-click-tab', () => {
    expect(grantOriginFor('click', { selector: '#buy' }, 'https://shop.example.com/cart')).toBe('https://shop.example.com');
    expect(grantOriginFor('click', { selector: '#buy' }, null)).toBeNull();
    expect(grantOriginFor('click', { selector: '#buy' }, 'app://frost/start')).toBeNull();
    for (const name of ['page_text', 'execute_javascript', 'serp_results', 'run_ai_search', 'mcp__files__read']) expect(grantOriginFor(name, {}, 'https://example.com/')).toBeNull();
    // The approval names the tab's site for the page tools, nothing for the others.
    expect(approvalOriginFor('execute_javascript', { code: '1' }, 'https://example.com/a')).toBe('https://example.com');
    expect(approvalOriginFor('page_text', {}, 'https://example.com/a')).toBe('https://example.com');
    expect(approvalOriginFor('serp_results', { query: 'q' }, 'https://example.com/a')).toBeNull();
    expect(approvalOriginFor('run_ai_search', { query: 'q' }, 'https://example.com/a')).toBeNull();
    expect(approvalOriginFor('mcp__files__read', {}, 'https://example.com/a')).toBeNull();
    expect(['click', 'execute_javascript', 'page_text', 'page_data', 'page_audit'].every(isTabBound)).toBe(true);
    expect(['navigate', 'serp_results', 'run_ai_search', 'mcp__files__read'].some(isTabBound)).toBe(false);
    // A page tool's run target is the tab's page without its fragment.
    expect(pageUrlOf('https://shop.example.com/cart?id=1#reviews')).toBe('https://shop.example.com/cart?id=1');
    expect(pageUrlOf('about:blank')).toBeNull();
    expect(runTargetFor('click', { selector: '#buy' }, 'https://shop.example.com/cart#x')).toEqual({ expectedOrigin: 'https://shop.example.com', expectedUrl: 'https://shop.example.com/cart' });
    expect(runTargetFor('serp_results', { query: 'q' }, 'https://shop.example.com/')).toEqual({ expectedOrigin: null, expectedUrl: null });
  });

  test('grant-origins-public-only', () => {
    for (const origin of ['https://example.com', 'https://shop.example.com:8443', 'https://xn--bcher-kva.com']) {
      expect(isGrantOrigin(origin), origin).toBe(true);
      expect(canGrant('navigate', origin), origin).toBe(true);
    }
    for (const origin of [
      // Plain http: never granted.
      'http://example.com',
      'http://example.com:8080',
      // A trailing dot names the same host another way.
      'https://example.com.',
      'https://example.com..',
      'https://xn--bcher-kva.example',
      'http://localhost',
      'https://localhost:3000',
      'https://app.localhost',
      'https://127.0.0.1',
      'https://127.1.2.3:8080',
      'https://10.0.0.8',
      'https://192.168.1.1',
      'https://172.16.0.1',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://0.0.0.0',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://[::ffff:127.0.0.1]',
      'https://router',
      'https://printer.local',
      'https://wiki.corp',
      'https://example.com/',
      'https://example.com/path',
      'https://user@example.com',
      'HTTPS://EXAMPLE.COM',
      'https://example.com:443',
      'ftp://example.com',
      'file://',
      'null',
      '',
    ]) {
      expect(isGrantOrigin(origin), origin).toBe(false);
      expect(canGrant('navigate', origin), origin).toBe(false);
      expect(canGrant('click', origin), origin).toBe(false);
    }
    expect(isGrantOrigin(42)).toBe(false);
    for (const name of ['page_text', 'page_audit', 'serp_results', 'run_ai_search', 'execute_javascript', 'mcp__files__read', 'shell', '__proto__']) expect(canGrant(name, 'https://example.com'), name).toBe(false);
  });

  test('display-limit-fits-every-catalogue-input', () => {
    // The worst input each schema admits: every string at its cap, of characters JSON writes as two.
    const fill = (n: number, ch = '"') => ch.repeat(n);
    const url = (n: number) => `https://example.com/${fill(n - 'https://example.com/'.length, '\\')}`;
    const worst: Record<string, unknown> = {
      page_audit: {},
      page_data: {},
      page_text: { maxChars: TOOL_RESULT_MAX_CHARS },
      navigate: { url: url(L.maxUrlChars) },
      click: { selector: fill(L.maxSelectorChars) },
      execute_javascript: { code: fill(EXECUTE_JS_MAX_SOURCE_CHARS) },
      serp_results: { query: fill(L.maxQueryChars), locale: 'es-419', device: 'mobile' },
      search_intent: { query: fill(L.maxQueryChars) },
      run_ai_search: { query: fill(L.maxQueryChars), locale: 'es-419' },
      gsc_performance: { url: url(L.maxUrlChars), days: L.maxGscDays },
      visibility_probes: {},
      run_visibility_probes: {},
    };
    for (const name of AGENT_TOOL_NAMES) {
      const parsed = getToolDefinition(name).inputSchema.safeParse(worst[name]);
      expect(parsed.success, name).toBe(true);
      expect(JSON.stringify(parsed.data).length, name).toBeLessThanOrEqual(APPROVAL_DISPLAY_MAX_CHARS);
    }
    // Code of escaped line breaks and tabs fits too.
    const code = getToolDefinition('execute_javascript').inputSchema.parse({ code: '\n\t'.repeat(EXECUTE_JS_MAX_SOURCE_CHARS / 2) });
    expect(JSON.stringify(code).length).toBeLessThanOrEqual(APPROVAL_DISPLAY_MAX_CHARS);
  });

  test('mcp-input-safe-json', () => {
    expect(isSafeInputJson({ path: '/notes.txt', lines: [1, 2], text: 'a\n\tb', nested: { ok: true, none: null } })).toBe(true);
    for (const value of [{ path: 'a\u202eb' }, { ['k\u200b']: 1 }, ['\u0000'], { deep: [{ x: '\ufeff' }] }, '\u2028', { s: '\ud800' }]) expect(isSafeInputJson(value)).toBe(false);
  });
});
