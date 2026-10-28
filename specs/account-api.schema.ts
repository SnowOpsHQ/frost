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
