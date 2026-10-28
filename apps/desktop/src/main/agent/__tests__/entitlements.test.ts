// Spec: docs/plans/phase-5-ai-agent.md (decision 3) · Acceptance: specs/agent-host.feature.md (Entitlements)
import { expect, test } from 'vitest';
import { AGENT_FEATURES, createDefaultAgentEntitlements } from '../entitlements';

test('entitlements-default-allowed', () => {
  const entitlements = createDefaultAgentEntitlements();
  expect(AGENT_FEATURES).toEqual(['agent', 'agent.skills', 'agent.mcp']);
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature)).toBe(true);
});
