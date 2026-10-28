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

/** Whether Node's permission model is in effect for `target` (`process`): file writes refused. */
export function permissionModelActive(target: object = process): boolean {
  try {
    const permission = (target as { permission?: { has?: (scope: string) => boolean } }).permission;
    return typeof permission?.has === 'function' && !permission.has('fs.write');
  } catch {
    return false;
  }
}
