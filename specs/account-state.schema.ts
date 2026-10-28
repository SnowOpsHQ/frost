/**
 * The desktop account as main shows it to the chrome (Phase 4 Task 5; acceptance
 * `account-signin.feature.md`; review focus "A website or another app cannot sign the user in to
 * someone else's account" and "The renderer never sees a token").
 *
 * Main signs in through the system browser with a loopback redirect and PKCE (`account-api.schema.ts`,
 * Desktop authorization): `signIn` opens the authorize page on a live user gesture; the callback's
 * code is exchanged in main; the account the backend names is shown for confirmation ("Sign in as
 * …?"), and only `confirmSignIn` stores the token and fetches entitlements.
 *
 * `AccountStateSchema` is **strict** and carries no token, code, verifier, state, snapshot or user
 * ID: an answer with any other member is refused by the router rather than forwarded.
 */
import { z } from 'zod';
import { ACCOUNT_USER_LIMITS, REQUEST_FINGERPRINT_PATTERN } from './account-api.schema';
import { EntitlementsSchema } from './entitlements-snapshot.spec';

// ---- Configuration ------------------------------------------------------------------------------

/**
 * The build's public account values (plan "Configuration"). Read from the build environment (Vite
 * `import.meta.env`, `envPrefix` `FROST_PUBLIC_`).
 *
 * **A build that has a value baked in never reads it from the run-time environment.** If either
 * value is baked in, the run-time environment is ignored for both (a swapped JWKS would self-sign
 * `pro`; a swapped API base would open a look-alike authorize page). Only an **unpackaged** build with
 * neither baked in (a dev or source build, which has no real keys to protect: anyone can rebuild the
 * source with their own) reads them from the run-time environment (dev, e2e). `app.isPackaged` alone
 * is not enough: it only looks at the executable's name.
 */
export const ACCOUNT_CONFIG_ENV = {
  apiBaseUrl: 'FROST_PUBLIC_API_BASE_URL',
  entitlementJwks: 'FROST_PUBLIC_ENTITLEMENT_JWKS',
} as const;

/**
 * Hosts an **unpackaged** build may reach over plain `http:` (a local backend). A packaged build
 * requires `https:`. The API base is an origin only: no path, query, fragment or credentials.
 */
export const UNPACKAGED_HTTP_API_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost']);

// ---- Timing -------------------------------------------------------------------------------------

/** How long a sign-in waits for the browser's callback before it ends as `timed-out`. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long an exchanged sign-in waits for the in-app confirmation before it is dropped (revoked) as `timed-out`. */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** The account and its entitlements are refreshed at start, on `refresh`, and this often. */
export const ACCOUNT_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
/** Each backend call (exchange, session, entitlements, sign-out) gives up after this long (a `network` failure). */
export const ACCOUNT_API_TIMEOUT_MS = 15_000;
/** On quit, an exchanged-but-unconfirmed (or signed-out) token's revocation may hold the quit at most this long. */
export const QUIT_REVOKE_TIMEOUT_MS = 2_000;
/** Longest backend answer body main reads, in bytes; a longer one is `invalid`. */
export const ACCOUNT_API_MAX_BODY_BYTES = 64 * 1024;
/** At most this many `account.watch` calls wait at once; one more answers the oldest early. */
export const MAX_PENDING_ACCOUNT_WATCHES = 4;

// ---- Loopback listener (shared with Search Console's OAuth, Task 8) -----------------------------

/** The only path that accepts the browser's redirect (`LOOPBACK_REDIRECT_PATTERN`). */
export const LOOPBACK_CALLBACK_PATH = '/callback';
/** Where the code-bearing callback is sent (303), so the code leaves the address bar and history. */
export const LOOPBACK_DONE_PATH = '/done';
/** The listener binds this address only. */
export const LOOPBACK_HOST = '127.0.0.1';
/**
 * After the first valid callback the listener serves only `LOOPBACK_DONE_PATH`, once, and closes
 * when it has, or after this long.
 */
export const LOOPBACK_DONE_LINGER_MS = 10_000;
/** At most this many connections to the listener at once (a browser needs one or two). */
export const LOOPBACK_MAX_CONNECTIONS = 16;
/**
 * A request's headers and body must arrive within this long, or its connection is closed (checked
 * at least every `LOOPBACK_REQUEST_TIMEOUT_MS / 4`).
 */
export const LOOPBACK_REQUEST_TIMEOUT_MS = 5_000;
/** Every answer of the listener carries these headers. */
export const LOOPBACK_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

// ---- State --------------------------------------------------------------------------------------

/**
 * - `unconfigured`: this build has no (valid) API base or entitlement keys; nothing is sent anywhere.
 * - `signed-out`: no account.
 * - `awaiting-browser`: the authorize page was opened; waiting for the browser (show `fingerprint`).
 * - `confirming`: the code was exchanged; "Sign in as `user.email`?" awaits `confirmSignIn`. Nothing
 *   is stored or used yet.
 * - `signed-in`: confirmed; the token is stored (or kept for this run only, `memory-only`).
 */
export const ACCOUNT_STATUSES = ['unconfigured', 'signed-out', 'awaiting-browser', 'confirming', 'signed-in'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The statuses of a pending sign-in request: they carry its `requestId` and `fingerprint`. */
export const PENDING_ACCOUNT_STATUSES: readonly AccountStatus[] = Object.freeze(['awaiting-browser', 'confirming']);
/** The statuses that name a user. */
export const USER_ACCOUNT_STATUSES: readonly AccountStatus[] = Object.freeze(['confirming', 'signed-in']);

/** Where the account is kept: the OS keychain (survives a restart) or this run only. */
export const KEYCHAIN_MODES = ['persistent', 'memory-only'] as const;
export type KeychainMode = (typeof KEYCHAIN_MODES)[number];

/**
 * Why the last sign-in or session ended (shown once; cleared by the next `signIn`):
 * - `browser-failed`: the system browser could not be opened, or the listener could not start.
 * - `timed-out`: no callback within `SIGN_IN_TIMEOUT_MS`, or no confirmation within `CONFIRM_TIMEOUT_MS`.
 * - `exchange-failed`: the backend refused the code, or answered something unusable.
 * - `network`: the backend could not be reached.
 * - `cancelled`: the browser reported the sign-in as refused or cancelled.
 * - `session-ended`: the backend no longer accepts the stored token (revoked, expired): signed out.
 */
export const ACCOUNT_ERRORS = ['browser-failed', 'timed-out', 'exchange-failed', 'network', 'cancelled', 'session-ended'] as const;
export type AccountError = (typeof ACCOUNT_ERRORS)[number];

/** A pending request's ID: 16 random bytes, base64url. Names the request; grants nothing. */
export const ACCOUNT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** The user as the chrome shows them: no ID, nothing else. */
export const AccountStateUserSchema = z.strictObject({
  email: z.email().max(ACCOUNT_USER_LIMITS.maxEmailChars),
  name: z.string().min(1).max(ACCOUNT_USER_LIMITS.maxNameChars).nullable(),
});
export type AccountStateUser = z.infer<typeof AccountStateUserSchema>;

/**
 * `account.state` and `account.watch`. Fields are tied to `status`:
 * - `user` only in `confirming` and `signed-in`;
 * - `requestId` and `fingerprint` (`requestFingerprint` of the request's PKCE challenge, the value
 *   the browser page shows) only in `awaiting-browser` and `confirming`;
 * - `entitlements` is `none` unless `signed-in` (fails closed: nothing is entitled before confirming).
 */
export const AccountStateSchema = z
  .strictObject({
    status: z.enum(ACCOUNT_STATUSES),
    user: AccountStateUserSchema.nullable(),
    entitlements: EntitlementsSchema,
    keychain: z.enum(KEYCHAIN_MODES),
    requestId: z.string().regex(ACCOUNT_REQUEST_ID_PATTERN).nullable(),
    fingerprint: z.string().regex(REQUEST_FINGERPRINT_PATTERN).nullable(),
    error: z.enum(ACCOUNT_ERRORS).nullable(),
    version: z.int().nonnegative(),
  })
  .refine((s) => USER_ACCOUNT_STATUSES.includes(s.status) === (s.user !== null), {
    error: 'user is set exactly in confirming and signed-in',
    path: ['user'],
  })
  .refine((s) => PENDING_ACCOUNT_STATUSES.includes(s.status) === (s.requestId !== null), {
    error: 'requestId is set exactly in awaiting-browser and confirming',
    path: ['requestId'],
  })
  .refine((s) => PENDING_ACCOUNT_STATUSES.includes(s.status) === (s.fingerprint !== null), {
    error: 'fingerprint is set exactly in awaiting-browser and confirming',
    path: ['fingerprint'],
  })
  .refine((s) => s.status === 'signed-in' || s.entitlements.status === 'none', {
    error: 'entitlements are none unless signed-in',
    path: ['entitlements'],
  });
export type AccountState = z.infer<typeof AccountStateSchema>;

// ---- Procedures ---------------------------------------------------------------------------------

/** `account.watch`: the state once its `version` exceeds `sinceVersion` (`-1`: at once). */
export const AccountWatchInputSchema = z.strictObject({ sinceVersion: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type AccountWatchInput = z.infer<typeof AccountWatchInputSchema>;

/** `account.confirmSignIn` and `account.cancelSignIn`: the pending request they answer. */
export const AccountRequestInputSchema = z.strictObject({ requestId: z.string().regex(ACCOUNT_REQUEST_ID_PATTERN) });
export type AccountRequestInput = z.infer<typeof AccountRequestInputSchema>;

/**
 * `account.signIn`:
 * - `started`: the authorize page was opened (status `awaiting-browser`; a pending one was replaced);
 * - `needs-gesture`: no live user gesture in the window that asked: nothing was opened;
 * - `unconfigured`: this build has no account configuration;
 * - `already-signed-in`: sign out first;
 * - `browser-failed`: the listener or the browser could not be started (status `signed-out`).
 */
export const SIGN_IN_RESULTS = ['started', 'needs-gesture', 'unconfigured', 'already-signed-in', 'browser-failed'] as const;
export type SignInResult = (typeof SIGN_IN_RESULTS)[number];
export const SignInResultSchema = z.enum(SIGN_IN_RESULTS);

/**
 * `account.confirmSignIn`, `cancelSignIn`, `signOut` and `refresh` answer a boolean: whether the
 * request was the pending one (for confirm: `confirming`, asked from the app window that started it,
 * with a live user gesture there), whether there was an account to sign out, whether a refresh ran
 * (signed in).
 */
export const AccountActionResultSchema = z.boolean();
