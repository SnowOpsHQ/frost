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
 */
import { AGENT_TOOL_INPUT_LIMITS } from './agent-tools.spec';

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
  maxUrlChars: AGENT_TOOL_INPUT_LIMITS.maxUrlChars,
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
} as const;

/** `gsc_performance` with no `url` when the chat's tab shows no web page. */
export const GSC_NO_PAGE_REASON = "The chat's tab shows no web page, so there is no page to look up. Give the page's address.";
