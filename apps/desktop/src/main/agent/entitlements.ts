import type { FeatureFlag } from '@app/specs/entitlements-snapshot.spec';

// The agent's entitlements port (Phase 5 Task 3, plan decision 3). Agent features ask this port
// whether they may run; it allows everything by default. Main wires it to Phase 4's verified
// entitlements with `accountAgentEntitlements` (each feature below maps to a Phase 4 flag), so no
// agent code changes when plans or licences start to gate them.

/** The agent features that can be gated: the agent itself, its skills, and MCP connections. */
export const AGENT_FEATURES = ['agent', 'agent.skills', 'agent.mcp'] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];

export interface AgentEntitlements {
  /** Whether `feature` may be used now. */
  allowed(feature: AgentFeature): boolean;
}

/** The default port: every agent feature allowed (until Phase 4's `requireFeature` is wired here). */
export function createDefaultAgentEntitlements(): AgentEntitlements {
  return { allowed: () => true };
}

/** The Phase 4 flag each agent feature needs (`entitlements-snapshot.spec.ts`). */
export const AGENT_FEATURE_FLAGS: Readonly<Record<AgentFeature, FeatureFlag>> = Object.freeze({ agent: 'ai-agent', 'agent.skills': 'ai-agent', 'agent.mcp': 'ai-agent' });

/** What the agent needs of Phase 4's entitlements: `requireFeature` throws unless the flag is granted. */
export interface FeatureGate {
  requireFeature(flag: FeatureFlag): void;
}

/**
 * The port over Phase 4's verified entitlements (`createAccountMain().entitlements`): a feature is
 * allowed while its flag is granted, and refused whenever `requireFeature` throws (free, signed out,
 * a snapshot that does not verify or has expired past grace). A build without the account system
 * (`configured()` false: development, the e2e suite, a self-built copy) has no plan to check and
 * nowhere to get one, so there every feature is allowed; shipped builds are configured.
 */
export function accountAgentEntitlements(gate: FeatureGate, account: { configured(): boolean } = { configured: () => true }): AgentEntitlements {
  return {
    allowed(feature) {
      if (!account.configured()) return true;
      try {
        gate.requireFeature(AGENT_FEATURE_FLAGS[feature]);
        return true;
      } catch {
        return false;
      }
    },
  };
}
