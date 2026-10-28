/**
 * The update client (design doc §4 Phase 7: auto-update, signed and staged; Phase 7 Task 4): how
 * main finds the feed, checks it, and downloads and verifies an update the user asked for. The Zod
 * side (the prefs file) is `update-client.schema.ts`; acceptance `update-client.feature.md`; the
 * signed manifest itself is `update-manifest.spec.ts` (Task 3). Implemented by
 * `apps/desktop/src/main/update/` (`feed.ts`, `prefs.ts`, `fetch.ts`, `download.ts`, `client.ts`),
 * pure Node: the Electron objects (`net`, the update session) are injected by main (Task 5).
 *
 * Plain values and types with no imports, so the chrome can use them too.
 *
 * ## Consent and privacy
 * - With no feed configured the client is `disabled` and makes no request at all. No build ships a
 *   feed today (there is no hosting), so this is the state of every build, dev and tests included.
 * - `checks: 'off'` (the user's setting) stops the automatic checks. "Check now" is itself a user
 *   action, so it still checks once.
 * - Nothing is downloaded until the user asks (`download()`, from `available` only), and nothing is
 *   installed by the client at all: on every build today the user installs the verified file by
 *   hand (`install: 'manual'`).
 * - A feed or artifact request sends **only** the request line, `Host`, and
 *   `User-Agent: frost/<version> (update check)` (`updateUserAgent`): no cookies, no credentials,
 *   no referrer, no install ID, no other header frost adds. Main makes it through a dedicated
 *   in-memory session (`UPDATE_PARTITION`, nothing shared with browsing) whose `onBeforeSendHeaders`
 *   drops every other header the session would add (`UPDATE_ALLOWED_REQUEST_HEADERS`); the network
 *   stack below that still adds its own transport headers (`Connection`, `Accept-Encoding`), which
 *   carry nothing about the install. The install ID only seeds the on-device rollout bucket.
 *
 * ## What is trusted
 * Nothing from the feed until it verifies: the envelope's Ed25519 signature
 * (`verifyEnvelope`, Task 3), then the high-water mark (no replay of an older manifest), then
 * `decide`. The artifact is trusted only once its byte count equals the signed `size` and its
 * SHA-256 equals the signed `sha256`; until then it is a `.partial` file, deleted on any failure.
 *
 * ## The high-water mark
 * `UpdatePrefs.highWaterMark` is the highest verified manifest (`version`, then `releasedAt`). A
 * verified manifest below it, or at its version with an earlier `releasedAt`, is refused
 * (`older-than-seen`). The mark is raised after a check by every verified manifest `decide` does
 * **not** call `prerelease-ignored`: a release build never moves its mark for a pre-release it
 * would never be offered, so a verified `2.0.0-beta.1` can't make it refuse a later `1.5.0` hotfix
 * as a replay. (An install running a pre-release is offered pre-releases, so they raise its mark.)
 * Consequence, by design: **a pulled release can't be rolled back to an older version.** Once an
 * install has seen 1.3.0, re-publishing 1.2.x is refused as a replay; the fix for a bad release is
 * a higher version (e.g. 1.3.1).
 *
 * ## Addresses
 * `private-address.spec.ts` applies to the **resolved address of every connection**: the feed, the
 * artifact, and every redirect hop of either, each checked before that hop is requested (an IP
 * literal directly, a name by resolving it and refusing if any address is private). The only
 * exception is `http:` to a `UPDATE_LOOPBACK_HOSTS` literal in an unpackaged build (the tests'
 * fake feed), never reachable from an `https:` hop.
 */

// ---- Feed --------------------------------------------------------------------------------------

/** The environment variable naming the feed URL (any build). */
export const UPDATE_FEED_ENV = 'FROST_UPDATE_FEED_URL';

/** `--frost-update-feed=<url>`: the feed URL, read by unpackaged builds only (wins over the env). */
export const UPDATE_FEED_SWITCH = 'frost-update-feed';

/**
 * `--frost-update-public-key=<keyId>:<spki-base64>`: unpackaged builds only (Task 5 wires it and
 * a packaged build refuses to start with it). It **replaces** the trusted keys
 * (`UPDATE_PUBLIC_KEYS`) with exactly this one, for the e2e suite's fake feed. A malformed value
 * trusts no key at all (fail closed: nothing verifies).
 */
export const UPDATE_PUBLIC_KEY_SWITCH = 'frost-update-public-key';

/** A feed URL is at most this long. */
export const MAX_FEED_URL_CHARS = 2048;

/** The SPKI base64 in `UPDATE_PUBLIC_KEY_SWITCH` is at most this long (an Ed25519 SPKI is 60). */
export const MAX_SWITCH_KEY_CHARS = 256;

/**
 * The only `http:` hosts any request may use, and only in an unpackaged build (the tests' fake feed):
 * the loopback literals. Everything else, every hop, is `https:`.
 */
export const UPDATE_LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'] as const;

/**
 * Feed rules (`resolveFeed`): the URL is printable ASCII without spaces, at most
 * `MAX_FEED_URL_CHARS`, parses, has no user name or password, and is `https:` with a host, or (an
 * unpackaged build only) `http:` to a `UPDATE_LOOPBACK_HOSTS` literal. Anything else, or nothing
 * configured, is no feed (`disabled`).
 */
export const FEED_URL_CHARS_PATTERN = /^[\x21-\x7e]+$/;

// ---- Requests ----------------------------------------------------------------------------------

/** The in-memory session main makes update requests through (`session.fromPartition(UPDATE_PARTITION, { cache: false })`). */
export const UPDATE_PARTITION = 'frost-update';

/** The `User-Agent` of every update request: the running version, nothing else. */
export function updateUserAgent(currentVersion: string): string {
  return `frost/${currentVersion} (update check)`;
}

/** The only request header the update session lets through (lowercase); `User-Agent` is forced to `updateUserAgent`. */
export const UPDATE_ALLOWED_REQUEST_HEADERS = ['user-agent'] as const;

/**
 * Caps per request (`fetch.ts`):
 * - redirects: at most `maxRedirects` (one more is refused); each one is checked before it is
 *   followed: `https:` only (never down to `http:`), no user name or password, a public address;
 * - the body: the envelope at most `MAX_ENVELOPE_BYTES` (Task 3), the artifact exactly its signed
 *   `size` (at most `MAX_ARTIFACT_BYTES`), one byte more ends the request;
 * - time: `responseMs` from each hop's start to its response headers, `idleMs` without a body byte,
 *   and `totalMs` for the whole request.
 * A name is resolved before each `https:` hop and refused if any address is private
 * (`private-address.spec.ts`); IP literals are checked directly. As for the bounded fetcher, a name
 * whose answer changes between the check and the connection (DNS rebinding) is a known gap of
 * `net.request`, which cannot be pinned to the checked address; the signature and hash checks still
 * hold whatever the address.
 */
export const UPDATE_FETCH_LIMITS = {
  maxRedirects: 5,
  envelope: { responseMs: 15_000, idleMs: 15_000, totalMs: 60_000 },
  artifact: { responseMs: 30_000, idleMs: 60_000, totalMs: 2 * 60 * 60 * 1000 },
} as const;

// ---- Schedule ----------------------------------------------------------------------------------

/**
 * Automatic checks (only with a feed and `checks: 'on'`): the first `firstCheckMs` after start, then
 * every `intervalMs`, each delay scaled by a random factor in `1 ± jitter` so installs don't check
 * in step. "Check now" runs at most once per `manualMinIntervalMs` (counted from the last check of
 * any kind); a call sooner answers the current state.
 */
export const UPDATE_SCHEDULE = {
  firstCheckMs: 30_000,
  intervalMs: 6 * 60 * 60 * 1000,
  jitter: 0.1,
  manualMinIntervalMs: 60_000,
} as const;

/** `delay` scaled by `1 + jitter * (2 * random - 1)` (`random` in [0, 1)). */
export function jittered(delay: number, random: number, jitter: number = UPDATE_SCHEDULE.jitter): number {
  return Math.round(delay * (1 + jitter * (2 * random - 1)));
}

// ---- Files -------------------------------------------------------------------------------------

/** The prefs file in `userData` (mode 0600 on POSIX, written atomically). */
export const UPDATE_PREFS_FILE = 'frost-update.json';
/** A prefs file larger than this is invalid (reset to defaults). */
export const MAX_PREFS_BYTES = 4096;
/** `format` of the prefs file. */
export const UPDATE_PREFS_FORMAT = 1;

/**
 * Downloads go to `userData/<UPDATE_DOWNLOADS_DIR>/<version>/<artifactFileName(version, platformKey)>`,
 * first as that name plus `UPDATE_PARTIAL_SUFFIX`, renamed only once verified. Once one is ready,
 * every other entry in the downloads directory is removed; a check that finds nothing newer than the
 * running version removes them all.
 */
export const UPDATE_DOWNLOADS_DIR = 'updates';
export const UPDATE_PARTIAL_SUFFIX = '.partial';

// ---- Prefs -------------------------------------------------------------------------------------

export const UPDATE_CHECKS = ['on', 'off'] as const;
export type UpdateChecks = (typeof UPDATE_CHECKS)[number];

/** The prefs file's content (`UpdatePrefsSchema`). */
export interface UpdatePrefs {
  format: typeof UPDATE_PREFS_FORMAT;
  /** Random UUIDv4, created on first read. Local only: never sent; seeds the rollout bucket. */
  installId: string;
  /** Automatic checks (default `on`; with no feed the client is `disabled` anyway). */
  checks: UpdateChecks;
  /** "Skip this version": `decide` treats exactly this version as `skipped`. */
  skippedVersion?: string | undefined;
  /** The highest verified manifest so far (`UpdateHighWaterMark`, update-manifest.spec.ts). */
  highWaterMark?: { version: string; releasedAt: string } | undefined;
}

// ---- Install -----------------------------------------------------------------------------------

/**
 * How a ready update is installed:
 * - `restart`: Electron's `autoUpdater` applies it on restart. Only possible on a macOS build
 *   signed with an Apple Developer ID (Squirrel.Mac refuses anything else) or a Squirrel.Windows
 *   install fed a Squirrel `RELEASES` feed.
 * - `manual`: the user opens the verified file themselves ("Show file").
 *
 * **Every build today is `manual`.** frost has no Developer ID, and the feed publishes the
 * `Setup.exe`, not a `RELEASES` feed, so `autoUpdater` can apply nothing. `CURRENT_INSTALL_MODE` is
 * what main passes; `restart` stays unreachable until both of those exist.
 */
export const UPDATE_INSTALL_MODES = ['manual', 'restart'] as const;
export type UpdateInstallMode = (typeof UPDATE_INSTALL_MODES)[number];
export const CURRENT_INSTALL_MODE: UpdateInstallMode = 'manual';

// ---- State -------------------------------------------------------------------------------------

/** The client's states (`UpdateStatus['kind']`). */
export const UPDATE_STATUS_KINDS = ['disabled', 'off', 'idle', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'error'] as const;
export type UpdateStatusKind = (typeof UPDATE_STATUS_KINDS)[number];

/**
 * Why the last step failed (a closed list; the chrome shows it):
 * - `feed-unreachable`: the feed did not answer 200 (network error, timeout, a status, a bad or
 *   missing `Location`, too many redirects);
 * - `feed-too-large`: the feed's body is over `MAX_ENVELOPE_BYTES`;
 * - `bad-envelope`: `verifyEnvelope` refused it (any reason but freshness);
 * - `stale`: the signed manifest has expired or is not yet valid (`expired`, `not-yet-valid`),
 *   at the check or again just before the download;
 * - `older-than-seen`: a verified manifest older than the high-water mark (a replay);
 * - `download-failed`: the artifact did not arrive (network error, timeout, a status, a bad
 *   redirect, too many redirects);
 * - `too-large`: the artifact is longer than its signed `size`;
 * - `size-mismatch`: it ended short of its signed `size`;
 * - `hash-mismatch`: its SHA-256 is not the signed one (the file is deleted);
 * - `insecure-redirect`: a redirect (or the URL itself) leaves `https:`;
 * - `private-address`: a hop's host is, or resolves to, a private address;
 * - `disk`: the file or the prefs could not be written;
 * - `internal`: anything else thrown (e.g. a running version that is not semver).
 */
export const UPDATE_ERROR_REASONS = [
  'feed-unreachable',
  'feed-too-large',
  'bad-envelope',
  'stale',
  'older-than-seen',
  'download-failed',
  'too-large',
  'hash-mismatch',
  'size-mismatch',
  'insecure-redirect',
  'private-address',
  'disk',
  'internal',
] as const;
export type UpdateErrorReason = (typeof UPDATE_ERROR_REASONS)[number];

/** Where the client is. Nothing here is a path: the verified file's path stays in main (`readyFile()`). */
export type UpdateStatus =
  | { readonly kind: 'disabled' | 'off' | 'idle' | 'checking' | 'up-to-date' }
  | {
      readonly kind: 'available';
      readonly version: string;
      readonly notes: string;
      readonly releasedAt: string;
      /** The running version is below the manifest's `minimumVersion`: no "Skip this version". */
      readonly required: boolean;
      /** The artifact's signed size in bytes. */
      readonly size: number;
    }
  | { readonly kind: 'downloading'; readonly version: string; readonly bytes: number; readonly total: number }
  | {
      readonly kind: 'ready';
      readonly version: string;
      readonly install: UpdateInstallMode;
      /** The verified file's name (`artifactFileName`), for the "install it by hand" text. Not a path. */
      readonly fileName: string;
    }
  | {
      readonly kind: 'error';
      readonly reason: UpdateErrorReason;
      /** The offered version, when a download failed. */
      readonly version?: string;
    };

/** What the chrome sees (`update.watch`, Task 5). */
export interface UpdateState {
  /** Advances by one on every change (the long-poll counter, like `BrowserState.version`). */
  readonly version: number;
  /** The running app's version. */
  readonly currentVersion: string;
  /** The user's setting. */
  readonly checks: UpdateChecks;
  /** When the last check finished (ISO 8601), `null` before the first. */
  readonly lastCheckedAt: string | null;
  readonly status: UpdateStatus;
}

/** At most this many `watch` calls wait; one more answers the oldest at once with the current state. */
export const MAX_PENDING_UPDATE_WATCHES = 4;

/** `downloading` advances the state version at most this many times per download (plus the start). */
export const UPDATE_PROGRESS_STEPS = 100;
