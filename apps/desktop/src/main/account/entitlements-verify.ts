import { compactVerify, importJWK, type CryptoKey } from 'jose';
import {
  COMPACT_JWS_PATTERN,
  DEFAULT_PLAN,
  ENTITLEMENT_ALG,
  ENTITLEMENT_TTL_SECONDS,
  EntitlementClaimsSchema,
  EntitlementHeaderSchema,
  EntitlementJwksSchema,
  FEATURE_FLAGS,
  INVALID_ENTITLEMENTS,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_SNAPSHOT_CHARS,
  OFFLINE_GRACE_MS,
  PLANS,
  type Entitlements,
  type EntitlementJwks,
  type FeatureFlag,
  type Plan,
} from '@app/specs/entitlements-snapshot.spec';

// Snapshot verification (spec `entitlements-snapshot.spec.ts`; acceptance `entitlements-client.feature.md`,
// Verification; review focus "A snapshot cannot be forged or replayed past its life"). Pure: no
// Electron, no clock of its own, no I/O; main passes the time, its high-water mark and whether the
// last refresh failed for a network reason.
//
// Order of checks: the string's shape; the build's JWKS; the protected header, exactly
// (`EntitlementHeaderSchema`: this is what refuses `alg: none`, HMAC, an embedded `jwk`, `jku`,
// `crit`, `b64`); the key by `kid` from the JWKS only; the EdDSA signature (jose, `algorithms:
// ['EdDSA']`); the claims (`EntitlementClaimsSchema`: `iss`, `aud`, `ver`, the TTL cap); `sub`;
// `iat` against the effective now plus skew. Any failure is `INVALID_ENTITLEMENTS`.

/** Why a snapshot was refused: a fixed word, safe to log (never the snapshot or a claim). */
export type SnapshotRefusal = 'format' | 'jwks' | 'header' | 'kid' | 'signature' | 'claims' | 'sub' | 'iat';

/** What main keeps of a verified snapshot (seconds, as signed). `features` holds known flags only. */
export interface VerifiedClaims {
  readonly sub: string;
  readonly plan: Plan;
  readonly features: readonly FeatureFlag[];
  readonly iat: number;
  readonly exp: number;
}

export interface SnapshotClock {
  /** The clock now (epoch ms). */
  readonly now: number;
  /** The latest time main has seen (epoch ms): clock readings and verified `iat`s. */
  readonly highWaterMs: number;
  /** Whether the last refresh failed for a network reason (the only case grace applies). */
  readonly offline: boolean;
}

export interface VerifyOptions extends SnapshotClock {
  /**
   * The build's verification keys (`FROST_PUBLIC_ENTITLEMENT_JWKS`): JSON text or the parsed value.
   * Anything that is not an `EntitlementJwksSchema` JWKS makes every snapshot invalid.
   */
  readonly jwks: unknown;
  /** The signed-in user's ID: the snapshot's `sub` must equal it. */
  readonly expectedSub: string;
}

export type SnapshotVerification =
  | { readonly ok: true; readonly entitlements: Entitlements; readonly claims: VerifiedClaims; readonly iat: number }
  | { readonly ok: false; readonly entitlements: Readonly<Entitlements>; readonly reason: SnapshotRefusal };

/** The time status is computed at: never before the high-water mark, so a clock set back changes nothing. */
export function effectiveNow(now: number, highWaterMs: number): number {
  return Math.max(now, highWaterMs);
}

/** The build's JWKS (JSON text or value), or `null` when it is not a valid `EntitlementJwksSchema` set. */
export function parseEntitlementJwks(raw: unknown): EntitlementJwks | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const parsed = EntitlementJwksSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The entitlements of verified `claims` at `clock` (sync; main re-evaluates as time passes):
 * `active` before `exp`; after it `grace` until `exp + OFFLINE_GRACE_SECONDS` only when `offline`;
 * else `expired` (free). A plan this build does not know shows as `free`; flags count regardless.
 */
export function evaluateClaims(claims: VerifiedClaims, clock: SnapshotClock): Entitlements {
  const at = effectiveNow(clock.now, clock.highWaterMs);
  const expiresAtMs = claims.exp * 1000;
  const graceEndsAtMs = expiresAtMs + OFFLINE_GRACE_MS;
  const times = { expiresAtMs, graceEndsAtMs };
  if (at < expiresAtMs) return { plan: claims.plan, features: [...claims.features], status: 'active', ...times };
  if (clock.offline && at < graceEndsAtMs) return { plan: claims.plan, features: [...claims.features], status: 'grace', ...times };
  return { plan: DEFAULT_PLAN, features: [], status: 'expired', ...times };
}

function refuse(reason: SnapshotRefusal): SnapshotVerification {
  return { ok: false, entitlements: INVALID_ENTITLEMENTS, reason };
}

/** base64url → JSON value, or `undefined`. */
function decodeJsonSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set(FEATURE_FLAGS);
const KNOWN_PLANS: ReadonlySet<string> = new Set(PLANS);

/**
 * Verifies the compact JWS `jws` for `expectedSub` against `jwks`. Never throws and never answers an
 * entitled status for anything it could not verify: every failure is `INVALID_ENTITLEMENTS` with a
 * fixed `reason`. On success, the entitlements at `options` (see `evaluateClaims`), the kept claims
 * and the verified `iat` (seconds; main raises its high-water mark to it).
 */
export async function verifySnapshot(jws: unknown, options: VerifyOptions): Promise<SnapshotVerification> {
  if (typeof jws !== 'string' || jws.length > MAX_SNAPSHOT_CHARS || !COMPACT_JWS_PATTERN.test(jws)) return refuse('format');
  const jwks = parseEntitlementJwks(options.jwks);
  if (!jwks) return refuse('jwks');

  const [headerSegment = '', payloadSegment = ''] = jws.split('.');
  // The header is checked exactly before any key is chosen: only `alg: EdDSA`, `kid`, `typ`.
  const header = EntitlementHeaderSchema.safeParse(decodeJsonSegment(headerSegment));
  if (!header.success) return refuse('header');
  // The key comes from the build's JWKS by `kid`, never from the snapshot.
  const jwk = jwks.keys.find((candidate) => candidate.kid === header.data.kid);
  if (!jwk) return refuse('kid');

  let payload: Uint8Array;
  try {
    const key = (await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ENTITLEMENT_ALG)) as CryptoKey;
    const verified = await compactVerify(jws, key, { algorithms: [ENTITLEMENT_ALG] });
    // jose's own reading of the header must be the one checked above (no decoder disagreement).
    const seen = EntitlementHeaderSchema.safeParse(verified.protectedHeader);
    if (!seen.success || seen.data.kid !== header.data.kid) return refuse('header');
    payload = verified.payload;
  } catch {
    return refuse('signature');
  }
  // Canonical encoding only: the payload segment is exactly the base64url of the verified bytes.
  if (Buffer.from(payload).toString('base64url') !== payloadSegment) return refuse('signature');

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as unknown;
  } catch {
    return refuse('claims');
  }
  const claims = EntitlementClaimsSchema.safeParse(raw);
  if (!claims.success || claims.data.exp - claims.data.iat > ENTITLEMENT_TTL_SECONDS) return refuse('claims');
  if (options.expectedSub.length === 0 || claims.data.sub !== options.expectedSub) return refuse('sub');
  const at = effectiveNow(options.now, options.highWaterMs);
  if (claims.data.iat * 1000 > at + MAX_CLOCK_SKEW_SECONDS * 1000) return refuse('iat');

  const plan: Plan = KNOWN_PLANS.has(claims.data.plan) ? (claims.data.plan as Plan) : DEFAULT_PLAN;
  const features = claims.data.features.filter((flag): flag is FeatureFlag => KNOWN_FLAGS.has(flag));
  const kept: VerifiedClaims = { sub: claims.data.sub, plan, features, iat: claims.data.iat, exp: claims.data.exp };
  return { ok: true, entitlements: evaluateClaims(kept, options), claims: kept, iat: kept.iat };
}
