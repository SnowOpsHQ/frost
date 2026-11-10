/**
 * Export Diagnostics (Phase 11 Task 12, SL-125; plan Decision 14 and Global constraints, Secrets:
 * "Diagnostics carry no URL at all"; acceptance `diagnostics.feature.md`). Help › Export Diagnostics…
 * shows a plain-text report in a Help sheet for review; Save… writes exactly that report, from main's
 * own copy, through main's own save dialog. Nothing is ever sent anywhere.
 *
 * The report holds versions, the platform, whether the build is packaged, the applied migration ids,
 * feature booleans (configured or on, never a value) and a bounded ring of main's **own** warnings and
 * errors. Every ring line is scrubbed when it enters the ring (the raw text is never kept), with
 * telemetry's scrubber (`SCRUB_RULES` in `telemetry-privacy.spec.ts`, with the machine's host and user
 * names and this profile's folders as literals) and then `DIAGNOSTICS_SCRUB_RULES` below; every line of
 * the built report is scrubbed again the same way. What must never be in a report is
 * `DIAGNOSTICS_FORBIDDEN` (one test per class).
 *
 * The SL-125 "copy installation ID" part is dropped (Decision 16): frost keeps no install ID.
 *
 * Plain values with no Zod, so the chrome renderer can use the text (its strict Trusted Types CSP
 * blocks Zod's eval probe). The procedures' schemas are in `whats-new.schema.ts` with the other
 * `help.*` schemas. Clean-room: frost's own words and rules.
 */

// ---- The log ring ---------------------------------------------------------------------------------

/**
 * Main's own warnings and errors (`console.warn` / `console.error`, which every main logger in frost
 * calls; Node prints process warnings through them too, among them telemetry's re-emitted unhandled
 * rejections: `process.emitWarning(reason, 'UnhandledPromiseRejectionWarning')`, the reason's stack or
 * text), the newest `maxLines` lines, each line's text cut to `maxLineChars` after scrubbing. A
 * message of several lines (a stack trace) takes one ring line per non-empty line. `console.log`,
 * `info` and `debug` are not kept, and nothing from a page is ever added (page console messages stay in
 * the devtools drawer's own per-tab log, `devtools.spec.ts`).
 */
export const DIAGNOSTICS_LOG_RING = { maxLines: 500, maxLineChars: 500 } as const;

/** The two console levels the ring keeps. */
export const DIAGNOSTICS_LOG_LEVELS = ['warn', 'error'] as const;
export type DiagnosticsLogLevel = (typeof DIAGNOSTICS_LOG_LEVELS)[number];

/**
 * - `maxMessageChars`: one console call's text is cut to this before it is scrubbed (each argument
 *   too, before it is formatted), back to the last separator so no half token is left;
 * - `maxInspectDepth` / `maxInspectArrayLength` / `maxInspectStringChars`: how far an object argument
 *   is formatted (`util.inspect`), so formatting stays small and quick; where inspect cuts a string
 *   (`'…'... N more characters`), the token the cut went through is dropped before scrubbing (it may
 *   be half a secret). An `Error` argument is written as `name: message`, its stack frames and an Error
 *   cause's `name: message` only, never its own properties (`body`, `response` …);
 * - `maxReportChars`: the longest report (the ring's lines and the header fit well inside);
 * - `maxKeptReports`: reports main keeps to save (the oldest is forgotten first; saving a forgotten one
 *   answers `stale`);
 * - `maxMigrationIds`: migration ids listed (each must match `DIAGNOSTICS_MIGRATION_ID_PATTERN`);
 * - `maxValueChars`: a version, platform or release value (each must match `DIAGNOSTICS_VALUE_PATTERN`,
 *   else it reads `unknown`).
 */
export const DIAGNOSTICS_LIMITS = {
  maxMessageChars: 4_000,
  maxInspectDepth: 2,
  maxInspectArrayLength: 20,
  maxInspectStringChars: 4_000,
  maxReportChars: 300_000,
  maxKeptReports: 4,
  maxMigrationIds: 256,
  maxValueChars: 64,
} as const;

/** A version, platform, architecture or OS release as the report prints it; anything else is `unknown`. */
export const DIAGNOSTICS_VALUE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A migration id as `packages/db` writes them (`0230_agent_chat_lifecycle`); others are left out. */
export const DIAGNOSTICS_MIGRATION_ID_PATTERN = /^\d{4}_[a-z0-9_]{1,80}$/;

// ---- The report's fields ----------------------------------------------------------------------------

/** The report's fields, in order, and their labels. Nothing else is in a report. */
export const DIAGNOSTICS_FIELDS = [
  { id: 'app', label: 'frost' },
  { id: 'electron', label: 'Electron' },
  { id: 'chromium', label: 'Chromium' },
  { id: 'node', label: 'Node' },
  { id: 'platform', label: 'Platform' },
  { id: 'arch', label: 'Architecture' },
  { id: 'os-release', label: 'OS release' },
  { id: 'packaged', label: 'Packaged build' },
  { id: 'migrations', label: 'Database migrations applied' },
  { id: 'features', label: 'Features' },
  { id: 'log', label: 'Main process warnings and errors' },
] as const;
export type DiagnosticsFieldId = (typeof DIAGNOSTICS_FIELDS)[number]['id'];

/**
 * The feature booleans (configured or turned on; never a value, an account, a key or an address).
 * Each reads `yes`, `no` or `unknown` (it could not be read).
 */
export const DIAGNOSTICS_FEATURES = [
  { id: 'database-on-disk', label: 'Session database on disk' },
  { id: 'telemetry-usage-configured', label: 'Usage telemetry configured in this build' },
  { id: 'telemetry-usage-on', label: 'Usage telemetry turned on' },
  { id: 'telemetry-errors-configured', label: 'Error reports configured in this build' },
  { id: 'telemetry-errors-on', label: 'Error reports turned on' },
  { id: 'agent-ready', label: 'AI agent set up' },
  { id: 'search-console-configured', label: 'Search Console configured in this build' },
  { id: 'search-console-connected', label: 'Search Console connected' },
  { id: 'sync-running', label: 'Sync running' },
] as const;
export type DiagnosticsFeatureId = (typeof DIAGNOSTICS_FEATURES)[number]['id'];

/** The report's first lines (no slash, at sign or address in them: they are scrubbed like the rest). */
export const DIAGNOSTICS_REPORT_HEADER = [
  'frost diagnostics report',
  'Made on this computer for a bug report. frost has not sent it anywhere.',
  'Left out on purpose: web addresses, page content, email addresses, file paths, keys and tokens, IP addresses, and this computer’s host and user names. Where a log line had one, it reads [url], [path], [email], [token], [key], [ip], [host] or [redacted].',
] as const;

// ---- What a report never holds --------------------------------------------------------------------

/**
 * The forbidden contents, one class each, with realistic lines that carry them (`examples`: the line
 * and the parts that must be gone from the report). `detect` finds the class in a report; a report
 * built from every example matches none. `report.test.ts` has one test per class.
 *
 * Page text has no pattern: it is kept out at the source (the ring wraps only main's own
 * `console.warn` / `console.error`; nothing listens to a page's `console-message`).
 *
 * Known limit: free text with no recognisable shape (a name, a sentence a page or a server wrote into
 * an error message or an unhandled rejection's reason) cannot be told apart by a pattern. That is why
 * the report is shown for review before it is saved.
 */
export interface DiagnosticsForbiddenClass {
  readonly id: string;
  readonly label: string;
  readonly examples: readonly { readonly line: string; readonly gone: readonly string[] }[];
  readonly detect: RegExp | null;
}

export const DIAGNOSTICS_FORBIDDEN: readonly DiagnosticsForbiddenClass[] = [
  {
    id: 'url',
    label: 'URLs of any scheme, and bare www. or host-with-path addresses',
    examples: [
      { line: 'fetch failed for https://shop.example.com/cart?session=a1b2c3&token=xyz789 (net::ERR_FAILED)', gone: ['https', 'shop.example.com', 'cart', 'a1b2c3', 'xyz789'] },
      { line: 'navigation to HTTP://Client-Site.COM:8080/Landing was refused', gone: ['HTTP', 'Client-Site', 'Landing'] },
      { line: 'renderer loaded app://app/index.html#settings', gone: ['app://', 'index.html'] },
      { line: 'image data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB failed to decode', gone: ['data:', 'iVBORw0KGgo'] },
      { line: 'worker blob:https://x.example/0b5e1f7a-1b2c-4d3e-8f90-123456789abc ended', gone: ['blob:', 'x.example'] },
      { line: 'opened file:///C:/Users/Dana/Documents/audit.html', gone: ['file:', 'Dana', 'audit'] },
      { line: 'devtools at ws://127.0.0.1:9222/devtools/page/ABCDEF', gone: ['ws:', '127.0.0.1', '9222', 'ABCDEF'] },
      { line: 'see www.client-site.co.uk for the page that failed', gone: ['www', 'client-site'] },
      { line: 'redirect loop on Client-Site.COM/landing?id=7', gone: ['Client-Site', 'landing'] },
      { line: 'mailto:press@client-site.com could not open', gone: ['mailto', 'press', 'client-site'] },
      { line: 'view-source:example.org/secret-page refused', gone: ['view-source', 'example.org', 'secret-page'] },
    ],
    detect: /:\/\/|\bwww\d{0,3}\.|\b(?:https?|wss?|ftp|data|blob|file|app|about|javascript|mailto|view-source|chrome|devtools):(?=\S)|[A-Za-z0-9-]\.[A-Za-z]{2,63}(?::\d|[/?#])/i,
  },
  {
    id: 'email',
    label: 'Email addresses',
    examples: [
      { line: 'sign-in failed for alice.smith+seo@client-site.co.uk (401)', gone: ['alice', 'client-site'] },
      { line: 'From: "Ops Team" <bob@corp.internal>', gone: ['bob@', 'corp.internal'] },
      { line: 'gsc: property owner dana_o@example.org has no access', gone: ['dana_o', 'example.org'] },
    ],
    detect: /@/,
  },
  {
    id: 'posix-path',
    label: 'POSIX file paths, absolute or relative, in a home folder or not',
    examples: [
      { line: 'could not open /home/alice/.config/frost/frost-session.db (SQLITE_BUSY)', gone: ['alice', '.config', 'frost-session'] },
      { line: 'wrote /Users/Bob Smith/Library/Application Support/frost/x.json', gone: ['Bob', 'Smith', 'Library', 'x.json'] },
      { line: 'temp file /var/folders/xy/abc123/T/frost-4f2a/shot.png removed', gone: ['folders', 'abc123', 'shot.png'] },
      { line: 'socket /tmp/frost-1000 refused', gone: ['/tmp', 'frost-1000'] },
      { line: 'notes in ~/clients/acme/notes.txt', gone: ['clients', 'acme', 'notes.txt'] },
      {
        line: "TypeError: Cannot read properties of undefined (reading 'url')\n    at loadPage (/opt/frost/resources/app.asar/.vite/build/main.js:120:7)\n    at node:internal/process/task_queues:95:5\n    at out/main/index.js:12:3",
        gone: ['/opt', 'resources', 'app.asar', 'main.js', 'task_queues', 'out/main', 'index.js'],
      },
    ],
    detect: /[\\/]/,
  },
  {
    id: 'windows-path',
    label: 'Windows file paths: drive, UNC, \\\\?\\ and environment-variable paths, either slash',
    examples: [
      { line: 'could not open C:\\Users\\bob.jones\\AppData\\Roaming\\frost\\frost-session.db', gone: ['bob', 'AppData', 'Roaming', 'frost-session'] },
      { line: 'long path \\\\?\\C:\\Users\\Carol\\Projects\\client\\export.har', gone: ['Carol', 'Projects', 'export.har'] },
      { line: 'share \\\\fileserver\\clients\\acme\\report.xlsx not reachable', gone: ['fileserver', 'acme', 'report.xlsx'] },
      { line: 'saved D:/work/client-x/audit.csv', gone: ['D:/work', 'client-x', 'audit.csv'] },
      { line: 'config %APPDATA%\\frost\\frost-sync.json missing', gone: ['APPDATA', 'frost-sync'] },
      { line: '{"file":"C:\\\\Users\\\\erin\\\\Desktop\\\\list.txt"}', gone: ['erin', 'Desktop', 'list.txt'] },
    ],
    detect: /[\\/]|\b[A-Za-z]:(?=[\\/])/,
  },
  {
    id: 'key',
    label: 'Keys, tokens and credentials: JWTs, prefixed API keys, Bearer and Basic values, long hex or base64 runs, secret assignments',
    examples: [
      { line: 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U rejected', gone: ['eyJhbGci', 'dozjgNry'] },
      { line: 'agent: model call failed with key sk-ant-api03-AbCdEf1234567890xyzQRS', gone: ['sk-ant', 'AbCdEf1234567890'] },
      { line: 'openai key sk-proj-abcDEF123456 was refused', gone: ['sk-proj', 'abcDEF123456'] },
      { line: 'request headers: Authorization: Bearer abc.def-ghi_123', gone: ['abc.def-ghi_123'] },
      { line: 'retrying with bearer 0123456789abcdef', gone: ['0123456789abcdef'] },
      { line: 'proxy said Basic dXNlcjpwYXNzd29yZA==', gone: ['dXNlcjpwYXNzd29yZA'] },
      { line: 'mcp server env GITHUB_TOKEN ghp_1234567890abcdefABCDEF1234567890abcd', gone: ['ghp_1234567890'] },
      { line: 'aws key AKIAIOSFODNN7EXAMPLE leaked', gone: ['AKIAIOSFODNN7EXAMPLE'] },
      { line: 'api_key=AIzaSyA-1234567890abcdefghijklmnop', gone: ['AIzaSyA', '1234567890abcdef'] },
      { line: 'x-api-key: 9f8e7d6c5b4a', gone: ['9f8e7d6c5b4a'] },
      { line: 'commit 3f786850e387550fdab836ed7e6dc881de23001b', gone: ['3f786850e387550fdab836ed7e6dc881de23001b'] },
      { line: 'blob dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ== cached', gone: ['dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ'] },
      { line: 'password="hunter two" and client_secret=GOCSPX-abc', gone: ['hunter', 'GOCSPX'] },
    ],
    detect: /eyJ[A-Za-z0-9_-]{4}|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|glpat|xox[abprs])[-_][A-Za-z0-9]|\bAKIA[0-9A-Z]{8}|\bAIza[0-9A-Za-z_-]{8}|\b(?:Bearer|Basic)\s+(?!\[)|[0-9a-f]{20}|(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])[A-Za-z0-9+_-]{20}/,
  },
  {
    id: 'ip',
    label: 'IP addresses (v4 and v6, with or without a port)',
    examples: [
      { line: 'connect ECONNREFUSED 192.168.1.20:8080', gone: ['192.168.1.20'] },
      { line: 'listening on [2001:db8::42]:443 and ::1', gone: ['2001:db8::42', '::1'] },
      { line: 'peer fe80::1ff:fe23:4567:890a%eth0 dropped', gone: ['fe80::1ff', 'eth0'] },
      { line: 'mapped ::ffff:10.0.0.7 seen', gone: ['10.0.0.7'] },
    ],
    detect: /\b\d{1,3}(?:\.\d{1,3}){3}\b|(?<![\w:.])[0-9a-f]{0,4}::|(?:[0-9a-f]{1,4}:){5,}[0-9a-f]{1,4}/i,
  },
  {
    id: 'machine-name',
    label: 'This computer’s host name and the user’s login name (scrubbed as literals)',
    examples: [
      { line: 'getaddrinfo ENOTFOUND Alices-Laptop.local', gone: ['Alices-Laptop'] },
      { line: 'keychain for alicew refused', gone: ['alicew'] },
      { line: 'lock held by ALICES-LAPTOP', gone: ['ALICES-LAPTOP'] },
    ],
    detect: null,
  },
  {
    id: 'page-text',
    label: 'Page text and page console messages (kept out at the source)',
    examples: [],
    detect: null,
  },
];

/** The host and user names the `machine-name` examples use as literals in tests. */
export const DIAGNOSTICS_TEST_LITERALS = ['Alices-Laptop.local', 'Alices-Laptop', 'alicew'] as const;

// ---- The diagnostics scrub pass ---------------------------------------------------------------------

/** Where a token ends in the rules below: whitespace, a quote, a bracket, a comma or semicolon. */
const TOKEN_STOP = '\\s"\'<>`(),;\\[\\]{}';
/** URI and host stop: whitespace, a quote, an angle bracket or a backtick. */
const URI_STOP = '\\s"\'<>`';
/** Top-level labels that make a mixed-case single-dot name a host (`Client-Site.COM`). */
const COMMON_TLDS = 'com|net|org|edu|gov|info|biz|io|co|ai|app|dev|xyz|site|online|shop|tech|cloud|uk|de|fr|nl|eu|us|ca|au|jp|in|br|es|it|ru|ch|se|no|dk|pl|be|at|local|internal|corp|lan|home|test|example|invalid|localhost';

export const DIAGNOSTICS_SCRUB_RULE_IDS = [
  'credential-header-line',
  'any-uri',
  'www',
  'host-with-path-or-port',
  'mixed-case-host',
  'any-at',
  'private-key-block',
  'auth-scheme',
  'secret-name-value',
  'secret-flag',
  'prefixed-key',
  'jwt-like',
  'long-hex',
  'long-base64',
  'ipv6-rest',
  'percent-encoded',
  'any-slash',
] as const;
export type DiagnosticsScrubRuleId = (typeof DIAGNOSTICS_SCRUB_RULE_IDS)[number];

/** How many times a percent-encoded token is decoded (on the side) to see what it hides. */
export const DIAGNOSTICS_PERCENT_DECODE_ROUNDS = 3;

/**
 * Before any rule, each line is put in Unicode NFKC (full-width `．` `／` `＠` read as `.` `/` `@`), and
 * every token holding a percent-escape is decoded (`DIAGNOSTICS_PERCENT_DECODE_ROUNDS`, bad sequences
 * left as they are) on the side: if the scrubber would change the decoded token, the whole token is
 * `[redacted]` (`https%3A%2F%2F…`, `alice%40example.com`).
 *
 * Then the rules below, in order, after telemetry's scrubber, on one line at a time (so each runs on
 * bounded text, and every pattern starts only where a token starts: linear time). Stricter than
 * telemetry's rules, since a diagnostics report has no use for any of it:
 * - `credential-header-line`: after `authorization`, `proxy-authorization`, `cookie` or `set-cookie`
 *   and `:` or `=`, the rest of the line (a cookie string, `Bearer <short token>`, a Digest username);
 * - `any-uri`: any `scheme://…` (any case), and `data:`, `blob:`, `file:`, `app:`, `about:`,
 *   `javascript:`, `mailto:`, `view-source:`, `http(s):`, `ws(s):`, `chrome:`, `devtools:` with
 *   something after them;
 * - `www`: a bare `www.` name;
 * - `host-with-path-or-port`: a dotted name (any case) followed by a port, `/`, `?` or `#`;
 * - `mixed-case-host`: a dotted name with a common top-level label, any case (`Client-Site.COM`);
 * - `any-at`: every token holding an `@` (an address, `user@host`, a scoped name);
 * - `private-key-block`: a PEM `-----BEGIN … KEY-----` marker;
 * - `auth-scheme`: `Bearer`, `Basic`, `Digest`, `Negotiate`, `NTLM`, `Token`, `ApiKey` and the value
 *   after it, any length;
 * - `secret-name-value`: a name holding `secret`, `token`, `password`, `passwd`, `api-key`,
 *   `apikey`, `auth`, `credential`, `session`, `cookie` or `private-key`, then `:` or `=`, then its value;
 * - `secret-flag`: the next token after a `--password`, `--passwd`, `--pass`, `--token`, `--secret`,
 *   `--api-key` flag (one dash or two, then a space or `=`), or after the words `password`, `passwd`
 *   or `token` (any case; so prose such as "unexpected token x" loses its next word too);
 * - `prefixed-key`: vendor-prefixed keys (`sk-…`, `pk_…`, `ghp_…`, `github_pat_…`, `glpat-…`,
 *   `xoxb-…`, `hf_…`, `npm_…`, `AKIA…`, `ASIA…`, `AIza…`);
 * - `jwt-like`: three dot-joined base64url runs of 8 or more;
 * - `long-hex`: 20 or more hex digits;
 * - `long-base64`: 20 or more base64(url) characters mixing digits, lower and upper case, or 32 or
 *   more of `A-Z a-z 0-9 + / -` mixing digits and letters (base32 secrets; `_` names such as
 *   migration ids are left alone);
 * - `ipv6-rest`: what telemetry's IPv6 rule leaves of a mapped address (`::ffff:[ip]`), and any other
 *   token starting with `::` or hex groups around `::`;
 * - `percent-encoded`: every token holding an encoded `/`, `\`, `@` or `:` (`%2F`, `%5C`, `%40`,
 *   `%3A`, also double-encoded `%252F`), whatever the side decode found;
 * - `any-slash`: every token holding a `/` or `\` (any path, absolute or relative, POSIX or Windows,
 *   UNC or `\\?\`, a stack frame's file, an environment-variable path).
 *
 * So a report holds no `/`, `\` or `@` at all (`DiagnosticsReportSchema` checks it again).
 */
export const DIAGNOSTICS_SCRUB_RULES: readonly { readonly id: DiagnosticsScrubRuleId; readonly pattern: RegExp; readonly replacement: string }[] = [
  { id: 'credential-header-line', pattern: /(?<![A-Za-z0-9_-])((?:proxy-)?authorization|(?:set-)?cookie)(["']?\s*[:=])[^\r\n]*/gi, replacement: '$1$2 [redacted]' },
  {
    id: 'any-uri',
    pattern: new RegExp(
      `(?<![A-Za-z0-9+.-])(?:[A-Za-z][A-Za-z0-9+.-]{0,31}:\\/\\/[^${URI_STOP}]*|(?:data|blob|file|app|about|javascript|mailto|view-source|https?|wss?|ftp|chrome|chrome-extension|devtools):[^${URI_STOP}]+)`,
      'gi',
    ),
    replacement: '[url]',
  },
  { id: 'www', pattern: new RegExp(`(?<![A-Za-z0-9_.-])www\\d{0,3}\\.[^${URI_STOP}]*`, 'gi'), replacement: '[url]' },
  {
    id: 'host-with-path-or-port',
    pattern: new RegExp(`(?<![A-Za-z0-9_.@%+-])(?:[A-Za-z0-9-]{1,63}\\.){1,126}[A-Za-z][A-Za-z0-9-]{0,62}(?::\\d{1,5}|[/?#])[^${URI_STOP}]*`, 'g'),
    replacement: '[url]',
  },
  {
    id: 'mixed-case-host',
    pattern: new RegExp(`(?<![A-Za-z0-9_.@%+-])(?:[A-Za-z0-9-]{1,63}\\.){1,126}(?:${COMMON_TLDS})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_])`, 'gi'),
    replacement: '[host]',
  },
  { id: 'any-at', pattern: new RegExp(`(?<![^${TOKEN_STOP}])[^${TOKEN_STOP}]*@[^${TOKEN_STOP}]*`, 'g'), replacement: '[email]' },
  { id: 'private-key-block', pattern: /-----(?:BEGIN|END)[A-Z ]{0,40}-----/g, replacement: '[key]' },
  { id: 'auth-scheme', pattern: /\b(Bearer|bearer|BEARER|Basic|basic|Digest|Negotiate|NTLM|Token|ApiKey)(\s+)(?!\[redacted\])[^\s"'<>`,;]+/g, replacement: '$1$2[redacted]' },
  {
    id: 'secret-name-value',
    pattern: /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{0,40}(?:secret|token|password|passwd|api[_-]?key|auth|credential|session|cookie|private[_-]?key)[A-Za-z0-9_-]{0,40})(["']?\s*[:=]\s*)(?!\[)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"',;&]+)/gi,
    replacement: '$1$2[redacted]',
  },
  {
    id: 'secret-flag',
    pattern: /(?<![A-Za-z0-9_-])(--?(?:password|passwd|pass|token|secret|api[-_]?key)|password|passwd|token)(\s+|=)(?!\[)[^\s"'<>`,;]+/gi,
    replacement: '$1$2[redacted]',
  },
  {
    id: 'prefixed-key',
    pattern: /(?<![A-Za-z0-9_-])(?:(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|hf|npm|pypi|whsec|shpat|shpss)[-_][A-Za-z0-9_-]{6,}|(?:AKIA|ASIA)[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,})/g,
    replacement: '[key]',
  },
  { id: 'jwt-like', pattern: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, replacement: '[token]' },
  { id: 'long-hex', pattern: /(?<![A-Za-z0-9])[0-9a-fA-F]{20,}(?![A-Za-z0-9])/g, replacement: '[token]' },
  {
    id: 'long-base64',
    pattern: /(?<![A-Za-z0-9+/_-])(?:(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{20,}|(?=[A-Za-z0-9+/-]*\d)(?=[A-Za-z0-9+/-]*[A-Za-z])[A-Za-z0-9+/-]{32,}(?![A-Za-z0-9_]))={0,2}/g,
    replacement: '[token]',
  },
  { id: 'ipv6-rest', pattern: /(?<![\w:.])[0-9a-f:]*::[0-9a-f:]*/gi, replacement: '[ip]' },
  { id: 'percent-encoded', pattern: new RegExp(`(?<![^${TOKEN_STOP}])[^${TOKEN_STOP}]*%(?:25){0,3}(?:2F|5C|40|3A)[^${TOKEN_STOP}]*`, 'gi'), replacement: '[redacted]' },
  { id: 'any-slash', pattern: new RegExp(`(?<![^${TOKEN_STOP}])[^${TOKEN_STOP}]*[\\\\/][^${TOKEN_STOP}]*`, 'g'), replacement: '[path]' },
];

/** Characters a built report never holds (every path, address and URL went with its token). */
export const DIAGNOSTICS_FORBIDDEN_CHARS = /[\\/@]/;

// ---- Saving ---------------------------------------------------------------------------------------

/**
 * What `help.saveDiagnostics` answers: `saved` (written to the file the user chose), `cancelled` (the
 * dialog was cancelled: nothing written), `stale` (main no longer keeps that report: nothing written),
 * `busy` (a diagnostics save dialog is already open: nothing written), `failed` (the write failed).
 */
export const DIAGNOSTICS_RESULTS = ['saved', 'cancelled', 'stale', 'busy', 'failed'] as const;
export type DiagnosticsResult = (typeof DIAGNOSTICS_RESULTS)[number];

/** Main's save dialog: offered in Downloads as `diagnosticsFileName`, one filter, overwrite confirmed. */
export const DIAGNOSTICS_SAVE_DIALOG = { title: 'Save diagnostics report', filterName: 'Text', extension: 'txt' } as const;

const two = (n: number) => String(n).padStart(2, '0');
/** `frost-diagnostics-<YYYYMMDD-HHMMSS>.txt` (local time). */
export function diagnosticsFileName(now: Date): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `frost-diagnostics-${stamp}.${DIAGNOSTICS_SAVE_DIALOG.extension}`;
}

// ---- The sheet -------------------------------------------------------------------------------------

/** The Help sheet's words. */
export const DIAGNOSTICS_TEXT = {
  title: 'Export diagnostics',
  close: 'Close diagnostics',
  intro: 'Review the report below before you save it. frost made it on this computer and never sends it anywhere; attach the saved file to a bug report if you want to.',
  loading: 'Making the report…',
  unavailable: 'The report couldn’t be made.',
  save: 'Save…',
  saving: 'Saving…',
  notes: {
    saved: 'Report saved.',
    stale: 'This report is out of date. Close this sheet and export again.',
    busy: 'A save dialog is already open.',
    failed: 'The report couldn’t be saved.',
  },
} as const satisfies { notes: Readonly<Record<Exclude<DiagnosticsResult, 'cancelled'>, string>> } & Record<string, unknown>;
