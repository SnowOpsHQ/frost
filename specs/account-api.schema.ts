/**
 * The account backend's HTTP surface as the desktop reads it (Phase 4 Task 1; acceptance
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

/** `GET`: who is signed in. A web session cookie today; Task 3 adds the desktop bearer token. */
export const SESSION_PATH = '/v1/session';

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
export const ACCOUNT_API_ERRORS = ['unauthorized', 'forbidden', 'not_found', 'unavailable', 'internal'] as const;
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
