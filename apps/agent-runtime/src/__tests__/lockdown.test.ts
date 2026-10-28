// Spec: docs/plans/phase-5-ai-agent.md decision 5 · Acceptance: specs/agent-runtime.feature.md (Lockdown)
import { describe, expect, test } from 'vitest';
import { lockdownNetworkGlobals, NETWORK_GLOBALS } from '../lockdown';

describe('lockdown', () => {
  test('lockdown-removes-network-globals', () => {
    const target: Record<string, unknown> = { fetch: () => {}, WebSocket: class {}, EventSource: class {}, XMLHttpRequest: class {}, WebSocketStream: class {}, Response, keep: 1 };
    const report = lockdownNetworkGlobals(target);
    expect([...report.removed].sort()).toEqual([...NETWORK_GLOBALS].sort());
    expect(report.failed).toEqual([]);
    for (const name of NETWORK_GLOBALS) expect(name in target).toBe(false);
    expect(target['Response']).toBe(Response);
    expect(target['keep']).toBe(1);
  });

  test('lockdown-removes-network-globals (non-configurable)', () => {
    const target = {};
    Object.defineProperty(target, 'fetch', { value: () => {}, writable: true, configurable: false });
    Object.defineProperty(target, 'WebSocket', { value: class {}, writable: false, configurable: false });
    const inherited = Object.create({ EventSource: class {} }) as object;
    const report = lockdownNetworkGlobals(target);
    expect(report.removed).toEqual(['fetch']);
    expect((target as { fetch?: unknown }).fetch).toBeUndefined();
    expect(report.failed).toEqual(['WebSocket']);
    const fromPrototype = lockdownNetworkGlobals(inherited);
    expect(fromPrototype.removed).toEqual(['EventSource']);
    expect((inherited as { EventSource?: unknown }).EventSource).toBeUndefined();
  });

  test('lockdown-real-globals', () => {
    const saved = new Map(NETWORK_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const));
    try {
      expect(typeof globalThis.fetch).toBe('function');
      const report = lockdownNetworkGlobals();
      expect(report.removed).toContain('fetch');
      expect(report.failed).toEqual([]);
      expect('fetch' in globalThis).toBe(false);
      expect('WebSocket' in globalThis).toBe(false);
      // What the proxied fetch builds on stays.
      expect(typeof Response).toBe('function');
      expect(typeof ReadableStream).toBe('function');
    } finally {
      for (const [name, descriptor] of saved) if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor);
    }
  });
});
