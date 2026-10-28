// The runtime's startup lockdown (Phase 5 Task 2, plan decisions 5 and 6; acceptance
// `specs/agent-runtime.feature.md`, Lockdown). The runtime's only way out is the proxied `fetch`
// (`proxy-fetch.ts`), which talks to main over the MessagePort and needs none of what is removed
// here. The web stream and `Response` classes it builds on are not network APIs and stay.
import type { LockdownTarget } from '@app/specs/agent-protocol.schema';

/** The globals that open a connection. */
export const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest'] as const satisfies readonly LockdownTarget[];

/**
 * The `process` functions that reach a builtin or native module around the bundle's imports (a
 * dependency's `process.getBuiltinModule('node:module')` → `createRequire(…)('undici')`, say).
 * Removed once the bundle's modules have loaded (they may look one up while loading).
 */
export const PROCESS_BUILTINS = ['getBuiltinModule', 'binding', '_linkedBinding', 'dlopen'] as const;

export interface LockdownReport {
  /** What was present and is now gone (deleted, or overwritten with `undefined`). */
  readonly removed: readonly LockdownTarget[];
  /** What was present and could not be removed (non-configurable and read-only). */
  readonly failed: readonly LockdownTarget[];
}

/** Removes `name` from `target`: whether it is gone. Never throws. */
function remove(target: object, name: string): boolean {
  try {
    if (Reflect.deleteProperty(target, name) && !(name in target)) return true;
    // Still there: non-configurable here, or inherited from a prototype.
    const own = Object.getOwnPropertyDescriptor(target, name);
    if (own === undefined || own.configurable || own.writable === true) {
      Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    }
  } catch {
    // A read-only, non-configurable property: reported by the caller.
  }
  try {
    return (target as Record<string, unknown>)[name] === undefined;
  } catch {
    return false;
  }
}

function lockdown<N extends string>(target: object, names: readonly N[], label: (name: N) => LockdownTarget): LockdownReport {
  const removed: LockdownTarget[] = [];
  const failed: LockdownTarget[] = [];
  for (const name of names) {
    if (!(name in target)) continue;
    (remove(target, name) ? removed : failed).push(label(name));
  }
  return { removed, failed };
}

/**
 * Removes each of `NETWORK_GLOBALS` from `target` (`globalThis` by default). A non-configurable one
 * is overwritten with `undefined` when it is writable and reported in `failed` when it is not.
 * Never throws.
 */
export function lockdownNetworkGlobals(target: object = globalThis): LockdownReport {
  return lockdown(target, NETWORK_GLOBALS, (name) => name);
}

/** Removes each of `PROCESS_BUILTINS` from `target` (`process` by default), as `lockdownNetworkGlobals`. */
export function lockdownProcess(target: object = process): LockdownReport {
  return lockdown(target, PROCESS_BUILTINS, (name) => `process.${name}`);
}

/** The part of Node's `Module` class the loader lockdown replaces. */
interface ModuleClass {
  _load?: unknown;
  prototype?: { require?: unknown; _compile?: unknown };
}

const refuseLoad = function require(): never {
  throw new Error('frost: the agent runtime loads no module after startup');
};

const refuseCompile = function _compile(): never {
  throw new Error('frost: the agent runtime compiles no module source after startup');
};

/** Replaces `owner[name]` (own or inherited) with `value`: whether it now holds `value`. Never throws. */
function replace(owner: object, name: string, value: unknown): boolean {
  try {
    Object.defineProperty(owner, name, { value, writable: false, configurable: false, enumerable: false });
  } catch {
    try {
      (owner as Record<string, unknown>)[name] = value;
    } catch {
      // Read-only and non-configurable: reported by the caller.
    }
  }
  try {
    return (owner as Record<string, unknown>)[name] === value;
  } catch {
    return false;
  }
}

/**
 * Stops module loading once the bundle has loaded (Task 3 review): Node's `Module._load` and
 * `Module.prototype.require` (which every `require`, a bundle's own included, and `createRequire`
 * go through) and `Module.prototype._compile` (which runs a source string as a module, no `eval`
 * needed) are replaced with functions that throw, and `process.mainModule` (the way to `Module`
 * from anywhere) is removed. `Module` is found through `target.mainModule` (`process` by
 * default); without one (an ES module entry, a test) only what is there is reported. Never throws.
 */
export function lockdownModuleLoader(target: object = process): LockdownReport {
  const removed: LockdownTarget[] = [];
  const failed: LockdownTarget[] = [];
  let mainModule: { constructor?: unknown } | undefined;
  try {
    mainModule = (target as { mainModule?: { constructor?: unknown } }).mainModule;
  } catch {
    mainModule = undefined;
  }
  const found: unknown = typeof mainModule === 'object' && mainModule !== null ? mainModule.constructor : undefined;
  if (typeof found === 'function') {
    const Module = found as unknown as ModuleClass;
    if ('_load' in Module) (replace(Module, '_load', refuseLoad) ? removed : failed).push('Module._load');
    const prototype = Module.prototype;
    if (typeof prototype === 'object' && prototype !== null && 'require' in prototype) (replace(prototype, 'require', refuseLoad) ? removed : failed).push('Module.prototype.require');
    // `new module.constructor()._compile(source, name)` runs source as a module without `eval`.
    if (typeof prototype === 'object' && prototype !== null && '_compile' in prototype) (replace(prototype, '_compile', refuseCompile) ? removed : failed).push('Module.prototype._compile');
  }
  if ('mainModule' in target) (remove(target, 'mainModule') ? removed : failed).push('process.mainModule');
  return { removed, failed };
}

/** A realm's code-generation entry points: its global object and its four function constructors. */
export interface CodeGenerationRealm {
  readonly global: object;
  readonly constructors: readonly unknown[];
}

/** The runtime's own realm. */
export function currentRealm(): CodeGenerationRealm {
  return {
    global: globalThis,
    constructors: [Function, async function () {}.constructor, function* () {}.constructor, async function* () {}.constructor],
  };
}

/**
 * Stops code generation from strings (Task 3 review; Electron 45 ignores
 * `--disallow-code-generation-from-strings` in a utility process): the global `eval` and
 * `Function` are replaced with functions that throw an `EvalError`, as are the `constructor` of
 * every function prototype (`Function`, async, generator and async generator functions), so
 * `(function () {}).constructor('…')` fails too. The replacements keep the old `prototype`, so
 * `instanceof Function` still holds and `(function () {}).constructor === Function` too. A library
 * that probes for `Function` (Zod does) falls back to its non-generated path. Never throws.
 */
export function lockdownCodeGeneration(realm: CodeGenerationRealm = currentRealm()): LockdownReport {
  const removed: LockdownTarget[] = [];
  const failed: LockdownTarget[] = [];
  const refuse = () => {
    throw new EvalError('frost: the agent runtime does not generate code from strings');
  };
  const global = realm.global as { eval?: unknown; Function?: unknown };
  if ('eval' in global) (replace(global, 'eval', function evaluate() { return refuse(); }) ? removed : failed).push('eval');
  let ok = true;
  const [plain] = realm.constructors;
  for (const constructor of realm.constructors) {
    if (typeof constructor !== 'function') continue;
    const blocked = function Function(): never {
      return refuse();
    };
    try {
      Object.defineProperty(blocked, 'prototype', { value: constructor.prototype, writable: false, configurable: false, enumerable: false });
    } catch {
      ok = false;
    }
    if (!replace(constructor.prototype as object, 'constructor', blocked)) ok = false;
    if (constructor === plain && 'Function' in global && !replace(global, 'Function', blocked)) ok = false;
  }
  if (typeof plain === 'function') (ok ? removed : failed).push('Function');
  return { removed, failed };
}

/** Whether Node's permission model is in effect for `target` (`process`): file writes refused. */
export function permissionModelActive(target: object = process): boolean {
  try {
    const permission = (target as { permission?: { has?: (scope: string) => boolean } }).permission;
    return typeof permission?.has === 'function' && !permission.has('fs.write');
  } catch {
    return false;
  }
}
