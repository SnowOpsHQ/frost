/**
 * Location profiles: seeing results "from" another place through the user's own proxy (Phase 12
 * Task 10b; plan `docs/plans/phase-12-big-bets.md`, Decisions 7 and 11, Global constraints
 * "Partitions" and "Secrets"; acceptance `location-profiles.feature.md`; shapes
 * `location-profiles.schema.ts`). Plain values and pure functions with no Zod, so the chrome renderer
 * imports them as they are (strict Trusted Types).
 *
 * - A profile is a label, a proxy scheme (`LOCATION_PROXY_SCHEMES`), a host and a port, stored in
 *   `location_profiles` (migration `0244_location_profiles`; **no secrets**). An `http` or `https`
 *   proxy may have a username and password: they live only in main, in `LOCATION_CREDENTIALS_FILE`
 *   through the agent's `createCredentialStore` (`os` protection only, each blob sealed to its slot,
 *   two slots per profile, `locationCredentialSlots`), write-only to the renderer (`hasCredentials`).
 *   Chromium does not authenticate SOCKS proxies, so a `socks5` profile never has credentials.
 * - Each profile gets an **in-memory** partition, `locationPartition(id)` (never `persist:`), whose
 *   proxy is `fixed_servers` with `proxyRulesFor(profile)` and Chromium's implicit loopback bypass
 *   kept (no `proxyBypassRules`). Main sets and awaits the proxy, then registers the session as
 *   browse-class (`browser/browse-class.ts`), before the profile's first tab exists.
 * - Each location tab's WebContents gets `LOCATION_WEBRTC_POLICY` at creation, before its first
 *   navigation (`window.ts` `createTabView`): a WebContents setting, not a session one.
 * - A location tab is ephemeral: never in history, never saved in the session, reopened by Reopen
 *   Closed Tab only within the run. Its state carries `location: { profileId, label }`; the badge
 *   (`LOCATION_BADGE`) always shows it.
 * - Proxy authentication answers Electron's `login` event only for `authInfo.isProxy`, on that
 *   profile's partition, for that profile's `host:port`, on the first attempt; every other `login`
 *   is cancelled.
 */

// ---- Partitions -------------------------------------------------------------------------------

/** Every location partition's name starts with this (no `persist:`: in memory only). */
export const LOCATION_PARTITION_PREFIX = 'frost-location-' as const;

/** A profile id: a lower-case UUIDv7 (`uuidv7` in `@app/db`). */
export const LOCATION_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isLocationProfileId(value: unknown): value is string {
  return typeof value === 'string' && LOCATION_PROFILE_ID_PATTERN.test(value);
}

/** The profile's partition (in memory: the name never starts with `persist:`). */
export function locationPartition(profileId: string): string {
  if (!isLocationProfileId(profileId)) throw new TypeError('not a location profile id');
  return `${LOCATION_PARTITION_PREFIX}${profileId}`;
}

/** Whether `partition` is a location profile's partition (exactly the prefix and a profile id). */
export function isLocationPartition(partition: unknown): partition is string {
  return typeof partition === 'string' && partition.startsWith(LOCATION_PARTITION_PREFIX) && isLocationProfileId(partition.slice(LOCATION_PARTITION_PREFIX.length));
}

/**
 * Applied to each location tab's WebContents at creation, before its first navigation
 * (`setWebRTCIPHandlingPolicy`, a WebContents method): WebRTC uses only proxied UDP (none through an
 * HTTP or SOCKS5 proxy: Chromium relays TCP only), so no candidate carries the user's own address.
 */
export const LOCATION_WEBRTC_POLICY = 'disable_non_proxied_udp' as const;

// ---- Profiles ---------------------------------------------------------------------------------

/** How frost talks to the proxy (Chromium's proxy URI schemes). */
export const LOCATION_PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;
export type LocationProxyScheme = (typeof LOCATION_PROXY_SCHEMES)[number];

export function isLocationProxyScheme(value: unknown): value is LocationProxyScheme {
  return typeof value === 'string' && (LOCATION_PROXY_SCHEMES as readonly string[]).includes(value);
}

/** Whether a scheme can carry a username and password (Chromium authenticates HTTP(S) proxies only). */
export function schemeTakesCredentials(scheme: LocationProxyScheme): boolean {
  return scheme !== 'socks5';
}

export const LOCATION_LIMITS = {
  /** Profiles, at most. */
  maxProfiles: 20,
  /** A label, at most (UTF-16 code units). A profile's label becomes a `SearchLocation` label (Decision 7), so it fits `SEARCH_LOCATION_MAX_CHARS` too (`location-profiles.test.ts` checks). */
  maxLabelChars: 64,
  /** A host name, at most. */
  maxHostChars: 253,
  minPort: 1,
  maxPort: 65_535,
  /** A proxy username or password, at most (UTF-16 code units). */
  maxCredentialChars: 256,
} as const;

/** The key store's file in `userData` (`createCredentialStore`; `os` protection only). */
export const LOCATION_CREDENTIALS_FILE = 'location-credentials.json' as const;

/** A profile's two credential slots. */
export function locationCredentialSlots(profileId: string): { readonly username: `location-username.${string}`; readonly password: `location-password.${string}` } {
  if (!isLocationProfileId(profileId)) throw new TypeError('not a location profile id');
  return { username: `location-username.${profileId}`, password: `location-password.${profileId}` };
}

/** Whether `value` is one of a profile's credential slots. */
export function isLocationCredentialSlot(value: unknown): value is `location-username.${string}` | `location-password.${string}` {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  const kind = value.slice(0, dot);
  return dot > 0 && (kind === 'location-username' || kind === 'location-password') && isLocationProfileId(value.slice(dot + 1));
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;

/** A label as stored: trimmed, 1–`maxLabelChars`, printable (no controls or bidirectional formatting); else `null`. */
export function normalizeLocationLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label === '' || label.length > LOCATION_LIMITS.maxLabelChars || CONTROL.test(label) || BIDI.test(label)) return null;
  return label;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_BRACKETED = /^\[[0-9a-f:.]{2,45}\]$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A proxy host as stored: lower-cased and trimmed; a DNS name (letters, digits, hyphens, dot-separated
 * labels of 1–63, no trailing dot), an IPv4 literal, or a bracketed IPv6 literal; at most
 * `maxHostChars`. Anything else (a scheme, a path, userinfo, a port, a wildcard): `null`. Loopback
 * and private addresses are allowed: the proxy is the user's own (a local SOCKS tunnel is common).
 */
export function normalizeLocationHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (host === '' || host.length > LOCATION_LIMITS.maxHostChars) return null;
  if (IPV4.test(host)) return host;
  if (IPV6_BRACKETED.test(host)) return host.slice(1, -1).includes(':') ? host : null;
  const labels = host.split('.');
  // An all-numeric name that is not an IPv4 literal (`1.2.3`, `999.1.1.1`) is refused: Chromium would read it as an address.
  if (labels.every((label) => /^\d+$/.test(label))) return null;
  return labels.every((label) => LABEL.test(label)) ? host : null;
}

export function isLocationPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= LOCATION_LIMITS.minPort && value <= LOCATION_LIMITS.maxPort;
}

/** A proxy username: 1–`maxCredentialChars`, printable, no `:` (HTTP Basic splits on it); else `null`. Never trimmed. */
export function normalizeLocationUsername(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > LOCATION_LIMITS.maxCredentialChars || CONTROL.test(value) || value.includes(':')) return null;
  return value;
}

/** A proxy password: 1–`maxCredentialChars`, printable; else `null`. Never trimmed. */
export function normalizeLocationPassword(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > LOCATION_LIMITS.maxCredentialChars || CONTROL.test(value)) return null;
  return value;
}

/** What a profile's proxy is (no label, no secret). */
export interface LocationProxy {
  readonly scheme: LocationProxyScheme;
  readonly host: string;
  readonly port: number;
}

/**
 * The partition's `proxyRules` (Chromium's URI format, one proxy for every URL scheme, no `direct://`
 * fallback): `<scheme>://<host>:<port>`. With no fallback, a proxy that cannot be reached fails the
 * request (`ERR_PROXY_CONNECTION_FAILED`); it never goes direct.
 */
export function proxyRulesFor(proxy: LocationProxy): string {
  const host = normalizeLocationHost(proxy.host);
  if (!isLocationProxyScheme(proxy.scheme) || host === null || !isLocationPort(proxy.port)) throw new TypeError('not a location proxy');
  return `${proxy.scheme}://${host}:${proxy.port}`;
}

/**
 * `host:port` as Electron's `login` event names a proxy (`authInfo.host`, `authInfo.port`): the host
 * lower-cased, an IPv6 literal without brackets. Compared with the profile's own to decide whether
 * to answer.
 */
export function proxyAuthKey(host: string, port: number): string {
  const bare = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return `${bare}:${port}`;
}

// ---- Capture refusal --------------------------------------------------------------------------

/**
 * Capture now and screenshots refuse on a location tab unless the page's search parameters carry
 * `location` (a result page the SERP service read): refusal `location-tab` (`CAPTURE_REFUSALS`,
 * `SCREENSHOT_REFUSALS`), with this message (Decision 11).
 */
export const LOCATION_TAB_REFUSAL_MESSAGE = 'This tab goes through a location proxy. Only its search result pages can be captured for now.' as const;

// ---- Database ---------------------------------------------------------------------------------

/** Migration `0244_location_profiles` creates exactly these tables. */
export const LOCATION_PROFILE_TABLES = ['location_profiles'] as const;
export const LOCATION_PROFILE_MIGRATION_IDS = ['0244_location_profiles'] as const;

// ---- UI ---------------------------------------------------------------------------------------

/**
 * The tab badge (`location-badge-always-visible`): on every location tab in the strip, active or
 * not, never shrunk or cut (the title is cut first); text only. There is no status-bar badge.
 */
export const LOCATION_BADGE = {
  /** The badge's visible text. */
  text: (label: string): string => label,
  /** Its accessible name and tooltip. */
  title: (label: string): string => `Location: ${label} (through your proxy; not in history)`,
} as const;

/** Labels of the schemes (text only). */
export const LOCATION_SCHEME_LABELS: Readonly<Record<LocationProxyScheme, string>> = {
  http: 'HTTP',
  https: 'HTTPS',
  socks5: 'SOCKS5',
};

/**
 * What is not proxied, said in Settings and the README (Decision 11; security review): Chromium's
 * implicit bypass (localhost, loopback and link-local addresses), frost's own fetches for a location
 * tab's audit and checks, a crawl, and "Open in" tools.
 */
export const LOCATION_NOT_PROXIED_NOTE =
  "Not proxied: pages on localhost, loopback and link-local addresses are reached directly, and frost's own requests for a location tab (robots.txt, the served HTML, probes, link, sitemap and hreflang checks, a site crawl) and \"Open in\" tools still go from your own connection." as const;

/** Permissions in a location tab (security review, lead ruling): said in Settings and the README. */
export const LOCATION_PERMISSIONS_NOTE = 'Location tabs never get your device location, and their permission answers are kept only until frost quits (they never use or change your other answers).' as const;

/** A sign-in on a plain `http` proxy travels unencrypted (security review). */
export const LOCATION_HTTP_SIGN_IN_NOTE = 'An HTTP proxy receives the username and password unencrypted. Use an HTTPS proxy when it needs a sign-in.' as const;

export const LOCATIONS_SETTINGS_TEXT = {
  intro: 'See search results from another place through your own proxy. Location tabs use a separate, temporary browsing session and are never kept in history.',
  notProxied: LOCATION_NOT_PROXIED_NOTE,
  permissions: LOCATION_PERMISSIONS_NOTE,
  httpSignIn: LOCATION_HTTP_SIGN_IN_NOTE,
  empty: 'No locations yet.',
  add: 'Add location',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  remove: 'Remove',
  removeQuestion: (label: string) => `Remove the location “${label}”? Its open tabs close.`,
  removeConfirm: 'Remove location',
  openTab: 'New tab',
  labelField: 'Name',
  schemeField: 'Proxy type',
  hostField: 'Host',
  portField: 'Port',
  usernameField: 'Username',
  passwordField: 'Password',
  credentialsSet: 'Sign-in saved',
  noCredentials: 'No sign-in',
  replacePlaceholder: 'Leave blank to keep',
  socksNoCredentials: 'SOCKS5 proxies cannot take a username and password.',
  editClosesTabs: 'Saving a change closes this location’s open tabs.',
  limit: `At most ${LOCATION_LIMITS.maxProfiles} locations.`,
  protection: {
    weak: 'No OS keychain is available, so a proxy sign-in cannot be saved.',
    unavailable: 'Encryption is unavailable here, so a proxy sign-in cannot be saved.',
  },
  results: {
    saved: 'Saved.',
    removed: 'Removed.',
    invalid: 'Check the name, host and port.',
    limit: `At most ${LOCATION_LIMITS.maxProfiles} locations.`,
    'no-keychain': 'No OS keychain is available, so the sign-in was not saved.',
    'socks-credentials': 'SOCKS5 proxies cannot take a username and password.',
    'not-found': 'That location no longer exists.',
    failed: 'Something went wrong. Try again.',
  },
} as const;

/** What saving or removing a profile answers (`location.create` / `update` / `remove`). */
export const LOCATION_WRITE_RESULTS = ['saved', 'removed', 'invalid', 'limit', 'no-keychain', 'socks-credentials', 'not-found', 'failed'] as const;
export type LocationWriteResult = (typeof LOCATION_WRITE_RESULTS)[number];

/** What "New tab in location" answers (`location.newTab`). */
export const LOCATION_NEW_TAB_RESULTS = ['opened', 'not-found', 'failed', 'no-window'] as const;
export type LocationNewTabResult = (typeof LOCATION_NEW_TAB_RESULTS)[number];

/** The command palette's entry (`location-palette.ts`): one action per profile. */
export const LOCATION_PALETTE = {
  group: 'New tab in location…',
  label: (label: string) => `New tab in location: ${label}`,
  manage: 'Manage locations',
} as const;

/** README "Locations" sections (`README.md`, `apps/desktop/README.md`) say at least these. */
export const LOCATION_README_FACTS = [
  'through your own proxy',
  'not kept in history',
  'localhost, loopback and link-local addresses',
  'still go from your own connection',
  'never get your device location',
  'an HTTPS proxy when it needs a sign-in',
] as const;
