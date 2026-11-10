import { CRAWL_AVAILABLE } from '@app/specs/site-crawl.spec';
import { AI_SEARCH_PROVIDER_AVAILABLE, isLegalGateId, LEGAL_GATE_IDS, SERP_API_VENDOR_AVAILABLE, type LegalGateId } from '@app/specs/data-sources.spec';

// The legal gates, main side (Phase 12; plan "As built", lead ruling on Decision 2's L4–L6; spec
// `data-sources.spec.ts`; acceptance `data-sources.feature.md`, Legal gates). Main reads every gate
// through one object built here from the shipped constants; services take it (or its `isOpen`) as a
// dependency, so unit tests open a gate by injection. The renderer never decides: it reads
// `available` from main's views. An unpackaged build may open listed gates with
// `--frost-e2e-open-gates=<id,id,…>` (`LEGAL_GATES_E2E_SWITCH`); a packaged build refuses to start
// with that switch (`PACKAGED_FORBIDDEN_SWITCHES`) and ignores it here too.

export interface LegalGates {
  /** Whether the gated feature `id` is offered in this build. */
  isOpen(id: LegalGateId): boolean;
}

/** Each gate as shipped. Flipping one to `true` is the change that adds the owner's note under `docs/research/`. */
export const SHIPPED_LEGAL_GATES: Readonly<Record<LegalGateId, boolean>> = {
  ...SERP_API_VENDOR_AVAILABLE,
  ...AI_SEARCH_PROVIDER_AVAILABLE,
  // L6: crawl start and resume (`specs/site-crawl.spec.ts`).
  crawl: CRAWL_AVAILABLE,
};

export interface LegalGatesDeps {
  /** `app.commandLine.getSwitchValue(LEGAL_GATES_E2E_SWITCH)` (`''` when absent). */
  readonly switchValue?: string | null;
  /** `app.isPackaged`: the switch is ignored. */
  readonly packaged: boolean;
}

export function createLegalGates(deps: LegalGatesDeps): LegalGates {
  const opened = new Set<LegalGateId>();
  if (!deps.packaged && typeof deps.switchValue === 'string') {
    for (const part of deps.switchValue.split(',')) {
      const id = part.trim();
      if (isLegalGateId(id)) opened.add(id);
    }
  }
  const state = new Map<LegalGateId, boolean>(LEGAL_GATE_IDS.map((id) => [id, SHIPPED_LEGAL_GATES[id] || opened.has(id)]));
  return { isOpen: (id) => state.get(id) === true };
}
