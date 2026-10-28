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
 * - `maxMessageChars`: an error's message (after scrubbing) is cut to this;
 * - `maxTypeChars`: an error's type (its class name) is cut to this;
 * - `maxFrames`: stack frames kept per exception (the innermost);
 * - `maxExceptions`: exceptions kept per event (a cause chain);
 * - `maxFunctionChars`: a frame's function name is cut to this;
 * - `maxQueuedSpans`: spans waiting for export (more are dropped);
 * - `maxExportBatch`: spans per OTLP request;
 * - `exportDelayMs`: how long an ended span waits before its batch is exported;
 * - `maxQueuedEvents`: error envelopes waiting to be sent (more are dropped);
 * - `sendTimeoutMs`: one request's deadline (OTLP or Sentry).
 */
export const TELEMETRY_LIMITS = {
  maxSpanNameChars: 64,
  maxMessageChars: 1_024,
  maxTypeChars: 128,
  maxFrames: 50,
  maxExceptions: 5,
  maxFunctionChars: 128,
  maxQueuedSpans: 512,
  maxExportBatch: 128,
  exportDelayMs: 5_000,
  maxQueuedEvents: 30,
  sendTimeoutMs: 10_000,
} as const;

// ---- Scrubbing --------------------------------------------------------------------------------

export const SCRUB_RULE_IDS = [
  'auth-header',
  'secret-assignment',
  'jwt',
  'url',
  'email',
  'home-path',
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
/** Where a path or URL ends: whitespace, a quote, an angle bracket or a backtick. */
const STOP = '\\s"\'<>`';

/**
 * Applied in this order to every string that leaves (an error's message and type, a frame's
 * function and module, a token-kind span attribute). Every pattern is global and is only ever
 * used with `String.prototype.replace`. Earlier rules see the raw text: a bearer token or a JWT is
 * replaced before the URL or base64 rules could split it.
 * - `auth-header`: `Bearer|Basic|Token <credential>` (`bearer`, `basic` too; not `token`, an
 *   ordinary word in parser errors);
 * - `secret-assignment`: `password=…`, `token: …`, `api_key=…`, `authorization: …`, `cookie: …`;
 * - `jwt`: three dot-separated base64url parts starting `eyJ`;
 * - `url`: any `scheme://…` (`https:`, `app:`, `file:`, `chrome-extension:` …) and `data:`,
 *   `blob:`, `mailto:`, `javascript:`, `about:` URIs, whole;
 * - `email`: an address;
 * - `home-path`: a path in a home directory (`/home/x/…`, `/var/home/x/…`, `/Users/x/…`, `/root/…`,
 *   `C:\Users\x\…` with either slash, also JSON-escaped), whole;
 * - `uuid`: an RFC 9562 UUID (install IDs are often one);
 * - `ipv4`, `ipv6`: an address (IPv4 first, so a mapped `::ffff:a.b.c.d` loses its IPv4 part whole);
 * - `query-string`: `?key=value…` outside a URL;
 * - `hex-token`: 32 or more hex digits;
 * - `base64-token`: 32 or more base64(url) characters mixing digits, lower and upper case.
 */
export const SCRUB_RULES: readonly { readonly id: ScrubRuleId; readonly pattern: RegExp; readonly replacement: string }[] = [
  { id: 'auth-header', pattern: /\b(Bearer|bearer|Basic|basic|Token)\s+[A-Za-z0-9._~+/-]{8,}=*/g, replacement: '$1 [redacted]' },
  {
    id: 'secret-assignment',
    pattern: /\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    replacement: '$1$2[redacted]',
  },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, replacement: '[token]' },
  { id: 'url', pattern: new RegExp(`\\b(?:[a-z][a-z0-9+.-]*:\\/\\/|(?:data|blob|mailto|javascript|about):)[^${STOP}]*`, 'gi'), replacement: '[url]' },
  { id: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, replacement: '[email]' },
  {
    id: 'home-path',
    pattern: new RegExp(`(?:\\/(?:(?:var\\/)?home|Users|root)\\/|\\b[A-Za-z]:(?:\\\\{1,2}|\\/)Users(?:\\\\{1,2}|\\/))[^${STOP}]*`, 'gi'),
    replacement: '[path]',
  },
  { id: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '[id]' },
  { id: 'ipv4', pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g, replacement: '[ip]' },
  {
    id: 'ipv6',
    pattern: /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?:%[\w.-]+)?(?![\w:])/gi,
    replacement: '[ip]',
  },
  { id: 'query-string', pattern: new RegExp(`\\?[^${STOP}#]*=[^${STOP}#]*`, 'g'), replacement: '?[query]' },
  { id: 'hex-token', pattern: /\b[0-9a-f]{32,}\b/gi, replacement: '[token]' },
  { id: 'base64-token', pattern: new RegExp(`(?<!${B64})(?=${B64}*\\d)(?=${B64}*[a-z])(?=${B64}*[A-Z])${B64}{32,}={0,2}`, 'g'), replacement: '[token]' },
];

/**
 * Besides the patterns, the machine's host name and the user's login name are replaced wherever
 * they appear (when at least this long, so a one-letter name does not blank out text).
 */
export const MIN_LITERAL_REDACTION_CHARS = 3;
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

/** The fields a stack frame keeps (`filename` app-relative, `function` and `module` scrubbed). */
export const SENTRY_FRAME_KEYS = ['filename', 'function', 'module', 'lineno', 'colno', 'in_app'] as const;

/**
 * A frame's file inside the app (the app's root, an `app.asar`, or the `app://` scheme) becomes
 * `APP_FRAME_PREFIX` + its path in the app; one in `node_modules` keeps its path from there; one in
 * Node's internals (`node:`) is kept; any other file becomes its base name and any other URL `[url]`.
 */
export const APP_FRAME_PREFIX = 'app:///';

/** The only Sentry envelope item type ever sent (no sessions, client reports, attachments, spans or logs). */
export const SENTRY_ENVELOPE_ITEM_TYPES = ['event'] as const;
