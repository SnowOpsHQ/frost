import { calculateJwkThumbprint, CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK, type CryptoKey } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_PLAN,
  ED25519_KEY_PART_PATTERN,
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_CLAIMS_VERSION,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_JWS_TYPE,
  ENTITLEMENT_KEY_CURVE,
  ENTITLEMENT_KEY_ID_PATTERN,
  ENTITLEMENT_KEY_TYPE,
  ENTITLEMENT_TTL_SECONDS,
  EntitlementClaimsSchema,
  EntitlementHeaderSchema,
  EntitlementJwksSchema,
  EntitlementPublicJwkSchema,
  PLAN_FEATURES,
  PLANS,
  type EntitlementJwks,
  type EntitlementPublicJwk,
  type Plan,
} from '@app/specs/entitlements-snapshot.spec';
import type { Database } from './db/client';
import { entitlements } from './db/schema';

// Signed entitlement snapshots (spec `entitlements.feature.md`, `entitlements-snapshot.spec.ts`).
// The private key comes from `ENTITLEMENT_SIGNING_KEY` and never leaves this module: what is
// published is `EntitlementSigner.jwks`, built from the public half only and validated against the
// spec's strict public-JWK schema. Error messages name the variable, never the key.

export class EntitlementKeyError extends Error {
  override readonly name = 'EntitlementKeyError';
}

/** A private Ed25519 JWK as `ENTITLEMENT_SIGNING_KEY` carries it (other members are ignored). */
const PrivateJwkSchema = z.object({
  kty: z.literal(ENTITLEMENT_KEY_TYPE),
  crv: z.literal(ENTITLEMENT_KEY_CURVE),
  x: z.string().regex(ED25519_KEY_PART_PATTERN),
  d: z.string().regex(ED25519_KEY_PART_PATTERN),
  kid: z.string().optional(),
  alg: z.enum([ENTITLEMENT_ALG, 'Ed25519']).optional(),
  use: z.literal('sig').optional(),
});

type PrivateJwk = Pick<z.infer<typeof PrivateJwkSchema>, 'kty' | 'crv' | 'x' | 'd'>;

/** JSON text → value, or `undefined`; the parser's message (which can quote the text) is dropped. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Why `raw` is not a usable signing key for `keyId`, or `null`. The answer never contains the key:
 * it is one of a few fixed phrases.
 */
export function signingKeyProblem(raw: string, keyId: string | undefined): string | null {
  const value = parseJson(raw);
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return 'must be a JSON object (a private JWK)';
  const record = value as Record<string, unknown>;
  if (record.kty !== ENTITLEMENT_KEY_TYPE || record.crv !== ENTITLEMENT_KEY_CURVE) return 'must be an Ed25519 key (kty OKP, crv Ed25519)';
  if (record.d === undefined) return 'must be a private key (it has no d)';
  const parsed = PrivateJwkSchema.safeParse(record);
  if (!parsed.success) return 'is not a well-formed Ed25519 private JWK';
  if (parsed.data.kid !== undefined && keyId !== undefined && parsed.data.kid !== keyId) return 'has a kid other than ENTITLEMENT_KEY_ID';
  return null;
}

/** Why `raw` is not a usable rotation JWKS next to the signing key `keyId`, or `null`. */
export function publicKeysProblem(raw: string, keyId: string | undefined): string | null {
  const value = parseJson(raw);
  if (value === undefined) return 'must be JSON (a JWKS: { "keys": [...] })';
  const keys = (value as { keys?: unknown } | null)?.keys;
  if (Array.isArray(keys) && keys.some((key) => key !== null && typeof key === 'object' && 'd' in key)) return 'must hold public keys only (a key has d)';
  const parsed = EntitlementJwksSchema.safeParse(value);
  if (!parsed.success) return 'must be a JWKS of Ed25519 public keys, each kid once';
  if (keyId !== undefined && parsed.data.keys.some((key) => key.kid === keyId)) return 'repeats the kid of ENTITLEMENT_KEY_ID';
  return null;
}

export interface EntitlementKeyConfig {
  /** `ENTITLEMENT_SIGNING_KEY`: the private JWK, as JSON. */
  readonly signingKey: string;
  /** `ENTITLEMENT_KEY_ID`. */
  readonly keyId: string;
  /** `ENTITLEMENT_PUBLIC_KEYS`: a JWKS of public keys still published during a rotation. */
  readonly publicKeys?: string | undefined;
}

/** Signs snapshots with the configured key. Holds the private key; exposes only the public JWKS. */
export interface EntitlementSigner {
  readonly kid: string;
  /** What `ENTITLEMENT_KEYS_PATH` answers: the signing key's public half, then the rotation keys. */
  readonly jwks: EntitlementJwks;
  /** A compact JWS over `payload` (UTF-8 JSON), with the spec's protected header. */
  signPayload(payload: string): Promise<string>;
}

const encoder = new TextEncoder();

/**
 * Loads and checks the signing key: well-formed (`signingKeyProblem`), importable, and its `d`
 * belongs to its `x` (a test signature verifies with the public half). Throws `EntitlementKeyError`.
 */
export async function loadEntitlementSigner(config: EntitlementKeyConfig): Promise<EntitlementSigner> {
  const refuse = (variable: string, problem: string): never => {
    throw new EntitlementKeyError(`${variable} ${problem}`);
  };
  if (!ENTITLEMENT_KEY_ID_PATTERN.test(config.keyId)) refuse('ENTITLEMENT_KEY_ID', `must match ${ENTITLEMENT_KEY_ID_PATTERN.source}`);
  const keyProblem = signingKeyProblem(config.signingKey, config.keyId);
  if (keyProblem) refuse('ENTITLEMENT_SIGNING_KEY', keyProblem);
  const rotationProblem = config.publicKeys === undefined ? null : publicKeysProblem(config.publicKeys, config.keyId);
  if (rotationProblem) refuse('ENTITLEMENT_PUBLIC_KEYS', rotationProblem);

  const parsed = PrivateJwkSchema.parse(JSON.parse(config.signingKey));
  const jwk: PrivateJwk = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, d: parsed.d };
  const publicJwk: EntitlementPublicJwk = EntitlementPublicJwkSchema.parse({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    kid: config.keyId,
    alg: ENTITLEMENT_ALG,
    use: 'sig',
  });

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = (await importJWK(jwk, ENTITLEMENT_ALG)) as CryptoKey;
    publicKey = (await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ENTITLEMENT_ALG)) as CryptoKey;
  } catch {
    return refuse('ENTITLEMENT_SIGNING_KEY', 'could not be imported as an Ed25519 private key (does its d match its x?)');
  }

  const header = EntitlementHeaderSchema.parse({ alg: ENTITLEMENT_ALG, kid: config.keyId, typ: ENTITLEMENT_JWS_TYPE });
  const signPayload = (payload: string): Promise<string> => new CompactSign(encoder.encode(payload)).setProtectedHeader(header).sign(privateKey);

  // Node refuses a mismatched pair at import; this proves it on any runtime: its own `x` must verify.
  try {
    await compactVerify(await signPayload('{"probe":true}'), publicKey, { algorithms: [ENTITLEMENT_ALG] });
  } catch {
    return refuse('ENTITLEMENT_SIGNING_KEY', 'has a d that does not match its x');
  }

  const rotation = config.publicKeys === undefined ? [] : EntitlementJwksSchema.parse(JSON.parse(config.publicKeys)).keys;
  const jwks = EntitlementJwksSchema.parse({ keys: [publicJwk, ...rotation] });
  return { kid: config.keyId, jwks, signPayload };
}

/** The account a snapshot is for. */
export interface SnapshotSubject {
  readonly id: string;
  readonly email: string;
}

/**
 * A snapshot for `subject` on `plan`: the plan's features, valid for `ENTITLEMENT_TTL_SECONDS` from
 * `now`. The claims are validated against the spec before signing, so the server never signs what a
 * client would refuse.
 */
export function issueSnapshot(signer: EntitlementSigner, subject: SnapshotSubject, plan: Plan, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const claims = EntitlementClaimsSchema.parse({
    iss: ENTITLEMENT_ISSUER,
    aud: ENTITLEMENT_AUDIENCE,
    sub: subject.id,
    email: subject.email,
    plan,
    features: [...PLAN_FEATURES[plan]],
    iat,
    exp: iat + ENTITLEMENT_TTL_SECONDS,
    ver: ENTITLEMENT_CLAIMS_VERSION,
  });
  return signer.signPayload(JSON.stringify(claims));
}

/** A new Ed25519 signing key (admin `keygen`, tests): never written anywhere by this module. */
export interface GeneratedEntitlementKey {
  readonly kid: string;
  /** The private JWK, `kid` included (for `ENTITLEMENT_SIGNING_KEY`). */
  readonly privateJwk: PrivateJwk & { readonly kid: string };
  readonly privateJwkJson: string;
  /** The public JWKS (for the desktop's `FROST_PUBLIC_ENTITLEMENT_JWKS`). */
  readonly jwks: EntitlementJwks;
}

/** Generates a key; `kid` defaults to the public key's RFC 7638 thumbprint. */
export async function generateEntitlementKey(kid?: string): Promise<GeneratedEntitlementKey> {
  if (kid !== undefined && !ENTITLEMENT_KEY_ID_PATTERN.test(kid)) throw new EntitlementKeyError(`key id must match ${ENTITLEMENT_KEY_ID_PATTERN.source}`);
  const { privateKey } = await generateKeyPair(ENTITLEMENT_ALG, { crv: ENTITLEMENT_KEY_CURVE, extractable: true });
  const exported = PrivateJwkSchema.parse(await exportJWK(privateKey));
  const base = { kty: exported.kty, crv: exported.crv, x: exported.x };
  const keyId = kid ?? (await calculateJwkThumbprint(base, 'sha256'));
  const privateJwk = { ...base, d: exported.d, kid: keyId };
  const jwks = EntitlementJwksSchema.parse({ keys: [{ ...base, kid: keyId, alg: ENTITLEMENT_ALG, use: 'sig' }] });
  return { kid: keyId, privateJwk, privateJwkJson: JSON.stringify(privateJwk), jwks };
}

// ---- Plans --------------------------------------------------------------------------------------

export const PlanSchema = z.enum(PLANS);

/** The account's plan: its `entitlements` row, else `DEFAULT_PLAN`. */
export async function planFor(db: Database, userId: string): Promise<Plan> {
  const rows = await db.select({ plan: entitlements.plan }).from(entitlements).where(eq(entitlements.userId, userId)).limit(1);
  const row = rows[0];
  return row ? PlanSchema.parse(row.plan) : DEFAULT_PLAN;
}

/** The account's entitlement row, if any. */
export async function entitlementRow(db: Database, userId: string): Promise<{ plan: Plan; updatedAt: Date } | null> {
  const rows = await db.select().from(entitlements).where(eq(entitlements.userId, userId)).limit(1);
  const row = rows[0];
  return row ? { plan: PlanSchema.parse(row.plan), updatedAt: row.updatedAt } : null;
}

/** Sets the account's plan (insert or update). */
export async function setPlan(db: Database, userId: string, plan: Plan): Promise<void> {
  await db
    .insert(entitlements)
    .values({ userId, plan })
    .onConflictDoUpdate({ target: entitlements.userId, set: { plan, updatedAt: sql`now()` } });
}
