/**
 * Consent-gated telemetry (Phase 4 Task 6; acceptance `telemetry.feature.md`; review focus
 * "Telemetry UI matches behaviour": `nothing-sent-before-consent`, `off-stops-export-immediately`,
 * `events-are-scrubbed`). `@app/telemetry` puts a consent gate in front of two channels:
 * - `usage`: OpenTelemetry traces, exported as OTLP/HTTP JSON;
 * - `errors`: Sentry error events, sent as Sentry envelopes.
 *
 * Both default to off, and nothing leaves the machine before the user turns a channel on. Turning a
 * channel off drops whatever it has queued and stops its export at once (no final flush). Telemetry
 * has no persistent identifier: no install ID, user ID, machine name or IP. A span carries only
 * `SPAN_ATTRIBUTE_ALLOWLIST` attributes; every string that leaves goes through `SCRUB_RULES`.
 *
 * Clean-room: the rules, limits and wording are frost's own, from the OTLP/HTTP specification
 * (opentelemetry.io), Sentry's public envelope and event payload documentation, and the formats
 * the patterns match (RFC 3986 URIs, RFC 5322 addresses, RFC 4291 IPv6, RFC 7519 JWTs, RFC 6750
 * bearer tokens).
 *
 * Plain values plus one Zod schema (`TelemetryConsentSchema`); later phases add their span attribute
 * keys to `SPAN_ATTRIBUTE_ALLOWLIST` (the only keys that are ever exported).
 */
import { z } from 'zod';
import { SEO_PANELS } from './seo-sidebar.spec';

// ---- Channels and consent ---------------------------------------------------------------------

/** The two things a user can consent to, each its own toggle. */
export const TELEMETRY_CHANNELS = ['usage', 'errors'] as const;
export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[number];

/** What each channel is: `usage` is OpenTelemetry traces, `errors` is Sentry error events. */
export const TELEMETRY_CHANNEL_BACKENDS = {
  usage: 'opentelemetry-traces',
  errors: 'sentry-errors',
} as const satisfies Record<TelemetryChannel, string>;

/** Consent per channel. Stored by main (Task 7) and checked again at every send. */
export const TelemetryConsentSchema = z.strictObject({
  usage: z.boolean(),
  errors: z.boolean(),
});
export type TelemetryConsent = z.infer<typeof TelemetryConsentSchema>;

/** Telemetry defaults off: nothing is sent until the user turns a channel on. */
export const DEFAULT_CONSENT: Readonly<TelemetryConsent> = Object.freeze({ usage: false, errors: false });

// ---- Resource ---------------------------------------------------------------------------------

/** The OpenTelemetry `service.name` of every span. */
export const TELEMETRY_SERVICE_NAME = 'frost';

/**
 * The only resource attributes a trace export carries: the service's name and version and the
 * operating system's family. No host name, user, machine or install ID, process command line or pid:
 * the SDK's resource detectors are never run.
 */
export const RESOURCE_ATTRIBUTE_KEYS = ['service.name', 'service.version', 'os.type'] as const;

/** Resource attribute namespaces that identify a machine, a person or a process: never exported. */
export const FORBIDDEN_RESOURCE_PREFIXES = ['host.', 'process.', 'user.', 'enduser.', 'device.', 'service.instance.', 'container.', 'k8s.', 'cloud.'] as const;

/** Node's `process.platform` values frost ships for, and the OTel `os.type` each maps to (anything else is `other`). */
export const TELEMETRY_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number];
export const OS_TYPE_BY_PLATFORM = { darwin: 'darwin', linux: 'linux', win32: 'windows' } as const satisfies Record<TelemetryPlatform, string>;

// ---- Span attributes --------------------------------------------------------------------------

/**
 * How an allowlisted attribute's value is checked; a value that does not pass is dropped (never
 * coerced or sent in part):
 * - `boolean`;
 * - `int` / `number`: a finite number in `[min, max]` (`int`: a safe integer);
 * - `enum`: one of `values`;
 * - `token`: a short string that, after scrubbing (`SCRUB_RULES`) and capping to `maxChars`,
 *   matches `pattern` (anchored, no spaces: never free text).
 */
export type SpanAttributeRule =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'int' | 'number'; readonly min: number; readonly max: number }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'token'; readonly pattern: RegExp; readonly maxChars: number };

/** A lowercase identifier: a command ID, an error code. */
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
/** A release version: `1.2.3` or `1.2.3-beta.1`. */
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,24})?$/;

/**
 * The only span attributes that are ever exported, and what their values may be. Keep it small;
 * a phase that needs a key adds it here (with the narrowest rule that serves it).
 * - `duration_ms`: how long something took, up to a day;
 * - `rule_count`: how many SEO rules ran;
 * - `outcome`: how the operation ended;
 * - `panel`: a SEO rail panel (`SEO_PANELS`);
 * - `platform`: Node's `process.platform`;
 * - `app.version`: frost's version;
 * - `command`: a command palette command ID;
 * - `cached`: whether an answer came from a cache.
 */
export const SPAN_ATTRIBUTE_ALLOWLIST = {
  duration_ms: { kind: 'number', min: 0, max: 86_400_000 },
  rule_count: { kind: 'int', min: 0, max: 10_000 },
  outcome: { kind: 'enum', values: ['ok', 'error', 'cancelled', 'timeout', 'unavailable'] },
  panel: { kind: 'enum', values: SEO_PANELS.map((panel) => panel.id) },
  platform: { kind: 'enum', values: TELEMETRY_PLATFORMS },
  'app.version': { kind: 'token', pattern: VERSION_PATTERN, maxChars: 40 },
  command: { kind: 'token', pattern: TOKEN_PATTERN, maxChars: 48 },
  cached: { kind: 'boolean' },
} as const satisfies Record<string, SpanAttributeRule>;
export type SpanAttributeKey = keyof typeof SPAN_ATTRIBUTE_ALLOWLIST;

/**
 * A span's name: a fixed, dotted identifier chosen in code (`app.start`, `seo.audit`), never built
 * from data. A name that does not match is exported as `SPAN_NAME_FALLBACK`.
 */
export const SPAN_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,5}$/;
export const SPAN_NAME_FALLBACK = 'span';

// ---- Limits -----------------------------------------------------------------------------------

/**
 * - `maxSpanNameChars`: a longer name is `SPAN_NAME_FALLBACK`;
 * - `maxScrubInputChars`: a string is cut to this before it is scrubbed (the partial token at the
 *   cut is dropped), so the patterns only ever see bounded text; what is scrubbed is capped again to
 *   its own limit below;
 * - `maxMessageChars`: an error's message (after scrubbing) is cut to this;
 * - `maxTypeChars`: an error's type (its class name) is cut to this;
 * - `maxFrames`: stack frames kept per exception (the innermost);
 * - `maxExceptions`: exceptions kept per event (a cause chain);
 * - `maxFunctionChars`: a frame's function name (and module) is cut to this;
 * - `maxFilenameChars`: a frame's file (after `appRelativeFilename`) is cut to this;
 * - `maxQueuedSpans`: spans waiting for export (more are dropped);
 * - `maxExportBatch`: spans per OTLP request;
 * - `exportDelayMs`: how long an ended span waits before its batch is exported (`createTelemetry`
 *   takes another one, `otel.exportDelayMs`, an integer up to `maxExportDelayMs`, for tests only;
 *   anything else is this);
 * - `maxExportDelayMs`: the longest such delay;
 * - `maxQueuedEvents`: error envelopes waiting to be sent (more are dropped);
 * - `sendTimeoutMs`: one request's deadline (OTLP or Sentry);
 * - `flushTimeoutMs`: `flush()`'s deadline when the caller gives none;
 * - `shutdownTimeoutMs`: `shutdown()`'s deadline when the caller gives none (quitting must not hang
 *   on an unreachable collector); at the deadline whatever is still queued or in flight is dropped.
 */
export const TELEMETRY_LIMITS = {
  maxSpanNameChars: 64,
  maxScrubInputChars: 16_384,
  maxMessageChars: 1_024,
  maxTypeChars: 128,
  maxFrames: 50,
  maxExceptions: 5,
  maxFunctionChars: 128,
  maxFilenameChars: 256,
  maxQueuedSpans: 512,
  maxExportBatch: 128,
  exportDelayMs: 5_000,
  maxExportDelayMs: 600_000,
  maxQueuedEvents: 30,
  sendTimeoutMs: 10_000,
  flushTimeoutMs: 10_000,
  shutdownTimeoutMs: 2_000,
} as const;

// ---- Scrubbing --------------------------------------------------------------------------------

export const SCRUB_RULE_IDS = [
  'desktop-token',
  'google-access-token',
  'google-refresh-token',
  'google-auth-code',
  'google-client-secret',
  'pkce-code',
  'auth-header',
  'secret-assignment',
  'jwt',
  'url',
  'email',
  'home-path',
  'abs-path',
  'host',
  'uuid',
  'ipv4',
  'ipv6',
  'query-string',
  'hex-token',
  'base64-token',
] as const;
export type ScrubRuleId = (typeof SCRUB_RULE_IDS)[number];

/** A run of base64 or base64url characters (the base64-token rule's alphabet). */
const B64 = '[A-Za-z0-9+/_-]';
/** Where a URL or a host's path ends: whitespace, a quote, an angle bracket or a backtick. */
const STOP = '\\s"\'<>`';
/** Where an absolute path ends: a quote, an angle bracket, a backtick or the line's end (folder names have spaces). */
const PATH_STOP = '\\r\\n"\'<>`';
/** One path segment (no whitespace, slash or backslash). */
const SEGMENT = `[^${STOP}/\\\\]+`;

/**
 * File extensions that are never a host's top-level label, so `index.ts`, `main.cjs`,
 * `seo-analysis.cjs`, `vendor.min.js` or `app.asar` are not host names. Two-letter extensions
 * that are also country-code TLDs (`md`, `rs`, `sh`, `py` …) are left out on purpose: a host in
 * such a TLD is scrubbed, and a file with such an extension then reads `[host]`.
 */
export const HOST_FILE_EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'json5', 'map', 'node', 'wasm', 'asar',
  'html', 'htm', 'css', 'scss', 'less', 'mdx', 'txt', 'log', 'csv', 'tsv', 'pdf', 'png', 'jpg', 'jpeg',
  'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'db', 'sqlite', 'sqlite3', 'lock', 'yml', 'yaml', 'toml',
  'xml', 'ini', 'conf', 'cfg', 'env', 'bash', 'zsh', 'bat', 'cmd', 'rb', 'go', 'java', 'kt', 'swift',
  'cpp', 'hpp', 'php', 'dll', 'dylib', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'zip', 'gz', 'tgz',
  'tar', 'bz2', 'xz', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'mp3', 'mp4', 'mov',
  'wav', 'webm', 'ogg', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'bak', 'tmp', 'old', 'plist', 'icns',
] as const;

/**
 * The top-level labels that make a name with a single dot a host (`client-site.com`,
 * `acme-intranet.corp`); any two-letter label (a country code) does too. A single-dot name with
 * another label (`page.reload`, `console.log`, `net.fetch`) is an identifier, not a host: frost's
 * command IDs and code names look like that. A name with two or more dots is a host whatever its
 * last label (unless it is a `HOST_FILE_EXTENSIONS` one).
 */
export const ONE_DOT_HOST_TLDS = [
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'info', 'biz', 'pro', 'mobi', 'app', 'dev', 'xyz', 'site',
  'online', 'shop', 'tech', 'cloud', 'blog', 'agency', 'studio', 'digital', 'solutions', 'company',
  'consulting', 'law', 'corp', 'local', 'internal', 'lan', 'home', 'intranet', 'localdomain', 'localhost',
  'test', 'example', 'invalid', 'onion', 'arpa',
] as const;

const LABEL = '[a-z0-9-]{1,63}';
/** Not a file extension (checked where the top-level label starts). */
const NOT_EXTENSION = `(?!(?:${HOST_FILE_EXTENSIONS.join('|')})(?![a-z0-9-]))`;
/** A host's last label ends here: not followed by more of a name, nor by `.` and more of one. */
const HOST_END = '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])';

/**
 * Applied in this order to every string that leaves (an error's message and type, a frame's
 * function, module and file, a token-kind span attribute). Every pattern is global and is only
 * ever used with `String.prototype.replace`. Earlier rules see the raw text: a bearer token or a JWT
 * is replaced before the URL or base64 rules could split it, an address before the host rule.
 *
 * Every pattern runs in time linear in its input: a pattern that scans a run of characters only
 * starts where that run starts (a lookbehind), and the text is cut to
 * `TELEMETRY_LIMITS.maxScrubInputChars` first anyway.
 *
 * First, the token shapes frost and Search Console handle, whole, whatever their letters (the
 * generic `base64-token` rule needs digits and both cases, which some random values lack):
 * - `desktop-token`: frost's desktop token, `frost_dt_…`;
 * - `google-access-token`: an OAuth access token as Google issues it, `ya29.…`;
 * - `google-refresh-token`: a Google refresh token, `1//…` (20 or more characters after it);
 * - `google-auth-code`: a Google authorization code, `4/0…` (20 or more characters after it);
 * - `google-client-secret`: an installed app's client secret, `GOCSPX-…`;
 * - `pkce-code`: a PKCE verifier or a code (43 or more unreserved characters, RFC 7636) after
 *   `code=`, `code: ` or `code_verifier=` (also quoted, as in JSON); a short value (`code=1`) is an
 *   exit or error code and is kept.
 *
 * Then the generic rules:
 * - `auth-header`: `Bearer|Basic|Token <credential>` (`bearer`, `basic` too; not `token`, an
 *   ordinary word in parser errors);
 * - `secret-assignment`: `password=…`, `pwd: …`, `passphrase=…`, `token: …`, `api_key=…`,
 *   `authorization: …`, `cookie: …`, `sid=…`, `session=…`; a quoted value is replaced whole
 *   (`password="hunter two"`);
 * - `jwt`: three dot-separated base64url parts starting `eyJ`;
 * - `url`: any `scheme://…` (`https:`, `app:`, `file:`, `chrome-extension:` …) and `data:`,
 *   `blob:`, `mailto:`, `javascript:`, `about:` URIs, whole;
 * - `email`: an address;
 * - `home-path`: a path in a home directory (`~/…`, `/home/x/…`, `/var/home/x/…`, `/Users/x/…`,
 *   `/root/…`, `C:\Users\x\…` with either slash, also JSON-escaped), to the end of the path (spaces
 *   included: up to a quote, an angle bracket, a backtick or the line's end);
 * - `abs-path`: any other absolute path, the same way: a drive letter (`D:\…`, `D:/…`), a UNC path
 *   (`\\server\share\…`), or a `/`-rooted path of two or more segments (`/mnt/data/…`,
 *   `/Volumes/…`, `/run/media/…`). Relative paths (`out/main/index.js`, `./x/y`) and one segment
 *   (`/tmp`) are kept;
 * - `host`: a lower-case host name, as Node and Chromium print them in DNS and TLS errors
 *   (`getaddrinfo ENOTFOUND client-site.com`, `Host: acme-intranet.corp. is not in the cert's
 *   altnames`), with its port and path (`www.example.com/alice/profile`): two or more dots, or one dot
 *   and a `ONE_DOT_HOST_TLDS` (or two-letter) last label; never a `HOST_FILE_EXTENSIONS` last label.
 *   Mixed-case names (`Server.emit`, `Object.loadPage`) are code, not hosts;
 * - `uuid`: an RFC 9562 UUID (install IDs are often one);
 * - `ipv4`, `ipv6`: an address (IPv4 first, so a mapped `::ffff:a.b.c.d` loses its IPv4 part whole);
 * - `query-string`: `?key=value…` outside a URL;
 * - `hex-token`: 32 or more hex digits;
 * - `base64-token`: 32 or more base64(url) characters mixing digits, lower and upper case.
 */
export const SCRUB_RULES: readonly { readonly id: ScrubRuleId; readonly pattern: RegExp; readonly replacement: string }[] = [
  { id: 'desktop-token', pattern: /(?<![A-Za-z0-9_-])frost_dt_[A-Za-z0-9_-]*/g, replacement: '[token]' },
  { id: 'google-access-token', pattern: /(?<![A-Za-z0-9._~+/-])ya29\.[A-Za-z0-9._~+/-]*/g, replacement: '[token]' },
  { id: 'google-refresh-token', pattern: /(?<![A-Za-z0-9._~+/:-])1\/\/[A-Za-z0-9_-]{20}[A-Za-z0-9._~+/-]*/g, replacement: '[token]' },
  { id: 'google-auth-code', pattern: /(?<![A-Za-z0-9._~+/:-])4\/0[A-Za-z0-9_-]{20}[A-Za-z0-9._~+/-]*/g, replacement: '[token]' },
  { id: 'google-client-secret', pattern: /(?<![A-Za-z0-9_-])GOCSPX-[A-Za-z0-9_-]*/g, replacement: '[token]' },
  { id: 'pkce-code', pattern: /(?<![A-Za-z0-9_-])(code(?:_verifier)?)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~-]{43,}/gi, replacement: '$1$2[redacted]' },
  { id: 'auth-header', pattern: /\b(Bearer|bearer|Basic|basic|Token)\s+[A-Za-z0-9._~+/-]{8,}=*/g, replacement: '$1 [redacted]' },
  {
    id: 'secret-assignment',
    pattern:
      /\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session(?:[_-]?id)?|sid)(["']?\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\\\r\n]|\\.)*'?|[^\s"',;&]+)/gi,
    replacement: '$1$2[redacted]',
  },
  { id: 'jwt', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, replacement: '[token]' },
  { id: 'url', pattern: new RegExp(`(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\\/\\/|(?:data|blob|mailto|javascript|about):)[^${STOP}]*`, 'gi'), replacement: '[url]' },
  { id: 'email', pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){0,126}\.[A-Za-z]{2,}/g, replacement: '[email]' },
  {
    id: 'home-path',
    pattern: new RegExp(`(?:(?<![\\w~])~\\/|\\/(?:(?:var\\/)?home|Users|root)\\/|(?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\{1,2}|\\/)Users(?:\\\\{1,2}|\\/))[^${PATH_STOP}]*`, 'gi'),
    replacement: '[path]',
  },
  {
    id: 'abs-path',
    pattern: new RegExp(
      `(?:(?<![\\w.~%+@:/\\\\-])\\/\\/?${SEGMENT}\\/|(?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\{1,2}|\\/)|(?<![\\w\\\\])\\\\{2}(?:\\\\{2})?${SEGMENT}\\\\{1,2})[^${PATH_STOP}]*`,
      'g',
    ),
    replacement: '[path]',
  },
  {
    id: 'host',
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.@%+-])(?:(?:${LABEL}\\.){2,126}${NOT_EXTENSION}[a-z]{2,63}|${LABEL}\\.${NOT_EXTENSION}(?:${ONE_DOT_HOST_TLDS.join('|')}|[a-z]{2}))${HOST_END}(?::\\d{1,5})?(?:[/?#][^${STOP}]*)?`,
      'g',
    ),
    replacement: '[host]',
  },
  { id: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[id]' },
  { id: 'ipv4', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replacement: '[ip]' },
  {
    id: 'ipv6',
    pattern: /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?:%[\w.-]+)?(?![\w:])/gi,
    replacement: '[ip]',
  },
  { id: 'query-string', pattern: new RegExp(`\\?[^${STOP}#=?]*=[^${STOP}#]*`, 'g'), replacement: '?[query]' },
  { id: 'hex-token', pattern: /\b[0-9a-f]{32,}\b/gi, replacement: '[token]' },
  { id: 'base64-token', pattern: new RegExp(`(?<!${B64})(?=${B64}*\\d)(?=${B64}*[a-z])(?=${B64}*[A-Z])${B64}{32,}={0,2}`, 'g'), replacement: '[token]' },
];

/**
 * Besides the patterns, the machine's host name (and its first label: `Alices-Laptop.local` and
 * `Alices-Laptop`) and the user's login name are replaced wherever they appear, case-insensitively,
 * when at least `MIN_LITERAL_REDACTION_CHARS` long (so a one-letter name does not blank out text).
 * One shorter than `MIN_UNBOUNDED_LITERAL_CHARS` is only replaced as a whole word (not next to a
 * letter or digit), so a login `ann` leaves `Cannot` alone.
 */
export const MIN_LITERAL_REDACTION_CHARS = 3;
export const MIN_UNBOUNDED_LITERAL_CHARS = 8;
export const LITERAL_REDACTION = '[redacted]';

// ---- Error events -----------------------------------------------------------------------------

/**
 * The only top-level fields an error event keeps (everything else is never sent: `request`,
 * `user`, `server_name`, `extra`, `breadcrumbs`, `tags`, `modules`, `debug_meta`, `transaction`,
 * `threads`, `spans`, `sdk` …). `exception` and `contexts` are rebuilt from their allowlists.
 */
export const SENTRY_EVENT_KEYS = ['event_id', 'timestamp', 'platform', 'level', 'release', 'environment', 'message', 'exception', 'contexts'] as const;

/** The contexts an error event keeps, and their fields. */
export const SENTRY_CONTEXT_ALLOWLIST = {
  os: ['name'],
  runtime: ['name', 'version'],
  app: ['app_version'],
} as const;

/** The fields a stack frame keeps (`filename` app-relative, `function` and `module` scrubbed; all capped). */
export const SENTRY_FRAME_KEYS = ['filename', 'function', 'module', 'lineno', 'colno', 'in_app'] as const;

/**
 * A frame's file inside the app (the app's root, an `app.asar`, or the `app://` scheme) becomes
 * `APP_FRAME_PREFIX` + its path in the app; one in `node_modules` keeps its path from there; one in
 * Node's internals (`node:`) is kept; any other file becomes its base name and any other URL `[url]`.
 */
export const APP_FRAME_PREFIX = 'app:///';

/**
 * The only Sentry envelope item type ever sent (no sessions, client reports, attachments, spans or
 * logs), and only an event the channel rebuilt itself (Sentry skips `beforeSend` for its own
 * internal errors; such an event is dropped at the transport).
 */
export const SENTRY_ENVELOPE_ITEM_TYPES = ['event'] as const;
