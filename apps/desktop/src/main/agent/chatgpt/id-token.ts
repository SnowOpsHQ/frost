import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { CHATGPT_LIMITS } from '@app/specs/agent-chatgpt.spec';
import { ChatgptIdTokenClaimsSchema, ChatgptIdTokenHeaderSchema, ChatgptJwkSchema, type ChatgptIdTokenClaims, type ChatgptJwk } from '@app/specs/agent-chatgpt.schema';
import { parseJson, send, type FetchLike } from './http';

// The ID token's checks (spec `agent-chatgpt.spec.ts`, `CHATGPT_ISSUER`, `CHATGPT_ID_TOKEN_ALG`,
// `CHATGPT_LIMITS.clockSkewMs`; acceptance `agent-chatgpt.feature.md`, "chatgpt-id-token-checks").
// An RS256 JWT verified with Node's `crypto` against the issuer's published keys (the fixed JWKS URL,
// never one named by the token), imported as JWK; no JWT library. Then its claims: the issuer, the
// audience (the issued client id; with several audiences `azp` must name it), `azp` when present,
// `exp`, `iat` and `nbf` (each within `clockSkewMs`), the attempt's `nonce` (a sign-in; a refresh
// has none) and a non-empty `sub`. The keys are trusted for `jwksTtlMs` after a fetch, then fetched
// again; an unknown `kid` (or a failed fetch) fetches at most once a `jwksRefetchMs`. Nothing here
// logs or returns the token.

/**
 * Why a token was refused. `expired` (`exp` past) and `not-yet-valid` (`iat` or `nbf` ahead) are
 * time-only (`isTimeOnlyFailure`): the signature, issuer, audience and nonce were fine.
 */
export type IdTokenFailure = 'malformed' | 'signature' | 'issuer' | 'audience' | 'expired' | 'not-yet-valid' | 'nonce' | 'keys-unavailable';

/** Whether the token failed only on time (a clock far off), every other check having passed. */
export function isTimeOnlyFailure(failure: IdTokenFailure): boolean {
  return failure === 'expired' || failure === 'not-yet-valid';
}
export type IdTokenResult = { readonly ok: true; readonly claims: ChatgptIdTokenClaims } | { readonly ok: false; readonly failure: IdTokenFailure };

export interface IdTokenExpectation {
  readonly issuer: string;
  /** The issued client id (the audience). */
  readonly clientId: string;
  /** The sign-in attempt's nonce, or `null` for a token from a refresh (not checked then). */
  readonly nonce: string | null;
  /** Epoch ms. */
  readonly now: number;
}

/** The issuer's signing keys, fetched once and again (rate-limited) when a token names an unknown `kid`. */
export interface Jwks {
  /** The keys a token with `kid` may be signed with (all of them without a `kid`); `unavailable` when they can't be fetched. */
  keysFor(kid: string | undefined): Promise<readonly KeyObject[] | 'unavailable'>;
}

export interface JwksDeps {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

interface CachedKey {
  readonly kid: string | undefined;
  readonly key: KeyObject;
}

function importKey(jwk: ChatgptJwk): KeyObject | null {
  try {
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    // RS256 with a modulus under 2048 bits is not accepted.
    return key.asymmetricKeyType === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048 ? key : null;
  } catch {
    return null;
  }
}

export function createJwks(deps: JwksDeps): Jwks {
  let cached: { readonly keys: readonly CachedKey[]; readonly at: number } | null = null;
  /** When the document was last asked for (fetched or not): the refetch throttle's clock. */
  let attemptedAt = -Infinity;
  let fetching: Promise<boolean> | null = null;

  const refresh = (): Promise<boolean> => {
    fetching ??= (async () => {
      attemptedAt = deps.now();
      const outcome = await send(deps.fetch, deps.url, { method: 'GET', headers: {} }, deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs });
      if (outcome.kind !== 'answer' || outcome.status !== 200) return false;
      const document = parseJson(outcome.text);
      const entries = typeof document === 'object' && document !== null && Array.isArray((document as { keys?: unknown }).keys) ? ((document as { keys: unknown[] }).keys as unknown[]) : null;
      if (entries === null) return false;
      const keys: CachedKey[] = [];
      for (const entry of entries) {
        if (keys.length >= CHATGPT_LIMITS.maxJwksKeys) break;
        // RSA signing keys for RS256 only: `use: 'enc'`, another `alg` or key type is skipped.
        const jwk = ChatgptJwkSchema.safeParse(entry);
        if (!jwk.success) continue;
        const key = importKey(jwk.data);
        if (key !== null) keys.push({ kid: jwk.data.kid, key });
      }
      cached = { keys, at: deps.now() };
      return true;
    })().finally(() => {
      fetching = null;
    });
    return fetching;
  };

  const pick = (kid: string | undefined): readonly KeyObject[] => (cached?.keys ?? []).filter((entry) => kid === undefined || entry.kid === kid).map((entry) => entry.key);

  return {
    async keysFor(kid) {
      const now = deps.now();
      const fresh = cached !== null && now - cached.at < CHATGPT_LIMITS.jwksTtlMs;
      if (fresh && pick(kid).length > 0) return pick(kid);
      // Nothing yet: fetched. Stale, or an unknown key id: fetched again, at most once a `jwksRefetchMs`.
      if (cached === null || now - attemptedAt >= CHATGPT_LIMITS.jwksRefetchMs) await refresh();
      // A document past its TTL that couldn't be fetched again is not used.
      if (cached === null || deps.now() - cached.at >= CHATGPT_LIMITS.jwksTtlMs) return 'unavailable';
      return pick(kid);
    },
  };
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string): unknown {
  return parseJson(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Verifies `token` (signature first, then the claims). Never throws. */
export async function verifyIdToken(token: string, expected: IdTokenExpectation, jwks: Jwks): Promise<IdTokenResult> {
  const fail = (failure: IdTokenFailure): IdTokenResult => ({ ok: false, failure });
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return fail('malformed');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = ChatgptIdTokenHeaderSchema.safeParse(decodeSegment(headerPart));
  if (!header.success) return fail('malformed');

  const keys = await jwks.keysFor(header.data.kid);
  if (keys === 'unavailable') return fail('keys-unavailable');
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii');
  const signature = Buffer.from(signaturePart, 'base64url');
  const verified = keys.some((key) => {
    try {
      return verify('sha256', signed, key, signature);
    } catch {
      return false;
    }
  });
  if (!verified) return fail('signature');

  const parsed = ChatgptIdTokenClaimsSchema.safeParse(decodeSegment(payloadPart));
  if (!parsed.success) return fail('malformed');
  const claims = parsed.data;
  if (claims.iss !== expected.issuer) return fail('issuer');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!audiences.includes(expected.clientId)) return fail('audience');
  if (audiences.length > 1 && claims.azp === undefined) return fail('audience');
  if (claims.azp !== undefined && claims.azp !== expected.clientId) return fail('audience');
  if (expected.nonce !== null && claims.nonce !== expected.nonce) return fail('nonce');
  // Time last, so a time-only failure means everything else held.
  const skew = CHATGPT_LIMITS.clockSkewMs;
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || (claims.nbf !== undefined && !Number.isFinite(claims.nbf))) return fail('malformed');
  if (claims.exp * 1000 + skew <= expected.now) return fail('expired');
  if (claims.iat * 1000 - skew > expected.now || (claims.nbf !== undefined && claims.nbf * 1000 - skew > expected.now)) return fail('not-yet-valid');
  return { ok: true, claims };
}
