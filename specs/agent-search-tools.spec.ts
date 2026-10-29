/**
 * The agent's search tools over the read-only data ports (Phase 5 Task 8, plan decision 4;
 * acceptance `agent-search-tools.feature.md`): `serp_results` → `SerpPort.results`, `run_ai_search`
 * → `SerpPort.aiSearch`, `search_intent` → `IntentPort.classify`, `gsc_performance` →
 * `GscPort.performance` (`@app/ai-skills` ports). Plain values with no imports beyond the Zod-free
 * agent specs.
 *
 * What the model reads:
 * - a port's `ok` answer, mapped to bounded data (`SEARCH_TOOL_LIMITS`: the top results, trimmed
 *   text, finite numbers; each list says how many there were);
 * - a port's `unavailable` answer as data `{ unavailable: <reason> }` (the reason cleaned and cut to
 *   `maxReasonChars`), so the model can tell the user why. The broker's tool errors carry fixed
 *   messages only (Task 4), and this keeps the port's words inside the untrusted wrapper;
 * - a tool error: `unavailable` when no port is wired at all, `timeout` past
 *   `SEARCH_TOOL_TIMEOUT_MS`, `failed` when the port throws, is stopped or answers something
 *   malformed.
 *
 * `gsc_performance` reads the site owner's data for one public page: its `url` (the chat tab's page
 * when the model gives none, filled in by main's broker as the call arrives, so the approval card
 * and its input hash show the page that will be read: `completeToolInput`) is stripped of user info
 * and fragment, and a page that isn't public (`isPublicPage`) is refused as data
 * (`GSC_NOT_PUBLIC_REASON`) without asking the port.
 */
import { isPublicPage } from './agent-approvals.spec';
import { modelPageUrl } from './agent-page-tools.spec';
import { AGENT_TOOL_INPUT_LIMITS, TOOL_RESULT_MAX_CHARS } from './agent-tools.spec';

/** The tools this covers (`AGENT_TOOL_NAMES`' search tools). */
export const SEARCH_TOOL_NAMES = ['serp_results', 'search_intent', 'run_ai_search', 'gsc_performance'] as const;
export type SearchToolName = (typeof SEARCH_TOOL_NAMES)[number];

export function isSearchToolName(name: unknown): name is SearchToolName {
  return typeof name === 'string' && (SEARCH_TOOL_NAMES as readonly string[]).includes(name);
}

/** How long a port query may take before the tool answers `timeout` (milliseconds); the port's signal is aborted then. */
export const SEARCH_TOOL_TIMEOUT_MS = 30_000;

/** The bounds of what the model reads from a port (counts, and characters). */
export const SEARCH_TOOL_LIMITS = {
  /** `serp_results`: organic results kept, and result features. */
  maxSerpResults: 10,
  maxSerpFeatures: 20,
  maxFeatureChars: 64,
  /** A result's or citation's URL, title and snippet. */
  maxUrlChars: 500,
  maxTitleChars: 300,
  maxSnippetChars: 500,
  /** `run_ai_search`: the answer's text and the citations kept. */
  maxAnswerChars: 8000,
  maxCitations: 20,
  /** `search_intent`: intents listed (one per `SEARCH_INTENTS` value at most). */
  maxIntents: 4,
  /** `gsc_performance`: top queries kept. */
  maxGscQueries: 25,
  /** A query echoed back, a locale, a timestamp. */
  maxQueryChars: AGENT_TOOL_INPUT_LIMITS.maxQueryChars,
  maxShortChars: 64,
  /** An `unavailable` answer's reason. */
  maxReasonChars: 500,
  /**
   * The JSON text a tool's data trims itself to (characters), under `TOOL_RESULT_MAX_CHARS` so the
   * untrusted wrapper never cuts it: list entries are dropped from the end (the total stays), then
   * the AI answer's text is cut.
   */
  budgetChars: TOOL_RESULT_MAX_CHARS - 2_000,
} as const;

/** Each tool's result `source` (the untrusted wrapper's). */
export const SEARCH_TOOL_SOURCES: Readonly<Record<SearchToolName, string>> = {
  serp_results: 'search:results',
  search_intent: 'search:intent',
  run_ai_search: 'search:ai-answer',
  gsc_performance: 'search:site-owner-data',
};

/**
 * The reasons main's default ports answer until the lead wires Phases 3 and 4 (each tool then says
 * this to the model as `{ unavailable: <reason> }`).
 */
export const PORT_NOT_CONNECTED_REASONS = {
  serp: "Search result data isn't connected in this build.",
  intent: "Search intent data isn't connected in this build.",
  gsc: "Search performance data from the site owner's account isn't connected in this build.",
  probes: "Visibility probes aren't connected in this build.",
} as const;

/** `gsc_performance` with no `url` when the chat's tab shows no web page. */
export const GSC_NO_PAGE_REASON = "The chat's tab shows no web page, so there is no page to look up. Give the page's address.";
/** `gsc_performance` for a page that isn't on a public host (a local or private address). */
export const GSC_NOT_PUBLIC_REASON = 'Search performance data is only read for public web pages, and this address is not one.';

/** The page `gsc_performance` reads for `url`: the URL the model sees (`modelPageUrl`), or `null`. */
export function gscPageUrl(url: unknown): string | null {
  return modelPageUrl(url);
}

/** Whether `gsc_performance` may read `url` (`gscPageUrl` of it is a public page). */
export function isGscReadablePage(url: unknown): boolean {
  const page = gscPageUrl(url);
  return page !== null && isPublicPage(page);
}

/**
 * A tool call's input with the defaults main fills in as the call arrives (before the broker parses,
 * shows and hashes it), so what is approved is what runs: `gsc_performance` without a `url` gets the
 * chat tab's page (`gscPageUrl(tabUrl)`, when the tab shows a web page) and without `days`
 * `defaultGscDays`. Any other input is returned as it is (the tool's schema still checks it).
 */
export function completeToolInput(toolName: string, input: unknown, tabUrl: string | null): unknown {
  if (toolName !== 'gsc_performance' || typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const given = input as Record<string, unknown>;
  const page = Object.hasOwn(given, 'url') ? null : gscPageUrl(tabUrl);
  return {
    ...given,
    ...(page !== null ? { url: page } : {}),
    ...(Object.hasOwn(given, 'days') ? {} : { days: AGENT_TOOL_INPUT_LIMITS.defaultGscDays }),
  };
}

// ---- Visibility probes (Phase 3's `SerpReadApi.probes` / `runProbes`) -------------------------

/**
 * `visibility_probes` (read: the chat tab's last probe run, `probes(tabId)`, never fetching) and
 * `run_visibility_probes` (act: `runProbes(tabId)`, which fetches the tab's page as frost's browser
 * and as each search and AI crawler Phase 3 models, and reads robots.txt). Both are page tools: the
 * run's page must be the expected one (an approved run: exactly the approved page), and Phase 3 runs
 * probes only for the **active** tab, so a chat whose tab isn't on screen is told so.
 */
export const PROBE_TOOL_NAMES = ['visibility_probes', 'run_visibility_probes'] as const;

export const PROBE_TOOL_LIMITS = {
  /** How long `run_visibility_probes` waits for the run to finish before answering how far it got (milliseconds). */
  waitMs: 30_000,
  /** How often it looks (milliseconds). */
  pollMs: 500,
  /** Characters of a row's title, URL and canonical. */
  maxTitleChars: 200,
  maxUrlChars: 500,
  /** Directives listed per agent. */
  maxDirectives: 16,
} as const;

export const PROBE_TOOL_SOURCE = 'frost:visibility-probes';

/** Why there is nothing to read or run (frost's own words, said as data). */
export const PROBE_TOOL_REASONS = {
  notActive: "frost runs probes only for the tab on screen, and the chat's tab is not it. Ask the user to switch back to it.",
  idle: 'No probe run for this page yet. run_visibility_probes starts one (the user is asked first).',
  otherPage: 'The last probe run was for another page.',
} as const;

