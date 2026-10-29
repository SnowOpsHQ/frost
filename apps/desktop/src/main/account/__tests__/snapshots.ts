// Test-only: ephemeral Ed25519 keys and snapshots built the way the backend builds them
// (`apps/backend/src/entitlements.ts`, `issueSnapshot`). No key is ever committed.
import { CompactSign, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_CLAIMS_VERSION,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_KEY_CURVE,
  ENTITLEMENT_TTL_SECONDS,
  PLAN_FEATURES,
  type EntitlementPublicJwk,
} from '@app/specs/entitlements-snapshot.spec';

export interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: EntitlementPublicJwk;
}

export async function testKey(kid = 'test-key-1'): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(ENTITLEMENT_ALG, { crv: ENTITLEMENT_KEY_CURVE, extractable: true });
  const { x } = await exportJWK(publicKey);
  if (typeof x !== 'string') throw new Error('no x');
  return { kid, privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' } };
}

export const jwksOf = (...keys: TestKey[]) => ({ keys: keys.map((key) => key.publicJwk) });

/** 2026-10-01T00:00:00Z. */
export const T0_MS = Date.UTC(2026, 9, 1);
export const T0 = T0_MS / 1000;
export const SUB = 'user-1';
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The claims the backend signs for a `pro` account at `iatSeconds`. */
export function proClaims(iatSeconds: number = T0, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ENTITLEMENT_ISSUER,
    aud: ENTITLEMENT_AUDIENCE,
    sub: SUB,
    email: 'dana@example.com',
    plan: 'pro',
    features: [...PLAN_FEATURES.pro],
    iat: iatSeconds,
    exp: iatSeconds + ENTITLEMENT_TTL_SECONDS,
    ver: ENTITLEMENT_CLAIMS_VERSION,
    ...overrides,
  };
}

export const encoder = new TextEncoder();
export const b64url = (value: string | Uint8Array) => Buffer.from(typeof value === 'string' ? encoder.encode(value) : value).toString('base64url');

/** A compact JWS of `claims`, signed by `key` with the spec's header (or `header`). */
export function sign(key: TestKey, claims: Record<string, unknown> = proClaims(), header?: Record<string, unknown>): Promise<string> {
  return new CompactSign(encoder.encode(JSON.stringify(claims)))
    .setProtectedHeader((header ?? { alg: ENTITLEMENT_ALG, kid: key.kid, typ: ENTITLEMENT_JWS_TYPE }) as { alg: string })
    .sign(key.privateKey);
}

/** A compact JWS signed (Ed25519) over any header, even one jose itself would refuse to produce. */
export async function signRaw(key: TestKey, header: Record<string, unknown>, claims: Record<string, unknown> = proClaims()): Promise<string> {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign('Ed25519', key.privateKey, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

/** Splits a compact JWS. */
export function parts(jws: string): [string, string, string] {
  const [h, p, s] = jws.split('.');
  if (h === undefined || p === undefined || s === undefined) throw new Error('not a compact JWS');
  return [h, p, s];
}
