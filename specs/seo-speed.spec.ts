/**
 * Page speed (Phase 2 Task 5; acceptance: `seo-speed.feature.md`): how frost measures a page's
 * loading performance in the tab, the limits on what the measurement may hold, the Core Web Vitals
 * bands, and the `performance` rules that feed the health score.
 *
 * Plain values (importing only types from other specs), so the chrome renderer can use them without
 * bundling Zod. The Zod schema that enforces the limits is `seo-speed.schema.spec.ts`.
 *
 * Lab data, not field data: every value is one visit, measured in this tab on this machine, with
 * its cache, network and CPU. Real visitors' experience (field data) can differ widely. The panel
 * and every rule say so.
 *
 * Clean-room: the bands are the publicly documented Core Web Vitals thresholds (the 75th-percentile
 * "good" and "poor" boundaries published for each metric); the other thresholds, the rule
 * ids and all wording are frost's own.
 */
import type { SeoRuleSpec } from './seo-rules.spec';

// ---- Measurement ----------------------------------------------------------------------------

/**
 * The isolated world the speed measurement runs in (`executeJavaScriptInIsolatedWorld`). Its own
 * world, not the extractor's (`SEO_WORLD_ID`): the web-vitals library and frost's observers live
 * there for the document's lifetime, apart from both the page and the extractor. Electron reserves
 * `0` (the main world) and `999`; the id must be in `1…536870911`.
 */
export const SPEED_WORLD_ID = 1_250;

/**
 * The isolated-world global that holds the measurement's state (the web-vitals callbacks' latest
 * values and the resource records) between polls. It exists only in `SPEED_WORLD_ID`: the page's
 * main world has its own global object and never sees it.
 */
export const SPEED_STATE_KEY = '__frostSpeedState' as const;

/** The five metrics frost reports, in the panel's order. */
export const VITAL_METRICS = ['lcp', 'cls', 'inp', 'fcp', 'ttfb'] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

/** The three Core Web Vitals (the others are diagnostics): the panel's lab verdict is the worst of these that were measured. */
export const CORE_WEB_VITALS = ['lcp', 'cls', 'inp'] as const satisfies readonly VitalMetric[];

export const VITAL_LABELS: Readonly<Record<VitalMetric, { readonly short: string; readonly name: string; readonly unit: 'ms' | 'score' }>> = {
  lcp: { short: 'LCP', name: 'Largest Contentful Paint', unit: 'ms' },
  cls: { short: 'CLS', name: 'Cumulative Layout Shift', unit: 'score' },
  inp: { short: 'INP', name: 'Interaction to Next Paint', unit: 'ms' },
  fcp: { short: 'FCP', name: 'First Contentful Paint', unit: 'ms' },
  ttfb: { short: 'TTFB', name: 'Time to First Byte', unit: 'ms' },
};

/**
 * The bands (publicly documented Core Web Vitals thresholds): a value at or below `good` is
 * `good`; above `poor` it is `poor`; in between `needs-improvement`. Times in milliseconds, CLS
 * unitless.
 */
export const VITAL_THRESHOLDS: Readonly<Record<VitalMetric, { readonly good: number; readonly poor: number }>> = {
  lcp: { good: 2_500, poor: 4_000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
  fcp: { good: 1_800, poor: 3_000 },
  ttfb: { good: 800, poor: 1_800 },
};

export const VITAL_BANDS = ['good', 'needs-improvement', 'poor'] as const;
export type VitalBand = (typeof VITAL_BANDS)[number];
export const VITAL_BAND_LABELS: Readonly<Record<VitalBand, string>> = { good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor' };

/**
 * When the page was shown (main owns the signal; spec `seo-speed.feature.md`, Background tabs).
 * frost's background tabs are detached views that still report `visible` and paint only once they
 * are shown, so web-vitals alone would measure "time until the user switched". Main records, per
 * tab's WebContents, when the current document was first shown (attached to the window) and when it
 * was first hidden after that, and passes both to the collector (epoch ms). A document whose
 * `performance.timeOrigin` precedes its first-shown time by more than `SHOWN_TOLERANCE_MS`, or that
 * was hidden before its first contentful paint, loaded hidden: FCP, LCP and CLS are dropped (`null`)
 * and the panel asks to re-measure.
 */
export const SHOWN_TOLERANCE_MS = 20;

/**
 * Native Wayland: some compositors never give Chromium presentation feedback, so no paint entry is
 * ever recorded (no FCP, LCP or CLS, in any world). Main tells the collector when the app runs on a
 * Wayland ozone platform on Linux; if no paint entry exists `PAINT_GRACE_MS` after the load event,
 * the measurement says `paintUnavailable` and the panel shows `WAYLAND_PAINT_NOTE`. frost does not
 * force X11.
 */
export const PAINT_GRACE_MS = 3_000;
export const WAYLAND_PAINT_NOTE =
  'No paint timing was reported: under native Wayland some compositors never tell the browser when a frame was shown, so FCP, LCP and CLS can’t be measured. Launching frost with --ozone-platform=x11 measures them.';

/**
 * The speed world listens for these events only when the browser itself fired them (`isTrusted`):
 * before loading web-vitals the collector wraps that world's `EventTarget.prototype.addEventListener`
 * (and `removeEventListener`, so removals still match) for these types. A synthetic `pageshow`,
 * `visibilitychange` or `prerenderingchange` dispatched by the page then reaches none of the
 * library's handlers. The wrapper stays for the document's lifetime: only frost's code runs in the
 * speed world, and the library registers some of these listeners later.
 */
export const TRUSTED_ONLY_EVENTS = ['pageshow', 'visibilitychange', 'prerenderingchange'] as const;

/** The DOM's element count and depth are recomputed on the first collection and every this many after (and after a route change). */
export const DOM_REFRESH_EVERY = 10;

/**
 * Too few requests: when the page's elements that usually fetch something (`img[src]`,
 * `script[src]`, stylesheet links; `resourceHints`) number at least `LOW_RESOURCES_MIN_HINTS` and the
 * observed requests (the document aside) are fewer than `LOW_RESOURCES_RATIO` of them, the page may
 * have cleared its timing entries before frost observed, or loaded them from the memory cache: the
 * panel says so. A heuristic, never a finding.
 */
export const LOW_RESOURCES_MIN_HINTS = 4;
export const LOW_RESOURCES_RATIO = 0.25;

/**
 * What the measurement may hold. The isolated-world collector applies every cap while it reads the
 * Performance API and the DOM; the analysis worker validates the answer against the same caps
 * (`PerformanceMeasurementSchema`).
 */
export const SPEED_LIMITS = {
  /**
   * Resource timing entries itemised (the first ones, in the order they were observed). Later ones
   * are only added to `overflow` (their count and bytes), so totals stay complete however many
   * requests a page makes.
   */
  maxResources: 1_000,
  /** Characters of a resource's URL kept (the record says whether it was cut; a cut URL never opens in a tab). */
  maxResourceUrlChars: 1_024,
  /** Characters of an `initiatorType`, `contentType` or `contentEncoding` value kept. */
  maxResourceFieldChars: 64,
  /** Elements walked at most to find the DOM's depth (`depthComplete: false` past it). */
  maxDomWalk: 50_000,
  /** Milliseconds the DOM-depth walk may take per measurement (then `depthComplete: false`). */
  domWalkBudgetMs: 50,
  /** Any count above this is reported as this. */
  maxCount: 100_000_000,
  /** Any byte count above this is reported as this (10 GB). */
  maxBytes: 10_000_000_000,
  /** Any time (ms since navigation start) or duration above this is reported as this (one day). */
  maxTimeMs: 86_400_000,
} as const;
export type SpeedLimits = { readonly [K in keyof typeof SPEED_LIMITS]: number };

/**
 * On its first run in a document the collector installs web-vitals and its resource observer, then
 * waits this long before answering, so the buffered entries (paint, LCP, layout shifts, resources
 * loaded before it was injected) reach their callbacks. Later runs answer at once.
 */
export const SPEED_SETTLE_MS = 150;

/** A measurement the page has not answered after this long is `timeout` (the page is busy). */
export const SPEED_MEASURE_TIMEOUT_MS = 2_000;

/**
 * Live updates: while the Speed panel is open on the active tab, the chrome asks main to measure it
 * again every `SPEED_POLL_MS` (each poll waits for the previous answer: never more than one in
 * flight). After `SPEED_LIVE_MAX_POLLS` polls of one page the updates pause ("Resume" starts a new
 * run of them). A poll session belongs to one tab and one URL: switching tabs, navigating (a new
 * URL), collapsing the sidebar or leaving the panel ends it, and its late answers are dropped.
 */
export const SPEED_POLL_MS = 1_000;
export const SPEED_LIVE_MAX_POLLS = 120;

/**
 * Main measures a tab at most once per this long: a request sooner than that after the last
 * measurement of the same document answers that measurement again, and a request while one is in
 * flight shares it. A page cannot be made to run the collector faster than this, whatever asks.
 */
export const SPEED_MIN_INTERVAL_MS = 500;

/**
 * `seo.measureSpeed` answers one of these: `ready` with the report of exactly the tab's current URL,
 * `pending` while the first measurement of it runs, `unavailable` with a reason.
 */
export const SPEED_STATUSES = ['pending', 'ready', 'unavailable'] as const;
export type SpeedStatus = (typeof SPEED_STATUSES)[number];

/**
 * Why there is no measurement: `no-page` (empty, or not `http(s)`), `load-error` / `crashed` (the
 * tab shows its panel), `background` (only the active tab is measured), `timeout` (the page did not
 * answer within `SPEED_MEASURE_TIMEOUT_MS`), `invalid-measurement` (the answer does not parse:
 * wrong shape or over a cap), `measurement-failed` (running it threw), `analysis-timeout` /
 * `analysis-failed` (the worker), `no-tab`.
 */
export const SPEED_UNAVAILABLE_REASONS = ['no-page', 'load-error', 'crashed', 'background', 'timeout', 'invalid-measurement', 'measurement-failed', 'analysis-timeout', 'analysis-failed', 'no-tab'] as const;
export type SpeedUnavailableReason = (typeof SPEED_UNAVAILABLE_REASONS)[number];

export const SPEED_UNAVAILABLE_MESSAGES: Readonly<Record<SpeedUnavailableReason, string>> = {
  'no-page': 'Only web pages (http and https) are measured.',
  'load-error': 'This page didn’t load, so there is nothing to measure.',
  crashed: 'This page crashed. Reload it to measure it again.',
  background: 'Only the tab you are looking at is measured.',
  timeout: 'The page took too long to answer. It may be busy.',
  'invalid-measurement': 'The page returned measurements frost could not read safely.',
  'measurement-failed': 'frost could not measure this page.',
  'analysis-timeout': 'This page’s measurements took too long to analyse.',
  'analysis-failed': 'frost could not analyse this page’s measurements.',
  'no-tab': 'This tab is gone.',
};

// ---- Resources ------------------------------------------------------------------------------

/** What a request is, for the breakdown (`resourceType` in `@app/seo-core`). */
export const RESOURCE_TYPES = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'other'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export const RESOURCE_TYPE_LABELS: Readonly<Record<ResourceType, string>> = {
  document: 'Document',
  script: 'Scripts',
  stylesheet: 'Stylesheets',
  image: 'Images',
  font: 'Fonts',
  fetch: 'Fetch / XHR',
  other: 'Other',
};

/**
 * How a request is classified, first match wins:
 * 1. the navigation itself, and `iframe` / `frame` initiators: `document`;
 * 2. `fetch`, `xmlhttprequest`, `beacon` and `eventsource` initiators: `fetch`;
 * 3. the response's MIME type, when the entry reports it (`contentType`; empty for cross-origin
 *    responses without `Timing-Allow-Origin`): `RESOURCE_MIME_TYPES`;
 * 4. the initiator: `script` → script; `img`, `image`, `input`, `icon` → image; `video`,
 *    `audio`, `track` → other;
 * 5. the URL's file extension: `RESOURCE_EXTENSIONS`;
 * 6. otherwise `other`.
 */
export const RESOURCE_FETCH_INITIATORS = ['fetch', 'xmlhttprequest', 'beacon', 'eventsource'] as const;
export const RESOURCE_DOCUMENT_INITIATORS = ['navigation', 'iframe', 'frame'] as const;
export const RESOURCE_MIME_TYPES: readonly { readonly match: RegExp; readonly type: ResourceType }[] = [
  { match: /^(text|application)\/(x-)?(javascript|ecmascript)$|^text\/jscript$|^application\/wasm$/, type: 'script' },
  { match: /^text\/css$/, type: 'stylesheet' },
  { match: /^image\//, type: 'image' },
  { match: /^font\/|^application\/(x-)?font-|^application\/vnd\.ms-fontobject$/, type: 'font' },
  { match: /^text\/html$|^application\/xhtml\+xml$/, type: 'document' },
];
export const RESOURCE_EXTENSIONS: Readonly<Record<string, ResourceType>> = {
  js: 'script',
  mjs: 'script',
  cjs: 'script',
  wasm: 'script',
  css: 'stylesheet',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  ico: 'image',
  bmp: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
  html: 'document',
  htm: 'document',
};

/**
 * MIME types that are text and compress well. A response of one of them (or classified `script`,
 * `stylesheet` or `document`) of at least `UNCOMPRESSED_MIN_BYTES` decoded, with an encoded size at
 * least its decoded size (or, where the entry reports it, an empty `contentEncoding`) was sent
 * uncompressed. Responses whose sizes are unavailable (cross-origin without `Timing-Allow-Origin`)
 * or that came from the cache without a size are never flagged.
 */
export const TEXT_MIME_TYPES = /^text\/|^application\/(json|(x-)?javascript|ecmascript|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|manifest\+json)$|^image\/svg\+xml$/;
export const UNCOMPRESSED_MIN_BYTES = 1_400;

/** The panel's lists: the largest resources and the uncompressed ones, and the third-party hosts shown. */
export const SPEED_PANEL_LIMITS = { largest: 10, uncompressed: 10, hosts: 8 } as const;

/**
 * First- or third-party: a request is first-party when its host has the page's registrable domain
 * (`static.example.com` and `shop.example.com` for a page on `www.example.com`; ports do not
 * matter). frost has no public-suffix list: the registrable domain is the host's last two labels,
 * or its last three when the last two are one of `MULTI_PART_SUFFIXES` (`example.co.uk`). That is
 * an approximation: suffixes it does not know (`github.io`, many country codes) make unrelated sites
 * look first-party to each other. An IP address or a single-label host is its own domain.
 */
export const THIRD_PARTY_RULE = 'registrable-domain' as const;
export const MULTI_PART_SUFFIXES: readonly string[] = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'co.za', 'org.za', 'gov.za',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'org.mx', 'gob.mx',
  'com.ar', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr', 'com.my', 'com.ph', 'com.vn', 'com.pl', 'com.ua', 'co.il', 'co.id', 'co.th',
];

// ---- Thresholds of the other rules -----------------------------------------------------------

/**
 * Page weight: the bytes of every request (each request's transfer size; for one answered from the
 * cache, its encoded body size), more than this is heavy. 3 MB is well above what a typical page
 * needs and slow on a mobile connection.
 */
export const PAGE_WEIGHT_WARN_BYTES = 3_000_000;

/** More requests than this is a lot for one page (each costs a round trip, or a slot on a connection). */
export const REQUEST_COUNT_WARN = 100;

/** More elements than this makes style, layout and script work on the DOM slower and costs memory. */
export const DOM_ELEMENTS_WARN = 1_500;

/** At most this many blocking `<head>` scripts are kept in the snapshot (`blockingScripts`; their total is counted). */
export const MAX_BLOCKING_SCRIPTS = 20;

// ---- Rules ----------------------------------------------------------------------------------

/**
 * How bands map to severities: a `poor` value is a **warning** (not an error: a lab value from one
 * visit is a strong hint, not proof, and the score should not treat it like a missing title); a
 * `needs-improvement` value is **info**; `good` passes. A metric that was not measured (no
 * interaction for INP, no paint reported, the page loaded in the background) passes: frost never
 * guesses a value.
 */
const LAB = 'Measured once, in this tab on this machine (lab data, not real visitors’ field data).';

function vitalRules<Id extends string>(metric: VitalMetric, id: Id, what: string, why: string, fix: string) {
  const { short } = VITAL_LABELS[metric];
  const { good, poor } = VITAL_THRESHOLDS[metric];
  const unit = metric === 'cls' ? '' : ' ms';
  return [
    {
      id: `${id}-poor` as `${Id}-poor`,
      category: 'performance',
      severity: 'warning',
      title: `${short} is poor`,
      condition: `The measured ${short} (${what}) is above ${poor}${unit}. ${LAB}`,
      why,
      fix,
    },
    {
      id: `${id}-needs-improvement` as `${Id}-needs-improvement`,
      category: 'performance',
      severity: 'info',
      title: `${short} needs improvement`,
      condition: `The measured ${short} is above ${good}${unit} and at most ${poor}${unit}. ${LAB}`,
      why,
      fix,
    },
  ] as const;
}

export const PERFORMANCE_RULE_SPECS = [
  ...vitalRules(
    'lcp',
    'lcp',
    'when the largest image or text block in the first viewport was painted',
    'The main content appearing late is what makes a page feel slow. LCP is one of the Core Web Vitals search engines use as a page experience signal.',
    'Make the largest element load first: serve the hero image small and in a modern format, preload it, don’t lazy-load it, and cut render-blocking CSS and scripts and server time before it.',
  ),
  ...vitalRules(
    'cls',
    'cls',
    'how much visible content moved unexpectedly while the page was open',
    'Content that jumps makes people lose their place or tap the wrong thing. CLS is one of the Core Web Vitals.',
    'Give images, videos, ads and embeds a width and height (or an aspect ratio), reserve space for late content, and don’t insert content above what is already shown.',
  ),
  ...vitalRules(
    'inp',
    'inp',
    'the slowest response to a click, tap or key press, measured from your interactions with the page',
    'A page that reacts late to input feels broken. INP is one of the Core Web Vitals.',
    'Break up long tasks, do less work in event handlers, defer non-essential scripts, and keep the DOM small so updates render fast.',
  ),
  ...vitalRules(
    'fcp',
    'fcp',
    'when the first text or image was painted',
    'Until something is painted people see a blank page and may leave. A late first paint usually means slow server time or render-blocking resources.',
    'Reduce server response time, inline the CSS the first view needs, and load other CSS and scripts without blocking rendering.',
  ),
  ...vitalRules(
    'ttfb',
    'ttfb',
    'how long until the first byte of the page’s HTML arrived, redirects included',
    'Everything else waits for the HTML. A slow server response delays every other metric.',
    'Cache pages at the server or a CDN, avoid redirects, and speed up the work done before the HTML is sent.',
  ),
  {
    id: 'page-weight-heavy',
    category: 'performance',
    severity: 'warning',
    title: 'Page is heavy',
    condition: `The page’s requests add up to more than ${PAGE_WEIGHT_WARN_BYTES / 1_000_000} MB (transfer sizes; a cached response counts at its encoded size). Cross-origin responses without Timing-Allow-Origin report no size and are not counted. ${LAB}`,
    why: 'Every byte has to be downloaded, which is slow and costly on mobile connections and data plans.',
    fix: 'Compress and resize images, serve modern formats, remove unused scripts and styles, and load what is below the fold only when needed.',
  },
  {
    id: 'request-count-high',
    category: 'performance',
    severity: 'warning',
    title: 'Page makes many requests',
    condition: `The page made more than ${REQUEST_COUNT_WARN} requests (the document included) by the time it was measured. ${LAB}`,
    why: 'Each request costs time and a connection slot, so many requests slow the page down, especially on high-latency networks.',
    fix: 'Combine small files, drop unused third-party tags, use image sprites or inline small icons, and lazy-load what is not needed at first.',
  },
  {
    id: 'dom-size-large',
    category: 'performance',
    severity: 'warning',
    title: 'DOM is large',
    condition: `The document has more than ${DOM_ELEMENTS_WARN} elements.`,
    why: 'A large DOM makes style calculation, layout and scripts slower and uses more memory, which hurts interaction responsiveness.',
    fix: 'Render long lists and hidden content on demand, flatten unnecessary wrapper elements, and paginate very long pages.',
  },
  {
    id: 'render-blocking-scripts',
    category: 'performance',
    severity: 'warning',
    title: 'Scripts block rendering',
    condition: 'A <script src> in <head> has neither async nor defer (and is not a module): the browser stops building the page until it is downloaded and run.',
    why: 'Nothing is painted while these scripts load and run, so the first paint and LCP are delayed by every one of them.',
    fix: 'Add defer (or async for independent scripts), move them to the end of <body>, or load them as modules.',
  },
  {
    id: 'uncompressed-text-resources',
    category: 'performance',
    severity: 'info',
    title: 'Text resources are not compressed',
    condition: `A text response (HTML, CSS, JavaScript, JSON, SVG …) of at least ${UNCOMPRESSED_MIN_BYTES.toLocaleString('en-US')} bytes was sent without compression (its encoded size is not below its decoded size, or it reports no content encoding).`,
    why: 'Text compresses to a fraction of its size with gzip or Brotli; sending it uncompressed wastes bandwidth and time.',
    fix: 'Enable gzip or Brotli on the server or CDN for text types.',
  },
] as const satisfies readonly SeoRuleSpec[];

export type PerformanceRuleId = (typeof PERFORMANCE_RULE_SPECS)[number]['id'];

/** The rules read from the page's snapshot (the extractor), not from the measurement: the Speed panel takes them from the audit. */
export const SNAPSHOT_PERFORMANCE_RULES = ['render-blocking-scripts'] as const satisfies readonly PerformanceRuleId[];

/** What the Speed panel says about the data (frost's own wording). */
export const LAB_DATA_NOTE =
  'Lab data: one visit, measured in this tab on this machine, with its cache, network and CPU. Real visitors’ experience (field data) can be very different.';
export const INP_HINT = 'Interact with the page to measure INP';
export const SIZE_UNAVAILABLE_LABEL = 'size unavailable';
/**
 * Cross-origin responses report sizes (and most timings) only when the server sends
 * `Timing-Allow-Origin`; without it the Performance API gives 0, which frost shows as "size
 * unavailable" and leaves out of byte totals.
 */
export const SIZE_UNAVAILABLE_NOTE = 'Cross-origin responses without a Timing-Allow-Origin header report no size to the page, so they are not in the byte totals.';
export const IFRAME_NOTE = 'Requests made inside iframes are not counted.';
export const BUFFER_FULL_NOTE = 'The browser’s request log was full: some requests may be missing (approximate if the page changed its buffer size). Re-measure to see them all.';
export const LOW_RESOURCES_NOTE = 'Fewer requests than this page’s elements suggest: it may have cleared its timing entries before frost started measuring, or loaded them from the memory cache. Re-measure to see them.';
/** The vitals belong to the page load (the hard navigation), never to an in-page route change. */
export const SINCE_LOAD_LABEL = 'Since the page loaded';
export const SOFT_NAVIGATION_NOTE =
  'This address was reached inside the page (a route change): the vitals and navigation timing belong to the page load; the requests are counted since the route changed.';
export const LOADED_HIDDEN_HINT = 'Loaded in a background tab: re-measure to see it';
export const WAYLAND_HINT = 'Not reported under native Wayland';
/** Where the panel's numbers come from: the live measurement, or the one taken with the audit (which the health score and the rail dot always use). */
export const SPEED_SOURCE_LABELS = { live: 'Live', audit: 'At audit time' } as const;
export const SCORE_SOURCE_NOTE = 'The health score and the rail dot use the measurement taken with the audit.';
