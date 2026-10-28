// The read-only data ports the SERP, intent and GSC tools run over (Phase 5 Task 1, plan decision
// 4; acceptance `specs/agent-protocol.feature.md`). Phases 3 and 4 export Zod-typed read APIs
// (`packages/ipc-contract/src/serp-service.ts`, `gsc-service.ts`); main adapts each to its port
// with a thin mapping. Until one is wired, main passes `unavailablePort(reason)` and the tool
// answers `unavailable`. Every query is read-only: no port changes anything anywhere, and each
// takes an optional `{ signal }` so a stopped chat abandons it.
import { AGENT_PROTOCOL_LIMITS } from '@app/specs/agent-protocol.schema';

/** A port's answer: the data, or why there is none (shown to the model as an `unavailable` result). */
export type PortAnswer<T> = { readonly status: 'ok'; readonly data: T } | { readonly status: 'unavailable'; readonly reason: string };

/** Options every port query takes. */
export interface PortQueryOptions {
  /** Aborted when the chat stops: the port may give up, rejecting with `signal.reason`. */
  readonly signal?: AbortSignal;
}

/**
 * The `unavailable` answer. `reason` reaches the model as a failed tool result's message, so it is
 * cut to that message's cap (`AGENT_PROTOCOL_LIMITS.maxErrorChars`), never splitting a surrogate pair.
 */
export function unavailable(reason: string): PortAnswer<never> {
  return { status: 'unavailable', reason: capChars(reason, AGENT_PROTOCOL_LIMITS.maxErrorChars) };
}

function capChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.charCodeAt(max - 1);
  // Don't end on the first half of a surrogate pair.
  return text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? max - 1 : max);
}

// ---- SERP ------------------------------------------------------------------------------------

export interface SerpQuery {
  readonly query: string;
  /** BCP 47 language and optional region (`en-US`); the service's default when absent. */
  readonly locale?: string;
  /** Which results; `desktop` when absent. */
  readonly device?: 'desktop' | 'mobile';
}

export interface SerpResult {
  /** 1-based organic position. */
  readonly position: number;
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

export interface SerpResults {
  readonly query: string;
  readonly locale: string | null;
  readonly device: 'desktop' | 'mobile';
  /** When the results were read (ISO 8601). */
  readonly fetchedAt: string;
  readonly results: readonly SerpResult[];
  /** Result features shown beside the organic results (answer boxes, questions, videos…), by name. */
  readonly features: readonly string[];
}

export interface AiSearchQuery {
  readonly query: string;
  readonly locale?: string;
}

export interface AiSearchAnswer {
  readonly query: string;
  /** The answer's text. */
  readonly answer: string;
  /** The sources the answer cited, in order. */
  readonly citations: readonly { readonly url: string; readonly title: string }[];
  readonly fetchedAt: string;
}

export interface SerpPort {
  /** The organic results for a query (`serp_results`). */
  results(query: SerpQuery, options?: PortQueryOptions): Promise<PortAnswer<SerpResults>>;
  /** An AI answer engine's answer and citations for a query (`run_ai_search`). */
  aiSearch(query: AiSearchQuery, options?: PortQueryOptions): Promise<PortAnswer<AiSearchAnswer>>;
}

// ---- Intent ----------------------------------------------------------------------------------

export const SEARCH_INTENTS = ['informational', 'navigational', 'commercial', 'transactional'] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

export interface IntentQuery {
  readonly query: string;
}

export interface IntentClassification {
  readonly query: string;
  /** The most likely intent. */
  readonly primary: SearchIntent;
  /** Each intent's confidence, 0 to 1, most likely first. */
  readonly intents: readonly { readonly intent: SearchIntent; readonly confidence: number }[];
}

export interface IntentPort {
  /** What a searcher wants from a query (`search_intent`). */
  classify(query: IntentQuery, options?: PortQueryOptions): Promise<PortAnswer<IntentClassification>>;
}

// ---- GSC -------------------------------------------------------------------------------------

export interface GscPerformanceQuery {
  /** The page (main fills in the current tab's when the model gives none). */
  readonly url: string;
  /** Days back from the latest data. */
  readonly days: number;
}

export interface GscQueryRow {
  readonly query: string;
  readonly clicks: number;
  readonly impressions: number;
  /** Clicks over impressions, 0 to 1. */
  readonly ctr: number;
  /** Average position, 1-based. */
  readonly position: number;
}

export interface GscPerformance {
  readonly url: string;
  readonly days: number;
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  /** Average position; `null` with no impressions. */
  readonly position: number | null;
  /** The page's top queries, most clicks first. */
  readonly queries: readonly GscQueryRow[];
}

export interface GscPort {
  /** A page's search performance over the last `days` (`gsc_performance`). */
  performance(query: GscPerformanceQuery, options?: PortQueryOptions): Promise<PortAnswer<GscPerformance>>;
}

// ---- Not wired -------------------------------------------------------------------------------

/**
 * A port standing in for any of the three when its source isn't connected: every query answers
 * `unavailable` with `reason` (capped), at once, whatever its signal.
 */
export function unavailablePort(reason: string): SerpPort & IntentPort & GscPort {
  const answered = unavailable(reason);
  const answer = async (): Promise<PortAnswer<never>> => answered;
  return { results: answer, aiSearch: answer, classify: answer, performance: answer };
}
