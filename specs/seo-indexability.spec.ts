/**
 * Indexability (Phase 2 Task 4; acceptance: `seo-indexability.feature.md`): what main records about
 * a tab's main-frame response, how it fetches the page's robots.txt, how frost reads robots.txt
 * (its own parser, written from the Robots Exclusion Protocol, RFC 9309), the hreflang code tables,
 * and the panel's verdicts.
 *
 * Plain values with no imports, so the chrome renderer can use them without bundling Zod. The Zod
 * schemas that enforce the caps are in `seo-snapshot.spec.ts` (`ResponseMetaSchema`,
 * `RobotsFetchSchema`, `PageContextSchema`, `HreflangLinkSchema`).
 */

// ---- Main-frame response (recorded by main from the browse session) -------------------------

/**
 * The response headers main keeps for a tab's document (lowercased names; every other header is
 * dropped as it arrives, so the page's response never puts more than these caps into main's
 * memory). `x-robots-tag` and `link` keep every instance (up to `maxValuesPerHeader`); the security
 * headers are for the Compliance panel (Task 6).
 */
export const RESPONSE_HEADER_ALLOWLIST = [
  'x-robots-tag',
  'link',
  'content-type',
  'cache-control',
  'last-modified',
  'etag',
  'vary',
  'content-language',
  'server',
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
] as const;
export type ResponseHeaderName = (typeof RESPONSE_HEADER_ALLOWLIST)[number];

export const RESPONSE_LIMITS = {
  /** Characters of one header value kept (cut, never split inside a surrogate pair). */
  maxHeaderValueChars: 2_048,
  /** Instances of one header name kept (`X-Robots-Tag` and `Link` may repeat). */
  maxValuesPerHeader: 8,
  /** Header values kept in all. */
  maxHeaders: 48,
  /** Redirect hops kept, oldest first (`redirectTotal` counts them all). */
  maxRedirects: 10,
  /** Main-frame requests per tab whose metadata main holds while they are in flight (the newest win). */
  maxPendingPerTab: 4,
  /** Tabs whose committed response main remembers (the least recently updated is dropped). */
  maxTrackedTabs: 64,
} as const;

/**
 * Where a tab's response metadata came from:
 * - `network`: the browse session's `webRequest` events for the main-frame request (status,
 *   redirects, headers);
 * - `cache`: the same events, but Chromium answered from its HTTP cache (`fromCache`): status and
 *   headers are the cached response's;
 * - `navigation`: no `webRequest` events matched the committed document (a page restored from the
 *   back/forward cache or the memory cache, or one committed before main listened). The status is
 *   `did-navigate`'s `httpResponseCode`; headers and redirects are unavailable;
 * - `in-page`: the URL changed inside the document (`pushState`, a fragment) and differs from the
 *   one the document was loaded at: there is no response for this URL at all (status and headers
 *   unknown).
 */
export const RESPONSE_SOURCES = ['network', 'cache', 'navigation', 'in-page'] as const;
export type ResponseSource = (typeof RESPONSE_SOURCES)[number];

// ---- robots.txt fetch -------------------------------------------------------------------------

/**
 * Main fetches `<page origin>/robots.txt` itself (never the page): through the **browse session**
 * (its proxy and certificate checks), cookies and credentials off, no referrer, not from or into
 * the HTTP cache. Bounded:
 * - `maxRedirects`: redirects followed (RFC 9309 asks crawlers to follow at least five); each hop
 *   must stay `http(s)` (another origin is allowed, as crawlers do). One more is `too-many-redirects`;
 *   a non-`http(s)` or unparsable `Location` is `bad-redirect`, never requested;
 * - `maxBytes`: the body is read up to 500 KiB (512 000 bytes; the limit RFC 9309 sets as a
 *   minimum and Google applies). The rest is never read and ignored (`truncated`);
 * - `timeoutMs`: one deadline for the whole fetch, redirects and body included (`timeout`);
 * - `cacheTtlMs`: the answer is kept per origin for this long (`failureTtlMs` for a fetch that
 *   failed: 5xx, unreachable, timeout, a bad redirect), at most `maxCacheEntries` origins (the
 *   oldest goes first); concurrent requests for one origin share one fetch.
 */
export const ROBOTS_FETCH_LIMITS = {
  maxRedirects: 5,
  maxBytes: 512_000,
  timeoutMs: 5_000,
  cacheTtlMs: 600_000,
  failureTtlMs: 60_000,
  maxCacheEntries: 32,
} as const;

/**
 * How a robots.txt fetch ended, and what it means for crawling (RFC 9309 §2.3.1, common crawler
 * practice):
 * - `ok` (2xx): the file is parsed and its rules apply;
 * - `unavailable` (4xx other than 429, or more than `maxRedirects` redirects): there is no
 *   robots.txt, so crawlers may fetch everything;
 * - `server-error` (5xx, or 429), `unreachable` (a network error), `timeout`, `bad-redirect`:
 *   unknown. Crawlers then assume everything is disallowed until they can read it, so frost's
 *   verdict for each bot is "unknown" and the `robots-txt-unreachable` rule fails.
 * 3xx responses are followed (above); a 3xx without a usable `Location` is `bad-redirect`.
 */
export const ROBOTS_FETCH_OUTCOMES = ['ok', 'unavailable', 'server-error', 'unreachable', 'timeout', 'bad-redirect'] as const;
export type RobotsFetchOutcome = (typeof ROBOTS_FETCH_OUTCOMES)[number];
/** The outcomes that leave crawlers unable to tell what is allowed (assume disallowed). */
export const ROBOTS_UNKNOWN_OUTCOMES = ['server-error', 'unreachable', 'timeout', 'bad-redirect'] as const satisfies readonly RobotsFetchOutcome[];

export const ROBOTS_OUTCOME_LABELS: Readonly<Record<RobotsFetchOutcome, string>> = {
  ok: 'Fetched',
  unavailable: 'Not found (no restrictions)',
  'server-error': 'Server error',
  unreachable: 'Could not connect',
  timeout: 'Timed out',
  'bad-redirect': 'Redirects to a non-web address',
};

// ---- robots.txt parsing (frost's own, from RFC 9309) ------------------------------------------

/**
 * The crawlers the panel gives a verdict for, as product tokens. A group applies to a crawler when
 * one of its `user-agent` values starts with the token, case-insensitively, followed by nothing or
 * a character that cannot be part of a token (so `Googlebot/2.1` is Googlebot's, `Googlebot-News`
 * is not). The most specific group wins: a crawler's own groups (all of them, merged), else the
 * `*` groups (merged), else no group (everything allowed).
 */
export const ROBOTS_AGENTS = ['Googlebot', 'Bingbot', '*'] as const;
export type RobotsAgent = (typeof ROBOTS_AGENTS)[number];

/**
 * Parsing bounds (the worker's robots.txt parse; the text is at most `ROBOTS_FETCH_LIMITS.maxBytes`):
 * - `maxLineChars`: a longer line is ignored (no real directive is that long);
 * - `maxSitemaps`: `Sitemap:` URLs kept (`sitemapTotal` counts them all);
 * - `maxViewChars`: characters of the file the panel's "View robots.txt" shows (the rest is cut,
 *   and the panel says so).
 */
export const ROBOTS_PARSE_LIMITS = {
  maxLineChars: 4_096,
  maxSitemaps: 50,
  maxViewChars: 100_000,
} as const;

// ---- hreflang -----------------------------------------------------------------------------------

/**
 * An hreflang value is `x-default`, or a language code from `ISO_639_1`, optionally followed by a
 * four-letter script subtag (ISO 15924 form, e.g. `zh-Hant`) and then optionally by a region code
 * from `ISO_3166_1_ALPHA_2`, joined by `-` and compared case-insensitively (BCP 47's common subset,
 * as search engines read it). `en_US`, `en-UK`, `eng` and `english` are invalid. A value checks
 * against frost's own tables, not `Intl`: `Intl.getCanonicalLocales` accepts any well-formed tag
 * (`qq-ZZ` too) and would say nothing about real codes.
 */
export const HREFLANG_X_DEFAULT = 'x-default' as const;

/** ISO 639-1 two-letter language codes. */
export const ISO_639_1 = [
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az', 'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs', 'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz', 'ee', 'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy', 'ga', 'gd', 'gl', 'gn', 'gu', 'gv', 'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu',
  'hy', 'hz', 'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu', 'ja', 'jv', 'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky', 'la', 'lb',
  'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv', 'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny', 'oc', 'oj', 'om',
  'or', 'os', 'pa', 'pi', 'pl', 'ps', 'pt', 'qu', 'rm', 'rn', 'ro', 'ru', 'rw', 'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty', 'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo', 'wa', 'wo', 'xh', 'yi', 'yo', 'za', 'zh', 'zu',
] as const;

/** ISO 3166-1 alpha-2 country codes (officially assigned). */
export const ISO_3166_1_ALPHA_2 = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR',
  'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW',
  'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY',
  'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV',
  'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG',
  'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM',
  'ZW',
] as const;

/** hreflang annotations read: `<link rel="alternate" hreflang>` in `<head>` (`SNAPSHOT_LIMITS.maxHreflang`) and HTTP `Link` headers (the header cap). */
export const HREFLANG_SOURCES = ['html', 'header'] as const;
export type HreflangSource = (typeof HREFLANG_SOURCES)[number];

/**
 * Reciprocity (each alternate listing this page back) needs fetching every alternate: out of scope
 * for Phase 2. The panel says so.
 */
export const HREFLANG_RECIPROCITY_CHECKED = false;

// ---- Verdict --------------------------------------------------------------------------------------

/**
 * The panel's overall verdict:
 * - `not-indexable`: a rule in `NOT_INDEXABLE_RULES` (`seo-rules.spec.ts`) fails (an error status,
 *   noindex in a robots meta tag or `X-Robots-Tag`, robots.txt blocking Googlebot); each is a reason;
 * - `canonicalised`: none of those, but the canonical (HTML or HTTP header) names another URL;
 * - `indexable`: neither.
 */
export const INDEXABILITY_VERDICTS = ['indexable', 'not-indexable', 'canonicalised'] as const;
export type IndexabilityVerdict = (typeof INDEXABILITY_VERDICTS)[number];
export const INDEXABILITY_VERDICT_LABELS: Readonly<Record<IndexabilityVerdict, string>> = {
  indexable: 'Indexable',
  'not-indexable': 'Not indexable',
  canonicalised: 'Indexable, but canonicalised elsewhere',
};
