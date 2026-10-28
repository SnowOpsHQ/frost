// Spec: docs/plans/phase-5-ai-agent.md decision 5 · Acceptance: specs/agent-runtime.feature.md (Lockdown)
import { describe, expect, test } from 'vitest';
import { LOCKDOWN_TARGETS } from '@app/specs/agent-protocol.schema';
import { lockdownNetworkGlobals, lockdownProcess, NETWORK_GLOBALS, PROCESS_BUILTINS, permissionModelActive } from '../lockdown';

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

  test('lockdown-process-builtins', () => {
    const fake = { getBuiltinModule: () => ({}), binding: () => ({}), _linkedBinding: () => ({}), dlopen: () => {}, exit: () => {}, version: 'v24' };
    const report = lockdownProcess(fake);
    expect(report.removed).toEqual(['process.getBuiltinModule', 'process.binding', 'process._linkedBinding', 'process.dlopen']);
    expect(report.failed).toEqual([]);
    for (const name of PROCESS_BUILTINS) expect((fake as Record<string, unknown>)[name]).toBeUndefined();
    // What a dependency does: an optional call finds nothing.
    expect((fake as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:dns')).toBeUndefined();
    expect(typeof fake.exit).toBe('function');
    expect(fake.version).toBe('v24');
    // Every name it reports is a protocol lockdown target.
    for (const name of [...lockdownNetworkGlobals({ fetch: 1 }).removed, ...report.removed]) expect(LOCKDOWN_TARGETS).toContain(name);
  });

  test('lockdown-report', () => {
    expect(permissionModelActive({ permission: { has: (scope: string) => scope !== 'fs.write' } })).toBe(true);
    expect(permissionModelActive({ permission: { has: () => true } })).toBe(false);
    expect(permissionModelActive({ permission: { has: () => { throw new Error('x'); } } })).toBe(false);
    expect(permissionModelActive({})).toBe(false);
    // This test process runs without one.
    expect(permissionModelActive()).toBe(false);
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
