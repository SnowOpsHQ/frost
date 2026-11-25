// Spec: specs/agent-protocol.schema.ts (LOCKDOWN_TARGETS) · Acceptance: specs/agent-runtime.feature.md (Lockdown: network-globals-lists-agree)
import { describe, expect, test } from 'vitest';
import { NETWORK_GLOBALS } from '@app/agent-runtime';
import { LOCKDOWN_TARGETS } from '@app/specs/agent-protocol.schema';
import { NETWORK_TARGETS } from '../session';

describe('network globals', () => {
  test('network-globals-lists-agree', () => {
    // The spec's list also names `process` functions, module-loader entries and code generation: the network ones are the plain names before `eval`.
    const inSpec = LOCKDOWN_TARGETS.filter((target) => !target.includes('.') && target !== 'eval' && target !== 'Function');
    expect(inSpec.length).toBeGreaterThan(0);
    expect([...NETWORK_GLOBALS].sort()).toEqual([...inSpec].sort());
    expect([...NETWORK_TARGETS].sort()).toEqual([...NETWORK_GLOBALS].sort());
  });
});
