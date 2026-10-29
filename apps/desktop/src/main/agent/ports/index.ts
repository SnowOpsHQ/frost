import { unavailablePort, type GscPort, type IntentPort, type ProbesPort, type SerpPort } from '@app/ai-skills';
import { PORT_NOT_CONNECTED_REASONS } from '@app/specs/agent-search-tools.spec';

// The agent's data ports as main wires them (Phase 5 Task 8, plan decision 4; acceptance
// `specs/agent-search-tools.feature.md`, Wiring). `createAgentService` takes optional `ports`; each
// one not given (or `null`) is `unavailablePort` with an honest reason, so its tools tell the model
// the data isn't connected in this build. After Phases 3 and 4 merge the lead passes the adapters in
// this folder from main's `index.ts`: `serpAdapter(serp.readApi)`, `intentAdapter(serp.readApi)` and
// `probesAdapter(serp.readApi)` (Phase 3's `SerpReadApi`, wired), and `gscAdapter(gsc.service)`
// (Phase 4's `GscService`, the lead's after Phase 4 merges).

export interface AgentPorts {
  readonly serp?: SerpPort | null;
  readonly intent?: IntentPort | null;
  readonly gsc?: GscPort | null;
  /** Phase 3's visibility probes (`visibility_probes`, `run_visibility_probes`). */
  readonly probes?: ProbesPort | null;
}

/** Every port, a not-connected stand-in for each one missing. */
export function resolveAgentPorts(ports: AgentPorts = {}): { readonly serp: SerpPort; readonly intent: IntentPort; readonly gsc: GscPort; readonly probes: ProbesPort } {
  return {
    serp: ports.serp ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.serp),
    intent: ports.intent ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.intent),
    gsc: ports.gsc ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.gsc),
    probes: ports.probes ?? unavailablePort(PORT_NOT_CONNECTED_REASONS.probes),
  };
}

export { GSC_ADAPTER_REASONS, gscAdapter, nearestGscRange, type GscServiceLike } from './gsc-adapter';
export { INTENT_ADAPTER_REASONS, intentAdapter, type IntentReadApiLike } from './intent-adapter';
export { SERP_ADAPTER_REASONS, serpAdapter, serpResultsOf, type SerpReadApiLike } from './serp-adapter';
export { probeReportOf, probesAdapter, type ProbesReadApiLike } from './probes-adapter';
