/**
 * The agent's core page tools (Phase 5 Task 5; acceptance `agent-page-tools.feature.md`): the
 * isolated worlds they run in, their time limits, and how much each one hands the model. Plain
 * values and pure functions (no Zod), used by main's page tool runner
 * (`apps/desktop/src/main/agent/tools/`).
 *
 * The page is untrusted: every script answer is parsed and checked in main, every list and string is
 * capped while the page is read, and every tool checks, inside its own isolated world, that the page
 * is still the one the broker decided on (`ToolRunContext.expectedOrigin` / `expectedUrl`) before
 * it reads or acts.
 */
import { AGENT_TOOL_INPUT_LIMITS, EXECUTE_JS_MAX_RESULT_BYTES, TOOL_RESULT_MAX_CHARS } from './agent-tools.spec';
import { SOCIAL_TAGS } from './seo-limits.spec';
import { parseWebUrl } from './web-url.spec';

// ---- Isolated worlds -------------------------------------------------------------------------

/**
 * The isolated world `click` and `page_text` run in (`executeJavaScriptInIsolatedWorld`). frost's
 * own fixed scripts only: no model- or user-written code ever runs here. Its own world, apart from
 * the page's main world (`0`), Electron's (`999`) and every SEO world (`SEO_WORLD_ID` 1207,
 * `A11Y_WORLD_ID` 1216, `SPEED_WORLD_ID` 1250), the full-screen exit's (1001) and the other phases'
 * (SERP 1301, capture 1600). The id must be in `1…536870911`.
 */
export const AGENT_PAGE_WORLD_ID = 1_500;

/**
 * The isolated world `execute_javascript` runs approved code in: dedicated to it, never the main
 * world, never an SEO world, never `AGENT_PAGE_WORLD_ID`. Code shares the page's DOM but not its
 * JavaScript globals.
 *
 * **Code approved on a page runs alongside the code approved earlier on that page** (the same
 * document): what one run leaves in this world (a variable, a timer, a changed built-in) stays for
 * the document's lifetime, as in a console, and the next run sees it. frost's own wrapper is kept
 * out of reach of it: on its first run in a document it stores the world's original built-ins in a
 * non-writable, non-configurable global (`EXECUTE_JS_VAULT_KEY`) and every later run uses only
 * those, so earlier code can't change which code runs, the page check, or how the result is written
 * and capped. It can still change the built-ins the approved code itself computes with (a run's
 * own `await` or returned promise included). Task 6's approval card says so: "Runs alongside any
 * code you allowed earlier on this page."
 */
export const AGENT_JS_WORLD_ID = 1_501;

/** World ids the agent's tools must never use: the main world, Electron's own, and every other frost world. */
export const NON_AGENT_WORLD_IDS: readonly number[] = [0, 999, 1_001, 1_207, 1_216, 1_250, 1_301, 1_600];

// ---- Time --------------------------------------------------------------------------------------

/** How long main waits for `click`'s or `page_text`'s script (milliseconds): `timeout` after it. */
export const PAGE_SCRIPT_TIMEOUT_MS = 3_000;

/**
 * How long `navigate` waits for the load to settle (`did-stop-loading` after the navigation started)
 * before it answers with what the tab shows by then (`settled: false`).
 */
export const NAVIGATE_SETTLE_TIMEOUT_MS = 15_000;

// ---- Sizes -------------------------------------------------------------------------------------

/** `click`'s bounds: elements scanned for visible text, and what it reports of the element. */
export const CLICK_LIMITS = {
  /** Clickable elements (`CLICKABLE_SELECTOR`) a text search reads, in document order. */
  maxScanElements: 2_000,
  /** Text nodes read for one element's name. */
  maxNameNodeVisits: 200,
  /** Characters of one element's name read (and reported). */
  maxNameChars: 160,
  /** Characters of a link's `href` reported. */
  maxHrefChars: 512,
} as const;

/**
 * What a text search for `click` considers clickable: links, buttons and button-like inputs,
 * disclosure summaries, labels, elements with a clickable ARIA role, and elements with a click
 * handler attribute or a non-negative `tabindex`.
 */
export const CLICKABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="image"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** `page_text`: its default length (the input's `maxChars` caps it, at most `TOOL_RESULT_MAX_CHARS`). */
export const PAGE_TEXT_DEFAULT_CHARS = AGENT_TOOL_INPUT_LIMITS.defaultPageTextChars;

/** `execute_javascript`'s result bounds (the result's UTF-8 JSON is cut at `EXECUTE_JS_MAX_RESULT_BYTES`). */
export const EXECUTE_JS_LIMITS = {
  maxResultBytes: EXECUTE_JS_MAX_RESULT_BYTES,
  /** Nesting serialised before a value is written `"[Too deep]"`. */
  maxDepth: 24,
  /** Characters of a thrown error reported (`name: message`). */
  maxErrorChars: 500,
  /** Characters of a DOM node's description (`<a id="…" class="…">`). */
  maxNodeChars: 200,
  /**
   * Longest answer the wrapper hands back (characters; its last step checks the answer's `length`,
   * else answers a fixed error): the result's JSON at the byte cap with every character escaped
   * (`\u00XX`, six characters each), plus the envelope.
   */
  maxAnswerChars: 6 * EXECUTE_JS_MAX_RESULT_BYTES + 1_024,
} as const;

/**
 * The global (in `AGENT_JS_WORLD_ID` only, non-writable and non-configurable) that holds the world's
 * original built-ins from frost's first run there in a document; every later run reads them from it.
 */
export const EXECUTE_JS_VAULT_KEY = '__frostAgentIntrinsics';

/**
 * The global name `execute_javascript`'s wrapper defines for one script evaluation, to tell a script
 * that failed to parse from one that threw while running (a parse failure falls back to running the
 * code as a function body; a run never repeats). Random per call (`id`: main's `randomUUID()`), so
 * the code can't declare it and shadow it.
 */
export function executeMarkKey(id: string): string {
  return `__frostRunMark_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
}

/**
 * What `page_audit` and `page_data` hand the model. They summarise main's audit (never the page
 * itself) and trim themselves to `budgetChars` of JSON text (least severe findings dropped first),
 * so the broker's hard cap (`TOOL_RESULT_MAX_CHARS`) rarely cuts them.
 */
export const PAGE_AUDIT_LIMITS = {
  /** JSON text a summary trims itself to (characters). */
  budgetChars: TOOL_RESULT_MAX_CHARS - 2_000,
  /** Findings listed, most severe first (the audit's order). */
  maxFindings: 60,
  /** Characters of a finding's title, why and fix each. */
  maxFindingTextChars: 320,
  /** Facts (label: value) per finding. */
  maxFindingFacts: 4,
  /** Sample values per finding, and characters of each. */
  maxFindingSamples: 3,
  maxSampleChars: 200,
  /** Headings in `page_data`'s outline, and characters of each. */
  maxHeadings: 60,
  maxHeadingChars: 160,
  /** Characters of the title, the description, the robots line and other page strings. */
  maxFactChars: 400,
  /** URLs (canonical, hreflang targets) reported, characters each. */
  maxUrlChars: 512,
  /** Distinct structured-data types listed. */
  maxSchemaTypes: 30,
  /** Hreflang annotations listed. */
  maxHreflang: 20,
  /** Indexability reasons listed. */
  maxReasons: 6,
  /**
   * `page_data`'s internal links (Task 7 review: the link skill needs them): distinct addresses
   * (fragment dropped) in page order, each with its anchor text, at most this many, the list's JSON
   * trimmed to `internalLinksBudgetChars`; the total counted says how many there were.
   */
  maxInternalLinks: 40,
  maxLinkTextChars: 100,
  internalLinksBudgetChars: 8_000,
  /**
   * `page_data`'s social tags (Phase 8 Task 3): every social sharing tag the snapshot holds
   * (`SOCIAL_TAGS`, one entry each, `null` when the page has none), each value cut to `maxFactChars`.
   */
  maxSocialFields: SOCIAL_TAGS.length,
  /**
   * `page_data`'s content summary lists at most this many of the Content panel's difficult sentences
   * (the report holds up to `SENTENCE_LIMITS.maxDifficultSentences`), each excerpt cut to `maxFactChars`.
   */
  maxDifficultSentencesForModel: 5,
} as const;

/**
 * How `page_data` trims itself to `PAGE_AUDIT_LIMITS.budgetChars` of JSON text (Phase 8 Task 3
 * review): the lowest-value list first, each one cut from its end until the output fits or the list
 * is empty, then the next. The guarantee holds for any page (every string counted as JSON, escapes
 * included). The heading outline reports what it dropped in `headings.omitted`, the internal links
 * in `internalLinks.omitted`; the others in `trimmed` (name: entries left out; absent when nothing
 * was cut). Social fields go from the end of `SOCIAL_TAGS`.
 */
export const PAGE_DATA_TRIM_ORDER = ['outline', 'hreflang', 'difficultSentences', 'social', 'internalLinks', 'schemaTypes', 'reasons'] as const;
export type PageDataTrimStep = (typeof PAGE_DATA_TRIM_ORDER)[number];

/** Characters of a page title any tool reports. */
export const PAGE_TITLE_MAX_CHARS = 300;

// ---- Pages -------------------------------------------------------------------------------------

// What the page checks and the redirect cancel are, and are not:
// - the exact-URL check (approved calls) is a **staleness guard**: it stops an approved call from
//   acting on a page the tab moved to after the user saw the request. It is not a boundary against
//   the page itself, which controls its own URL (`history.pushState`) and DOM;
// - cancelling a granted navigate's off-origin redirect is a **partial exfiltration guard**: a
//   granted site can't bounce the tab (and what the URL carries) to another site through a server
//   redirect of the agent's own navigation. The page can still send data elsewhere by its own
//   means (its scripts, links the agent clicks).

/**
 * The page a script checks for, written as the page itself can read it with nothing but
 * unforgeable `Location` attributes and string concatenation (`location.origin +
 * location.pathname + location.search`): `url` without its fragment and without user info.
 * `null` for anything but an `http(s)` URL.
 */
export function pageKeyOf(url: unknown): string | null {
  const parsed = parseWebUrl(url);
  return parsed === null ? null : parsed.origin + parsed.pathname + parsed.search;
}

/** A tool result's `source` for a page on `origin`. */
export function pageSource(origin: string): string {
  return `page:${origin}`;
}

/**
 * A page's URL as the model is told it (`page_audit`, `page_data`, `navigate`'s answer,
 * `gsc_performance`'s page): an `http(s)` URL without user info or fragment; `null` for anything else.
 * One helper, so no tool hands the model a `user:password@` part or a fragment another doesn't.
 */
export function modelPageUrl(url: unknown): string | null {
  const parsed = parseWebUrl(url);
  if (parsed === null) return null;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href;
}
