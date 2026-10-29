/**
 * Signed entitlement snapshots (Phase 4 Task 2, backend; Task 4, desktop; acceptance
 * `entitlements.feature.md`; review focus "A snapshot cannot be forged or replayed past its life").
 *
 * The backend answers `GET ENTITLEMENTS_PATH` with a **snapshot**: a compact JWS (RFC 7515) over
 * JSON claims (`EntitlementClaimsSchema`), signed with an Ed25519 key (RFC 8037, `alg: EdDSA`).
 * The desktop verifies it against the public keys baked into its build (`EntitlementJwksSchema`, the
 * same set the backend publishes at `ENTITLEMENT_KEYS_PATH`) and derives what main and the chrome
 * see (`EntitlementsSchema`).
 *
 * - **Which plan includes which feature is server-side** (`PLAN_FEATURES`). A snapshot carries the
 *   plan and its feature flags; the client gates on flags, never on the plan, so a plan can change
 *   its features without a desktop release.
 * - **Forward-compatible wire format.** A snapshot's `plan` and `features` may hold values a client
 *   does not know yet (the server can add a flag before clients know it); a client ignores unknown
 *   flags. The header is exact: no parameter other than `alg`, `kid` and `typ` is accepted (no
 *   embedded `jwk`, `jku`, `x5u` or `crit`).
 * - **Fail closed.** A missing, unsigned, tampered, wrong-`kid`, wrong-audience, wrong-account or
 *   expired-beyond-grace snapshot is `free`; a verification error is never a paid plan.
 *
 * Clean-room: from RFC 7515 (JWS), RFC 7517 (JWK), RFC 7519 (JWT claim names), RFC 8037 (OKP keys,
 * EdDSA), RFC 8725 (explicit `typ`) and RFC 7638 (key thumbprints, the CLI's default `kid`).
 *
 * - **Times.** Claims (`iat`, `exp`) are seconds since the epoch (JWT `NumericDate`); `Entitlements`
 *   times are milliseconds since the epoch (JavaScript `Date`), named `…Ms` to say so.
 * - **A new restrictive claim needs a `ver` bump.** Unknown claims are stripped, not refused, so an
 *   older client silently ignores a claim it does not know. A claim that only adds (a new flag, a
 *   display value) may ship under the same `ver`; one that restricts (a device binding, a
 *   `not-before` …) must raise `ENTITLEMENT_CLAIMS_VERSION`, which older clients refuse (fail closed).
 * - **What a schema cannot check.** `EntitlementClaimsSchema` has no clock: the client checks
 *   `iat <= effective now + MAX_FUTURE_IAT_SECONDS` itself (effective now: its time high-water mark,
 *   never a clock that moved back) and judges the snapshot from `max(effective now, iat)`, so a slow
 *   client clock neither refuses a fresh snapshot nor lengthens its life; and it checks `sub` against
 *   the signed-in user. Desktop rules: `entitlements-client.feature.md`.
 *
 * Depends only on Zod.
 */
import { z } from 'zod';

// ---- Routes -------------------------------------------------------------------------------------

/** `GET` (authenticated: desktop bearer, or a web session cookie): `EntitlementsResponse`, `no-store`. */
export const ENTITLEMENTS_PATH = '/v1/entitlements';

/** `GET` (public): the JWKS of every key that may have signed a live snapshot (`EntitlementJwks`). */
export const ENTITLEMENT_KEYS_PATH = '/.well-known/frost-entitlement-keys';

// ---- Plans and flags ----------------------------------------------------------------------------

/** The plans the backend grants (admin CLI `grant <email> <plan>`). No billing in v1. */
export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** An account with no entitlement row is on this plan; so is every snapshot that fails to verify. */
export const DEFAULT_PLAN: Plan = 'free';

/** The feature flags this build knows. A client gates on these, never on a plan name. */
export const FEATURE_FLAGS = ['ai-agent', 'search-console', 'sync'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/**
 * The server's plan → features mapping (the backend signs `PLAN_FEATURES[plan]` into `features`).
 * Moving a feature between plans is a change here and on the server only.
 */
export const PLAN_FEATURES: Readonly<Record<Plan, readonly FeatureFlag[]>> = Object.freeze({
  free: Object.freeze([]),
  pro: Object.freeze(['ai-agent', 'search-console', 'sync'] as const),
});

/** A plan identifier on the wire: a known `Plan` or one a newer server added. */
export const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A feature flag on the wire: a known `FeatureFlag` or one a newer server added. */
export const FEATURE_FLAG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** At most this many flags in one snapshot. */
export const MAX_SNAPSHOT_FEATURES = 64;

// ---- Signature and lifetimes --------------------------------------------------------------------

/** The only JWS algorithm: EdDSA over Ed25519 (RFC 8037). Anything else (`none`, `HS256` …) is refused. */
export const ENTITLEMENT_ALG = 'EdDSA';
/** Key type and curve of every signing and verification key. */
export const ENTITLEMENT_KEY_TYPE = 'OKP';
export const ENTITLEMENT_KEY_CURVE = 'Ed25519';

/** The `iss` claim of every snapshot. */
export const ENTITLEMENT_ISSUER = 'frost-account-api';
/** The `aud` claim of every snapshot (a single string). */
export const ENTITLEMENT_AUDIENCE = 'frost-desktop';
/** The protected header's `typ` (explicit typing, RFC 8725 §3.11): a snapshot is no other JWT. */
export const ENTITLEMENT_JWS_TYPE = 'frost-entitlement+jwt';
/** The claims' format version (`ver`). A client refuses any other. */
export const ENTITLEMENT_CLAIMS_VERSION = 1;

/** A snapshot is valid for this long after `iat` (`exp - iat`): 3 days. */
export const ENTITLEMENT_TTL_SECONDS = 3 * 24 * 60 * 60;
/**
 * After `exp`, a client that could not refresh for network reasons keeps the snapshot's features for
 * this long (`grace`): 7 days. Never after a refusal from the server, and never on a moved-back clock.
 */
export const OFFLINE_GRACE_SECONDS = 7 * 24 * 60 * 60;
/**
 * Clock skew allowance between client and server: the slack above a snapshot's end of grace up to
 * which a clock reading may still raise the client's time high-water mark (`CLOCK_MARK_HORIZON_MS`).
 */
export const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
/**
 * How far `iat` (signed server time) may be ahead of the client's effective now before the snapshot is
 * refused: one TTL. A client clock that runs slow still accepts fresh snapshots; the snapshot is judged
 * from its own `iat` (and the high-water mark is raised to it), so this never extends its life.
 */
export const MAX_FUTURE_IAT_SECONDS = ENTITLEMENT_TTL_SECONDS;

/** A key ID: letters, digits, `.`, `_`, `-` (an RFC 7638 thumbprint fits). */
export const ENTITLEMENT_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** An Ed25519 key's `x` (public) or `d` (private) member: 32 bytes, base64url without padding. */
export const ED25519_KEY_PART_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A compact JWS: three base64url segments. */
export const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Longest snapshot string a client accepts. */
export const MAX_SNAPSHOT_CHARS = 8192;

// ---- Wire format --------------------------------------------------------------------------------

export const EntitlementKeyIdSchema = z.string().regex(ENTITLEMENT_KEY_ID_PATTERN);

/** The protected header, exactly: any other parameter (`jwk`, `jku`, `crit` …) is refused. */
export const EntitlementHeaderSchema = z.strictObject({
  alg: z.literal(ENTITLEMENT_ALG),
  kid: EntitlementKeyIdSchema,
  typ: z.literal(ENTITLEMENT_JWS_TYPE),
});
export type EntitlementHeader = z.infer<typeof EntitlementHeaderSchema>;

const NumericDateSchema = z.int().nonnegative();

/**
 * The signed claims (times in seconds). Non-strict (an unknown claim is stripped, not refused) so
 * the server can add one; a claim that restricts needs a `ver` bump (see the file comment). `sub` is
 * the account's user ID, which the client compares with the signed-in user; `plan` and `features`
 * may hold values this build does not know (unknown flags are ignored, never an error). `exp` is
 * after `iat` by at most `ENTITLEMENT_TTL_SECONDS`. The client checks `iat` against its own clock
 * (`MAX_FUTURE_IAT_SECONDS`): this schema cannot.
 */
export const EntitlementClaimsSchema = z
  .object({
    iss: z.literal(ENTITLEMENT_ISSUER),
    aud: z.literal(ENTITLEMENT_AUDIENCE),
    sub: z.string().min(1).max(128),
    email: z.email().max(320),
    plan: z.string().regex(PLAN_ID_PATTERN),
    features: z
      .array(z.string().regex(FEATURE_FLAG_PATTERN))
      .max(MAX_SNAPSHOT_FEATURES)
      .refine((flags) => new Set(flags).size === flags.length, { error: 'features must not repeat' }),
    iat: NumericDateSchema,
    exp: NumericDateSchema,
    ver: z.literal(ENTITLEMENT_CLAIMS_VERSION),
  })
  .refine((claims) => claims.exp > claims.iat && claims.exp - claims.iat <= ENTITLEMENT_TTL_SECONDS, {
    error: `exp must be after iat by at most ${ENTITLEMENT_TTL_SECONDS} seconds`,
    path: ['exp'],
  });
export type EntitlementClaims = z.infer<typeof EntitlementClaimsSchema>;

/** `GET ENTITLEMENTS_PATH` (200). The snapshot is a credential-like value: it stays in main. */
export const EntitlementsResponseSchema = z.object({
  snapshot: z.string().max(MAX_SNAPSHOT_CHARS).regex(COMPACT_JWS_PATTERN),
});
export type EntitlementsResponse = z.infer<typeof EntitlementsResponseSchema>;

/**
 * One public verification key: an Ed25519 OKP JWK with its `kid`. Strict: a private member (`d`) or
 * anything else is refused, so a private key can never be published or baked into a build.
 */
export const EntitlementPublicJwkSchema = z.strictObject({
  kty: z.literal(ENTITLEMENT_KEY_TYPE),
  crv: z.literal(ENTITLEMENT_KEY_CURVE),
  x: z.string().regex(ED25519_KEY_PART_PATTERN),
  kid: EntitlementKeyIdSchema,
  alg: z.literal(ENTITLEMENT_ALG).optional(),
  use: z.literal('sig').optional(),
});
export type EntitlementPublicJwk = z.infer<typeof EntitlementPublicJwkSchema>;

/**
 * `GET ENTITLEMENT_KEYS_PATH` and the desktop's `FROST_PUBLIC_ENTITLEMENT_JWKS`: the keys that may
 * have signed a live snapshot (several during a rotation), each `kid` once.
 */
export const EntitlementJwksSchema = z.strictObject({
  keys: z
    .array(EntitlementPublicJwkSchema)
    .min(1)
    .max(16)
    .refine((keys) => new Set(keys.map((key) => key.kid)).size === keys.length, { error: 'kid must be unique' }),
});
export type EntitlementJwks = z.infer<typeof EntitlementJwksSchema>;

// ---- What main and the chrome see (Task 4) ------------------------------------------------------

/**
 * - `none`: no snapshot (signed out, or never fetched).
 * - `active`: a verified snapshot within its life.
 * - `grace`: past `exp`, within `OFFLINE_GRACE_SECONDS`, after a refresh that failed for network reasons.
 * - `expired`: past `exp` and not (or no longer) in grace.
 * - `invalid`: a snapshot that failed verification (signature, `kid`, `typ`, `iss`, `aud`, `sub`, skew, format).
 */
export const ENTITLEMENT_STATUSES = ['none', 'active', 'grace', 'expired', 'invalid'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/** The statuses whose features count. Every other status is `DEFAULT_PLAN` with no features. */
export const ENTITLED_STATUSES: readonly EntitlementStatus[] = Object.freeze(['active', 'grace']);

/** The statuses of a verified snapshot: they carry its times. `none` and `invalid` carry none. */
export const TIMED_STATUSES: readonly EntitlementStatus[] = Object.freeze(['active', 'grace', 'expired']);

/** `graceEndsAtMs - expiresAtMs` of every timed status. */
export const OFFLINE_GRACE_MS = OFFLINE_GRACE_SECONDS * 1000;

/**
 * `EntitlementsReader.current()` and `account.entitlements`: the verified result, never the snapshot.
 *
 * - `plan` is a display label: a known `Plan` (a plan this build does not know is shown as
 *   `DEFAULT_PLAN`). Gating reads `features` only, which holds only flags this build knows.
 * - `expiresAtMs` (the snapshot's `exp`) and `graceEndsAtMs` (`exp + OFFLINE_GRACE_SECONDS`) are epoch
 *   milliseconds. `active`, `grace` and `expired` carry both (`graceEndsAtMs = expiresAtMs +
 *   OFFLINE_GRACE_MS`); `none` and `invalid` carry `null` for both.
 * - Fails closed by construction: unless `status` is `active` or `grace`, `plan` is `free` and
 *   `features` is empty.
 */
export const EntitlementsSchema = z
  .strictObject({
    plan: z.enum(PLANS),
    features: z
      .array(z.enum(FEATURE_FLAGS))
      .refine((flags) => new Set(flags).size === flags.length, { error: 'features must not repeat' }),
    status: z.enum(ENTITLEMENT_STATUSES),
    expiresAtMs: z.int().nonnegative().nullable(),
    graceEndsAtMs: z.int().nonnegative().nullable(),
  })
  .refine((e) => ENTITLED_STATUSES.includes(e.status) || (e.plan === DEFAULT_PLAN && e.features.length === 0), {
    error: `without an active or grace snapshot, plan is ${DEFAULT_PLAN} with no features`,
    path: ['features'],
  })
  .refine(
    (e) =>
      TIMED_STATUSES.includes(e.status)
        ? e.expiresAtMs !== null && e.graceEndsAtMs !== null && e.graceEndsAtMs === e.expiresAtMs + OFFLINE_GRACE_MS
        : e.expiresAtMs === null && e.graceEndsAtMs === null,
    {
      error: 'active, grace and expired carry expiresAtMs and graceEndsAtMs = expiresAtMs + OFFLINE_GRACE_MS; none and invalid carry neither',
      path: ['graceEndsAtMs'],
    },
  );
export type Entitlements = z.infer<typeof EntitlementsSchema>;

/** No snapshot: the signed-out state. */
export const NO_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  plan: DEFAULT_PLAN,
  features: [],
  status: 'none',
  expiresAtMs: null,
  graceEndsAtMs: null,
});

/** A snapshot that failed verification: the fail-closed state. */
export const INVALID_ENTITLEMENTS: Readonly<Entitlements> = Object.freeze({
  plan: DEFAULT_PLAN,
  features: [],
  status: 'invalid',
  expiresAtMs: null,
  graceEndsAtMs: null,
});

/**
 * Whether `entitlements` grant `flag`: an entitled status (`active`, `grace`) and the flag among its
 * features. The one rule behind `EntitlementsReader.has` and the IPC `requireFeature` middleware.
 */
export function entitlementGrants(entitlements: Entitlements, flag: FeatureFlag): boolean {
  return ENTITLED_STATUSES.includes(entitlements.status) && entitlements.features.includes(flag);
}

/** The `cause.code` (and message) of the `FORBIDDEN` error `requireFeature(flag)` rejects with. */
export const FEATURE_NOT_ENTITLED_CODE = 'FEATURE_NOT_ENTITLED';

// ---- Desktop client (Task 4, `entitlements-client.feature.md`) ---------------------------------

/**
 * Why a refresh of the snapshot failed, as main reports it to the entitlements store:
 * - `network`: no answer (offline, DNS, timeout, TLS, a 5xx): the only kind that allows offline grace.
 * - `auth`: the server refused the credential (401): the snapshot is dropped (`none`).
 * - `invalid`: the server answered, but not with a snapshot that verifies: `invalid` (free).
 */
export const ENTITLEMENT_REFRESH_FAILURES = ['network', 'auth', 'invalid'] as const;
export type EntitlementRefreshFailure = (typeof ENTITLEMENT_REFRESH_FAILURES)[number];

/**
 * How far past the latest verified `iat` a **clock reading** may raise main's time high-water mark:
 * that snapshot's end of grace plus `MAX_CLOCK_SKEW_SECONDS`. Far enough that a clock set back never
 * revives any snapshot main has seen; no further, so a clock that jumped ahead (to 2099, say) and came
 * back does not lock out the next fresh snapshot. A verified `iat` raises the mark without this cap, and
 * a newer verified `iat` supersedes what clock readings added before it.
 */
export const CLOCK_MARK_HORIZON_MS = (ENTITLEMENT_TTL_SECONDS + OFFLINE_GRACE_SECONDS + MAX_CLOCK_SKEW_SECONDS) * 1000;

/** Main writes its time high-water mark at most this often while the clock only moves forward. */
export const HIGH_WATER_PERSIST_INTERVAL_MS = 60_000;
/** Main re-reads the clock (raising the high-water mark) at least this often while it holds a snapshot. */
export const ENTITLEMENT_HEARTBEAT_MS = 10 * 60_000;
