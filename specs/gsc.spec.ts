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
 * (`sites`, `searchAnalytics/query`). Search Console is free and needs no frost account (2026-10-29:
 * `UNGATED_FEATURES` in `entitlements-snapshot.spec.ts`); the connection is this frost profile's
 * (`GSC_PROFILE_OWNER`). No token, code, verifier or `state` ever leaves main.
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

// ---- Owner --------------------------------------------------------------------------------------

/**
 * Who a Google connection belongs to in main: this frost profile, whoever is signed in to frost (or
 * nobody), since Search Console needs no frost account (2026-10-29). Not a frost user ID's shape, so a
 * blob an older build stored under a frost account is another owner's: revoked and deleted at start.
 */
export const GSC_PROFILE_OWNER = 'frost-profile:local';

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
  /** The most date rows an answer holds: one per day of the longest range (`GSC_MAX_RANGE_DAYS`). */
  maxDateRows: 490,
  /** `countries` answers at most this many countries (most clicks first, as Google orders them). */
  maxCountries: 250,
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
 * - `not-entitled`: kept for wire compatibility; main never answers it (Search Console is not gated);
 * - `already-connected`: disconnect first;
 * - `browser-failed`: the listener or the browser could not be started.
 */
export const GSC_CONNECT_RESULTS = ['started', 'needs-gesture', 'unconfigured', 'not-entitled', 'already-connected', 'browser-failed'] as const;
export type GscConnectResult = (typeof GSC_CONNECT_RESULTS)[number];

/**
 * `gsc.status` / `gsc.watch` (`GscStatusSchema`): never a token, a code or an account name.
 *
 * **The connection belongs to this frost profile (`GSC_PROFILE_OWNER`), not to a frost account.** The
 * `gsc` blob carries its owner; one stored under any other owner (a frost user ID, by an older build)
 * is never read with and is revoked and deleted. Signing in or out of frost never touches it.
 */
export interface GscStatus {
  /** This build has a Search Console client. */
  configured: boolean;
  /** Always `true` from main (Search Console is not gated); kept for wire compatibility. */
  entitled: boolean;
  /** A refresh token is held for this profile. */
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

/** The preset ranges, in days (each ends `GSC_DATA_LAG_DAYS` before today, UTC). A query names one of these or a custom `range`. */
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

// ---- Custom ranges ------------------------------------------------------------------------------

/**
 * How far back Search Console keeps data, in calendar months: a custom range starts no earlier than
 * `gscRetentionStart(nowMs)`.
 */
export const GSC_RETENTION_MONTHS = 16;

/**
 * The longest custom range, in days (both ends inclusive). Any 16 calendar months span at most 489
 * days (with a leap February), so the "Last 16 months" range (`gscRetentionStart` to the lag day)
 * always fits, and `GSC_LIMITS.maxDateRows` (one row per day) holds it untruncated.
 */
export const GSC_MAX_RANGE_DAYS = 490;

/** `iso` (`YYYY-MM-DD`) as a UTC day's epoch ms, or `null` if it is not a real calendar date. */
function dayMs(iso: string): number | null {
  if (!GSC_DATE_PATTERN.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) && isoDay(ms) === iso ? ms : null;
}

/** Whether `iso` is a real calendar date in `YYYY-MM-DD` form (no `2026-02-30`). */
export const isGscDate = (iso: string): boolean => dayMs(iso) !== null;

/** The days `range` spans, both ends inclusive (`0` if either end is not a real date or start is after end). */
export function gscRangeDays(range: GscDateRange): number {
  const start = dayMs(range.start);
  const end = dayMs(range.end);
  return start === null || end === null || start > end ? 0 : Math.round((end - start) / DAY_MS) + 1;
}

/**
 * The first day Search Console still holds: `nowMs`'s UTC date `GSC_RETENTION_MONTHS` calendar
 * months earlier, the same day of the month, or that month's last day when it is shorter (today the
 * 31st, that month has 30 days: the 30th).
 */
export function gscRetentionStart(nowMs: number): string {
  const now = new Date(Math.floor(nowMs / DAY_MS) * DAY_MS);
  const months = now.getUTCFullYear() * 12 + now.getUTCMonth() - GSC_RETENTION_MONTHS;
  const year = Math.floor(months / 12);
  const month = months - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoDay(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay)));
}

/**
 * A custom range as frost reads it, or `null` when it is refused (the read answers `invalid` and
 * sends nothing):
 * - both ends real `YYYY-MM-DD` dates, inclusive;
 * - an end after today (UTC) is refused; an end after the lag day (today or the last
 *   `GSC_DATA_LAG_DAYS` days: partial data) is clamped to the lag day, `gscDateRange(1, nowMs).end`;
 * - the start no earlier than `gscRetentionStart(nowMs)` and no later than the (clamped) end;
 * - at most `GSC_MAX_RANGE_DAYS` days.
 */
export function gscCustomRange(start: string, end: string, nowMs: number): GscDateRange | null {
  const startMs = dayMs(start);
  const endMs = dayMs(end);
  if (startMs === null || endMs === null) return null;
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  if (endMs > today) return null;
  const lagDay = today - GSC_DATA_LAG_DAYS * DAY_MS;
  const range = { start, end: isoDay(Math.min(endMs, lagDay)) };
  if (start < gscRetentionStart(nowMs)) return null;
  const days = gscRangeDays(range);
  return days >= 1 && days <= GSC_MAX_RANGE_DAYS ? range : null;
}

// ---- Filters ------------------------------------------------------------------------------------

/** The devices a query may be filtered on (Google's `device` dimension values). */
export const GSC_DEVICES = ['DESKTOP', 'MOBILE', 'TABLET'] as const;
export type GscDevice = (typeof GSC_DEVICES)[number];

/**
 * A country filter's value: Google's ISO 3166-1 alpha-3 code, in lowercase as Google answers it
 * (`usa`, `gbr`). The picker offers only the countries a `countries` read answered.
 */
export const GSC_COUNTRY_PATTERN = /^[a-z]{3}$/;

/**
 * ISO 3166-1 alpha-3 (lowercase, as Google answers) to alpha-2 (uppercase), so the chrome can name a
 * country with `Intl.DisplayNames` (`type: 'region'`). Every officially assigned code; a code Google
 * answers that is not here is shown as is.
 */
export const GSC_COUNTRY_ALPHA3: Readonly<Record<string, string>> = Object.freeze({
  abw: 'AW', afg: 'AF', ago: 'AO', aia: 'AI', ala: 'AX', alb: 'AL', and: 'AD', are: 'AE', arg: 'AR', arm: 'AM',
  asm: 'AS', ata: 'AQ', atf: 'TF', atg: 'AG', aus: 'AU', aut: 'AT', aze: 'AZ', bdi: 'BI', bel: 'BE', ben: 'BJ',
  bes: 'BQ', bfa: 'BF', bgd: 'BD', bgr: 'BG', bhr: 'BH', bhs: 'BS', bih: 'BA', blm: 'BL', blr: 'BY', blz: 'BZ',
  bmu: 'BM', bol: 'BO', bra: 'BR', brb: 'BB', brn: 'BN', btn: 'BT', bvt: 'BV', bwa: 'BW', caf: 'CF', can: 'CA',
  cck: 'CC', che: 'CH', chl: 'CL', chn: 'CN', civ: 'CI', cmr: 'CM', cod: 'CD', cog: 'CG', cok: 'CK', col: 'CO',
  com: 'KM', cpv: 'CV', cri: 'CR', cub: 'CU', cuw: 'CW', cxr: 'CX', cym: 'KY', cyp: 'CY', cze: 'CZ', deu: 'DE',
  dji: 'DJ', dma: 'DM', dnk: 'DK', dom: 'DO', dza: 'DZ', ecu: 'EC', egy: 'EG', eri: 'ER', esh: 'EH', esp: 'ES',
  est: 'EE', eth: 'ET', fin: 'FI', fji: 'FJ', flk: 'FK', fra: 'FR', fro: 'FO', fsm: 'FM', gab: 'GA', gbr: 'GB',
  geo: 'GE', ggy: 'GG', gha: 'GH', gib: 'GI', gin: 'GN', glp: 'GP', gmb: 'GM', gnb: 'GW', gnq: 'GQ', grc: 'GR',
  grd: 'GD', grl: 'GL', gtm: 'GT', guf: 'GF', gum: 'GU', guy: 'GY', hkg: 'HK', hmd: 'HM', hnd: 'HN', hrv: 'HR',
  hti: 'HT', hun: 'HU', idn: 'ID', imn: 'IM', ind: 'IN', iot: 'IO', irl: 'IE', irn: 'IR', irq: 'IQ', isl: 'IS',
  isr: 'IL', ita: 'IT', jam: 'JM', jey: 'JE', jor: 'JO', jpn: 'JP', kaz: 'KZ', ken: 'KE', kgz: 'KG', khm: 'KH',
  kir: 'KI', kna: 'KN', kor: 'KR', kwt: 'KW', lao: 'LA', lbn: 'LB', lbr: 'LR', lby: 'LY', lca: 'LC', lie: 'LI',
  lka: 'LK', lso: 'LS', ltu: 'LT', lux: 'LU', lva: 'LV', mac: 'MO', maf: 'MF', mar: 'MA', mco: 'MC', mda: 'MD',
  mdg: 'MG', mdv: 'MV', mex: 'MX', mhl: 'MH', mkd: 'MK', mli: 'ML', mlt: 'MT', mmr: 'MM', mne: 'ME', mng: 'MN',
  mnp: 'MP', moz: 'MZ', mrt: 'MR', msr: 'MS', mtq: 'MQ', mus: 'MU', mwi: 'MW', mys: 'MY', myt: 'YT', nam: 'NA',
  ncl: 'NC', ner: 'NE', nfk: 'NF', nga: 'NG', nic: 'NI', niu: 'NU', nld: 'NL', nor: 'NO', npl: 'NP', nru: 'NR',
  nzl: 'NZ', omn: 'OM', pak: 'PK', pan: 'PA', pcn: 'PN', per: 'PE', phl: 'PH', plw: 'PW', png: 'PG', pol: 'PL',
  pri: 'PR', prk: 'KP', prt: 'PT', pry: 'PY', pse: 'PS', pyf: 'PF', qat: 'QA', reu: 'RE', rou: 'RO', rus: 'RU',
  rwa: 'RW', sau: 'SA', sdn: 'SD', sen: 'SN', sgp: 'SG', sgs: 'GS', shn: 'SH', sjm: 'SJ', slb: 'SB', sle: 'SL',
  slv: 'SV', smr: 'SM', som: 'SO', spm: 'PM', srb: 'RS', ssd: 'SS', stp: 'ST', sur: 'SR', svk: 'SK', svn: 'SI',
  swe: 'SE', swz: 'SZ', sxm: 'SX', syc: 'SC', syr: 'SY', tca: 'TC', tcd: 'TD', tgo: 'TG', tha: 'TH', tjk: 'TJ',
  tkl: 'TK', tkm: 'TM', tls: 'TL', ton: 'TO', tto: 'TT', tun: 'TN', tur: 'TR', tuv: 'TV', twn: 'TW', tza: 'TZ',
  uga: 'UG', ukr: 'UA', umi: 'UM', ury: 'UY', usa: 'US', uzb: 'UZ', vat: 'VA', vct: 'VC', ven: 'VE', vgb: 'VG',
  vir: 'VI', vnm: 'VN', vut: 'VU', wlf: 'WF', wsm: 'WS', yem: 'YE', zaf: 'ZA', zmb: 'ZM', zwe: 'ZW',
});

/**
 * Why an answer has no data:
 * - `unconfigured`: no Search Console client in this build.
 * - `not-entitled`: kept for wire compatibility; main never answers it (Search Console is not gated).
 * - `not-connected`: no Google account is connected for this profile (or the
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
