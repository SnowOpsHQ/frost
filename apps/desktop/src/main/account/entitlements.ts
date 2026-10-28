import { z } from 'zod';
import {
  COMPACT_JWS_PATTERN,
  ENTITLEMENT_HEARTBEAT_MS,
  ENTITLEMENT_REFRESH_FAILURES,
  entitlementGrants,
  FEATURE_NOT_ENTITLED_CODE,
  HIGH_WATER_PERSIST_INTERVAL_MS,
  INVALID_ENTITLEMENTS,
  MAX_SNAPSHOT_CHARS,
  NO_ENTITLEMENTS,
  type Entitlements,
  type EntitlementRefreshFailure,
  type FeatureFlag,
} from '@app/specs/entitlements-snapshot.spec';
import type { SecretName } from '@app/specs/secret-store.spec';
import { effectiveNow, evaluateClaims, verifySnapshot, type VerifiedClaims } from './entitlements-verify';
import type { SecretStore } from './secret-store';

// Main's entitlements (spec `entitlements-snapshot.spec.ts`; acceptance `entitlements-client.feature.md`,
// Store; plan "Interfaces for other phases": `EntitlementsReader` is stable — Phase 5 gates on it).
// No Electron import: main passes the secret store, the build's JWKS and a log.
//
// State: what is held (nothing, a refused snapshot, or a verified snapshot with its account), whether
// the last refresh failed for a network reason, and the time high-water mark. It lives in one secret
// blob (`ENTITLEMENTS_SECRET`), so the mark cannot be dropped without the snapshot. `current()`
// recomputes the status from the verified claims at `max(now, highWater)` on every read; a timer at
// the next boundary (and a heartbeat) recomputes it unasked and fires `onChange`.
//
// A snapshot that does not verify fails closed: whatever was held is replaced by `invalid` (free),
// persisted, so neither a restart nor a later read brings an older valid snapshot back.

/** The secret blob entitlements live in. */
export const ENTITLEMENTS_SECRET: SecretName = 'entitlements';

/** The stable read side: what Phase 5 and the routers gate on. */
export interface EntitlementsReader {
  /** The verified entitlements now (never the snapshot). Recomputed against the clock on every call. */
  current(): Entitlements;
  /** Whether `flag` is granted now: an `active` or `grace` snapshot that carries it. */
  has(flag: FeatureFlag): boolean;
  /** Throws `FeatureNotEntitledError` unless `has(flag)`. */
  requireFeature(flag: FeatureFlag): void;
  /** Called with the new entitlements whenever they change (also when only time passed). Returns the unsubscribe. */
  onChange(listener: (entitlements: Entitlements) => void): () => void;
}

/** Main's side: what the account service (Task 5) drives. */
export interface EntitlementsController extends EntitlementsReader {
  /**
   * A snapshot the server answered for the signed-in user `sub`. Verified first: if it does not
   * verify (signature, `kid`, claims, another account, skew), the held state becomes `invalid` (free)
   * and is persisted. A verified one replaces the held snapshot (unless older than it), clears the
   * offline flag and raises the high-water mark to its `iat`. Resolves with `current()`.
   */
  update(snapshot: string, sub: string): Promise<Entitlements>;
  /**
   * A refresh failed: `network` keeps the snapshot and allows grace after `exp`; `auth` drops it
   * (`none`); `invalid` replaces it with `invalid`. Answers `current()`.
   */
  markRefreshFailed(kind: EntitlementRefreshFailure): Entitlements;
  /** Sign-out: nothing held (`none`), persisted. The high-water mark stays. Answers `current()`. */
  clear(): Entitlements;
  /** Stops the timer and drops the listeners. */
  dispose(): void;
}

export class FeatureNotEntitledError extends Error {
  override readonly name = 'FeatureNotEntitledError';
  readonly code = FEATURE_NOT_ENTITLED_CODE;
  constructor(readonly flag: FeatureFlag) {
    super(`${FEATURE_NOT_ENTITLED_CODE}: ${flag}`);
  }
}

export interface CreateEntitlementsOptions {
  /**
   * The build's `FROST_PUBLIC_ENTITLEMENT_JWKS` (JSON text, or parsed). Missing or malformed: every
   * snapshot is `invalid`.
   */
  readonly jwks: unknown;
  /** The secret store (`createSecretStore`); only `ENTITLEMENTS_SECRET` is used. */
  readonly store: Pick<SecretStore, 'read' | 'write' | 'delete'>;
  /** Fixed messages only: never a snapshot, a claim or an account. */
  readonly log: (message: string) => void;
  /** Epoch ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

const StoredSnapshotSchema = z.strictObject({
  kind: z.literal('snapshot'),
  jws: z.string().max(MAX_SNAPSHOT_CHARS).regex(COMPACT_JWS_PATTERN),
  sub: z.string().min(1).max(128),
});

/** The persisted state (version 1). */
const PersistedStateSchema = z.strictObject({
  v: z.literal(1),
  highWaterMs: z.int().nonnegative(),
  offline: z.boolean(),
  held: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('invalid') }), StoredSnapshotSchema]),
});
type PersistedState = z.infer<typeof PersistedStateSchema>;

type Held = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'snapshot'; readonly jws: string; readonly sub: string; readonly claims: VerifiedClaims };

const FAILURES: ReadonlySet<string> = new Set(ENTITLEMENT_REFRESH_FAILURES);
/** `setTimeout`'s longest delay. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function readState(store: CreateEntitlementsOptions['store'], log: (message: string) => void): PersistedState | null {
  const text = store.read(ENTITLEMENTS_SECRET);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    value = undefined;
  }
  const parsed = PersistedStateSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  log('entitlements: stored state unreadable; discarded');
  store.delete(ENTITLEMENTS_SECRET);
  return null;
}

/**
 * Main's entitlements over `store`, loaded and re-verified (the stored snapshot is checked again
 * against this build's keys and the stored high-water mark) before it resolves.
 */
export async function createEntitlements(options: CreateEntitlementsOptions): Promise<EntitlementsController> {
  const { jwks, store, log } = options;
  const now = options.now ?? (() => Date.now());

  const stored = readState(store, log);
  let highWaterMs = Math.max(stored?.highWaterMs ?? 0, now());
  let persistedHighWaterMs = stored?.highWaterMs ?? -1;
  let offline = stored?.offline ?? false;
  let held: Held = stored?.held.kind === 'invalid' ? { kind: 'invalid' } : { kind: 'none' };
  /** Bumped by every change of what is held, so a verification that finishes late cannot undo one. */
  let generation = 0;
  let last: Entitlements | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const listeners = new Set<(entitlements: Entitlements) => void>();

  const persist = (): void => {
    const heldState: PersistedState['held'] = held.kind === 'snapshot' ? { kind: 'snapshot', jws: held.jws, sub: held.sub } : { kind: held.kind };
    const state: PersistedState = { v: 1, highWaterMs, offline, held: heldState };
    store.write(ENTITLEMENTS_SECRET, JSON.stringify(state));
    persistedHighWaterMs = highWaterMs;
  };

  /**
   * Raises the mark to the clock. While a snapshot is held, writes it when it moved by
   * `HIGH_WATER_PERSIST_INTERVAL_MS` (any amount with `force`); every change of state writes it too.
   */
  const tick = (force = false): void => {
    highWaterMs = Math.max(highWaterMs, now());
    if (held.kind !== 'snapshot') return;
    if (force ? highWaterMs > persistedHighWaterMs : highWaterMs - persistedHighWaterMs >= HIGH_WATER_PERSIST_INTERVAL_MS) persist();
  };

  const evaluate = (): Entitlements => {
    switch (held.kind) {
      case 'none':
        return NO_ENTITLEMENTS;
      case 'invalid':
        return INVALID_ENTITLEMENTS;
      case 'snapshot':
        return evaluateClaims(held.claims, { now: now(), highWaterMs, offline });
    }
  };

  const schedule = (entitlements: Entitlements): void => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || held.kind !== 'snapshot' || entitlements.graceEndsAtMs === null || entitlements.expiresAtMs === null) return;
    const at = effectiveNow(now(), highWaterMs);
    // The next boundary: exp while active; the end of grace after it (a heartbeat in between).
    const boundary = at < entitlements.expiresAtMs ? entitlements.expiresAtMs : entitlements.graceEndsAtMs;
    if (at >= entitlements.graceEndsAtMs) return;
    const delay = Math.min(Math.max(boundary - at, 0), ENTITLEMENT_HEARTBEAT_MS, MAX_TIMER_MS);
    timer = setTimeout(() => {
      timer = undefined;
      tick(true);
      refresh();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  /** Recomputes, notifies on a change and re-arms the timer. */
  const refresh = (): Entitlements => {
    const entitlements = evaluate();
    const changed = last === null || JSON.stringify(last) !== JSON.stringify(entitlements);
    last = entitlements;
    schedule(entitlements);
    if (changed) {
      for (const listener of [...listeners]) {
        try {
          listener(entitlements);
        } catch {
          log('entitlements: a change listener threw');
        }
      }
    }
    return entitlements;
  };

  const current = (): Entitlements => {
    tick();
    return refresh();
  };

  // Load: the stored snapshot is verified again (this build's keys, the stored mark).
  if (stored?.held.kind === 'snapshot') {
    const result = await verifySnapshot(stored.held.jws, { jwks, expectedSub: stored.held.sub, now: now(), highWaterMs, offline });
    if (result.ok) {
      held = { kind: 'snapshot', jws: stored.held.jws, sub: stored.held.sub, claims: result.claims };
    } else {
      log(`entitlements: stored snapshot refused (${result.reason})`);
      held = { kind: 'invalid' };
      offline = false;
      persist();
    }
  }
  // Nothing is announced for the loaded state: `last` starts there.
  tick();
  last = evaluate();
  schedule(last);

  return {
    current,
    has: (flag) => entitlementGrants(current(), flag),
    requireFeature(flag) {
      if (!entitlementGrants(current(), flag)) throw new FeatureNotEntitledError(flag);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async update(snapshot, sub) {
      const started = ++generation;
      tick();
      const result = await verifySnapshot(snapshot, { jwks, expectedSub: sub, now: now(), highWaterMs, offline: false });
      if (disposed || started !== generation) return current();
      if (!result.ok) {
        log(`entitlements: snapshot refused (${result.reason})`);
        held = { kind: 'invalid' };
      } else if (held.kind === 'snapshot' && held.sub === sub && result.claims.iat < held.claims.iat) {
        log('entitlements: an older snapshot was ignored');
        return current();
      } else {
        held = { kind: 'snapshot', jws: snapshot, sub, claims: result.claims };
        highWaterMs = Math.max(highWaterMs, result.iat * 1000);
      }
      offline = false;
      tick();
      persist();
      return refresh();
    },
    markRefreshFailed(kind) {
      if (!FAILURES.has(kind)) throw new Error('entitlements: unknown refresh failure');
      generation++;
      tick();
      if (kind === 'network') {
        offline = true;
      } else {
        offline = false;
        held = kind === 'auth' ? { kind: 'none' } : { kind: 'invalid' };
      }
      persist();
      return refresh();
    },
    clear() {
      generation++;
      tick();
      held = { kind: 'none' };
      offline = false;
      persist();
      return refresh();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
