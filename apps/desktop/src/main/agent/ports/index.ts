import { unavailablePort, type GscPort, type IntentPort, type SerpPort } from '@app/ai-skills';
import { PORT_NOT_CONNECTED_REASONS } from '@app/specs/agent-search-tools.spec';

// The agent's data ports as main wires them (Phase 5 Task 8, plan decision 4; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). `createAgentService` takes optional `ports`; each
// one not given (or `null`) is `unavailablePort` with an honest reason, so its tools tell the model
// the data isn't connected in this build. After Phases 3 and 4 merge the lead passes the adapters in
// this folder from main's `index.ts`: `serpAdapter(serp.readApi)`, `intentAdapter(serp.readApi)`
// (Phase 3's `SerpReadApi`) and `gscAdapter(gsc.service)` (Phase 4's `GscService`).

export interface AgentPorts {
  readonly serp?: SerpPort | null;
  readonly intent?: IntentPort | null;
  readonly gsc?: GscPort | null;
}

/** Every port, a not-connected stand-in for each one missing. */
export function resolveAgentPorts(ports: AgentPorts = {}): { readonly serp: SerpPort; readonly intent: IntentPort; readonly gsc: GscPort } {
  return {
    serp: ports.serp ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.serp),
    intent: ports.intent ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.intent),
    gsc: ports.gsc ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.gsc),
  };
}

export { GSC_ADAPTER_REASONS, gscAdapter, nearestGscRange, type GscServiceLike } from './gsc-adapter';
export { INTENT_ADAPTER_REASONS, intentAdapter, type IntentReadApiLike } from './intent-adapter';
export { SERP_ADAPTER_REASONS, serpAdapter, serpResultsOf, type SerpReadApiLike } from './serp-adapter';
