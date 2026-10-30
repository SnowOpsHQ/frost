// Spec: docs/plans/phase-5-ai-agent.md (decision 3), specs/entitlements-snapshot.spec.ts (UNGATED_FEATURES)
// Acceptance: specs/agent-host.feature.md (Entitlements)
import { expect, test } from 'vitest';
import { UNGATED_FEATURES } from '@app/specs/entitlements-snapshot.spec';
import * as entitlementsModule from '../entitlements';
import { AGENT_FEATURES, createDefaultAgentEntitlements } from '../entitlements';

test('entitlements-default-allowed', () => {
  const entitlements = createDefaultAgentEntitlements();
  expect(AGENT_FEATURES).toEqual(['agent', 'agent.skills', 'agent.mcp']);
  for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature)).toBe(true);
});

test('entitlements-never-gated', () => {
  // The AI agent is free and needs no frost account: nothing maps agent features to Phase 4's flags.
  expect(UNGATED_FEATURES).toContain('ai-agent');
  expect(Object.keys(entitlementsModule).sort()).toEqual(['AGENT_FEATURES', 'createDefaultAgentEntitlements']);
  // Asked any number of times, by any feature: allowed.
  const entitlements = createDefaultAgentEntitlements();
  for (let i = 0; i < 3; i++) for (const feature of AGENT_FEATURES) expect(entitlements.allowed(feature), feature).toBe(true);
});
