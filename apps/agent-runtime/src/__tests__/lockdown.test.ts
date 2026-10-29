// Spec: docs/plans/phase-5-ai-agent.md decision 5 · Acceptance: specs/agent-runtime.feature.md (Lockdown)
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { LOCKDOWN_TARGETS } from '@app/specs/agent-protocol.schema';
import { lockdownCodeGeneration, lockdownModuleLoader, lockdownNetworkGlobals, lockdownProcess, NETWORK_GLOBALS, PROCESS_BUILTINS, permissionModelActive } from '../lockdown';

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

  test('lockdown-module-loader', () => {
    class FakeModule {
      static _load(id: string) {
        return `loaded ${id}`;
      }
      require(id: string) {
        return FakeModule._load(id);
      }
      _compile(source: string) {
        return `ran ${source}`;
      }
    }
    const main = new FakeModule();
    const fake: { mainModule?: FakeModule; exit: () => void } = { mainModule: main, exit: () => {} };
    const report = lockdownModuleLoader(fake);
    expect(report).toEqual({ removed: ['Module._load', 'Module.prototype.require', 'Module.prototype._compile', 'process.mainModule'], failed: [] });
    expect('mainModule' in fake).toBe(false);
    expect(() => FakeModule._load('node:net')).toThrow('loads no module after startup');
    // A `require` a module already holds goes through the prototype: refused too.
    expect(() => main.require('node:child_process')).toThrow('loads no module after startup');
    // Compiling a source string as a module: refused too (it needs no `eval`).
    expect(() => new FakeModule()._compile('process.exit()')).toThrow('compiles no module source after startup');
    expect(typeof fake.exit).toBe('function');
    // Without a main module (an ES module entry), nothing to report.
    expect(lockdownModuleLoader({})).toEqual({ removed: [], failed: [] });
    for (const name of report.removed) expect(LOCKDOWN_TARGETS).toContain(name);
  });

  test('lockdown-code-generation', () => {
    // A separate realm, so this test process keeps its own eval.
    const context = vm.createContext({});
    const realm = vm.runInContext('({ global: globalThis, constructors: [Function, async function () {}.constructor, function* () {}.constructor, async function* () {}.constructor] })', context) as { global: object; constructors: unknown[] };
    expect(vm.runInContext('eval("1 + 1")', context)).toBe(2);
    const report = lockdownCodeGeneration(realm);
    expect(report).toEqual({ removed: ['eval', 'Function'], failed: [] });
    for (const code of ['eval("1 + 1")', '(0, eval)("1")', 'Function("return 1")()', 'new Function("return 1")', '(function () {}).constructor("return 1")()', '(async function () {}).constructor("return 1")', '(function* () {}).constructor("yield 1")', '(async function* () {}).constructor("yield 1")']) {
      expect(() => vm.runInContext(code, context), code).toThrow('does not generate code from strings');
    }
    // What libraries rely on still holds.
    expect(vm.runInContext('(function () {}) instanceof Function', context)).toBe(true);
    expect(vm.runInContext('(function () {}).constructor === Function', context)).toBe(true);
    expect(vm.runInContext('typeof Function.prototype.call', context)).toBe('function');
    expect(vm.runInContext('[1, 2].map((x) => x * 2).join()', context)).toBe('2,4');
    // Zod's probe answers "no eval" instead of throwing.
    expect(vm.runInContext('(() => { try { Function(""); return true; } catch { return false; } })()', context)).toBe(false);
    for (const name of report.removed) expect(LOCKDOWN_TARGETS).toContain(name);
  });

  test('jitless-zod', async () => {
    // The package entry (what the utility process loads) puts Zod in jitless mode before any schema is built.
    await import('../index');
    const { z } = await import('zod');
    expect(z.config().jitless).toBe(true);
    expect((globalThis as { __zod_globalConfig?: { jitless?: unknown } }).__zod_globalConfig?.jitless).toBe(true);
    // And the entry imports it first.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source.match(/^import [^;]+;/m)?.[0]).toBe("import './jitless';");
  });
});
