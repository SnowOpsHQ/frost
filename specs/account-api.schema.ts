/**
 * The account backend's HTTP surface as the desktop reads it (Phase 4 Tasks 1 and 3; acceptance
 * `account-backend.feature.md`): route paths and the Zod schemas of every answer the desktop parses.
 * The backend (`apps/backend`) answers exactly these shapes and its tests validate them here; the
 * desktop's API client (Task 5) validates every answer with the same schemas before using it.
 *
 * Answer objects are non-strict (unknown keys are stripped, not refused) so the backend can add a
 * field before every desktop build knows it. Nothing here carries a token, a password or a secret.
 */
import { z } from 'zod';

// ---- Routes -------------------------------------------------------------------------------------

/** better-auth's own endpoints (web sign-up, password and magic-link sign-in) live under this path. */
export const AUTH_BASE_PATH = '/api/auth';

/** `GET`: who is signed in: a desktop bearer token (`DESKTOP_TOKEN_PATH`) or a web session cookie. */
export const SESSION_PATH = '/v1/session';

/**
 * `POST` with `Authorization: Bearer <desktop token>` only (cookies are ignored): revokes that token.
 * Idempotent: 204 for any well-formed bearer, known, expired or already revoked; 401 without one.
 */
export const SIGN_OUT_PATH = '/v1/sign-out';

/** `GET`: liveness and database reachability. No authentication. */
export const HEALTH_PATH = '/healthz';

/** The better-auth endpoints the web sign-in pages use, relative to `AUTH_BASE_PATH`. */
export const AUTH_ROUTES = {
  signUpEmail: '/sign-up/email',
  signInEmail: '/sign-in/email',
  signInMagicLink: '/sign-in/magic-link',
  verifyMagicLink: '/magic-link/verify',
  verifyEmail: '/verify-email',
  getSession: '/get-session',
  signOut: '/sign-out',
} as const;

/**
 * The only better-auth endpoints the backend serves, and their methods; every other path under
 * `AUTH_BASE_PATH` answers 404. Adding one is a reviewed change here.
 */
export const AUTH_ENDPOINT_METHODS: Readonly<Record<(typeof AUTH_ROUTES)[keyof typeof AUTH_ROUTES], 'GET' | 'POST'>> = {
  '/sign-up/email': 'POST',
  '/sign-in/email': 'POST',
  '/sign-in/magic-link': 'POST',
  '/magic-link/verify': 'GET',
  '/verify-email': 'GET',
  '/get-session': 'GET',
  '/sign-out': 'POST',
};

// ---- Limits -------------------------------------------------------------------------------------

/** Password length bounds for email-and-password accounts (better-auth enforces them on sign-up). */
export const PASSWORD_LIMITS = { minLength: 10, maxLength: 128 } as const;

/** Bounds on an account's fields, enforced when a user is created or updated. */
export const ACCOUNT_USER_LIMITS = { maxNameChars: 200, maxEmailChars: 320 } as const;

/** Lifetime of a magic link, in seconds. Each link is single-use and stored hashed. */
export const MAGIC_LINK_TTL_SECONDS = 10 * 60;

/**
 * Lifetime of an email-verification link, in seconds. The link is a stateless signed token (not
 * stored, not single-use): it verifies the address until it expires, and signs nobody in.
 */
export const EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60;

/**
 * Per-client-IP request limits on the auth endpoints (fixed windows, seconds). Over the limit
 * answers 429 with `X-Retry-After`. `default` covers every endpoint without its own rule.
 */
export const AUTH_RATE_LIMITS = {
  default: { window: 60, max: 100 },
  signIn: { window: 10, max: 3 },
  signUp: { window: 60, max: 5 },
  magicLink: { window: 60, max: 5 },
} as const;

/** Minimum length of `BETTER_AUTH_SECRET`; a shorter or missing secret refuses startup. */
export const AUTH_SECRET_MIN_LENGTH = 32;

// ---- Errors -------------------------------------------------------------------------------------

/** The `error` codes the backend's own routes answer (better-auth's endpoints keep their own shape). */
export const ACCOUNT_API_ERRORS = [
  'unauthorized',
  'forbidden',
  'not_found',
  'unavailable',
  'internal',
  /** `DESKTOP_TOKEN_PATH`: the body is not a `DesktopTokenRequest` (or not JSON). */
  'invalid_request',
  /** `DESKTOP_TOKEN_PATH`: the code is unknown, used, expired, or its verifier or redirect does not match. */
  'invalid_grant',
  /** Over a `DESKTOP_RATE_LIMITS` rule (429, with `Retry-After` in seconds). */
  'rate_limited',
] as const;
export type AccountApiError = (typeof ACCOUNT_API_ERRORS)[number];

/**
 * Every non-2xx answer from the backend's own routes: a short machine-readable code. Typed as any
 * string (not the enum) so a newer backend's code still parses as an error on an older desktop.
 */
export const ErrorResponseSchema = z.object({ error: z.string().min(1).max(100) });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---- Answers ------------------------------------------------------------------------------------

/** The signed-in user as the desktop shows it. `name` is `null` when the account has none (magic-link sign-up). */
export const AccountUserSchema = z.object({
  id: z.string().min(1).max(128),
  email: z.email().max(ACCOUNT_USER_LIMITS.maxEmailChars),
  name: z.string().min(1).max(ACCOUNT_USER_LIMITS.maxNameChars).nullable(),
});
export type AccountUser = z.infer<typeof AccountUserSchema>;

/** `GET /v1/session` (200): the user, and when the credential that authenticated the request expires. */
export const SessionResponseSchema = z.object({
  user: AccountUserSchema,
  expiresAt: z.iso.datetime().optional(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

/** `GET /healthz` (200). An unreachable database answers 503 with `ErrorResponse` `unavailable`. */
export const HealthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---- Desktop authorization (Phase 4 Task 3) -----------------------------------------------------
//
// The desktop signs in through the system browser with a loopback redirect and PKCE (RFC 8252,
// RFC 7636), using OAuth's parameter names:
//   1. main listens on `http://127.0.0.1:<port>/callback`, makes a `state` and a PKCE verifier, and
//      opens `GET DESKTOP_AUTHORIZE_PATH?redirect_uri&state&code_challenge&code_challenge_method=S256`;
//   2. the browser signs in on frost's own pages (password, magic link or sign-up), then the user
//      presses Continue; the backend redirects (303) to `redirect_uri?code=…&state=…`;
//   3. main checks `state`, then `POST DESKTOP_TOKEN_PATH` with the code and the verifier, and gets a
//      desktop token: `Authorization: Bearer` on `SESSION_PATH`, `/v1/entitlements` and
//      `SIGN_OUT_PATH`.
//
// The desktop's loopback callback (`GET /callback`) must answer with `Referrer-Policy: no-referrer`,
// load no subresources (no images, styles or scripts from anywhere), and answer the code-bearing
// request with a redirect to a code-free URL on the listener (e.g. `303` to `/done`), so the code is
// not left in the address bar, the history or a `Referer`.

/** `GET`: the browser page that signs in and asks to continue. `POST`: Continue (same-origin form). */
export const DESKTOP_AUTHORIZE_PATH = '/desktop/authorize';

/** `POST` (JSON, no cookies): swaps a code and its PKCE verifier for a desktop token. */
export const DESKTOP_TOKEN_PATH = '/desktop/token';

/**
 * The sign-in page's own form targets (same-origin `POST`s, `application/x-www-form-urlencoded`,
 * carrying the authorize parameters). Browser-only: the desktop never calls them. Each answers a
 * page, or 303 back to `DESKTOP_AUTHORIZE_PATH`.
 */
export const DESKTOP_PAGE_PATHS = {
  signIn: '/desktop/sign-in',
  signUp: '/desktop/sign-up',
  magicLink: '/desktop/magic-link',
  signOut: '/desktop/sign-out',
} as const;

/** The loopback ports a redirect may use: unprivileged only. */
export const LOOPBACK_PORT_RANGE = { min: 1024, max: 65_535 } as const;

/**
 * The only `redirect_uri` accepted, compared as the exact string: `http://127.0.0.1:<port>/callback`
 * with a port in `LOOPBACK_PORT_RANGE` written without leading zeros, and nothing else (no query,
 * fragment, user info, trailing slash or other path). Not `localhost` (a name can resolve elsewhere,
 * RFC 8252 §8.3), not `https`, and not `[::1]`: the desktop's listener binds `127.0.0.1` only, so one
 * spelling is accepted and nothing has to be normalised.
 */
export const LOOPBACK_REDIRECT_PATTERN =
  /^http:\/\/127\.0\.0\.1:(?:102[4-9]|10[3-9]\d|1[1-9]\d{2}|[2-9]\d{3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\/callback$/;

/** `state`: the desktop's nonce, echoed back on the redirect. RFC 3986 unreserved characters only. */
export const DESKTOP_STATE_LIMITS = { minLength: 16, maxLength: 128 } as const;
export const DESKTOP_STATE_PATTERN = /^[A-Za-z0-9\-._~]+$/;

/** The only PKCE method: `code_challenge = BASE64URL(SHA-256(code_verifier))`, no padding. */
export const PKCE_METHOD = 'S256';
/** An S256 challenge: 43 base64url characters (32 bytes). */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43 to 128 characters of the unreserved set. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** A one-time authorization code: 32 random bytes, base64url (43 characters). Stored SHA-256-hashed. */
export const DESKTOP_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** How long a code can be swapped, in seconds. It works once. */
export const DESKTOP_CODE_TTL_SECONDS = 120;

/**
 * A desktop token: `frost_dt_` and 32 random bytes, base64url. Opaque to the desktop (sent back as a
 * bearer), stored SHA-256-hashed, revocable (`SIGN_OUT_PATH`).
 */
export const DESKTOP_TOKEN_PATTERN = /^frost_dt_[A-Za-z0-9_-]{43}$/;
/** A desktop token's lifetime, in days, from the exchange. It is not extended by use. */
export const DESKTOP_TOKEN_TTL_DAYS = 30;

/**
 * Continue needs a web session created (signed in, or signed in again) at most this many seconds
 * ago; an older one is asked to sign in again for this request. Issuing a code ends the web session,
 * so every desktop sign-in takes fresh credentials: a browser that is merely still signed in cannot
 * be used by another local program with one click.
 */
export const DESKTOP_RECENT_AUTH_SECONDS = 10 * 60;

// ---- Request fingerprint ------------------------------------------------------------------------

/** Crockford's base32 alphabet (no I, L, O or U): easy to read aloud and compare. */
const FINGERPRINT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `XXXX-XXXX` in `FINGERPRINT_ALPHABET`. */
export const REQUEST_FINGERPRINT_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of `bytes`, synchronous and dependency-free so main, the chrome and the backend share it. */
function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => {
      h[i] = ((h[i] ?? 0) + value) >>> 0;
    });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((value, i) => outView.setUint32(i * 4, value));
  return out;
}

/**
 * A short, human-comparable fingerprint of a desktop sign-in request, shown both on the Continue page
 * and in the app while it waits, so the user can tell their own request from another program's:
 * the first 40 bits of SHA-256 over the `code_challenge`'s ASCII bytes, as 8 characters of
 * `FINGERPRINT_ALPHABET` (most significant bits first), split `XXXX-XXXX`. Pure and synchronous.
 * Throws `RangeError` for a value that is not a `CODE_CHALLENGE_PATTERN` challenge.
 */
export function requestFingerprint(codeChallenge: string): string {
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) throw new RangeError('not an S256 code challenge');
  const digest = sha256(new TextEncoder().encode(codeChallenge));
  let bits = 0;
  for (let i = 0; i < 5; i += 1) bits = bits * 256 + (digest[i] ?? 0);
  let text = '';
  for (let i = 7; i >= 0; i -= 1) text += FINGERPRINT_ALPHABET[Math.floor(bits / 32 ** i) % 32];
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

/**
 * Per-client-IP limits on the desktop endpoints (fixed windows, seconds); over the limit is 429
 * `rate_limited` with `Retry-After`. `token`: `DESKTOP_TOKEN_PATH`; `authorize`: `POST
 * DESKTOP_AUTHORIZE_PATH` (code issuance). The sign-in forms count against `AUTH_RATE_LIMITS`.
 */
export const DESKTOP_RATE_LIMITS = {
  token: { window: 60, max: 10 },
  authorize: { window: 60, max: 30 },
} as const;

/**
 * `GET`/`POST DESKTOP_AUTHORIZE_PATH` parameters (the query, or the Continue form's fields). Each
 * must appear exactly once; anything invalid answers a plain 400 page and never redirects. Other
 * parameters are ignored.
 */
export const DesktopAuthorizeQuerySchema = z.object({
  redirect_uri: z.string().regex(LOOPBACK_REDIRECT_PATTERN),
  state: z.string().min(DESKTOP_STATE_LIMITS.minLength).max(DESKTOP_STATE_LIMITS.maxLength).regex(DESKTOP_STATE_PATTERN),
  code_challenge: z.string().regex(CODE_CHALLENGE_PATTERN),
  code_challenge_method: z.literal(PKCE_METHOD),
});
export type DesktopAuthorizeQuery = z.infer<typeof DesktopAuthorizeQuerySchema>;

/** `POST DESKTOP_TOKEN_PATH` body (`Content-Type: application/json`). `redirect_uri` must equal the authorize request's. */
export const DesktopTokenRequestSchema = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string().regex(DESKTOP_CODE_PATTERN),
  code_verifier: z.string().regex(CODE_VERIFIER_PATTERN),
  redirect_uri: z.string().regex(LOOPBACK_REDIRECT_PATTERN),
});
export type DesktopTokenRequest = z.infer<typeof DesktopTokenRequestSchema>;

/**
 * `POST DESKTOP_TOKEN_PATH` (200, `no-store`): the desktop token, when it expires (epoch
 * milliseconds), and whose it is (shown in the app's "Sign in as …?" confirmation). Errors are 400
 * `{ error: 'invalid_request' | 'invalid_grant' }` or 429 `{ error: 'rate_limited' }`.
 */
export const DesktopTokenResponseSchema = z.object({
  token: z.string().regex(DESKTOP_TOKEN_PATTERN),
  expiresAt: z.number().int().positive(),
  user: AccountUserSchema,
});
export type DesktopTokenResponse = z.infer<typeof DesktopTokenResponseSchema>;
