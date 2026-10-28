/**
 * Main's side of the agent (Phase 5 Task 3; acceptance `agent-host.feature.md`): the agent host's
 * caps, the key store's slots and bounds, and the model proxy's allowlists and pure checks. Plain
 * values and pure functions with no Zod and no Electron, so every rule is unit-testable on its own.
 *
 * The proxy sends a model request only when every check here passes for the route main's settings
 * name (never one the runtime names): the exact method and URL (`isAllowedModelRequest`), the
 * request headers it keeps (an allowlist: everything else, credentials included, is dropped), and
 * the body (JSON whose model is the configured one, with no server-side tool, MCP server, file
 * reference or stored-state reference). The header and body allowlists were built from the requests
 * the installed providers actually send (captured offline through the runtime's proxied fetch; test
 * `proxy-accepts-real-provider-requests` keeps them honest).
 */
import { DEFAULT_MODEL_ID, isAllowedModelId, modelProvider, routeModelId, type ModelId, type ModelRoute } from './agent-tools.spec';

// ---- Host ------------------------------------------------------------------------------------

/** The utility process's service name (Activity Monitor, task manager). */
export const AGENT_SERVICE_NAME = 'frost agent';
/** The runtime's bundle, beside main's in the build directory (Forge's `agent-runtime` entry). */
export const AGENT_RUNTIME_FILE = 'agent-runtime.cjs';

export const AGENT_HOST_LIMITS = {
  /** How long a forked runtime has to post `ready` before main kills it and tries again. */
  readyTimeoutMs: 10_000,
  /** Waits before each restart after an exit or a missed `ready`, the last one repeated (capped). */
  restartBackoffMs: [500, 1_000, 2_000, 5_000, 10_000, 30_000],
  /** A runtime up this long resets the backoff. */
  stableAfterMs: 60_000,
  /** Failed starts in a row before main stops restarting (`crashed`) until the next use. */
  maxConsecutiveFailures: 6,
} as const;

/** The restart wait after `failures` failed starts in a row (1 → the first entry), capped at the last. */
export function restartDelayMs(failures: number): number {
  const steps = AGENT_HOST_LIMITS.restartBackoffMs;
  const index = Math.min(Math.max(Math.floor(failures), 1), steps.length) - 1;
  return steps[index]!;
}

// ---- Settings --------------------------------------------------------------------------------

/** The agent's settings file in `userData` (route and model; small JSON, written atomically). */
export const AGENT_SETTINGS_FILE = 'agent-settings.json';

export interface AgentModelSettings {
  readonly route: ModelRoute;
  readonly modelId: ModelId;
}

/** A new install: the gateway route and `DEFAULT_MODEL_ID`. */
export const DEFAULT_AGENT_MODEL_SETTINGS: AgentModelSettings = { route: 'gateway', modelId: DEFAULT_MODEL_ID };

/** Whether `route` may serve `modelId` (an allowed model whose provider the route serves). */
export function isValidModelSettings(value: { readonly route: unknown; readonly modelId: unknown }): value is AgentModelSettings {
  return (value.route === 'gateway' || value.route === 'byok-anthropic' || value.route === 'byok-openai') && isAllowedModelId(value.modelId) && routeModelId(value.route, value.modelId) !== null;
}

// ---- Credentials -----------------------------------------------------------------------------

/** One stored key per provider account: each route uses one slot. */
export const CREDENTIAL_SLOTS = ['anthropic', 'openai', 'gateway'] as const;
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

export function isCredentialSlot(value: unknown): value is CredentialSlot {
  return typeof value === 'string' && (CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

export const ROUTE_CREDENTIAL_SLOT: Readonly<Record<ModelRoute, CredentialSlot>> = {
  'byok-anthropic': 'anthropic',
  'byok-openai': 'openai',
  gateway: 'gateway',
};

/** The encrypted keys' file in `userData` (mode 0600, written atomically). */
export const CREDENTIALS_FILE = 'agent-credentials.json';

export const CREDENTIAL_LIMITS = {
  /** A key's length after trimming (characters). */
  minKeyChars: 8,
  maxKeyChars: 512,
  /** The stored file read back, at most (bytes): three encrypted keys are far smaller. */
  maxFileBytes: 64 * 1024,
} as const;

/**
 * How well a stored key is protected, for the settings page to say plainly:
 * - `os`: encrypted with a key the OS keeps (Keychain, DPAPI, a Linux secret service);
 * - `weak`: Linux with no secret service (Electron's encryptor writes `v10` data, keyed by a fixed
 *   key built into Chromium), so anyone who can read the file can read the key;
 * - `unavailable`: no encryption: frost refuses to store a key.
 */
export const KEY_PROTECTIONS = ['os', 'weak', 'unavailable'] as const;
export type KeyProtection = (typeof KEY_PROTECTIONS)[number];

/**
 * A key as stored: trimmed, `minKeyChars`–`maxKeyChars` printable ASCII characters with no space
 * (every provider's keys are; anything else is a paste mistake or not a key). `null` when refused.
 */
export function normalizeKey(key: unknown): string | null {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (trimmed.length < CREDENTIAL_LIMITS.minKeyChars || trimmed.length > CREDENTIAL_LIMITS.maxKeyChars) return null;
  return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : null;
}

// ---- Model proxy: caps -----------------------------------------------------------------------

/** The in-memory session model requests go out on (no `persist:` prefix: nothing is written to disk). */
export const AGENT_MODEL_PARTITION = 'agent-model';

export const AGENT_PROXY_LIMITS = {
  /** Model requests in flight at once; one more is refused. */
  maxConcurrentRequests: 4,
  /** No bytes (head or body) for this long → the request is aborted (`timeout`). */
  idleTimeoutMs: 120_000,
  /** One request's whole life, head to last byte (`timeout`). */
  maxRequestMs: 15 * 60_000,
  /** A response's status text, kept only when printable ASCII (characters). */
  maxStatusTextChars: 64,
  /** A kept response header's value (characters); a longer one is dropped. */
  maxResponseHeaderValueChars: 256,
} as const;

/** Why the proxy refused a request: logged as one line with no URL query, header or body. */
export const PROXY_REFUSALS = [
  'endpoint',
  'busy',
  'duplicate-id',
  'no-key',
  'key-unavailable',
  'body-missing',
  'body-encoding',
  'body-size',
  'body-json',
  'model',
  'body-field',
  'tool',
  'content',
  'store',
  'provider-options',
  'redirect',
] as const;
export type ProxyRefusal = (typeof PROXY_REFUSALS)[number];

// ---- Model proxy: headers --------------------------------------------------------------------

export type HeaderPairs = readonly (readonly [string, string])[];

/** A header value check: the value to send (possibly narrowed), or `null` to drop the header. */
type HeaderRule = (value: string) => string | null;

const exactly =
  (...allowed: string[]): HeaderRule =>
  (value) =>
    allowed.includes(value) ? value : null;
const matching =
  (pattern: RegExp): HeaderRule =>
  (value) =>
    pattern.test(value) ? value : null;

/**
 * The `anthropic-beta` flags passed on: the one the Anthropic provider sends for frost's plain
 * function tools (structured tool input). Flags for server tools, MCP, files, code execution or
 * context editing are dropped (their bodies are refused anyway).
 */
export const ANTHROPIC_BETA_ALLOWLIST: readonly string[] = ['structured-outputs-2025-11-13'];

/** The SDKs' own `User-Agent` (`ai-sdk-<provider>/<version> …`); anything else is dropped. */
const USER_AGENT = matching(/^ai-sdk-[a-z-]+\/[0-9A-Za-z.+-]+( [\x21-\x7e]+){0,8}$/);

/**
 * Request headers the runtime may send, per route (lower-case names): an allowlist, so `Host`,
 * `Authorization`, `x-api-key`, `Cookie`, `Proxy-*`, `Transfer-Encoding`, organisation and
 * project headers, observability headers and anything new are dropped. `content-type` is set by
 * main (always `application/json`), as is the credential. Captured from the installed providers:
 * - Anthropic: `anthropic-version: 2023-06-01`, `anthropic-beta`, `content-type`, `user-agent`;
 * - OpenAI (Responses): `content-type`, `user-agent`;
 * - gateway: `ai-gateway-protocol-version`, `ai-language-model-specification-version`,
 *   `ai-language-model-id`, `ai-language-model-streaming`, `ai-gateway-auth-method` (main sets it),
 *   `content-type`, `user-agent`.
 */
export const REQUEST_HEADER_ALLOWLIST: Readonly<Record<ModelRoute, Readonly<Record<string, HeaderRule>>>> = {
  'byok-anthropic': {
    'user-agent': USER_AGENT,
    'anthropic-version': exactly('2023-06-01'),
    'anthropic-beta': (value) => {
      const kept = value
        .split(',')
        .map((flag) => flag.trim())
        .filter((flag) => ANTHROPIC_BETA_ALLOWLIST.includes(flag));
      return kept.length > 0 ? [...new Set(kept)].join(',') : null;
    },
  },
  'byok-openai': {
    'user-agent': USER_AGENT,
  },
  gateway: {
    'user-agent': USER_AGENT,
    'ai-gateway-protocol-version': matching(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
    'ai-language-model-specification-version': matching(/^\d{1,3}$/),
    'ai-language-model-id': matching(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/),
    'ai-language-model-streaming': exactly('true', 'false'),
  },
};

/**
 * The headers kept from the runtime's `pairs` for `route`: allowlisted names only (lower-cased),
 * each value passing its rule (possibly narrowed), the first of a repeated name only, so the value
 * checked is the value sent. Never throws.
 */
export function filterRequestHeaders(route: ModelRoute, pairs: HeaderPairs): [string, string][] {
  const rules = Object.hasOwn(REQUEST_HEADER_ALLOWLIST, route) ? REQUEST_HEADER_ALLOWLIST[route] : {};
  const kept: [string, string][] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
    const name = pair[0].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!Object.hasOwn(rules, name)) continue;
    const value = rules[name]!(pair[1]);
    if (value !== null) kept.push([name, value]);
  }
  return kept;
}

/**
 * The headers main adds after the kept ones: the content type and the route's credential. The
 * Anthropic provider sends its key as `x-api-key`; OpenAI and the gateway as `Authorization:
 * Bearer` (the providers' sources), and the gateway also names the method (`api-key`).
 */
export function mainRequestHeaders(route: ModelRoute, key: string): [string, string][] {
  const headers: [string, string][] = [['content-type', 'application/json']];
  if (route === 'byok-anthropic') headers.push(['x-api-key', key]);
  else headers.push(['authorization', `Bearer ${key}`]);
  if (route === 'gateway') headers.push(['ai-gateway-auth-method', 'api-key']);
  return headers;
}

/**
 * Response headers passed back to the runtime: what the providers read (the content type, request
 * ids for error reports, retry hints and rate limits). Never `set-cookie`, organisation or project
 * ids, server or routing headers, or encoding and length headers (Electron has already decoded the
 * body).
 */
export const RESPONSE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'request-id',
  'x-request-id',
  'retry-after',
  'retry-after-ms',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);

/** The kept response headers: allowlisted names (lower-cased), printable ASCII values within `maxResponseHeaderValueChars`. */
export function filterResponseHeaders(pairs: Iterable<readonly [string, string]>): [string, string][] {
  const kept: [string, string][] = [];
  for (const [name, value] of pairs) {
    const lower = String(name).toLowerCase();
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower)) continue;
    const text = String(value);
    if (text.length > AGENT_PROXY_LIMITS.maxResponseHeaderValueChars || !/^[\x20-\x7e]*$/.test(text)) continue;
    kept.push([lower, text]);
  }
  return kept;
}

/** A status text the runtime gets: printable ASCII within `maxStatusTextChars`, else `''`. */
export function sanitizeStatusText(text: unknown): string {
  return typeof text === 'string' && text.length <= AGENT_PROXY_LIMITS.maxStatusTextChars && /^[\x20-\x7e]*$/.test(text) ? text : '';
}

// ---- Model proxy: bodies ---------------------------------------------------------------------

export type BodyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ProxyRefusal };

const OK: BodyCheck = { ok: true };
const refuse = (reason: ProxyRefusal): BodyCheck => ({ ok: false, reason });

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Json, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

/**
 * Top-level body fields each route may send (the providers' text generation requests with frost's
 * options). Absent from the lists, so refused: Anthropic `mcp_servers`, `container`,
 * `context_management`, `compaction`, `fallbacks`; OpenAI `previous_response_id`, `conversation`,
 * `prompt`, `background`; the gateway's `headers` and any provider routing.
 */
export const BODY_FIELDS: Readonly<Record<ModelRoute, readonly string[]>> = {
  'byok-anthropic': ['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice', 'stream', 'temperature', 'top_k', 'top_p', 'stop_sequences', 'thinking', 'output_config'],
  'byok-openai': ['model', 'input', 'instructions', 'store', 'include', 'tools', 'tool_choice', 'stream', 'temperature', 'top_p', 'max_output_tokens', 'reasoning', 'text', 'parallel_tool_calls'],
  gateway: ['prompt', 'tools', 'toolChoice', 'providerOptions', 'includeRawChunks', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences', 'presencePenalty', 'frequencyPenalty', 'seed', 'responseFormat'],
};

/** Anthropic content blocks allowed in `messages` (no image, document, file, search, server-tool, MCP or container block). */
export const ANTHROPIC_BLOCK_TYPES: readonly string[] = ['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'];
/** OpenAI Responses input items allowed (no file search, web search, computer, shell, MCP, image or stored item reference). */
export const OPENAI_INPUT_ITEM_TYPES: readonly string[] = ['message', 'function_call', 'function_call_output', 'reasoning'];
/** OpenAI message content parts allowed (no `input_image`, `input_file` or `input_audio`). */
export const OPENAI_CONTENT_TYPES: readonly string[] = ['input_text', 'output_text', 'refusal'];
/** OpenAI `include` values allowed (reasoning carried in the request, since nothing is stored). */
export const OPENAI_INCLUDE: readonly string[] = ['reasoning.encrypted_content'];
/** Gateway prompt parts allowed (no file, no provider-executed tool, no approval part). */
export const GATEWAY_PART_TYPES: readonly string[] = ['text', 'reasoning', 'tool-call', 'tool-result'];
/** Gateway tool result outputs allowed (no `content`, which may carry files or URLs). */
export const GATEWAY_TOOL_OUTPUT_TYPES: readonly string[] = ['text', 'json', 'error-text', 'error-json', 'execution-denied'];
/**
 * Provider options the gateway route may carry, per provider: OpenAI's `store` (must be `false`) and
 * reasoning or verbosity knobs, Anthropic's thinking knobs. Anything else (MCP servers, containers,
 * gateway routing, BYOK credentials) is refused.
 */
export const GATEWAY_PROVIDER_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  openai: ['store', 'reasoningEffort', 'reasoningSummary', 'textVerbosity', 'parallelToolCalls'],
  anthropic: ['thinking', 'sendReasoning', 'effort', 'disableParallelToolUse'],
};
/** Provider namespaces a gateway prompt message or part may carry options for (reasoning signatures, item ids). */
const GATEWAY_PART_OPTION_PROVIDERS: readonly string[] = ['anthropic', 'openai'];

/** The model header the gateway reads (its body names no model). */
export const GATEWAY_MODEL_HEADER = 'ai-language-model-id';

/**
 * Whether the body may go out on `route` with `modelId` (main's settings): JSON text whose model is
 * `routeModelId(route, modelId)` (the gateway's: the `ai-language-model-id` header among `headers`,
 * already filtered), only `BODY_FIELDS`, only plain function tools, only text, tool and reasoning
 * content, and, for an OpenAI model, `store: false`. Never throws.
 */
export function checkModelRequestBody(route: ModelRoute, modelId: string, body: string, headers: HeaderPairs = []): BodyCheck {
  const expected = Object.hasOwn(BODY_FIELDS, route) ? routeModelId(route, modelId) : null;
  if (expected === null) return refuse('model');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refuse('body-json');
  }
  if (!isObject(parsed)) return refuse('body-json');
  if (!onlyKeys(parsed, BODY_FIELDS[route])) return refuse('body-field');
  try {
    switch (route) {
      case 'byok-anthropic':
        return parsed.model === expected ? checkAnthropic(parsed) : refuse('model');
      case 'byok-openai':
        return parsed.model === expected ? checkOpenAi(parsed) : refuse('model');
      case 'gateway': {
        const models = headers.filter(([name]) => name.toLowerCase() === GATEWAY_MODEL_HEADER);
        if (models.length !== 1 || models[0]![1] !== expected) return refuse('model');
        return checkGateway(parsed, modelProvider(modelId) === 'openai');
      }
    }
  } catch {
    // A getter cannot exist on parsed JSON; this only guards against a bug above.
    return refuse('body-json');
  }
  return refuse('model');
}

function checkAnthropic(body: Json): BodyCheck {
  const { system, messages, tools, tool_choice: toolChoice } = body;
  if (system !== undefined && typeof system !== 'string') {
    if (!Array.isArray(system) || !system.every((block) => isObject(block) && block.type === 'text')) return refuse('content');
  }
  if (!Array.isArray(messages)) return refuse('content');
  for (const message of messages) {
    if (!isObject(message) || !onlyKeys(message, ['role', 'content']) || (message.role !== 'user' && message.role !== 'assistant')) return refuse('content');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) return refuse('content');
    for (const block of message.content) {
      if (!isObject(block) || typeof block.type !== 'string' || !ANTHROPIC_BLOCK_TYPES.includes(block.type)) return refuse('content');
      if (block.type === 'tool_result' && block.content !== undefined && typeof block.content !== 'string') {
        if (!Array.isArray(block.content) || !block.content.every((part) => isObject(part) && part.type === 'text')) return refuse('content');
      }
    }
  }
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return refuse('tool');
    // A plain (custom) tool has no `type`, or `custom`; every server tool names its own type.
    for (const tool of tools) if (!isObject(tool) || (tool.type !== undefined && tool.type !== 'custom') || typeof tool.name !== 'string') return refuse('tool');
  }
  if (toolChoice !== undefined && (!isObject(toolChoice) || !['auto', 'any', 'none', 'tool'].includes(String(toolChoice.type)))) return refuse('tool');
  return OK;
}

function checkOpenAi(body: Json): BodyCheck {
  if (body.store !== false) return refuse('store');
  const { input, include, tools, tool_choice: toolChoice } = body;
  if (include !== undefined && (!Array.isArray(include) || !include.every((value) => typeof value === 'string' && OPENAI_INCLUDE.includes(value)))) return refuse('body-field');
  if (typeof input !== 'string') {
    if (!Array.isArray(input)) return refuse('content');
    for (const item of input) {
      if (!isObject(item)) return refuse('content');
      const type = item.type ?? (typeof item.role === 'string' ? 'message' : undefined);
      if (typeof type !== 'string' || !OPENAI_INPUT_ITEM_TYPES.includes(type)) return refuse('content');
      if (type === 'message') {
        if (!['user', 'assistant', 'system', 'developer'].includes(String(item.role))) return refuse('content');
        if (typeof item.content !== 'string' && !(Array.isArray(item.content) && item.content.every((part) => isObject(part) && OPENAI_CONTENT_TYPES.includes(String(part.type))))) return refuse('content');
      }
      if (type === 'function_call_output' && typeof item.output !== 'string') {
        if (!Array.isArray(item.output) || !item.output.every((part) => isObject(part) && part.type === 'input_text')) return refuse('content');
      }
    }
  }
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return refuse('tool');
    for (const tool of tools) if (!isObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string') return refuse('tool');
  }
  if (toolChoice !== undefined && !['auto', 'none', 'required'].includes(String(toolChoice))) {
    if (!isObject(toolChoice) || toolChoice.type !== 'function') return refuse('tool');
  }
  return OK;
}

function checkGateway(body: Json, openAiModel: boolean): BodyCheck {
  const { prompt, tools, toolChoice, providerOptions } = body;
  if (!Array.isArray(prompt)) return refuse('content');
  for (const message of prompt) {
    if (!isObject(message) || !onlyKeys(message, ['role', 'content', 'providerOptions'])) return refuse('content');
    if (!partOptionsOk(message.providerOptions)) return refuse('provider-options');
    if (message.role === 'system') {
      if (typeof message.content !== 'string') return refuse('content');
      continue;
    }
    if (!['user', 'assistant', 'tool'].includes(String(message.role)) || !Array.isArray(message.content)) return refuse('content');
    for (const part of message.content) {
      if (!isObject(part) || !GATEWAY_PART_TYPES.includes(String(part.type))) return refuse('content');
      if (!partOptionsOk(part.providerOptions)) return refuse('provider-options');
      if (part.type === 'tool-call' && part.providerExecuted !== undefined && part.providerExecuted !== false) return refuse('tool');
      if (part.type === 'tool-result' && (!isObject(part.output) || !GATEWAY_TOOL_OUTPUT_TYPES.includes(String(part.output.type)))) return refuse('content');
    }
  }
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return refuse('tool');
    for (const tool of tools) {
      if (!isObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !onlyKeys(tool, ['type', 'name', 'description', 'inputSchema', 'strict', 'inputExamples'])) return refuse('tool');
    }
  }
  if (toolChoice !== undefined && (!isObject(toolChoice) || !['auto', 'none', 'required', 'tool'].includes(String(toolChoice.type)))) return refuse('tool');
  if (providerOptions !== undefined) {
    if (!isObject(providerOptions)) return refuse('provider-options');
    for (const [provider, options] of Object.entries(providerOptions)) {
      if (!Object.hasOwn(GATEWAY_PROVIDER_OPTIONS, provider) || !isObject(options) || !onlyKeys(options, GATEWAY_PROVIDER_OPTIONS[provider]!)) return refuse('provider-options');
    }
  }
  const openai = isObject(providerOptions) && isObject(providerOptions.openai) ? providerOptions.openai : undefined;
  if (openai?.store !== undefined && openai.store !== false) return refuse('store');
  if (openAiModel && openai?.store !== false) return refuse('store');
  return OK;
}

/** A gateway message's or part's provider options: absent, or objects for `anthropic` / `openai` only. */
function partOptionsOk(options: unknown): boolean {
  if (options === undefined) return true;
  return isObject(options) && Object.entries(options).every(([provider, value]) => GATEWAY_PART_OPTION_PROVIDERS.includes(provider) && isObject(value));
}
