/**
 * `run_ai_search` through the providers' APIs on the user's own key (Phase 12 Task 8; plan
 * `docs/plans/phase-12-big-bets.md`, Decisions 3 (K-C1), 4 and 8, Global constraints "Untrusted text"
 * and "Approvals", the Threat model's AI-answer rows, and the lead's legal-gate rulings in "As
 * built"; acceptance `ai-search.feature.md`; Zod side `ai-search.schema.ts`). Plain values, no Zod.
 *
 * - **Engines and vias.** The model may name an engine (`AI_SEARCH_ENGINES`); how it is reached
 *   (`via`) is the user's setting per engine, never the model's. In this phase the only via is `api`
 *   (`AI_SEARCH_VIAS`; signed-in tabs are the deferred proposal D1): Perplexity's Sonar API for
 *   `perplexity`, OpenAI Responses with its web-search tool for `chatgpt` (labelled "OpenAI web search
 *   — may differ from the ChatGPT app"). `google-ai-mode` has no API (Q8), so it is never usable here.
 * - **Usable.** An engine's `api` via is usable only when its provider's legal gate is open
 *   (`AI_SEARCH_PROVIDER_AVAILABLE`, read through main's `legalGates.isOpen`), its key is set, and its
 *   via setting is not `off` (`aiSearchVia`). As shipped both gates are closed: `run_ai_search` is
 *   answered as data (`not-available`, `LEGAL_GATE_NOTE`) when it arrives, with no approval card.
 * - **What is approved is what runs.** `resolveAiSearch` (pure) picks the engine and via at the
 *   moment the call arrives; `completeToolInput` (`agent-search-tools.spec.ts`) writes both into the
 *   input main shows, hashes and runs (any `via` the model sent is dropped first). At run time main
 *   resolves the engine's via again: a different one answers `expired` (`setting-changed`) and sends
 *   nothing.
 * - **Bounds.** At most `maxCallsPerTurn` calls per turn and one call per engine every
 *   `perEngineCooldownMs` across turns (`AI_SEARCH_LIMITS`), so a looping model can neither run up a
 *   bill nor look like automation. The request body is fixed (`aiSearchRequestBody`): only the query
 *   and an allowlisted model vary. The answer is parsed in the SERP worker (size and depth before
 *   `JSON.parse`, strict capped schemas), citations kept as `http(s)` only, deduplicated, at most
 *   `maxCitations`, and it reaches the model only inside the untrusted wrapper
 *   (`SEARCH_TOOL_SOURCES.run_ai_search`, `search:ai-answer`).
 *
 * Provider documentation (K-C1, Q4), read on 2026-11-10:
 * - Perplexity: https://docs.perplexity.ai/api-reference/sonar-post — `POST
 *   https://api.perplexity.ai/v1/sonar` (Bearer), body `{ model: 'sonar', messages: [{ role, content }] }`;
 *   the answer is `choices[0].message.content`, the sources are top-level `citations` (URL strings) and
 *   `search_results` (`title`, `url`, `date`, `snippet` …). **Structured citations: yes** (kept).
 *   The same page says Sonar's chat-completions support ended on 2026-09-27 and that synchronous
 *   Sonar requests keep working, reformulated as Agent API requests; the Agent API
 *   (https://docs.perplexity.ai/api-reference/agent-post, `POST /v1/agent`, sources as `url_citation`
 *   annotations and `search_results` output items) would be a reviewed change to `DATA_API_REQUESTS`.
 *   Only `sonar` is pinned: the page shows no other model name.
 * - OpenAI: https://developers.openai.com/api/docs/guides/tools-web-search (redirected from
 *   platform.openai.com) — Responses with `tools: [{ type: 'web_search' }]` (the legacy
 *   `web_search_preview` is not used); the answer is the `message` output item's `output_text`
 *   content, its sources `annotations` of type `url_citation` (`url`, `title`, `start_index`,
 *   `end_index`). **Structured citations: yes** (kept). `gpt-5` needs reasoning effort above
 *   `minimal`; `tool_choice: 'required'` makes the search run. The API reference itself
 *   (`/v1/responses`, `store`) answered 403 on Task 1's read and is still **unverified** here; `store:
 *   false` is the documented Responses field name frost already sends on the agent's own route.
 * K-C1 drops neither provider: both return citations as structured fields, not prose only.
 */
import { DATA_AI_SEARCH_PROVIDERS, DATA_API_LIMITS, DATA_PROVIDER_LABELS, LEGAL_GATE_NOTE } from './data-sources.spec';
import { AGENT_TOOL_INPUT_LIMITS, UNSAFE_INPUT_CHARS } from './agent-tools.spec';

// ---- Engines, vias and providers ----------------------------------------------------------------

/** The AI answer engines the model may name (plan Decision 8). */
export const AI_SEARCH_ENGINES = ['perplexity', 'chatgpt', 'google-ai-mode'] as const;
export type AiSearchEngine = (typeof AI_SEARCH_ENGINES)[number];

export function isAiSearchEngine(value: unknown): value is AiSearchEngine {
  return typeof value === 'string' && (AI_SEARCH_ENGINES as readonly string[]).includes(value);
}

/** How an engine is reached. Only `api` in this phase (`tab` is the deferred proposal D1). */
export const AI_SEARCH_VIAS = ['api'] as const;
export type AiSearchVia = (typeof AI_SEARCH_VIAS)[number];

export function isAiSearchVia(value: unknown): value is AiSearchVia {
  return typeof value === 'string' && (AI_SEARCH_VIAS as readonly string[]).includes(value);
}

/** What an engine's via setting may hold: a via, or `off` (the engine is never used). */
export const AI_SEARCH_VIA_SETTINGS = ['api', 'off'] as const;
export type AiSearchViaSetting = (typeof AI_SEARCH_VIA_SETTINGS)[number];

export function isAiSearchViaSetting(value: unknown): value is AiSearchViaSetting {
  return typeof value === 'string' && (AI_SEARCH_VIA_SETTINGS as readonly string[]).includes(value);
}

/** The AI search data providers (`DATA_AI_SEARCH_PROVIDERS`). */
export type AiSearchProvider = (typeof DATA_AI_SEARCH_PROVIDERS)[number];

export function isAiSearchProvider(value: unknown): value is AiSearchProvider {
  return typeof value === 'string' && (DATA_AI_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/** Each engine's `api` provider; `null`: no API in this phase (`google-ai-mode`, Q8). */
export const AI_SEARCH_API_PROVIDER: Readonly<Record<AiSearchEngine, AiSearchProvider | null>> = {
  perplexity: 'perplexity',
  chatgpt: 'openai-search',
  'google-ai-mode': null,
};

/** Each engine in words (text labels only, L7). */
export const AI_SEARCH_ENGINE_LABELS: Readonly<Record<AiSearchEngine, string>> = {
  perplexity: 'Perplexity',
  chatgpt: 'OpenAI web search — may differ from the ChatGPT app',
  'google-ai-mode': 'Google AI Mode',
};

/** Each via in words. */
export const AI_SEARCH_VIA_LABELS: Readonly<Record<AiSearchVia, string>> = { api: 'API' };

/** What an answer says beside itself (the answer data's `note`): which engine, reached how. */
export function aiSearchAnswerNote(engine: AiSearchEngine, via: AiSearchVia): string {
  const provider = AI_SEARCH_API_PROVIDER[engine];
  return `Answered by ${AI_SEARCH_ENGINE_LABELS[engine]} through ${provider === null ? 'its' : DATA_PROVIDER_LABELS[provider]} ${AI_SEARCH_VIA_LABELS[via]}, on the user's own key. An API answer may differ from what the engine's own app shows.`;
}

// ---- The fixed request bodies (K-C1, Q4) ---------------------------------------------------------

/** The models frost may ask per provider (first: the one it asks). Changing it is a reviewed spec change. */
export const AI_SEARCH_MODELS: Readonly<Record<AiSearchProvider, readonly string[]>> = {
  perplexity: ['sonar'],
  'openai-search': ['gpt-5-mini', 'gpt-5'],
};

/** Whether `model` is on `provider`'s allowlist. */
export function isAiSearchModel(provider: AiSearchProvider, model: unknown): model is string {
  return typeof model === 'string' && AI_SEARCH_MODELS[provider].includes(model);
}

/**
 * The request body main sends for `query` (a JSON value; the client sends its JSON text). Fixed but
 * for the query and an allowlisted model (default: the provider's first). `null` for a model off the
 * list or a query that is empty, longer than `AGENT_TOOL_INPUT_LIMITS.maxQueryChars` or holds an
 * unsafe character. There is no locale: neither body takes one in v1, so the tool's input has none
 * either (Task 8 review).
 * - Perplexity: `{ model, messages: [{ role: 'user', content: query }], stream: false }`;
 * - OpenAI: `{ model, input: query, tools: [{ type: 'web_search' }], tool_choice: 'required',
 *   reasoning: { effort: 'low' }, store: false, stream: false }`.
 */
export function aiSearchRequestBody(provider: AiSearchProvider, query: unknown, model: string = AI_SEARCH_MODELS[provider]![0]!): Record<string, unknown> | null {
  if (!isAiSearchProvider(provider) || !isAiSearchModel(provider, model)) return null;
  if (typeof query !== 'string' || query.trim() === '' || query.length > AGENT_TOOL_INPUT_LIMITS.maxQueryChars || UNSAFE_INPUT_CHARS.test(query)) return null;
  if (provider === 'perplexity') return { model, messages: [{ role: 'user', content: query }], stream: false };
  return { model, input: query, tools: [{ type: 'web_search' }], tool_choice: 'required', reasoning: { effort: 'low' }, store: false, stream: false };
}

// ---- Limits -------------------------------------------------------------------------------------

export const AI_SEARCH_LIMITS = {
  /** `run_ai_search` calls handed to a provider in one turn of one chat, at most; more answer `capped`. */
  maxCallsPerTurn: 2,
  /** The least time between two calls to one engine, across turns (ms); sooner answers `cooldown`. */
  perEngineCooldownMs: 20_000,
  /** The provider's answer, at most (bytes, UTF-8): the client's cap, checked again before `JSON.parse`. */
  maxResponseBytes: DATA_API_LIMITS.maxResponseBytes,
  /** Nesting of arrays and objects in the answer, at most; checked on the text before `JSON.parse`. */
  maxDepth: 32,
  /** Entries in any array read (choices, output items, content parts, annotations, sources), at most. */
  maxItems: 200,
  /** A provider string read (the answer's text included), at most (UTF-16 code units). */
  maxStringChars: 200_000,
  // The next four equal `SEARCH_TOOL_LIMITS`' (`agent-search-tools.spec.ts`, which imports this file,
  // so they are written out here; a test keeps them equal).
  /** The answer's text kept (characters; `SEARCH_TOOL_LIMITS.maxAnswerChars`). */
  maxAnswerChars: 8000,
  /** Citations kept, after `http(s)` filtering and de-duplication (`SEARCH_TOOL_LIMITS.maxCitations`). */
  maxCitations: 20,
  /** A citation's URL (longer ones are dropped) and title (cut): `SEARCH_TOOL_LIMITS.maxUrlChars` / `maxTitleChars`. */
  maxCitationUrlChars: 500,
  maxCitationTitleChars: 300,
  /** The SERP worker's deadline for one `ai-answer` job (ms). */
  parseTimeoutMs: 10_000,
  /** `ai-answer` jobs waiting for the worker, at most; one more fails at once. */
  maxQueuedJobs: 4,
} as const;

/**
 * How long `run_ai_search` may take before the tool answers `timeout` (ms; Task 8 review): longer
 * than the other search tools' `SEARCH_TOOL_TIMEOUT_MS`, because one call may wait for its turn at the
 * provider (`maxWaitingPerProvider` ahead of it, `minIntervalMs` apart), then take the client's whole
 * `timeoutMs`, then the worker's `parseTimeoutMs`; plus 5 s for the settings and key reads. At the
 * deadline (or Stop) the signal reaches the client: a waiting request is never sent, one in flight is
 * aborted, and no answer is passed on.
 */
export const AI_SEARCH_TOOL_TIMEOUT_MS =
  (DATA_API_LIMITS.maxWaitingPerProvider + 1) * Math.max(...DATA_AI_SEARCH_PROVIDERS.map((provider) => DATA_API_LIMITS.minIntervalMs[provider])) + DATA_API_LIMITS.timeoutMs + AI_SEARCH_LIMITS.parseTimeoutMs + 5_000;

// ---- Settings (`app_settings`, `0005_app_settings`; no migration) ---------------------------------

/** Each engine's via setting's `app_settings` key: one `AI_SEARCH_VIA_SETTINGS` value. */
export const AI_SEARCH_VIA_KEYS: Readonly<Record<AiSearchEngine, string>> = {
  perplexity: 'ai_search_via_perplexity',
  chatgpt: 'ai_search_via_chatgpt',
  'google-ai-mode': 'ai_search_via_google_ai_mode',
};

/** `AI_SEARCH_VIA_KEYS[engine]` (the plan's `AI_SEARCH_VIA_KEY(engine)`). */
export function AI_SEARCH_VIA_KEY(engine: AiSearchEngine): string {
  return AI_SEARCH_VIA_KEYS[engine];
}

/** The `app_settings` key of the engine `run_ai_search` uses when the model names none. */
export const AI_SEARCH_DEFAULT_ENGINE_KEY = 'ai_search_default_engine' as const;

/**
 * The stored settings as main reads them (`SettingsRepository.aiSearchSettings`): each engine's via
 * setting (`null`: never set, read as "the API when it is usable") and the default engine (`null`:
 * none). A missing or tampered row reads as `null`. Task 9's view writes them.
 */
export interface AiSearchSettings {
  readonly via: Readonly<Record<AiSearchEngine, AiSearchViaSetting | null>>;
  readonly defaultEngine: AiSearchEngine | null;
}

export const DEFAULT_AI_SEARCH_SETTINGS: AiSearchSettings = {
  via: { perplexity: null, chatgpt: null, 'google-ai-mode': null },
  defaultEngine: null,
};

/**
 * What `resolveAiSearch` decides from, read by main at the moment a call arrives (and again when it
 * runs): the settings, each provider's legal gate (`legalGates.isOpen`) and whether its key is set.
 */
export interface AiSearchContext {
  readonly settings: AiSearchSettings;
  readonly gates: Readonly<Record<AiSearchProvider, boolean>>;
  readonly keys: Readonly<Record<AiSearchProvider, boolean>>;
}

/** The context as shipped with nothing known: every gate closed, no key (so `not-available`). */
export const CLOSED_AI_SEARCH_CONTEXT: AiSearchContext = {
  settings: DEFAULT_AI_SEARCH_SETTINGS,
  gates: { perplexity: false, 'openai-search': false },
  keys: { perplexity: false, 'openai-search': false },
};

/**
 * `engine`'s usable via now, or `null`: `api` when the engine has an API provider whose gate is open
 * and whose key is set, and its via setting is not `off` (unset reads as `api`).
 */
export function aiSearchVia(engine: AiSearchEngine, context: AiSearchContext): AiSearchVia | null {
  const provider = AI_SEARCH_API_PROVIDER[engine];
  if (provider === null || context.gates[provider] !== true || context.keys[provider] !== true) return null;
  return context.settings.via[engine] === 'off' ? null : 'api';
}

// ---- Resolving a call ---------------------------------------------------------------------------

/**
 * Why `run_ai_search` sends nothing (said to the model as data `{ unavailable, state }`, except
 * `setting-changed`, which the tool answers as `expired`):
 * - `not-available`: no engine is usable because its provider's legal gate is closed (as shipped:
 *   both), or the engine named is gated off (`LEGAL_GATE_NOTE`);
 * - `none-set-up`: a gate is open but no engine is usable (no key set, or switched off);
 * - `engine-off`: the engine named is gated open but has no key or is switched off;
 * - `no-api`: the engine named has no API in this build (`google-ai-mode`; its tab path is D1);
 * - `setting-changed`: the engine's via changed since the call was approved (nothing sent);
 * - `capped`: `maxCallsPerTurn` calls already went out this turn;
 * - `cooldown`: the engine was asked less than `perEngineCooldownMs` ago, or a call to it is still
 *   running (council review: one call per engine in flight, its slot claimed before anything is awaited);
 * - `request-failed`: the data API client refused or the provider failed (its words withheld);
 * - `invalid-answer`: the provider's answer could not be read (too large, too deep, wrong shape, empty).
 */
export const AI_SEARCH_UNAVAILABLE_REASONS = ['not-available', 'none-set-up', 'engine-off', 'no-api', 'setting-changed', 'capped', 'cooldown', 'request-failed', 'invalid-answer'] as const;
export type AiSearchUnavailableReason = (typeof AI_SEARCH_UNAVAILABLE_REASONS)[number];

/** What each reason says (frost's own words; never a key, a URL or a provider's error text). */
export const AI_SEARCH_UNAVAILABLE_MESSAGES: Readonly<Record<AiSearchUnavailableReason, string>> = {
  'not-available': `AI search is not available: ${LEGAL_GATE_NOTE}`,
  'none-set-up': 'No AI search source is set up. Add a Perplexity or OpenAI key in Settings › Data sources.',
  'engine-off': 'That AI engine is not set up for AI search. Add its key in Settings › Data sources, or ask without naming an engine.',
  'no-api': 'frost has no API for that AI engine in this build. Ask without naming an engine, or name Perplexity or ChatGPT.',
  'setting-changed': 'The AI search setting changed; ask again.',
  capped: `At most ${AI_SEARCH_LIMITS.maxCallsPerTurn} AI searches run in one turn, so nothing was sent. Use the answers you have.`,
  cooldown: `That AI engine was asked less than ${AI_SEARCH_LIMITS.perEngineCooldownMs / 1000} seconds ago, or is still answering, so nothing was sent. Try again later.`,
  'request-failed': 'The AI search request failed. Its details are not shown.',
  'invalid-answer': "The AI engine's answer could not be read.",
};

export type AiSearchResolution = { readonly ok: true; readonly engine: AiSearchEngine; readonly via: AiSearchVia } | { readonly ok: false; readonly reason: AiSearchUnavailableReason };

/**
 * The engine and via a `run_ai_search` call runs with (plan Decision 8), pure:
 * - an engine the model named: that engine, with its usable via; else `no-api` (no provider),
 *   `not-available` (its gate is closed) or `engine-off` (no key, or switched off);
 * - none named: the default engine setting when it has a usable via, else the first of
 *   `AI_SEARCH_ENGINES` with one; none at all: `not-available` when no AI search gate is open, else
 *   `none-set-up`.
 * Any `via` in `input` is ignored: the via is always the setting's. Never throws.
 */
export function resolveAiSearch(input: unknown, context: AiSearchContext): AiSearchResolution {
  const named = typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as { engine?: unknown }).engine : undefined;
  if (named !== undefined) {
    if (!isAiSearchEngine(named)) return { ok: false, reason: 'engine-off' };
    const via = aiSearchVia(named, context);
    if (via !== null) return { ok: true, engine: named, via };
    const provider = AI_SEARCH_API_PROVIDER[named];
    if (provider === null) return { ok: false, reason: 'no-api' };
    return { ok: false, reason: context.gates[provider] === true ? 'engine-off' : 'not-available' };
  }
  const preferred = context.settings.defaultEngine;
  const order = preferred !== null && isAiSearchEngine(preferred) ? [preferred, ...AI_SEARCH_ENGINES.filter((engine) => engine !== preferred)] : [...AI_SEARCH_ENGINES];
  for (const engine of order) {
    const via = aiSearchVia(engine, context);
    if (via !== null) return { ok: true, engine, via };
  }
  return { ok: false, reason: DATA_AI_SEARCH_PROVIDERS.some((provider) => context.gates[provider] === true) ? 'none-set-up' : 'not-available' };
}
