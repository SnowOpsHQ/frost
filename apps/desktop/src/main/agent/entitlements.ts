// The agent's entitlements port (Phase 5 Task 3, plan decision 3). Agent features ask this port
// whether they may run; it allows everything by default. The lead wires it to Phase 4's
// `requireFeature(flag)` once both phases have merged (one adapter: each feature below maps to a
// Phase 4 flag), so no agent code changes when plans or licences start to gate them.

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
