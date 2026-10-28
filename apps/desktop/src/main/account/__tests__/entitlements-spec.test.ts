// Spec: specs/entitlements-snapshot.spec.ts (EntitlementHeaderSchema, EntitlementClaimsSchema,
// EntitlementsSchema, OFFLINE_GRACE_MS, entitlementGrants)
// Acceptance: specs/entitlements-client.feature.md (Spec schemas)
import { describe, expect, test } from 'vitest';
import {
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_STATUSES,
  ENTITLEMENT_TTL_SECONDS,
  ENTITLED_STATUSES,
  EntitlementClaimsSchema,
  EntitlementHeaderSchema,
  EntitlementsSchema,
  entitlementGrants,
  INVALID_ENTITLEMENTS,
  NO_ENTITLEMENTS,
  OFFLINE_GRACE_MS,
  type Entitlements,
} from '@app/specs/entitlements-snapshot.spec';
import { proClaims, T0, T0_MS } from './snapshots';

const header = { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE };
const timed = (status: Entitlements['status'], overrides: Partial<Entitlements> = {}): Entitlements => ({
  plan: 'pro',
  features: ['ai-agent', 'sync'],
  status,
  expiresAtMs: T0_MS,
  graceEndsAtMs: T0_MS + OFFLINE_GRACE_MS,
  ...overrides,
});

describe('entitlements spec schemas', () => {
  test('header-schema-is-exact', () => {
    expect(EntitlementHeaderSchema.safeParse(header).success).toBe(true);
    const extras = [{ jwk: { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43) } }, { jku: 'https://evil.test/keys' }, { x5u: 'https://evil.test/c' }, { crit: ['b64'] }, { b64: false }, { cty: 'JWT' }];
    for (const extra of extras) expect(EntitlementHeaderSchema.safeParse({ ...header, ...extra }).success, JSON.stringify(extra)).toBe(false);
    for (const alg of ['none', 'HS256', 'ES256', 'RS256', 'Ed25519', 'eddsa']) expect(EntitlementHeaderSchema.safeParse({ ...header, alg }).success, alg).toBe(false);
    for (const typ of ['JWT', 'at+jwt', undefined]) expect(EntitlementHeaderSchema.safeParse({ ...header, typ }).success, String(typ)).toBe(false);
    expect(EntitlementHeaderSchema.safeParse({ alg: 'EdDSA', typ: ENTITLEMENT_JWS_TYPE }).success).toBe(false);
  });

  test('claims-schema-caps-ttl', () => {
    expect(EntitlementClaimsSchema.safeParse(proClaims()).success).toBe(true);
    expect(EntitlementClaimsSchema.safeParse(proClaims(T0, { exp: T0 + ENTITLEMENT_TTL_SECONDS })).success).toBe(true);
    expect(EntitlementClaimsSchema.safeParse(proClaims(T0, { exp: T0 + ENTITLEMENT_TTL_SECONDS + 1 })).success).toBe(false);
    expect(EntitlementClaimsSchema.safeParse(proClaims(T0, { exp: T0 })).success).toBe(false);
    expect(EntitlementClaimsSchema.safeParse(proClaims(T0, { exp: T0 - 1 })).success).toBe(false);
    // Seconds, not milliseconds: an `exp` in ms is far beyond the TTL.
    expect(EntitlementClaimsSchema.safeParse(proClaims(T0, { exp: T0_MS })).success).toBe(false);
    // Unknown claims are stripped (forward-compatible), not kept.
    const parsed = EntitlementClaimsSchema.parse(proClaims(T0, { device: 'abc' }));
    expect(parsed).not.toHaveProperty('device');
  });

  test('entitlements-schema-fails-closed', () => {
    for (const status of ENTITLEMENT_STATUSES.filter((s) => !ENTITLED_STATUSES.includes(s))) {
      const times = status === 'expired' ? {} : { expiresAtMs: null, graceEndsAtMs: null };
      expect(EntitlementsSchema.safeParse(timed(status, { ...times, plan: 'pro', features: [] })).success, `${status} pro`).toBe(false);
      expect(EntitlementsSchema.safeParse(timed(status, { ...times, plan: 'free', features: ['sync'] })).success, `${status} flags`).toBe(false);
      expect(EntitlementsSchema.safeParse(timed(status, { ...times, plan: 'free', features: [] })).success, `${status} free`).toBe(true);
    }
    for (const status of ENTITLED_STATUSES) expect(EntitlementsSchema.safeParse(timed(status)).success, status).toBe(true);
    expect(EntitlementsSchema.parse(NO_ENTITLEMENTS)).toEqual(NO_ENTITLEMENTS);
    expect(EntitlementsSchema.parse(INVALID_ENTITLEMENTS)).toEqual(INVALID_ENTITLEMENTS);
  });

  test('entitlements-schema-ties-times-to-status', () => {
    for (const status of ['active', 'grace', 'expired'] as const) {
      const base = status === 'expired' ? { plan: 'free' as const, features: [] } : {};
      expect(EntitlementsSchema.safeParse(timed(status, base)).success, status).toBe(true);
      expect(EntitlementsSchema.safeParse(timed(status, { ...base, expiresAtMs: null })).success, `${status} no exp`).toBe(false);
      expect(EntitlementsSchema.safeParse(timed(status, { ...base, graceEndsAtMs: null })).success, `${status} no grace`).toBe(false);
      expect(EntitlementsSchema.safeParse(timed(status, { ...base, graceEndsAtMs: T0_MS + OFFLINE_GRACE_MS + 1 })).success, `${status} grace off`).toBe(false);
      // Seconds where milliseconds belong do not satisfy the offset.
      expect(EntitlementsSchema.safeParse(timed(status, { ...base, expiresAtMs: T0, graceEndsAtMs: T0 + OFFLINE_GRACE_MS / 1000 })).success, `${status} seconds`).toBe(false);
    }
    for (const status of ['none', 'invalid'] as const) {
      const free = { plan: 'free' as const, features: [] };
      expect(EntitlementsSchema.safeParse(timed(status, { ...free, expiresAtMs: null, graceEndsAtMs: null })).success, status).toBe(true);
      expect(EntitlementsSchema.safeParse(timed(status, { ...free })).success, `${status} times`).toBe(false);
      expect(EntitlementsSchema.safeParse(timed(status, { ...free, graceEndsAtMs: null })).success, `${status} exp`).toBe(false);
    }
    // Only known plans and flags; no other member (the snapshot never rides along).
    expect(EntitlementsSchema.safeParse(timed('active', { plan: 'team' as never })).success).toBe(false);
    expect(EntitlementsSchema.safeParse(timed('active', { features: ['teleport' as never] })).success).toBe(false);
    expect(EntitlementsSchema.safeParse(timed('active', { features: ['sync', 'sync'] })).success).toBe(false);
    expect(EntitlementsSchema.safeParse({ ...timed('active'), snapshot: 'a.b.c' }).success).toBe(false);
  });

  test('entitlement-grants-needs-entitled-status', () => {
    expect(entitlementGrants(timed('active'), 'sync')).toBe(true);
    expect(entitlementGrants(timed('grace'), 'ai-agent')).toBe(true);
    expect(entitlementGrants(timed('active'), 'search-console')).toBe(false);
    // Even a value that breaks the schema's rule is not entitled outside active/grace.
    for (const status of ['none', 'expired', 'invalid'] as const) expect(entitlementGrants(timed(status), 'sync'), status).toBe(false);
  });
});
