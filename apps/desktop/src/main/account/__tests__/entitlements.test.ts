// Spec: specs/entitlements-snapshot.spec.ts (EntitlementsSchema, NO_ENTITLEMENTS, INVALID_ENTITLEMENTS,
// FEATURE_NOT_ENTITLED_CODE, ENTITLEMENT_REFRESH_FAILURES, HIGH_WATER_PERSIST_INTERVAL_MS,
// ENTITLEMENT_HEARTBEAT_MS), specs/secret-store.spec.ts (SECRET_NAMES)
// Acceptance: specs/entitlements-client.feature.md (Store) · review focus "A snapshot cannot be forged
// or replayed past its life"
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ENTITLEMENT_HEARTBEAT_MS,
  ENTITLEMENT_TTL_SECONDS,
  EntitlementsSchema,
  FEATURE_NOT_ENTITLED_CODE,
  HIGH_WATER_PERSIST_INTERVAL_MS,
  INVALID_ENTITLEMENTS,
  NO_ENTITLEMENTS,
  OFFLINE_GRACE_MS,
  PLAN_FEATURES,
  type Entitlements,
} from '@app/specs/entitlements-snapshot.spec';
import type { SecretName } from '@app/specs/secret-store.spec';
import { createEntitlements, FeatureNotEntitledError, type CreateEntitlementsOptions } from '../entitlements';
import { DAY_MS, jwksOf, proClaims, sign, SUB, T0, T0_MS, testKey, type TestKey } from './snapshots';

let key: TestKey;
let jwks: string;

beforeAll(async () => {
  key = await testKey('k1');
  jwks = JSON.stringify(jwksOf(key));
});

const EXP_MS = T0_MS + ENTITLEMENT_TTL_SECONDS * 1000;
const GRACE_END_MS = EXP_MS + OFFLINE_GRACE_MS;

/** The secret store as entitlements use it, in memory. */
function memoryStore() {
  const blobs = new Map<SecretName, string>();
  return {
    blobs,
    read: vi.fn(async (name: SecretName) => blobs.get(name) ?? null),
    write: vi.fn(async (name: SecretName, value: string) => (blobs.set(name, value), true)),
    delete: vi.fn(async (name: SecretName) => void blobs.delete(name)),
  };
}

let instances: { dispose(): void }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: T0_MS, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  for (const instance of instances) instance.dispose();
  instances = [];
  vi.useRealTimers();
});

async function open(store: ReturnType<typeof memoryStore>, overrides: Partial<CreateEntitlementsOptions> = {}) {
  const log = vi.fn();
  const entitlements = await createEntitlements({ jwks, store, log, ...overrides });
  instances.push(entitlements);
  return { entitlements, log };
}

const active = (): Entitlements => ({ plan: 'pro', features: [...PLAN_FEATURES.pro], status: 'active', expiresAtMs: EXP_MS, graceEndsAtMs: GRACE_END_MS });

describe('entitlements store', () => {
  test('reader-current-has-require', async () => {
    const { entitlements } = await open(memoryStore());
    expect(entitlements.current()).toEqual(NO_ENTITLEMENTS);
    expect(entitlements.has('sync')).toBe(false);
    expect(() => entitlements.requireFeature('sync')).toThrow(FeatureNotEntitledError);

    await expect(entitlements.update(await sign(key), SUB)).resolves.toEqual(active());
    expect(entitlements.current()).toEqual(active());
    expect(EntitlementsSchema.parse(entitlements.current())).toEqual(active());
    for (const flag of PLAN_FEATURES.pro) {
      expect(entitlements.has(flag)).toBe(true);
      expect(() => entitlements.requireFeature(flag)).not.toThrow();
    }
    // A free account: verified, no features.
    await entitlements.update(await sign(key, proClaims(T0 + 1, { plan: 'free', features: [] })), SUB);
    expect(entitlements.current()).toMatchObject({ plan: 'free', status: 'active', features: [] });
    expect(entitlements.has('ai-agent')).toBe(false);
  });

  test('current-for-is-the-accounts-only', async () => {
    const { entitlements } = await open(memoryStore());
    expect(entitlements.currentFor(SUB)).toEqual(NO_ENTITLEMENTS);
    await entitlements.update(await sign(key), SUB);
    expect(entitlements.currentFor(SUB)).toEqual(active());
    // A snapshot held for another account entitles nobody else.
    expect(entitlements.currentFor('someone-else')).toEqual(NO_ENTITLEMENTS);
    // A refused snapshot is `invalid` whoever asks.
    await entitlements.update('not.a.snapshot', SUB);
    expect(entitlements.currentFor('someone-else')).toEqual(INVALID_ENTITLEMENTS);
  });

  test('require-feature-throws-coded-error', async () => {
    const { entitlements } = await open(memoryStore());
    const error = (() => {
      try {
        entitlements.requireFeature('search-console');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(FeatureNotEntitledError);
    expect(error).toBeInstanceOf(Error);
    expect((error as FeatureNotEntitledError).code).toBe(FEATURE_NOT_ENTITLED_CODE);
    expect((error as FeatureNotEntitledError).flag).toBe('search-console');
    expect((error as Error).name).toBe('FeatureNotEntitledError');
  });

  test('onchange-fires-at-boundary', async () => {
    const { entitlements } = await open(memoryStore());
    const seen: Entitlements[] = [];
    const off = entitlements.onChange((e) => seen.push(e));
    await entitlements.update(await sign(key), SUB);
    expect(seen.map((e) => e.status)).toEqual(['active']);

    // Online: active until exp, then expired, with no update in between.
    await vi.advanceTimersByTimeAsync(EXP_MS - T0_MS - 1);
    expect(seen.map((e) => e.status)).toEqual(['active']);
    expect(entitlements.has('sync')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map((e) => e.status)).toEqual(['active', 'expired']);
    expect(entitlements.current()).toMatchObject({ status: 'expired', plan: 'free', features: [] });

    // A network failure now: grace until its end, then expired again.
    entitlements.markRefreshFailed('network');
    expect(seen.map((e) => e.status)).toEqual(['active', 'expired', 'grace']);
    expect(entitlements.has('sync')).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_END_MS - EXP_MS - 1);
    expect(seen.map((e) => e.status)).toEqual(['active', 'expired', 'grace']);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.map((e) => e.status)).toEqual(['active', 'expired', 'grace', 'expired']);
    expect(entitlements.has('sync')).toBe(false);

    // Unsubscribed: no more calls. A listener that throws does not break the others.
    off();
    const other = vi.fn(() => {
      throw new Error('listener broke');
    });
    const third = vi.fn();
    entitlements.onChange(other);
    entitlements.onChange(third);
    entitlements.clear();
    expect(seen).toHaveLength(4);
    expect(other).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledWith(NO_ENTITLEMENTS);
  });

  test('onchange-fires-at-boundary offline from the start', async () => {
    const { entitlements } = await open(memoryStore());
    const seen: string[] = [];
    entitlements.onChange((e) => seen.push(e.status));
    await entitlements.update(await sign(key), SUB);
    entitlements.markRefreshFailed('network');
    await vi.advanceTimersByTimeAsync(EXP_MS - T0_MS);
    expect(seen).toEqual(['active', 'grace']);
    await vi.advanceTimersByTimeAsync(OFFLINE_GRACE_MS);
    expect(seen).toEqual(['active', 'grace', 'expired']);
  });

  test('onchange-in-order-when-reentrant', async () => {
    const { entitlements } = await open(memoryStore());
    const first: string[] = [];
    const second: string[] = [];
    entitlements.onChange((e) => {
      first.push(e.status);
      // Sign out from inside the notification (as a UI reaction might).
      if (e.status === 'active') entitlements.clear();
    });
    entitlements.onChange((e) => second.push(e.status));
    await entitlements.update(await sign(key), SUB);
    expect(first).toEqual(['active', 'none']);
    expect(second).toEqual(['active', 'none']);
    expect(entitlements.current()).toEqual(NO_ENTITLEMENTS);
  });

  test('reads-do-not-rearm-timer', async () => {
    const { entitlements } = await open(memoryStore());
    await entitlements.update(await sign(key), SUB);
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    for (let i = 0; i < 50; i++) {
      entitlements.current();
      entitlements.has('sync');
      entitlements.requireFeature('ai-agent');
    }
    expect(setTimer).not.toHaveBeenCalled();
    expect(clearTimer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    // The boundary moves (a network failure past exp): re-armed once.
    vi.setSystemTime(EXP_MS + 1);
    entitlements.markRefreshFailed('network');
    expect(entitlements.current().status).toBe('grace');
    expect(vi.getTimerCount()).toBe(1);
  });

  test('entitlements-persist-across-instances', async () => {
    const store = memoryStore();
    const first = await open(store);
    await first.entitlements.update(await sign(key), SUB);
    first.entitlements.markRefreshFailed('network');
    first.entitlements.dispose();
    // The stored state carries the snapshot (main only), never as anything the chrome sees.
    expect(store.blobs.get('entitlements')).toContain('.');

    const second = await open(store);
    expect(second.entitlements.current()).toEqual(active());
    vi.setSystemTime(EXP_MS + DAY_MS);
    // The offline flag came along: grace, not expired.
    expect(second.entitlements.current()).toMatchObject({ status: 'grace' });
    expect(second.log).not.toHaveBeenCalled();
  });

  test('high-water-persists', async () => {
    const store = memoryStore();
    const first = await open(store);
    await first.entitlements.update(await sign(key), SUB);
    // The app keeps running past exp; the heartbeat raises the mark on its own.
    await vi.advanceTimersByTimeAsync(EXP_MS - T0_MS + 2 * ENTITLEMENT_HEARTBEAT_MS);
    expect(first.entitlements.current().status).toBe('expired');
    first.entitlements.dispose();

    // Restart with the clock set back into the snapshot's life: still expired.
    vi.setSystemTime(T0_MS + DAY_MS);
    const second = await open(store);
    expect(second.entitlements.current()).toMatchObject({ status: 'expired', features: [] });
    second.entitlements.markRefreshFailed('network');
    expect(second.entitlements.current().status).toBe('grace');
    second.entitlements.dispose();

    // Past grace, then back again: expired even offline.
    vi.setSystemTime(GRACE_END_MS + HIGH_WATER_PERSIST_INTERVAL_MS);
    const third = await open(store);
    expect(third.entitlements.current().status).toBe('expired');
    third.entitlements.dispose();
    vi.setSystemTime(T0_MS);
    const fourth = await open(store);
    expect(fourth.entitlements.current().status).toBe('expired');
  });

  test('high-water-persists between reads', async () => {
    const store = memoryStore();
    const { entitlements } = await open(store);
    await entitlements.update(await sign(key), SUB);
    const writes = store.write.mock.calls.length;
    // Reads within the interval do not write; one after it does.
    vi.setSystemTime(T0_MS + HIGH_WATER_PERSIST_INTERVAL_MS - 1);
    entitlements.current();
    expect(store.write.mock.calls.length).toBe(writes);
    vi.setSystemTime(T0_MS + HIGH_WATER_PERSIST_INTERVAL_MS);
    entitlements.has('sync');
    expect(store.write.mock.calls.length).toBe(writes + 1);
  });

  test('clock-jump-ahead-does-not-lock-out', async () => {
    const store = memoryStore();
    const { entitlements } = await open(store);
    await entitlements.update(await sign(key), SUB);
    // The clock jumps to 2099 for a moment: the held snapshot is expired (as that clock says).
    vi.setSystemTime(Date.UTC(2099, 0, 1));
    expect(entitlements.current().status).toBe('expired');
    // Back to the real time: the held snapshot stays expired (a clock set back revives nothing) …
    vi.setSystemTime(T0_MS + 3600_000);
    expect(entitlements.current().status).toBe('expired');
    // … but a fresh snapshot is active.
    await entitlements.update(await sign(key, proClaims(T0 + 3600)), SUB);
    expect(entitlements.current()).toMatchObject({ status: 'active', features: [...PLAN_FEATURES.pro] });
    entitlements.dispose();

    // Across a restart and a sign-out too.
    vi.setSystemTime(Date.UTC(2099, 0, 1));
    const second = await open(store);
    expect(second.entitlements.current().status).toBe('expired');
    second.entitlements.clear();
    second.entitlements.dispose();
    vi.setSystemTime(T0_MS + 7200_000);
    const third = await open(store);
    await third.entitlements.update(await sign(key, proClaims(T0 + 7200)), SUB);
    expect(third.entitlements.current().status).toBe('active');
    // An older snapshot replayed with the clock set back is still judged at the mark.
    third.entitlements.clear();
    vi.setSystemTime(GRACE_END_MS + 2 * DAY_MS);
    third.entitlements.current();
    third.entitlements.markRefreshFailed('network');
    vi.setSystemTime(T0_MS);
    await third.entitlements.update(await sign(key, proClaims(T0 + 7200)), SUB);
    expect(third.entitlements.current().status).toBe('expired');
  });

  test('slow-clock-accepts-fresh-snapshot', async () => {
    const store = memoryStore();
    const { entitlements } = await open(store);
    await entitlements.update(await sign(key), SUB);
    // The client clock is an hour slow; the server signs real time.
    const iat = T0 + 2 * 3600;
    vi.setSystemTime(T0_MS + 3600_000);
    await expect(entitlements.update(await sign(key, proClaims(iat)), SUB)).resolves.toMatchObject({ status: 'active', expiresAtMs: (iat + ENTITLEMENT_TTL_SECONDS) * 1000 });
    // The mark was raised to the signed iat: a restart with the clock further back still judges from it.
    entitlements.dispose();
    vi.setSystemTime((iat + ENTITLEMENT_TTL_SECONDS) * 1000 - 1000);
    const next = await open(store);
    vi.setSystemTime(T0_MS);
    expect(next.entitlements.current().status).toBe('active');
    expect(JSON.parse(store.blobs.get('entitlements') ?? '{}')).toMatchObject({ highWaterMs: (iat + ENTITLEMENT_TTL_SECONDS) * 1000 - 1000 });
  });

  test('unverified-update-fails-closed', async () => {
    const store = memoryStore();
    const { entitlements, log } = await open(store);
    const seen: string[] = [];
    entitlements.onChange((e) => seen.push(e.status));
    const good = await sign(key);
    await entitlements.update(good, SUB);
    const forged = `${good.slice(0, good.lastIndexOf('.'))}.${'A'.repeat(86)}`;
    await expect(entitlements.update(forged, SUB)).resolves.toEqual(INVALID_ENTITLEMENTS);
    expect(entitlements.current()).toEqual(INVALID_ENTITLEMENTS);
    expect(entitlements.has('sync')).toBe(false);
    expect(seen).toEqual(['active', 'invalid']);
    // Persisted as such: a restart does not bring the earlier valid snapshot back.
    expect(store.blobs.get('entitlements')).not.toContain(good);
    const next = await open(store);
    expect(next.entitlements.current()).toEqual(INVALID_ENTITLEMENTS);
    // A valid snapshot for another account is refused too.
    await entitlements.update(good, SUB);
    await expect(entitlements.update(await sign(key, proClaims(T0, { sub: 'user-2' })), SUB)).resolves.toEqual(INVALID_ENTITLEMENTS);
    // Logs carry a fixed reason only.
    expect(log).toHaveBeenCalled();
    for (const [message] of log.mock.calls) {
      expect(String(message)).toMatch(/^entitlements: /);
      expect(String(message)).not.toContain(good.slice(0, 20));
      expect(String(message)).not.toContain('user-2');
    }
  });

  test('older-snapshot-does-not-replace-newer', async () => {
    const { entitlements } = await open(memoryStore());
    const older = await sign(key, proClaims(T0 - 3600));
    await entitlements.update(await sign(key, proClaims(T0, { plan: 'free', features: [] })), SUB);
    await entitlements.update(older, SUB);
    expect(entitlements.current()).toMatchObject({ plan: 'free', features: [] });
  });

  test('refresh-failure-kinds', async () => {
    const { entitlements } = await open(memoryStore());
    await entitlements.update(await sign(key), SUB);
    vi.setSystemTime(EXP_MS + DAY_MS);
    expect(entitlements.current().status).toBe('expired');
    expect(entitlements.markRefreshFailed('network')).toMatchObject({ status: 'grace' });
    // A refusal from the server ends grace and drops the snapshot.
    expect(entitlements.markRefreshFailed('auth')).toEqual(NO_ENTITLEMENTS);
    expect(entitlements.markRefreshFailed('network')).toEqual(NO_ENTITLEMENTS);

    vi.setSystemTime(T0_MS + 2 * DAY_MS);
    // The clock moved back: the new snapshot (iat now) is still accepted, judged at the high-water mark.
    await entitlements.update(await sign(key, proClaims(Math.floor((EXP_MS + DAY_MS) / 1000))), SUB);
    expect(entitlements.current().status).toBe('active');
    expect(entitlements.markRefreshFailed('invalid')).toEqual(INVALID_ENTITLEMENTS);

    // A later valid update clears both the failure and the offline flag.
    const iat = Math.floor((EXP_MS + DAY_MS) / 1000) + 60;
    entitlements.markRefreshFailed('network');
    await entitlements.update(await sign(key, proClaims(iat)), SUB);
    vi.setSystemTime((iat + ENTITLEMENT_TTL_SECONDS) * 1000 + 1);
    expect(entitlements.current().status).toBe('expired');
    expect(() => entitlements.markRefreshFailed('bogus' as never)).toThrow();
  });

  test('update-racing-clear-does-not-revive', async () => {
    const { entitlements } = await open(memoryStore());
    const pending = entitlements.update(await sign(key), SUB);
    entitlements.clear();
    await pending;
    expect(entitlements.current()).toEqual(NO_ENTITLEMENTS);
  });

  test('clear-drops-snapshot-keeps-high-water', async () => {
    const store = memoryStore();
    const { entitlements } = await open(store);
    await entitlements.update(await sign(key), SUB);
    vi.setSystemTime(GRACE_END_MS);
    entitlements.current();
    entitlements.clear();
    expect(entitlements.current()).toEqual(NO_ENTITLEMENTS);
    expect(entitlements.has('sync')).toBe(false);
    const next = await open(store);
    expect(next.entitlements.current()).toEqual(NO_ENTITLEMENTS);
    // The mark survived: a replayed old snapshot is expired even with the clock set back.
    vi.setSystemTime(T0_MS);
    await next.entitlements.update(await sign(key), SUB);
    expect(next.entitlements.current().status).toBe('expired');
  });

  test('corrupt-state-is-none', async () => {
    for (const bad of ['not json', '{"v":2}', JSON.stringify({ v: 1, highWaterMs: -1, offline: false, held: { kind: 'none' } }), '[]']) {
      const store = memoryStore();
      store.blobs.set('entitlements', bad);
      const { entitlements, log } = await open(store);
      expect(entitlements.current(), bad).toEqual(NO_ENTITLEMENTS);
      expect(store.blobs.has('entitlements'), bad).toBe(false);
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[0])).not.toContain(bad);
    }
  });

  test('missing-jwks-makes-every-snapshot-invalid', async () => {
    for (const set of [undefined, '', '{"keys":[]}']) {
      const { entitlements } = await open(memoryStore(), { jwks: set });
      await expect(entitlements.update(await sign(key), SUB)).resolves.toEqual(INVALID_ENTITLEMENTS);
    }
    // A stored snapshot is verified again at start: a build without its key does not honour it.
    const store = memoryStore();
    const first = await open(store);
    await first.entitlements.update(await sign(key), SUB);
    const other = await open(store, { jwks: JSON.stringify(jwksOf(await testKey('k9'))) });
    expect(other.entitlements.current()).toEqual(INVALID_ENTITLEMENTS);
  });
});
