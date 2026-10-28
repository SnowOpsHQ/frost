// Spec: specs/entitlements-snapshot.spec.ts (EntitlementHeaderSchema, EntitlementClaimsSchema,
// EntitlementJwksSchema, EntitlementsSchema, MAX_CLOCK_SKEW_SECONDS, OFFLINE_GRACE_SECONDS)
// Acceptance: specs/entitlements-client.feature.md (Verification) · review focus "A snapshot cannot be
// forged or replayed past its life"
import { createHmac } from 'node:crypto';
import { CompactSign } from 'jose';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_TTL_SECONDS,
  EntitlementsSchema,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_SNAPSHOT_CHARS,
  OFFLINE_GRACE_MS,
  PLAN_FEATURES,
} from '@app/specs/entitlements-snapshot.spec';
import { verifySnapshot, type VerifyOptions } from '../entitlements-verify';
import { b64url, DAY_MS, encoder, jwksOf, parts, proClaims, sign, signRaw, SUB, T0, T0_MS, testKey, type TestKey } from './snapshots';

let key: TestKey;
let rotated: TestKey;
let stranger: TestKey;
let jwks: unknown;

beforeAll(async () => {
  key = await testKey('k1');
  rotated = await testKey('k2');
  stranger = await testKey('k3');
  jwks = jwksOf(key, rotated);
});

const EXP_MS = T0_MS + ENTITLEMENT_TTL_SECONDS * 1000;
const GRACE_END_MS = EXP_MS + OFFLINE_GRACE_MS;
const at = (now: number, overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({ jwks, expectedSub: SUB, now, highWaterMs: 0, offline: false, ...overrides });

async function expectInvalid(jws: unknown, options: VerifyOptions = at(T0_MS + 1000), reason?: string) {
  const result = await verifySnapshot(jws, options);
  expect(result.ok).toBe(false);
  expect(result.entitlements).toEqual({ plan: 'free', features: [], status: 'invalid', expiresAtMs: null, graceEndsAtMs: null });
  if (reason !== undefined && !result.ok) expect(result.reason).toBe(reason);
  return result;
}

/** Every forgery the suite builds, for `snapshot-fails-closed`. */
const forgeries: { name: string; jws: () => Promise<string> | string; jwks?: () => unknown }[] = [];

describe('verifySnapshot', () => {
  test('valid-snapshot-is-active', async () => {
    const jws = await sign(key);
    const result = await verifySnapshot(jws, at(T0_MS + 1000));
    expect(result.ok).toBe(true);
    expect(result.entitlements).toEqual({ plan: 'pro', features: [...PLAN_FEATURES.pro], status: 'active', expiresAtMs: EXP_MS, graceEndsAtMs: GRACE_END_MS });
    expect(EntitlementsSchema.parse(result.entitlements)).toEqual(result.entitlements);
    if (result.ok) {
      expect(result.iat).toBe(T0);
      expect(result.claims).toEqual({ sub: SUB, plan: 'pro', features: [...PLAN_FEATURES.pro], iat: T0, exp: T0 + ENTITLEMENT_TTL_SECONDS });
    }
    // The JWKS may come as the build's JSON text (FROST_PUBLIC_ENTITLEMENT_JWKS).
    expect((await verifySnapshot(jws, at(T0_MS, { jwks: JSON.stringify(jwks) }))).entitlements.status).toBe('active');
    // A free account: active, no features.
    const free = await verifySnapshot(await sign(key, proClaims(T0, { plan: 'free', features: [] })), at(T0_MS));
    expect(free.entitlements).toMatchObject({ plan: 'free', features: [], status: 'active' });
  });

  test('rotation-key-verifies', async () => {
    // (The raw test signer agrees with jose's on a valid header.)
    expect((await verifySnapshot(await signRaw(key, { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE }), at(T0_MS))).entitlements.status).toBe('active');
    expect((await verifySnapshot(await sign(rotated), at(T0_MS))).entitlements.status).toBe('active');
  });

  test('tampered-payload-is-invalid', async () => {
    const [h, , s] = parts(await sign(key, proClaims(T0, { plan: 'free', features: [] })));
    for (const claims of [proClaims(), proClaims(T0, { sub: 'user-2' }), proClaims(T0, { plan: 'free', features: ['sync'] })]) {
      const jws = `${h}.${b64url(JSON.stringify(claims))}.${s}`;
      forgeries.push({ name: 'tampered payload', jws: () => jws });
      await expectInvalid(jws, at(T0_MS), 'signature');
    }
  });

  test('tampered-signature-is-invalid', async () => {
    const [h, p, s] = parts(await sign(key));
    const bytes = Buffer.from(s, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const jws = `${h}.${p}.${b64url(bytes)}`;
    forgeries.push({ name: 'tampered signature', jws: () => jws });
    await expectInvalid(jws, at(T0_MS), 'signature');
    // A signature by another key under a trusted kid.
    const other = await sign(stranger, proClaims(), { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE });
    forgeries.push({ name: 'stranger under k1', jws: () => other });
    await expectInvalid(other, at(T0_MS), 'signature');
  });

  test('alg-none-is-invalid', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE }));
    const p = b64url(JSON.stringify(proClaims()));
    for (const jws of [`${h}.${p}.`, `${h}.${p}.AA`]) {
      forgeries.push({ name: 'alg none', jws: () => jws });
      await expectInvalid(jws, at(T0_MS));
    }
  });

  test('hs256-with-public-key-is-invalid', async () => {
    const header = { alg: 'HS256', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE };
    const claims = encoder.encode(JSON.stringify(proClaims()));
    const secrets = [Buffer.from(key.publicJwk.x, 'base64url'), encoder.encode(key.publicJwk.x), encoder.encode(JSON.stringify(key.publicJwk))];
    for (const secret of secrets) {
      const jws = await new CompactSign(claims).setProtectedHeader(header).sign(secret);
      forgeries.push({ name: 'HS256', jws: () => jws });
      await expectInvalid(jws, at(T0_MS), 'header');
    }
    // The same, hand-rolled with node:crypto (no library check in the way).
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(proClaims()))}`;
    const mac = createHmac('sha256', Buffer.from(key.publicJwk.x, 'base64url')).update(signingInput).digest();
    await expectInvalid(`${signingInput}.${b64url(mac)}`, at(T0_MS), 'header');
  });

  test('unknown-kid-is-invalid', async () => {
    const jws = await sign(stranger);
    forgeries.push({ name: 'unknown kid', jws: () => jws });
    await expectInvalid(jws, at(T0_MS), 'kid');
  });

  test('wrong-key-type-in-jwks-is-invalid', async () => {
    const jws = await sign(key);
    const x = key.publicJwk.x;
    const bad = [
      { keys: [{ ...key.publicJwk, crv: 'X25519' }] },
      { keys: [{ ...key.publicJwk, crv: 'Ed448' }] },
      { keys: [{ kty: 'EC', crv: 'P-256', x, y: x, kid: 'k1' }] },
      { keys: [{ kty: 'oct', k: x, kid: 'k1' }] },
      { keys: [{ ...key.publicJwk, d: x }] },
      { keys: [{ ...key.publicJwk, alg: 'HS256' }] },
    ];
    for (const set of bad) {
      forgeries.push({ name: 'bad jwks', jws: () => jws, jwks: () => set });
      await expectInvalid(jws, at(T0_MS, { jwks: set }), 'jwks');
    }
  });

  test('embedded-jwk-header-is-ignored', async () => {
    const header = { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE, jwk: { kty: 'OKP', crv: 'Ed25519', x: stranger.publicJwk.x } };
    const jws = await sign(stranger, proClaims(), header);
    forgeries.push({ name: 'embedded jwk', jws: () => jws });
    await expectInvalid(jws, at(T0_MS), 'header');
    for (const extra of [{ jku: 'https://evil.test/keys' }, { x5u: 'https://evil.test/c' }, { crit: ['exp'], exp: 1 }, { cty: 'JWT' }]) {
      // Signed by the trusted key itself: only the header's extra member is wrong.
      const other = await signRaw(key, { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE, ...extra });
      forgeries.push({ name: 'header extra', jws: () => other });
      await expectInvalid(other, at(T0_MS), 'header');
    }
    // b64: false (RFC 7797, unencoded payload) is refused before any verification.
    const unencoded = await signRaw(key, { alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE, b64: false, crit: ['b64'] });
    await expectInvalid(unencoded, at(T0_MS), 'header');
  });

  test('wrong-claims-are-invalid', async () => {
    const cases: Record<string, unknown>[] = [{ iss: 'someone-else' }, { aud: 'frost-web' }, { aud: ['frost-desktop'] }, { ver: 2 }, { ver: undefined }, { email: 'not-an-email' }];
    for (const overrides of cases) {
      const jws = await sign(key, proClaims(T0, overrides));
      forgeries.push({ name: `claims ${JSON.stringify(overrides)}`, jws: () => jws });
      await expectInvalid(jws, at(T0_MS), 'claims');
    }
    for (const typ of ['JWT', 'at+jwt']) {
      const jws = await sign(key, proClaims(), { alg: 'EdDSA', kid: 'k1', typ });
      forgeries.push({ name: `typ ${typ}`, jws: () => jws });
      await expectInvalid(jws, at(T0_MS), 'header');
    }
    // A payload that is not JSON, under a valid signature.
    const garbage = await new CompactSign(encoder.encode('not json')).setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: ENTITLEMENT_JWS_TYPE }).sign(key.privateKey);
    await expectInvalid(garbage, at(T0_MS), 'claims');
  });

  test('wrong-sub-is-invalid', async () => {
    const jws = await sign(key, proClaims(T0, { sub: 'user-2' }));
    forgeries.push({ name: 'other account', jws: () => jws });
    await expectInvalid(jws, at(T0_MS), 'sub');
    await expectInvalid(await sign(key), at(T0_MS, { expectedSub: 'user-2' }), 'sub');
    await expectInvalid(await sign(key), at(T0_MS, { expectedSub: '' }), 'sub');
  });

  test('future-iat-beyond-skew-is-invalid', async () => {
    const skew = MAX_CLOCK_SKEW_SECONDS;
    await expectInvalid(await sign(key, proClaims(T0 + skew + 1)), at(T0_MS), 'iat');
    expect((await verifySnapshot(await sign(key, proClaims(T0 + skew)), at(T0_MS))).entitlements.status).toBe('active');
    // The skew is measured from the effective now (the high-water mark), not a clock set back.
    expect((await verifySnapshot(await sign(key, proClaims(T0 + 3600)), at(T0_MS, { highWaterMs: T0_MS + 3600_000 }))).entitlements.status).toBe('active');
  });

  test('ttl-over-limit-is-invalid', async () => {
    const jws = await sign(key, proClaims(T0, { exp: T0 + ENTITLEMENT_TTL_SECONDS + 1 }));
    forgeries.push({ name: 'long ttl', jws: () => jws });
    await expectInvalid(jws, at(T0_MS), 'claims');
    await expectInvalid(await sign(key, proClaims(T0, { exp: T0 + 365 * 86400 })), at(T0_MS), 'claims');
  });

  test('expired-online-is-free', async () => {
    const jws = await sign(key);
    const before = await verifySnapshot(jws, at(EXP_MS - 1));
    expect(before.entitlements.status).toBe('active');
    for (const now of [EXP_MS, EXP_MS + 1, EXP_MS + DAY_MS]) {
      const result = await verifySnapshot(jws, at(now));
      expect(result.ok).toBe(true);
      expect(result.entitlements).toEqual({ plan: 'free', features: [], status: 'expired', expiresAtMs: EXP_MS, graceEndsAtMs: GRACE_END_MS });
    }
  });

  test('expired-offline-within-grace-is-grace', async () => {
    const jws = await sign(key);
    for (const now of [EXP_MS, EXP_MS + DAY_MS, GRACE_END_MS - 1]) {
      expect((await verifySnapshot(jws, at(now, { offline: true }))).entitlements).toEqual({
        plan: 'pro',
        features: [...PLAN_FEATURES.pro],
        status: 'grace',
        expiresAtMs: EXP_MS,
        graceEndsAtMs: GRACE_END_MS,
      });
    }
    // Offline before exp is still simply active.
    expect((await verifySnapshot(jws, at(T0_MS, { offline: true }))).entitlements.status).toBe('active');
  });

  test('beyond-grace-is-expired', async () => {
    const jws = await sign(key);
    for (const now of [GRACE_END_MS, GRACE_END_MS + 1, GRACE_END_MS + 30 * DAY_MS]) {
      expect((await verifySnapshot(jws, at(now, { offline: true }))).entitlements).toMatchObject({ plan: 'free', features: [], status: 'expired' });
    }
  });

  test('clock-rollback-does-not-extend-grace', async () => {
    const jws = await sign(key);
    // The clock is set back to inside the snapshot's life, but main has seen a later time.
    for (const offline of [false, true]) {
      expect((await verifySnapshot(jws, at(T0_MS + DAY_MS, { highWaterMs: GRACE_END_MS + 1, offline }))).entitlements.status, `offline ${offline}`).toBe('expired');
    }
    // Online past exp, the clock set back: not revived.
    expect((await verifySnapshot(jws, at(T0_MS + DAY_MS, { highWaterMs: EXP_MS + 1 }))).entitlements.status).toBe('expired');
    // Offline within grace, the clock set back: still grace with the same end, never active.
    const graced = await verifySnapshot(jws, at(T0_MS, { highWaterMs: EXP_MS + DAY_MS, offline: true }));
    expect(graced.entitlements).toMatchObject({ status: 'grace', graceEndsAtMs: GRACE_END_MS });
  });

  test('unknown-flags-dropped', async () => {
    const jws = await sign(key, proClaims(T0, { features: ['teleport', 'sync', 'ai-agent-v2', 'search-console'] }));
    expect((await verifySnapshot(jws, at(T0_MS))).entitlements).toMatchObject({ plan: 'pro', features: ['sync', 'search-console'], status: 'active' });
    const team = await sign(key, proClaims(T0, { plan: 'team', features: ['sync', 'team-seats'] }));
    const result = await verifySnapshot(team, at(T0_MS));
    expect(result.entitlements).toMatchObject({ plan: 'free', features: ['sync'], status: 'active' });
    expect(EntitlementsSchema.safeParse(result.entitlements).success).toBe(true);
  });

  test('malformed-jwks-is-invalid', async () => {
    const jws = await sign(key);
    for (const set of [undefined, null, '', 'not json', '{"keys":[]}', { keys: [] }, { keys: [key.publicJwk, key.publicJwk] }, [key.publicJwk], key.publicJwk, { keys: [key.publicJwk], extra: 1 }]) {
      await expectInvalid(jws, at(T0_MS, { jwks: set }), 'jwks');
    }
  });

  test('malformed-snapshot-is-invalid', async () => {
    const jws = await sign(key);
    for (const bad of [undefined, null, 42, {}, '', 'a.b', `${jws}.x`, `${jws} `, `${jws}=`, `a${'A'.repeat(MAX_SNAPSHOT_CHARS)}.b.c`]) {
      await expectInvalid(bad, at(T0_MS), 'format');
    }
    // A header that is not JSON, or not an object.
    const [, p, s] = parts(jws);
    for (const h of [b64url('not json'), b64url('[]'), b64url('null')]) await expectInvalid(`${h}.${p}.${s}`, at(T0_MS), 'header');
  });

  test('snapshot-fails-closed', async () => {
    expect(forgeries.length).toBeGreaterThan(20);
    const times = [T0_MS, EXP_MS - 1, EXP_MS + 1, GRACE_END_MS - 1, GRACE_END_MS + 1];
    for (const forgery of forgeries) {
      const jws = await forgery.jws();
      for (const now of times) {
        for (const offline of [false, true]) {
          const result = await verifySnapshot(jws, at(now, { offline, ...(forgery.jwks ? { jwks: forgery.jwks() } : {}) }));
          expect(result.entitlements.status, forgery.name).toBe('invalid');
          expect(result.entitlements.features, forgery.name).toEqual([]);
          expect(result.entitlements.plan, forgery.name).toBe('free');
        }
      }
    }
  });
});
