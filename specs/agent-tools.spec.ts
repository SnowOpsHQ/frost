/**
 * The agent's tool catalogue, caps, models and model endpoints (Phase 5 Task 1; acceptance
 * `agent-protocol.feature.md`). Plain values and pure functions with no imports, so the chrome
 * renderer can use them without bundling Zod (strict Trusted Types); the MessagePort messages are
 * in `agent-protocol.schema.ts`, the tools' input schemas in `@app/ai-skills`.
 *
 * Used by the agent runtime (which tools it offers the model), main's approval broker (each tool's
 * risk class and whether a standing grant may cover it), main's model proxy (the endpoint
 * allowlist) and the agent panel (labels, models).
 */

// ---- Tools -----------------------------------------------------------------------------------

/**
 * How much a tool can do, which decides how main's broker treats a call (plan Task 4):
 * - `read`: reads the page or frost's own data; runs without asking (turning the tool off revokes
 *   it), except on a page whose host isn't public;
 * - `act`: changes what the tab shows (navigates, clicks) or sends model-chosen text to a third
 *   party that may act on it (`run_ai_search`: an AI answer engine may fetch URLs it is given);
 *   asks unless the tool is grantable (`navigate`, `click`) and a standing grant for that tool and
 *   origin exists;
 * - `execute`: runs code in the page; asks every call, never grantable;
 * - `external`: an MCP server's tool, untrusted; asks every call, never grantable.
 */
export const AGENT_TOOL_RISKS = ['read', 'act', 'execute', 'external'] as const;
export type AgentToolRisk = (typeof AGENT_TOOL_RISKS)[number];

/** frost's own tools, as the model sees their names. */
export const AGENT_TOOL_NAMES = [
  'page_audit',
  'page_data',
  'page_text',
  'navigate',
  'click',
  'execute_javascript',
  'serp_results',
  'search_intent',
  'run_ai_search',
  'gsc_performance',
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export interface AgentToolSpec {
  readonly name: AgentToolName;
  readonly risk: AgentToolRisk;
  /**
   * Whether a standing grant may cover a call. `read` tools are always covered (an implied grant),
   * `navigate` and `click` by a grant the user gave for that tool and origin; `run_ai_search`
   * (`act`), `execute` and `external` never.
   */
  readonly grantable: boolean;
  /** One line for the user (tool cards, approval prompts, the tools list). */
  readonly label: string;
}

/** The catalogue: every tool frost offers the model. No shell, file or fetch tool exists. */
export const AGENT_TOOLS: { readonly [N in AgentToolName]: AgentToolSpec & { readonly name: N } } = {
  page_audit: { name: 'page_audit', risk: 'read', grantable: true, label: "Read this page's SEO audit" },
  page_data: { name: 'page_data', risk: 'read', grantable: true, label: "Read this page's facts" },
  page_text: { name: 'page_text', risk: 'read', grantable: true, label: "Read this page's visible text" },
  navigate: { name: 'navigate', risk: 'act', grantable: true, label: 'Open a web address in this tab' },
  click: { name: 'click', risk: 'act', grantable: true, label: 'Click something on this page' },
  execute_javascript: { name: 'execute_javascript', risk: 'execute', grantable: false, label: 'Run JavaScript on this page' },
  serp_results: { name: 'serp_results', risk: 'read', grantable: true, label: 'Look up search results for a query' },
  search_intent: { name: 'search_intent', risk: 'read', grantable: true, label: "Classify a query's search intent" },
  run_ai_search: { name: 'run_ai_search', risk: 'act', grantable: false, label: 'Ask an AI search engine a query' },
  gsc_performance: { name: 'gsc_performance', risk: 'read', grantable: true, label: "Read a page's search performance" },
};

/** Whether `name` is one of frost's own tools. */
export function isAgentToolName(name: unknown): name is AgentToolName {
  return typeof name === 'string' && Object.hasOwn(AGENT_TOOLS, name);
}

/**
 * A tool name any model provider accepts: letters, digits, `_` and `-`, 1 to 64 characters.
 * Every name in a chat (frost's and MCP tools') matches it.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * MCP tools are dynamic: main names each `mcp__<server>__<tool>` (within `TOOL_NAME_PATTERN`; the
 * server part has no `_`), so one never takes a catalogue name. They are always `external` and
 * never grantable.
 */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';
export const MCP_TOOL_RISK = 'external' satisfies AgentToolRisk;
export const MCP_TOOL_GRANTABLE = false;

/** Whether `name` names an MCP tool (`MCP_TOOL_NAME_PREFIX`, then a non-empty server and tool). */
export function isMcpToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_PATTERN.test(name) && /^mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+$/.test(name);
}

/** A tool's risk class: the catalogue's, `external` for an MCP tool, `null` for any other name. */
export function toolRisk(name: unknown): AgentToolRisk | null {
  if (isAgentToolName(name)) return AGENT_TOOLS[name].risk;
  return isMcpToolName(name) ? MCP_TOOL_RISK : null;
}

/** Whether a standing grant may cover a call to `name` (`false` for an unknown name). */
export function isGrantable(name: unknown): boolean {
  return isAgentToolName(name) ? AGENT_TOOLS[name].grantable : false;
}

/**
 * Why a tool call produced no output (`tool.result` with `ok: false`):
 * - `denied`: the user said no;
 * - `unavailable`: the tool's data source isn't connected (a port answered `unavailable`);
 * - `failed`: the tool ran and failed;
 * - `timeout`: the tool ran out of time (`EXECUTE_JS_TIMEOUT_MS` for JavaScript);
 * - `expired`: the approval wasn't answered before the chat stopped;
 * - `invalid-input`: the input didn't match the tool's schema;
 * - `not-allowed`: the tool isn't allowed in this chat.
 */
export const TOOL_ERROR_CODES = ['denied', 'unavailable', 'failed', 'timeout', 'expired', 'invalid-input', 'not-allowed'] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// ---- Caps ------------------------------------------------------------------------------------

/** How long a page script may run before main gives up on it (milliseconds). */
export const EXECUTE_JS_TIMEOUT_MS = 5_000;
/** Largest page script result, as UTF-8 JSON (bytes); a larger result is truncated. */
export const EXECUTE_JS_MAX_RESULT_BYTES = 64 * 1024;
/** Longest script the model may ask to run (characters); longer input is refused, never cut. */
export const EXECUTE_JS_MAX_SOURCE_CHARS = 20_000;
/** Longest tool output the model sees: the JSON text of the untrusted wrapper's `data` (characters). */
export const TOOL_RESULT_MAX_CHARS = 32_000;
/** Most model steps (each one a response, with or without tool calls) in one turn. */
export const MAX_TOOL_STEPS = 12;
/** Most messages a chat sends the model. */
export const CHAT_MAX_MESSAGES = 200;

/**
 * Characters no tool input text may hold (`@app/ai-skills` input schemas; MCP inputs in main's
 * broker): C0 and C1 controls and DEL, Unicode format characters (category Cf: bidi overrides and
 * isolates, zero-width characters, the BOM, the soft hyphen), the line and paragraph separators,
 * and lone surrogates. What the user approves is shown exactly, so nothing in it may be invisible
 * or reorder what is shown.
 */
export const UNSAFE_INPUT_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/u;
/** `UNSAFE_INPUT_CHARS` less line feed and tab, for code (`execute_javascript`). */
export const UNSAFE_CODE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\p{Cs}]/u;

/** Whether `text` holds none of `UNSAFE_INPUT_CHARS` (`code`: line feeds and tabs allowed). */
export function isSafeInputText(text: string, kind: 'text' | 'code' = 'text'): boolean {
  return !(kind === 'code' ? UNSAFE_CODE_CHARS : UNSAFE_INPUT_CHARS).test(text);
}

/** Bounds of the tools' inputs (`@app/ai-skills` input schemas). */
export const AGENT_TOOL_INPUT_LIMITS = {
  /** `navigate` and `gsc_performance` URLs (characters). */
  maxUrlChars: 2048,
  /** `click`'s CSS selector (characters). */
  maxSelectorChars: 1024,
  /** `click`'s visible text (characters). */
  maxClickTextChars: 256,
  /** Search queries (characters). */
  maxQueryChars: 256,
  /** `page_text` when the model gives no `maxChars`. */
  defaultPageTextChars: 16_000,
  /** `gsc_performance` days: the default and the longest window. */
  defaultGscDays: 28,
  maxGscDays: 480,
} as const;

// ---- Models ----------------------------------------------------------------------------------

/**
 * How main reaches a model: the user's own key for one provider (bring-your-own-key), or a gateway
 * key that takes `provider/model` ids.
 */
export const MODEL_ROUTES = ['byok-anthropic', 'byok-openai', 'gateway'] as const;
export type ModelRoute = (typeof MODEL_ROUTES)[number];

export const MODEL_PROVIDERS = ['anthropic', 'openai'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The provider each bring-your-own-key route serves. */
export const BYOK_ROUTE_PROVIDER: Readonly<Record<Exclude<ModelRoute, 'gateway'>, ModelProvider>> = {
  'byok-anthropic': 'anthropic',
  'byok-openai': 'openai',
};

/** The model a new install uses. */
export const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-5-5';

/** Models the user may choose, as `provider/model` ids. */
export const ALLOWED_MODEL_IDS = [
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-5-5',
  'openai/gpt-5',
  'openai/gpt-5-mini',
] as const;
export type ModelId = (typeof ALLOWED_MODEL_IDS)[number];

export function isAllowedModelId(modelId: unknown): modelId is ModelId {
  return typeof modelId === 'string' && (ALLOWED_MODEL_IDS as readonly string[]).includes(modelId);
}

/** The provider of an allowed model id (its prefix), or `null` for any other id. */
export function modelProvider(modelId: unknown): ModelProvider | null {
  if (!isAllowedModelId(modelId)) return null;
  const prefix = modelId.slice(0, modelId.indexOf('/'));
  return (MODEL_PROVIDERS as readonly string[]).includes(prefix) ? (prefix as ModelProvider) : null;
}

/**
 * The id the route's provider expects for `modelId`: the gateway takes the `provider/model` id as
 * is; a bring-your-own-key route drops the prefix (`claude-sonnet-5-5`). `null` (refused) for an id
 * not in `ALLOWED_MODEL_IDS`, or one whose provider isn't the bring-your-own-key route's.
 */
export function routeModelId(route: ModelRoute, modelId: string): string | null {
  const provider = modelProvider(modelId);
  if (provider === null) return null;
  if (route === 'gateway') return modelId;
  if (!Object.hasOwn(BYOK_ROUTE_PROVIDER, route) || BYOK_ROUTE_PROVIDER[route] !== provider) return null;
  return modelId.slice(provider.length + 1);
}

// ---- Model requests --------------------------------------------------------------------------

export interface ModelRequestTarget {
  readonly method: 'POST';
  /** The exact, canonical URL (`new URL(url).href === url`). */
  readonly url: string;
}

/**
 * The only requests main's model proxy sends for each route: one method and one exact URL each
 * (the providers' text generation endpoints at their default base URLs), not the provider's whole
 * API. A request goes out only if `isAllowedModelRequest` holds for the configured route.
 */
export const MODEL_REQUESTS: Readonly<Record<ModelRoute, readonly ModelRequestTarget[]>> = {
  'byok-anthropic': [{ method: 'POST', url: 'https://api.anthropic.com/v1/messages' }],
  'byok-openai': [{ method: 'POST', url: 'https://api.openai.com/v1/responses' }],
  gateway: [{ method: 'POST', url: 'https://ai-gateway.vercel.sh/v4/ai/language-model' }],
};

/**
 * Whether `url` is a string written exactly as the URL parser writes it back
 * (`new URL(url).href === url`). A string the parser would rewrite (a backslash, a tab or line
 * break, a missing `//`, a full-width dot, a space or NUL, an upper-case host, a default port) is
 * refused, so the URL checked is the URL sent. Never throws.
 */
export function isCanonicalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).href === url;
  } catch {
    return false;
  }
}

/**
 * Whether main's proxy may send a model request for `route`: `url` is canonical (`isCanonicalUrl`)
 * and `method` and `url` are exactly one of the route's `MODEL_REQUESTS`. Exact equality leaves no
 * room for another host, scheme, port, user name, path, query or fragment. Never throws.
 */
export function isAllowedModelRequest(route: ModelRoute, method: unknown, url: unknown): boolean {
  if (!Object.hasOwn(MODEL_REQUESTS, route) || typeof method !== 'string' || !isCanonicalUrl(url)) return false;
  return MODEL_REQUESTS[route].some((target) => target.method === method && target.url === url);
}
