/**
 * Compliance (Phase 2 Task 6; acceptance: `seo-compliance.feature.md`): the page's transport and
 * header security, read from the snapshot and the response main recorded (Task 4), and an
 * accessibility check run on request with `axe-core` in an isolated world. Their rules, in the
 * categories `security` and `accessibility`, are frost's own (ids, wording, thresholds and
 * scoring), written from the relevant web standards: Mixed Content, RFC 6797 (HSTS), CSP Level 3,
 * Referrer Policy, `X-Content-Type-Options`, `X-Frame-Options` and WCAG 2.x. `axe-core` (MPL-2.0)
 * is used unmodified, as a library; frost only chooses which of its rules run and how the results
 * are shown and scored.
 *
 * Plain values with type-only imports, so the chrome renderer can use them without bundling Zod.
 * The Zod schemas that enforce the caps are `seo-compliance.schema.ts` (validated in the analysis
 * worker, beside the snapshot).
 */
import type { SeoRuleSpec } from './seo-rules.spec';

// ---- Security: what is read ---------------------------------------------------------------------

/**
 * The response headers the Compliance panel shows, in its order (all in Task 4's
 * `RESPONSE_HEADER_ALLOWLIST`), with frost's labels. `Permissions-Policy` is shown (present or not)
 * but no rule reads it: what a page should restrict depends on what it does.
 */
export const SECURITY_HEADERS = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'] as const;
export type SecurityHeaderName = (typeof SECURITY_HEADERS)[number];
export const SECURITY_HEADER_LABELS: Readonly<Record<SecurityHeaderName, string>> = {
  'content-security-policy': 'Content-Security-Policy',
  'strict-transport-security': 'Strict-Transport-Security',
  'x-content-type-options': 'X-Content-Type-Options',
  'x-frame-options': 'X-Frame-Options',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
};

/**
 * How a header row reads:
 * - `good`: sent with a value that does its job;
 * - `weak`: sent, but a rule flags its value (a short HSTS max-age, `unsafe-inline` scripts, an
 *   unsafe referrer policy, an `X-Content-Type-Options` other than `nosniff`, an `X-Frame-Options`
 *   other than `DENY` / `SAMEORIGIN`);
 * - `missing`: not sent;
 * - `unknown`: main has no headers for this document (`ResponseMeta.headersAvailable` false: a
 *   page from the back/forward cache, an in-page URL, or none recorded). Never a failure;
 * - `not-applicable`: HSTS on a page that is not served over https (browsers ignore it there).
 * A `<meta http-equiv="Content-Security-Policy">` or `<meta name="referrer">` counts for its
 * header's row when the header is missing or unknown (shown as "from a meta tag").
 */
export const HEADER_STATES = ['good', 'weak', 'missing', 'unknown', 'not-applicable'] as const;
export type HeaderState = (typeof HEADER_STATES)[number];
export const HEADER_STATE_LABELS: Readonly<Record<HeaderState, string>> = {
  good: 'Present',
  weak: 'Weak',
  missing: 'Missing',
  unknown: 'Unknown',
  'not-applicable': 'Not applicable',
};

/**
 * Hosts that are this computer: `localhost` and `*.localhost`, `127.0.0.0/8` and `[::1]`. Browsers
 * treat them as secure contexts even over plain http (W3C Secure Contexts, "potentially
 * trustworthy"), so a local development server is not flagged by `https-missing`. Its headers are
 * still checked.
 */
export const LOOPBACK_HOST_PATTERNS = ['localhost', '*.localhost', '127.0.0.0/8', '[::1]'] as const;

/** HSTS `max-age` below this (180 days, in seconds) is `hsts-short-max-age`; a year (31 536 000) is the usual value. */
export const HSTS_MIN_MAX_AGE_SECONDS = 15_552_000;

/**
 * Referrer policies (Referrer Policy, W3C). A `Referrer-Policy` header may list several,
 * comma-separated: the last one a browser knows wins. A `<meta name="referrer">` sets the document's
 * policy after the header, so a valid one takes precedence; it also accepts the legacy values
 * `never` (= `no-referrer`), `always` (= `unsafe-url`), `default` (= `strict-origin-when-cross-origin`)
 * and `origin-when-crossorigin` (= `origin-when-cross-origin`).
 */
export const REFERRER_POLICIES = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'] as const;
export type ReferrerPolicyValue = (typeof REFERRER_POLICIES)[number];
export const LEGACY_META_REFERRER: Readonly<Record<string, ReferrerPolicyValue>> = {
  never: 'no-referrer',
  always: 'unsafe-url',
  default: 'strict-origin-when-cross-origin',
  'origin-when-crossorigin': 'origin-when-cross-origin',
};
/** Policies that send the full URL (path and query) to other sites: `referrer-policy-unsafe`. */
export const UNSAFE_REFERRER_POLICIES = ['unsafe-url', 'no-referrer-when-downgrade'] as const satisfies readonly ReferrerPolicyValue[];

/**
 * The CSP source-list keywords that make browsers ignore `'unsafe-inline'` in a script directive
 * (CSP Level 3): a nonce, a hash, or `'strict-dynamic'`.
 */
export const CSP_INLINE_OVERRIDES = ['nonce-', 'sha256-', 'sha384-', 'sha512-', 'strict-dynamic'] as const;

/**
 * Subresources an https page loads over plain http (Mixed Content, W3C), by what the browser does.
 * An http URL of this computer (`LOOPBACK_HOST_PATTERNS`) is "a priori authenticated" and not mixed
 * content, so it is not reported.
 * - **active** (blockable): `script`, `stylesheet`, `frame` (`<iframe>`, `<frame>`), `object`
 *   (`<object data>`, `<embed src>`) and `font` (`<link rel=preload as=font>`). Chromium blocks
 *   them before any request is made: the page is broken where it used them. `mixed-content-active`;
 * - **passive** (upgradable): `image` (`<img>`, `<input type=image>`, `<link rel~=icon>`, a video
 *   `poster`) and `media` (`<video>`, `<audio>`, `<source>` in them, `<track>`). Chromium upgrades
 *   them to https (and the load fails if the host has no https). `mixed-content-passive`.
 */
export const INSECURE_RESOURCE_KINDS = ['script', 'stylesheet', 'frame', 'object', 'font', 'image', 'media'] as const;
export type InsecureResourceKind = (typeof INSECURE_RESOURCE_KINDS)[number];
export const ACTIVE_RESOURCE_KINDS = ['script', 'stylesheet', 'frame', 'object', 'font'] as const satisfies readonly InsecureResourceKind[];
export const PASSIVE_RESOURCE_KINDS = ['image', 'media'] as const satisfies readonly InsecureResourceKind[];
export const INSECURE_RESOURCE_LABELS: Readonly<Record<InsecureResourceKind, string>> = {
  script: 'Script',
  stylesheet: 'Stylesheet',
  frame: 'Frame',
  object: 'Embedded object',
  font: 'Font',
  image: 'Image',
  media: 'Media',
};

/**
 * Where mixed content is read: the snapshot only (the DOM, in the isolated world), never the browse
 * session's `webRequest`. Chromium blocks active mixed content in the renderer before a request
 * exists and upgrades passive mixed content to https, so the network would see neither as an http
 * request; and the browse session's `webRequest` listeners have one owner per event, filtered to
 * main frames (`browser/web-request.ts`). The page's markup states what it asks for, blocked or not.
 */
export const MIXED_CONTENT_SOURCE = 'snapshot' as const;

/**
 * Caps on what the extractor reads for security (`PageSecuritySchema`):
 * - `maxResourceElements`: elements that can load a subresource looked at, in document order;
 * - `maxInsecureResources`: distinct (kind, URL) http subresources kept (`insecureResourceTotal`
 *   counts the distinct ones among the elements looked at);
 * - `maxMetaCsp`: `<meta http-equiv="Content-Security-Policy">` values kept (each cut to
 *   `maxMetaChars`); `maxMetaScan`: `<meta>` elements looked at for them and for `<meta name=referrer>`;
 * - `budgetMs`: the security read's own deadline (after the extractor's), then `resourcesTruncated`.
 */
export const SECURITY_LIMITS = {
  maxResourceElements: 5_000,
  maxInsecureResources: 100,
  maxMetaCsp: 4,
  maxMetaChars: 2_048,
  maxMetaScan: 500,
  budgetMs: 250,
} as const;
export type SecurityLimits = { readonly [K in keyof typeof SECURITY_LIMITS]: number };

/**
 * The security card's verdict:
 * - `insecure`: an error-severity security rule fails (not https, or active mixed content);
 * - `attention`: a warning-severity one fails (no HSTS, passive mixed content, an unsafe referrer policy);
 * - `secure`: neither (info-level hardening suggestions may remain);
 * - `local`: served over http from this computer (`LOOPBACK_HOST_PATTERNS`), and nothing above an info fails.
 */
export const SECURITY_VERDICTS = ['secure', 'attention', 'insecure', 'local'] as const;
export type SecurityVerdict = (typeof SECURITY_VERDICTS)[number];
export const SECURITY_VERDICT_LABELS: Readonly<Record<SecurityVerdict, string>> = {
  secure: 'Secure',
  attention: 'Needs attention',
  insecure: 'Not secure',
  local: 'Local page',
};

// ---- Accessibility ------------------------------------------------------------------------------

/**
 * The isolated world the accessibility check runs in (`executeJavaScriptInIsolatedWorld`), its own,
 * apart from the extractor's (`SEO_WORLD_ID`): `axe` and its caches live only there, never in the
 * page's main world (review focus `measurement-runs-isolated`). `axe-core` is injected once per
 * document, on the first run.
 */
export const A11Y_WORLD_ID = 1_216;

/** A run not answered after this long is abandoned ("timed out"); its late answer is ignored. */
export const A11Y_TIMEOUT_MS = 10_000;

/**
 * What runs: the `axe-core` rules tagged with one of these (WCAG 2.0, 2.1 and 2.2 level A and AA,
 * and axe's best practices), minus `A11Y_DISABLED_RULES`. AAA rules and experimental ones are not run.
 */
export const A11Y_RUN_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] as const;

/**
 * Rules turned off, and why:
 * - `region` (best practice: all content inside landmarks): fails on most real pages for every node
 *   outside a landmark, so it buries the findings that matter;
 * - `frame-tested`: frames are not checked (`iframes: false` below), so it would only ever report
 *   "incomplete" for every frame.
 */
export const A11Y_DISABLED_RULES = ['region', 'frame-tested'] as const;

/**
 * How `axe.run` is called: the main document only (`iframes: false`: frames would need axe injected
 * into each of them), no CSSOM preload (`preload: false`: it would fetch the page's stylesheets
 * again, so `css-orientation-lock` may come back incomplete), only violations' nodes collected
 * (`resultTypes`: passes and incomplete checks are counted by rule), no HTML snippets
 * (`axe.configure({ noHtml: true })`), selectors on, no XPath or ancestry.
 */
export const A11Y_RUN_OPTIONS = { iframes: false, preload: false, resultTypes: ['violations'], selectors: true, xpath: false, ancestry: false, absolutePaths: false, elementRef: false, performanceTimer: false } as const;

/** axe's impact levels, worst first: violations are grouped by them. */
export const A11Y_IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type A11yImpact = (typeof A11Y_IMPACTS)[number];
export const A11Y_IMPACT_LABELS: Readonly<Record<A11yImpact, string>> = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor' };

/**
 * The impacts that count toward the health score, once a run has happened (`a11y-critical`,
 * `a11y-serious`: one warning each, however many rules and elements). Moderate and minor
 * violations are shown, never scored. A page nobody checked is not penalised.
 */
export const A11Y_SCORED_IMPACTS = ['critical', 'serious'] as const satisfies readonly A11yImpact[];

/**
 * Caps (applied by the run script in the page, enforced again by the worker's schema):
 * - `maxRules`: violated rules kept (worst impact first; `violationTotal` counts them all);
 * - `maxNodesPerRule`: elements kept per rule (`nodeTotal` counts them all);
 * - string caps for a rule's id, help, description, help URL, tags, and an element's selector and
 *   failure summary;
 * - `maxRuleCount`: the passes / incomplete / inapplicable rule counts (axe has about a hundred rules);
 * - `maxResultChars` / `maxResultNodes`: main's own size check of the raw answer before keeping it
 *   (a bounded walk: strings' lengths and values visited); over either, the run "failed".
 */
export const A11Y_LIMITS = {
  maxRules: 100,
  maxNodesPerRule: 10,
  maxIdChars: 64,
  maxHelpChars: 300,
  maxDescriptionChars: 600,
  maxUrlChars: 2_048,
  maxTags: 16,
  maxTagChars: 40,
  maxSelectorChars: 512,
  maxSummaryChars: 1_000,
  maxVersionChars: 32,
  maxRuleCount: 1_000,
  maxResultChars: 2_000_000,
  maxResultNodes: 20_000,
} as const;
export type A11yLimits = { readonly [K in keyof typeof A11Y_LIMITS]: number };

/**
 * A tab's accessibility run, as `seo.getAudit` reports it beside a ready audit
 * (`AccessibilityRunState`):
 * - `idle`: no run for the document shown (none asked for, or the page navigated since);
 * - `running`: started at `startedAt`, not answered yet;
 * - `done`: answered; its results are in the audit (`SeoAudit.compliance.accessibility`) once it is re-scored;
 * - `timed-out`: not answered within `A11Y_TIMEOUT_MS`;
 * - `failed`: the check could not run (`reason`).
 * A run belongs to one document and URL: a new document, an in-page navigation to another URL, a
 * crash or a closed tab cancels it (its late answer is dropped) and the state goes back to `idle`.
 */
export const A11Y_RUN_STATUSES = ['idle', 'running', 'done', 'timed-out', 'failed'] as const;
export type A11yRunStatus = (typeof A11Y_RUN_STATUSES)[number];

/**
 * Why a run failed: `busy` (an earlier, abandoned run is still going in the page), `script-error`
 * (the check threw or answered nothing usable), `too-large` (the answer was over main's size check).
 */
export const A11Y_FAIL_REASONS = ['busy', 'script-error', 'too-large'] as const;
export type A11yFailReason = (typeof A11Y_FAIL_REASONS)[number];

export interface AccessibilityRunState {
  readonly status: A11yRunStatus;
  /** When the run started (epoch ms, main's clock); `null` when `idle`. */
  readonly startedAt: number | null;
  /** When it ended (answered, timed out or failed); `null` while `idle` or `running`. */
  readonly finishedAt: number | null;
  readonly reason: A11yFailReason | null;
}
export const IDLE_A11Y_RUN: AccessibilityRunState = { status: 'idle', startedAt: null, finishedAt: null, reason: null };

/** What the panel says for each run state (frost's own strings). */
export const A11Y_RUN_MESSAGES: Readonly<Record<A11yRunStatus, string>> = {
  idle: 'Checks the page against WCAG 2.x level A and AA and accessibility best practices. It runs on request because it is heavy.',
  running: 'Checking the page…',
  done: 'Scoring the results…',
  'timed-out': `The check took longer than ${A11Y_TIMEOUT_MS / 1_000} seconds and was stopped. Very large pages can take that long.`,
  failed: 'The accessibility check could not run on this page.',
};
export const A11Y_FAIL_MESSAGES: Readonly<Record<A11yFailReason, string>> = {
  busy: 'An earlier check is still running in this page. Try again in a moment.',
  'script-error': 'The accessibility check could not run on this page.',
  'too-large': 'The page’s results were too large to read safely.',
};

/**
 * What the audit holds about the accessibility check (`AccessibilityReport.status`): `not-run` (no
 * answer for this document and URL), `invalid` (an answer the worker's schema rejected; nothing of
 * it is shown or scored), `done`.
 */
export const A11Y_REPORT_STATUSES = ['not-run', 'invalid', 'done'] as const;
export type A11yReportStatus = (typeof A11Y_REPORT_STATUSES)[number];

/** How many of a rule's elements the panel lists before "Show all" (at most `maxNodesPerRule` are kept). */
export const A11Y_PANEL_NODES = 5;

// ---- Rules --------------------------------------------------------------------------------------

/**
 * The `security` and `accessibility` rules (spread into `SEO_RULE_SPECS`, after the others). A rule
 * that reads response headers passes when main has none for the document (shown as "unknown").
 */
export const COMPLIANCE_RULE_SPECS = [
  // Security
  {
    id: 'https-missing',
    category: 'security',
    severity: 'error',
    title: 'Page is not served over HTTPS',
    condition: 'The page URL uses http: and its host is not this computer (localhost, *.localhost, 127.0.0.0/8 or [::1], which browsers already treat as secure).',
    why: 'Over plain HTTP anyone on the network path can read the page and change it on the way. Browsers mark the page “Not secure”, and search engines prefer the HTTPS address of a page when both exist.',
    fix: 'Serve the site over HTTPS and redirect every http:// address to its https:// one with a permanent (301) redirect.',
  },
  {
    id: 'mixed-content-active',
    category: 'security',
    severity: 'error',
    title: 'Scripts, styles or frames load over HTTP',
    condition:
      'The page is served over https and asks for a script, stylesheet, frame, embedded object or font from an http: URL (<script src>, <link rel="stylesheet">, <link rel="preload"> or "modulepreload" for a script, style or font, <iframe>, <frame>, <object data>, <embed src>).',
    why: 'Browsers block these outright, so the page is broken where it relies on them: styles missing, scripts that never run, empty frames. Anything loaded over HTTP could be replaced on the way by code that takes over the whole page.',
    fix: 'Load each of them from an https:// URL (or host it on your own site), or remove it.',
  },
  {
    id: 'mixed-content-passive',
    category: 'security',
    severity: 'warning',
    title: 'Images or media load over HTTP',
    condition: 'The page is served over https and asks for an image or media file from an http: URL (<img>, <input type="image">, <link rel="icon">, a video poster, <video>, <audio>, <source>, <track>).',
    why: 'Browsers upgrade these requests to HTTPS, and the file is missing where the host has no HTTPS; where it does load over HTTP, it can be swapped on the way. Either way the page is no longer fully secure.',
    fix: 'Point each of them at its https:// URL.',
  },
  {
    id: 'hsts-missing',
    category: 'security',
    severity: 'warning',
    title: 'No HSTS header',
    condition: 'The page is served over https, its response headers are known, and it has no Strict-Transport-Security header with a valid max-age above 0 (browsers read the first one).',
    why: 'Without HSTS, a visitor who types the address or follows an old http:// link first asks over plain HTTP, and that request can be intercepted before the redirect to HTTPS.',
    fix: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response (and add preload once every subdomain serves HTTPS).',
  },
  {
    id: 'hsts-short-max-age',
    category: 'security',
    severity: 'info',
    title: 'HSTS expires quickly',
    condition: `The Strict-Transport-Security max-age is below ${HSTS_MIN_MAX_AGE_SECONDS.toLocaleString('en-US')} seconds (180 days).`,
    why: 'A short max-age runs out between visits, so returning visitors are unprotected again; browsers’ HSTS preload lists ask for at least a year.',
    fix: 'Raise max-age to a year (31536000).',
  },
  {
    id: 'csp-missing',
    category: 'security',
    severity: 'info',
    title: 'No Content Security Policy',
    condition: 'The page sets no Content Security Policy: no Content-Security-Policy header (its headers are known) and no <meta http-equiv="Content-Security-Policy">.',
    why: 'A policy is defence in depth against cross-site scripting: it limits where scripts, styles and frames may come from, so an injected script has less it can do. It does not change rankings.',
    fix: 'Add a Content-Security-Policy header; try it first as Content-Security-Policy-Report-Only to see what the page needs.',
  },
  {
    id: 'csp-unsafe-inline',
    category: 'security',
    severity: 'info',
    title: 'Content Security Policy allows inline scripts',
    condition:
      'Inline scripts are allowed by every policy the page sets: each policy that governs scripts (script-src, else default-src) lists \'unsafe-inline\' without a nonce, a hash or \'strict-dynamic\' (any of which make browsers ignore it), and any other policy does not restrict scripts.',
    why: 'Inline script is how most cross-site scripting runs; allowing it removes most of what the policy protects.',
    fix: 'Move inline scripts into files, or allow them by nonce (\'nonce-…\') or hash (\'sha256-…\'), and drop \'unsafe-inline\'.',
  },
  {
    id: 'nosniff-missing',
    category: 'security',
    severity: 'info',
    title: 'Content type sniffing is allowed',
    condition: 'The response headers are known and X-Content-Type-Options is not nosniff.',
    why: 'Without it, browsers may guess a response’s type from its contents, so a file uploaded as text or an image can be run as a script or stylesheet.',
    fix: 'Send X-Content-Type-Options: nosniff on every response.',
  },
  {
    id: 'clickjacking-unprotected',
    category: 'security',
    severity: 'info',
    title: 'Any site can frame this page',
    condition: 'The response headers are known, X-Frame-Options is not DENY or SAMEORIGIN, and no Content-Security-Policy header has a frame-ancestors directive (it is ignored in a <meta> policy).',
    why: 'Another site can load the page in an invisible frame and trick visitors into clicking its buttons (clickjacking).',
    fix: 'Send Content-Security-Policy: frame-ancestors \'self\' (and X-Frame-Options: SAMEORIGIN for older browsers).',
  },
  {
    id: 'referrer-policy-missing',
    category: 'security',
    severity: 'info',
    title: 'No referrer policy',
    condition: 'The page sets no valid referrer policy: no Referrer-Policy header with a known value (its headers are known) and no <meta name="referrer"> with one.',
    why: 'Browsers then use their own default (strict-origin-when-cross-origin in current ones, something looser in older ones), so what the page’s addresses reveal to other sites is left to the browser.',
    fix: 'Send Referrer-Policy: strict-origin-when-cross-origin (or a stricter policy).',
  },
  {
    id: 'referrer-policy-unsafe',
    category: 'security',
    severity: 'warning',
    title: 'Referrer policy leaks full addresses',
    condition: `The page’s referrer policy (a <meta name="referrer">, else the last known value of the Referrer-Policy header) is ${UNSAFE_REFERRER_POLICIES.join(' or ')}.`,
    why: 'These send the page’s full address, path and query string included, to every site it links to or loads from. Addresses often carry search terms, account ids or tokens.',
    fix: 'Use strict-origin-when-cross-origin, same-origin or no-referrer.',
  },
  // Accessibility (from the on-demand check; only once it has run)
  {
    id: 'a11y-critical',
    category: 'accessibility',
    severity: 'warning',
    title: 'Critical accessibility problems',
    condition: 'The accessibility check (run on request in the Compliance panel, on the document and URL shown) found a violation of critical impact. A page that was not checked passes.',
    why: 'Critical problems shut some people out of the page entirely: an unlabelled button or form field, an image with no text alternative, content a keyboard cannot reach.',
    fix: 'Fix the rules listed under Critical in the Compliance panel, starting with the ones that affect the most elements.',
  },
  {
    id: 'a11y-serious',
    category: 'accessibility',
    severity: 'warning',
    title: 'Serious accessibility problems',
    condition: 'The accessibility check (run on request, on the document and URL shown) found a violation of serious impact. A page that was not checked passes.',
    why: 'Serious problems make the page hard to use for many people: text with too little contrast, links that cannot be told apart, missing page language.',
    fix: 'Fix the rules listed under Serious in the Compliance panel.',
  },
] as const satisfies readonly SeoRuleSpec[];
