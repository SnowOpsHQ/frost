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
 * - `read`: reads the page or frost's own data; runs without asking (turning the tool off revokes it);
 * - `act`: changes what the tab shows (navigates, clicks); asks unless a standing grant for that
 *   tool and origin exists;
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
   * `act` tools by a grant the user gave for that tool and origin; `execute` and `external` never.
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
  run_ai_search: { name: 'run_ai_search', risk: 'read', grantable: true, label: 'Ask an AI search engine a query' },
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

// ---- Model endpoints -------------------------------------------------------------------------

/**
 * The one URL prefix main's model proxy lets each route reach (the providers' default base URLs).
 * A request goes out only if `isAllowedModelUrl` holds for the configured route.
 */
export const MODEL_ENDPOINTS: Readonly<Record<ModelRoute, string>> = {
  'byok-anthropic': 'https://api.anthropic.com/v1/',
  'byok-openai': 'https://api.openai.com/v1/',
  gateway: 'https://ai-gateway.vercel.sh/v4/ai/',
};

/**
 * Whether main's proxy may send a model request for `route` to `url`. The URL is parsed (which
 * normalises it: host case, default port, `.` and `..` segments, `\`) and must then have exactly the
 * endpoint's origin (`https:`, the host, the default port), no user name or password, no fragment,
 * and a path that starts with the endpoint's path. A path holding an encoded `/`, `\` or `.`
 * (`%2f`, `%5c`, `%2e`) is refused, as a server could decode it into another path. Never throws.
 */
export function isAllowedModelUrl(route: ModelRoute, url: unknown): boolean {
  if (typeof url !== 'string' || !Object.hasOwn(MODEL_ENDPOINTS, route)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const endpoint = new URL(MODEL_ENDPOINTS[route]);
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '' || parsed.hash !== '' || url.includes('#')) return false;
  if (parsed.origin !== endpoint.origin) return false;
  if (/%(?:2f|5c|2e)/i.test(parsed.pathname)) return false;
  return parsed.pathname.startsWith(endpoint.pathname);
}
