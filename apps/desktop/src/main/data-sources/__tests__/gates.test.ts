// Spec: specs/data-sources.spec.ts (LEGAL_GATE_IDS, SERP_API_VENDOR_AVAILABLE, AI_SEARCH_PROVIDER_AVAILABLE,
// LEGAL_GATES_E2E_SWITCH), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/data-sources.feature.md (Legal gates) · plan docs/plans/phase-12-big-bets.md, As built (legal gates)
import { describe, expect, test } from 'vitest';
import { LEGAL_GATE_IDS, LEGAL_GATES_E2E_SWITCH } from '@app/specs/data-sources.spec';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { remoteDebuggingRefusal } from '../../security/policy';
import { createLegalGates, SHIPPED_LEGAL_GATES } from '../gates';

const open = (gates: { isOpen(id: (typeof LEGAL_GATE_IDS)[number]): boolean }) => LEGAL_GATE_IDS.filter((id) => gates.isOpen(id));

describe('legal gates', () => {
  test('legal-gates-default-to-the-shipped-constants', () => {
    for (const packaged of [true, false]) {
      for (const switchValue of [undefined, null, '']) {
        const gates = createLegalGates({ packaged, switchValue });
        for (const id of LEGAL_GATE_IDS) expect(gates.isOpen(id), id).toBe(SHIPPED_LEGAL_GATES[id]);
      }
    }
  });

  test('legal-gates-open-only-by-switch-unpackaged', () => {
    // Unpackaged: the listed ids open, the rest keep their shipped value; unknown ids are ignored.
    expect(open(createLegalGates({ packaged: false, switchValue: 'serpapi,crawl,nope' }))).toEqual(['serpapi', 'crawl']);
    expect(open(createLegalGates({ packaged: false, switchValue: ' perplexity , openai-search ,,' }))).toEqual(['perplexity', 'openai-search']);
    expect(open(createLegalGates({ packaged: false, switchValue: LEGAL_GATE_IDS.join(',') }))).toEqual([...LEGAL_GATE_IDS]);
    expect(open(createLegalGates({ packaged: false, switchValue: 'SERPAPI,__proto__,toString,constructor' }))).toEqual([]);
    // Packaged: the switch changes nothing (and the app refuses to start with it at all).
    expect(open(createLegalGates({ packaged: true, switchValue: LEGAL_GATE_IDS.join(',') }))).toEqual(LEGAL_GATE_IDS.filter((id) => SHIPPED_LEGAL_GATES[id]));
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(LEGAL_GATES_E2E_SWITCH);
    expect(remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (name) => name === LEGAL_GATES_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBe(`${PACKAGED_DEBUG_REFUSAL} (${LEGAL_GATES_E2E_SWITCH})`);
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: (name) => name === LEGAL_GATES_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBeNull();
  });

  test('legal-gates-unknown-id-is-closed', () => {
    const gates = createLegalGates({ packaged: false, switchValue: LEGAL_GATE_IDS.join(',') });
    expect(gates.isOpen('nope' as 'crawl')).toBe(false);
    expect(gates.isOpen('__proto__' as 'crawl')).toBe(false);
  });
});
