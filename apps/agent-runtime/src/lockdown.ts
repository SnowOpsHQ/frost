// Removes the runtime's network globals at startup (Phase 5 Task 2, plan decision 5; acceptance
// `specs/agent-runtime.feature.md`, Lockdown). The runtime's only way out is the proxied `fetch`
// (`proxy-fetch.ts`), which talks to main over the MessagePort and needs none of these. The web
// stream and `Response` classes it builds on are not network APIs and stay.

/** The globals that open a connection. */
export const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'WebSocketStream', 'EventSource', 'XMLHttpRequest'] as const;

export interface LockdownReport {
  /** Globals that were present and are now gone (deleted, or overwritten with `undefined`). */
  readonly removed: readonly string[];
  /** Globals that were present and could not be removed (non-configurable and read-only). */
  readonly failed: readonly string[];
}

/**
 * Deletes each of `NETWORK_GLOBALS` from `target` (`globalThis` by default). A non-configurable one
 * is overwritten with `undefined` when it is writable and reported in `failed` when it is not.
 * Never throws.
 */
export function lockdownNetworkGlobals(target: object = globalThis): LockdownReport {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const name of NETWORK_GLOBALS) {
    if (!(name in target)) continue;
    try {
      if (Reflect.deleteProperty(target, name) && !(name in target)) {
        removed.push(name);
        continue;
      }
      // Still there: non-configurable here, or inherited from a prototype.
      const own = Object.getOwnPropertyDescriptor(target, name);
      if (own === undefined || own.configurable || own.writable === true) {
        Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false, enumerable: false });
      }
    } catch {
      // A read-only, non-configurable property: reported below.
    }
    if ((target as Record<string, unknown>)[name] === undefined) removed.push(name);
    else failed.push(name);
  }
  return { removed, failed };
}
