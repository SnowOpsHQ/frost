// Spec: docs/plans/phase-5-ai-agent.md (decision 3) · Acceptance: specs/agent-host.feature.md (Entitlements)
import { expect, test } from 'vitest';
import { AGENT_FEATURE_FLAGS, AGENT_FEATURES, accountAgentEntitlements, createDefaultAgentEntitlements } from '../entitlements';

test('entitlements-default-allowed', () => {
  const entitlements = createDefaultAgentEntitlements();
  expect(AGENT_FEATURES).toEqual(['agent', 'agent.skills', 'agent.mcp']);
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature)).toBe(true);
});

test('entitlements-follow-the-account', () => {
  expect(AGENT_FEATURE_FLAGS).toEqual({ agent: 'ai-agent', 'agent.skills': 'ai-agent', 'agent.mcp': 'ai-agent' });
  const granted = new Set<string>();
  const asked: string[] = [];
  const gate = {
    requireFeature(flag: string) {
      asked.push(flag);
      if (!granted.has(flag)) throw new Error(`not entitled to ${flag}`);
    },
  };
  let configured = true;
  const entitlements = accountAgentEntitlements(gate, { configured: () => configured });
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature), feature).toBe(false);
  granted.add('ai-agent');
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature), feature).toBe(true);
  expect(new Set(asked)).toEqual(new Set(['ai-agent']));
  // No account system in this build: no plan to check, so everything is allowed (asked live, not once).
  granted.clear();
  configured = false;
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature), feature).toBe(true);
  configured = true;
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature), feature).toBe(false);
});
