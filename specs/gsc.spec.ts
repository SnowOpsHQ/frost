/**
 * Search Console (Phase 4 Task 8; acceptance `gsc.feature.md`; review focus "Search Console asks for
 * read-only access only" and "The renderer never sees a token"). Plain values and functions with no
 * Zod, so the chrome renderer (the Settings view, the performance panel) can use them: its strict
 * Trusted Types CSP blocks Zod's eval probe. The Zod schemas of the `gsc.*` procedures, of the
 * `GscService` answers and of Google's own answers are in `gsc.schema.ts`.
 *
 * Main connects to Google with OAuth 2.0 for installed apps (authorization code, PKCE S256, the
 * shared loopback redirect listener) asking for exactly `GSC_SCOPE`, keeps the refresh token in the
 * secret store's `gsc` blob and the access token in memory, and reads the Search Console API v3
 * (`sites`, `searchAnalytics/query`). Search Console is a `pro` feature (`search-console`). No token,
 * code, verifier or `state` ever leaves main.
 *
 * Clean-room: frost's own names and limits; Google's endpoints and parameters are its public API.
 */

// ---- Scope --------------------------------------------------------------------------------------

/**
 * The only OAuth scope frost ever asks Google for (plan Global Constraint "Search Console is
 * read-only"). The consent URL carries exactly this scope (no `openid`, no `email`, never
 * `include_granted_scopes`), and a token answer that grants anything else is refused and revoked.
 * Without `openid email` Google names no account, so frost shows "Connected" without an email.
 */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

// ---- Configuration ------------------------------------------------------------------------------

/**
 * The build's public Search Console values (plan "Configuration"), read like the account's
 * (`account-state.schema.ts`, `ACCOUNT_CONFIG_ENV`): baked in at build time (`import.meta.env`,
 * `envPrefix` `FROST_PUBLIC_`). The installed-app client secret is not confidential by Google's own
 * definition, but it is still never committed. **One rule for every public value
 * (`build-config.spec.ts`)**: a build with any `FROST_PUBLIC_*` value baked in (Search Console's, the
 * account's or telemetry's) reads none of them from the run-time environment, nor `GSC_ENDPOINT_ENV`;
 * only an unpackaged build with nothing baked in (dev, e2e) does. Both are needed: a missing or
 * malformed one leaves Search Console `unconfigured`.
 */
export const GSC_CONFIG_ENV = {
  clientId: 'FROST_PUBLIC_GSC_CLIENT_ID',
  clientSecret: 'FROST_PUBLIC_GSC_CLIENT_SECRET',
} as const;

/** What a client ID and secret may look like (Google's are within these; anything else is refused). */
export const GSC_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
export const GSC_CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;

/** Google's endpoints: fixed for every build that has a value baked in, and for every packaged build. */
export const GSC_ENDPOINTS = {
  /** OAuth 2.0 authorization (the consent page, opened in the system browser). */
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  /** Code exchange and refresh. */
  tokenUrl: 'https://oauth2.googleapis.com/token',
  /** Revocation (disconnect). */
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  /** The Search Console API v3 base (`/sites`, `/sites/{siteUrl}/searchAnalytics/query`). */
  apiBase: 'https://www.googleapis.com/webmasters/v3',
} as const;
export type GscEndpoints = { readonly [K in keyof typeof GSC_ENDPOINTS]: string };

/**
 * Test fakes' endpoints (plan "Configuration", `FROST_GSC_*_URL`): read **only** by an unpackaged
 * build that reads its configuration from the run-time environment (no `FROST_PUBLIC_*` value baked
 * in at all, `runtimeOverridesAllowed`). Each, when
 * set, replaces its `GSC_ENDPOINTS` value; it must be `https:`, or `http:` on
 * `UNPACKAGED_HTTP_GSC_HOSTS`, with no credentials, query or fragment (else Search Console is
 * `unconfigured`: a refused override never falls back to Google silently).
 */
export const GSC_ENDPOINT_ENV = {
  authUrl: 'FROST_GSC_AUTH_URL',
  tokenUrl: 'FROST_GSC_TOKEN_URL',
  revokeUrl: 'FROST_GSC_REVOKE_URL',
  apiBase: 'FROST_GSC_API_BASE',
} as const;
export const UNPACKAGED_HTTP_GSC_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost']);

/**
 * The consent URL's query: exactly these parameters (`client_id`, `redirect_uri`, `state` and
 * `code_challenge` vary per request). `access_type=offline` and `prompt=consent` make Google answer a
 * refresh token every time.
 */
export const GSC_AUTH_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'access_type', 'prompt'] as const;
export const GSC_AUTH_FIXED_PARAMS = Object.freeze({
  response_type: 'code',
  scope: GSC_SCOPE,
  code_challenge_method: 'S256',
  access_type: 'offline',
  prompt: 'consent',
} as const);

// ---- Timing and limits --------------------------------------------------------------------------

export const GSC_LIMITS = {
  /** Each call to Google (token, revoke, API) gives up after this long (`network`). */
  timeoutMs: 20_000,
  /** Longest answer body read from Google, in bytes; a longer one is `invalid`. */
  maxBodyBytes: 1024 * 1024,
  /** At most this many properties are kept from `sites` (the rest are dropped). */
  maxProperties: 1_000,
  /** Longest property `siteUrl` and page URL, in characters. */
  maxUrlChars: 2_048,
  /** Longest search query kept (a longer one is cut). */
  maxQueryChars: 512,
  /** `topQueries` answers at most this many queries (most clicks first, as Google orders them). */
  maxTopQueries: 25,
  /** The most date rows an answer holds (the longest range). */
  maxDateRows: 90,
  /** At most this many `gsc.watch` calls wait at once; one more answers the oldest early. */
  maxPendingWatches: 4,
  /** Answers kept in the cache at most (the oldest go first). */
  maxCacheEntries: 64,
} as const;

/** How long a property list or a performance / queries answer is reused (per key; cleared on disconnect). */
export const GSC_CACHE_TTL_MS = 15 * 60_000;
/** An access token is refreshed this long before Google says it expires. */
export const GSC_ACCESS_TOKEN_SKEW_MS = 60_000;
/** How long a connect waits for the browser's callback (the loopback closes then). */
export const GSC_CONNECT_TIMEOUT_MS = 10 * 60_000;
/**
 * On quit, what is still running may hold the quit at most this long: a revocation, an exchange in
 * flight (its tokens are revoked when it lands), and the revocation of a refresh token that was never
 * written to the keychain (memory-only, or the write failed): a grant this run cannot keep is not left
 * alive at Google.
 */
export const GSC_QUIT_REVOKE_TIMEOUT_MS = 2_000;

/**
 * Calls to the Search Console API go through a token bucket: at most `burst` at once, refilled at
 * `perSecond`. A call with no token left is not sent and answers `quota`. (The token and revoke
 * endpoints are not counted: a revocation is never held back.) Identical reads in flight at once are
 * merged into one call.
 */
export const GSC_RATE_LIMIT = { perSecond: 10, burst: 20 } as const;

/**
 * After a token refresh fails for a `network` or `invalid` reason, no refresh is tried again for
 * `initialMs`, doubling after each further failure up to `maxMs`; calls meanwhile answer that failure
 * without sending anything. A successful refresh (or a new connection) resets it.
 */
export const GSC_REFRESH_BACKOFF = { initialMs: 1_000, maxMs: 5 * 60_000 } as const;

// ---- Status -------------------------------------------------------------------------------------

/**
 * Why the last connect failed, or the connection ended (shown once; cleared by the next `connect`):
 * - `browser-failed`: the listener could not start, or the system browser could not be opened.
 * - `timed-out`: no callback within `GSC_CONNECT_TIMEOUT_MS`.
 * - `cancelled`: the browser reported the consent as refused or cancelled.
 * - `exchange-failed`: Google refused the code, or answered something unusable (no refresh token).
 * - `network`: Google could not be reached.
 * - `scope-refused`: Google granted more than `GSC_SCOPE`: refused, revoked, nothing kept.
 * - `auth-expired`: Google no longer accepts the refresh token (revoked, expired): disconnected.
 */
export const GSC_ERRORS = ['browser-failed', 'timed-out', 'cancelled', 'exchange-failed', 'network', 'scope-refused', 'auth-expired'] as const;
export type GscError = (typeof GSC_ERRORS)[number];

/**
 * `gsc.connect`:
 * - `started`: the consent page was opened (`connecting`; a pending connect was replaced);
 * - `needs-gesture`: no live user gesture in the window that asked: nothing opened;
 * - `unconfigured`: this build has no Search Console client;
 * - `not-entitled`: the plan does not include `search-console`;
 * - `already-connected`: disconnect first;
 * - `browser-failed`: the listener or the browser could not be started.
 */
export const GSC_CONNECT_RESULTS = ['started', 'needs-gesture', 'unconfigured', 'not-entitled', 'already-connected', 'browser-failed'] as const;
export type GscConnectResult = (typeof GSC_CONNECT_RESULTS)[number];

/**
 * `gsc.status` / `gsc.watch` (`GscStatusSchema`): never a token, a code or an account name.
 *
 * **The connection belongs to the frost account that made it.** The `gsc` blob carries that
 * account's user ID; while another account (or none) is signed in the connection is not
 * `connected`, nothing reads with it and its tokens are never sent. Signing in as a different account
 * disconnects it (revoked and deleted); signing out and back in as the same account keeps it.
 */
export interface GscStatus {
  /** This build has a Search Console client. */
  configured: boolean;
  /** The plan includes `search-console` now. */
  entitled: boolean;
  /** A refresh token is held for the signed-in frost account. */
  connected: boolean;
  /** A connect is waiting for the browser. Never with `connected`. */
  connecting: boolean;
  /**
   * Connected: `persistent` only if the refresh token was written to the OS keychain, else
   * `memory-only` (no keychain, or the write failed: it lasts this run and is revoked at quit). Not
   * connected: where a connection would be kept.
   */
  keychain: 'persistent' | 'memory-only';
  error: GscError | null;
  version: number;
}

// ---- Properties ---------------------------------------------------------------------------------

/**
 * A Search Console property: a URL prefix (`https://www.example.com/`: URLs that begin with it) or
 * a domain (`sc-domain:example.com`: the domain and every subdomain, over `http:` and `https:`).
 */
export const GSC_PROPERTY_KINDS = ['url-prefix', 'domain'] as const;
export type GscPropertyKind = (typeof GSC_PROPERTY_KINDS)[number];
export const GSC_DOMAIN_PREFIX = 'sc-domain:';

/** Google's permission levels. `siteUnverifiedUser` reads no data: such properties are ignored. */
export const GSC_PERMISSION_LEVELS = ['siteOwner', 'siteFullUser', 'siteRestrictedUser', 'siteUnverifiedUser'] as const;
export type GscPermissionLevel = (typeof GSC_PERMISSION_LEVELS)[number];
export const GSC_UNVERIFIED_PERMISSION: GscPermissionLevel = 'siteUnverifiedUser';

export interface GscProperty {
  siteUrl: string;
  kind: GscPropertyKind;
  permissionLevel: GscPermissionLevel;
}

// ---- Performance --------------------------------------------------------------------------------

/** `page`: the one URL (its fragment dropped; `page equals` filter). `property`: the whole property. */
export const GSC_QUERY_SCOPES = ['page', 'property'] as const;
export type GscQueryScope = (typeof GSC_QUERY_SCOPES)[number];

/** The ranges offered, in days (each ends `GSC_DATA_LAG_DAYS` before today, UTC). */
export const GSC_RANGE_DAYS = [7, 28, 90] as const;
export type GscRangeDays = (typeof GSC_RANGE_DAYS)[number];

/**
 * Search Console's data lags: the last complete ("final") day is about two days ago. A range of `n`
 * days ends on today's UTC date minus `GSC_DATA_LAG_DAYS` and starts `n - 1` days before that, both
 * inclusive (Google's `startDate` and `endDate`, `YYYY-MM-DD`). Google dates are in its own
 * (Pacific) time zone; UTC is close enough and the same for every user.
 */
export const GSC_DATA_LAG_DAYS = 2;

export interface GscDateRange {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive. */
  end: string;
}

export const GSC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The `days`-day range ending `GSC_DATA_LAG_DAYS` before `nowMs`'s UTC date (see `GSC_DATA_LAG_DAYS`). */
export function gscDateRange(days: number, nowMs: number): GscDateRange {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const end = today - GSC_DATA_LAG_DAYS * DAY_MS;
  return { start: isoDay(end - (days - 1) * DAY_MS), end: isoDay(end) };
}

/**
 * Why an answer has no data:
 * - `unconfigured`: no Search Console client in this build.
 * - `not-entitled`: the plan does not include `search-console` (checked before anything is sent).
 * - `not-connected`: no Google account is connected for the signed-in frost account (or the
 *   connection changed, by a disconnect or a new connection, while the read was running: what it read
 *   belongs to the old one and is not answered).
 * - `no-property`: no verified property covers the URL (or Google refused access to it).
 * - `auth-expired`: Google refused the credentials, even after a refresh.
 * - `quota`: Google's quota or rate limit (429, or 403 with a quota reason), or frost's own
 *   (`GSC_RATE_LIMIT`: nothing was sent).
 * - `network`: Google could not be reached (no answer, timeout, 408, 5xx).
 * - `invalid`: a malformed query, or an answer that is not what the API documents.
 * - `not-a-web-page`: the URL is not `http(s)`.
 */
export const GSC_UNAVAILABLE_REASONS = ['unconfigured', 'not-entitled', 'not-connected', 'no-property', 'auth-expired', 'quota', 'network', 'invalid', 'not-a-web-page'] as const;
export type GscUnavailableReason = (typeof GSC_UNAVAILABLE_REASONS)[number];
