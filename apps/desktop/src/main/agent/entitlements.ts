// The agent's entitlements port (Phase 5 Task 3, plan decision 3). Agent features ask this port
// whether they may run; it allows everything.
//
// The AI agent is never gated (2026-10-29: frost is free and open source; `UNGATED_FEATURES` in
// `specs/entitlements-snapshot.spec.ts`): it works signed out and on any plan, so main passes no port
// and the default below applies. The port stays only as a seam for tests of the refusal paths. It
// must not be wired to Phase 4's entitlements (`requireFeature`, `has`): a missing, expired or
// unverifiable snapshot never turns the agent off.

/** The agent features a port is asked about: the agent itself, its skills, and MCP connections. */
export const AGENT_FEATURES = ['agent', 'agent.skills', 'agent.mcp'] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];

export interface AgentEntitlements {
  /** Whether `feature` may be used now. */
  allowed(feature: AgentFeature): boolean;
}

/** The port main uses: every agent feature allowed, always (the agent is not gated). */
export function createDefaultAgentEntitlements(): AgentEntitlements {
  return { allowed: () => true };
}
