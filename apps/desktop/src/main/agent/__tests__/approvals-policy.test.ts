// Spec: specs/agent-approvals.spec.ts (decide, decideFor, grantOriginFor, approvalOriginFor, isGrantOrigin, canGrant, isTabBound)
// · specs/agent-tools.spec.ts (AGENT_TOOLS, toolRisk)
// Acceptance: specs/agent-approvals.feature.md (Scenarios: policy)
import { describe, expect, test } from 'vitest';
import { approvalOriginFor, canGrant, decide, decideFor, grantOriginFor, isGrantOrigin, isTabBound, type DecideContext } from '@app/specs/agent-approvals.spec';
import { AGENT_TOOL_NAMES, AGENT_TOOLS } from '@app/specs/agent-tools.spec';

const context = (overrides: Partial<DecideContext> = {}): DecideContext => ({ grantable: true, hasGrant: false, readToolsAllowed: true, privateOrigin: false, ...overrides });
const every = (): DecideContext[] =>
  [true, false].flatMap((grantable) =>
    [true, false].flatMap((hasGrant) => [true, false].flatMap((readToolsAllowed) => [true, false].map((privateOrigin) => ({ grantable, hasGrant, readToolsAllowed, privateOrigin })))),
  );

describe('approval policy', () => {
  test('policy-read-runs', () => {
    expect(decide('read', context())).toBe('run');
    expect(decide('read', context({ readToolsAllowed: false }))).toBe('ask');
    // Grants and origins don't matter to a read tool.
    for (const c of every()) expect(decide('read', c)).toBe(c.readToolsAllowed ? 'run' : 'ask');
    for (const name of AGENT_TOOL_NAMES.filter((n) => AGENT_TOOLS[n].risk === 'read')) expect(decideFor(name, context())).toBe('run');
  });

  test('policy-act-needs-grant', () => {
    expect(decide('act', context())).toBe('ask');
    expect(decide('act', context({ hasGrant: true }))).toBe('run');
    expect(decide('act', context({ hasGrant: true, privateOrigin: true }))).toBe('ask');
    expect(decide('act', context({ hasGrant: true, grantable: false }))).toBe('ask');
    for (const c of every()) expect(decide('act', c)).toBe(c.grantable && c.hasGrant && !c.privateOrigin ? 'run' : 'ask');
    expect(decideFor('navigate', context({ hasGrant: true }))).toBe('run');
    expect(decideFor('click', context())).toBe('ask');
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
  });

  test('grant-origin-click-tab', () => {
    expect(grantOriginFor('click', { selector: '#buy' }, 'https://shop.example.com/cart')).toBe('https://shop.example.com');
    expect(grantOriginFor('click', { selector: '#buy' }, null)).toBeNull();
    expect(grantOriginFor('click', { selector: '#buy' }, 'app://frost/start')).toBeNull();
    for (const name of ['page_text', 'execute_javascript', 'serp_results', 'mcp__files__read']) expect(grantOriginFor(name, {}, 'https://example.com/')).toBeNull();
    // The approval names the tab's site for the page tools, nothing for the others.
    expect(approvalOriginFor('execute_javascript', { code: '1' }, 'https://example.com/a')).toBe('https://example.com');
    expect(approvalOriginFor('page_text', {}, 'https://example.com/a')).toBe('https://example.com');
    expect(approvalOriginFor('serp_results', { query: 'q' }, 'https://example.com/a')).toBeNull();
    expect(approvalOriginFor('mcp__files__read', {}, 'https://example.com/a')).toBeNull();
    expect(['click', 'execute_javascript', 'page_text', 'page_data', 'page_audit'].every(isTabBound)).toBe(true);
    expect(['navigate', 'serp_results', 'mcp__files__read'].some(isTabBound)).toBe(false);
  });

  test('grant-origins-public-only', () => {
    for (const origin of ['https://example.com', 'http://example.com', 'https://shop.example.com:8443', 'https://xn--bcher-kva.example']) {
      // `.example` is reserved: only the first three are public.
      expect(isGrantOrigin(origin), origin).toBe(!origin.endsWith('.example'));
    }
    for (const origin of [
      'http://localhost',
      'http://localhost:3000',
      'http://app.localhost',
      'http://127.0.0.1',
      'http://127.1.2.3:8080',
      'http://10.0.0.8',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://169.254.169.254',
      'http://100.64.0.1',
      'http://0.0.0.0',
      'http://[::1]',
      'http://[fd00::1]',
      'http://[fe80::1]',
      'http://[::ffff:127.0.0.1]',
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
    }
    expect(isGrantOrigin(42)).toBe(false);
    expect(canGrant('navigate', 'https://example.com')).toBe(true);
    expect(canGrant('click', 'https://example.com')).toBe(true);
    for (const name of ['page_text', 'page_audit', 'serp_results', 'execute_javascript', 'mcp__files__read', 'shell', '__proto__']) expect(canGrant(name, 'https://example.com'), name).toBe(false);
  });
});
