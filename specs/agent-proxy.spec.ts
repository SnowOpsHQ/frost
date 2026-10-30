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
import { CHATGPT_TOOL_NAMESPACE, type ChatgptModelView } from './agent-chatgpt.spec';
import { DEFAULT_MODEL_ID, isAgentModelId, MAX_TOOL_STEPS, MODEL_ROUTES, modelProvider, routeModelId, type AgentModelId, type KeyRoute, type ModelRoute } from './agent-tools.spec';

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
  /** The window the flood limits below count in. */
  floodWindowMs: 10_000,
  /**
   * Strikes (an invalid or unexpected message, a refused model request) in one window before main
   * kills the runtime and starts another (a failure toward `maxConsecutiveFailures`).
   */
  maxStrikesPerWindow: 32,
  /** Messages of any kind from the runtime in one window before main kills it (a stream's deltas are far fewer). */
  maxInboundPerWindow: 20_000,
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
  /** A catalogue id, or a `chatgpt/<slug>` on the `chatgpt` route (`AgentModelId`). */
  readonly modelId: AgentModelId;
}

/** A new install: the gateway route and `DEFAULT_MODEL_ID`. */
export const DEFAULT_AGENT_MODEL_SETTINGS: AgentModelSettings = { route: 'gateway', modelId: DEFAULT_MODEL_ID };

/**
 * Whether `route` may serve `modelId`, as a format check: an allowed model whose provider the route
 * serves, or a well-formed `chatgpt/<slug>` on the `chatgpt` route (main also requires the slug to
 * be in the account's last model list).
 */
export function isValidModelSettings(value: { readonly route: unknown; readonly modelId: unknown }): value is AgentModelSettings {
  return (MODEL_ROUTES as readonly unknown[]).includes(value.route) && isAgentModelId(value.modelId) && routeModelId(value.route as ModelRoute, value.modelId) !== null;
}

/**
 * Whether main may use these settings: `isValidModelSettings`, and on the `chatgpt` route the model
 * in `chatgptModels`, the account's last model list (persisted with the settings, so a restart
 * without network keeps the choice). A ChatGPT id the list no longer has is not usable.
 */
export function isUsableModelSettings(value: { readonly route: unknown; readonly modelId: unknown }, chatgptModels: readonly ChatgptModelView[]): value is AgentModelSettings {
  if (!isValidModelSettings(value)) return false;
  return value.route !== 'chatgpt' || chatgptModels.some((model) => model.id === value.modelId);
}

// ---- Credentials -----------------------------------------------------------------------------

/** One stored key per provider account: each route uses one slot. */
export const CREDENTIAL_SLOTS = ['anthropic', 'openai', 'gateway'] as const;
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

export function isCredentialSlot(value: unknown): value is CredentialSlot {
  return typeof value === 'string' && (CREDENTIAL_SLOTS as readonly string[]).includes(value);
}

/** The slot each key route uses. The `chatgpt` route has none: its credential is the sign-in's access token. */
export const ROUTE_CREDENTIAL_SLOT: Readonly<Record<KeyRoute, CredentialSlot>> = {
  'byok-anthropic': 'anthropic',
  'byok-openai': 'openai',
  gateway: 'gateway',
};

/** The slot `route` uses, or `null` for the `chatgpt` route (no stored key). */
export function routeCredentialSlot(route: ModelRoute): CredentialSlot | null {
  return route === 'chatgpt' ? null : ROUTE_CREDENTIAL_SLOT[route];
}

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
  /** At most one log line per refusal reason (or failure) in this window; the rest are counted. */
  logWindowMs: 60_000,
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
  'output-cap',
  'redirect',
  'no-chat',
  'turn-budget',
  /**
   * The ChatGPT plan refused this turn already (a usage limit, not eligible, plan usage off, an
   * unsupported request): nothing goes out on the plan again until the turn ends (the SDK's retry
   * would repeat it). Not the runtime's fault.
   */
  'plan-paused',
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
 *   `content-type`, `user-agent`;
 * - ChatGPT plan: the OpenAI provider's, as `byok-openai` (no `openai-organization` or
 *   `openai-project`: the route takes `Authorization: Bearer` only).
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
  chatgpt: {
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
 * Bearer` (the providers' sources), and the gateway also names the method (`api-key`). On the
 * `chatgpt` route `key` is the sign-in's access token, sent as `Authorization: Bearer` only.
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

/**
 * The most output a model request may ask for (tokens): the runtime sends it on every turn
 * (`maxOutputTokens`), and the proxy refuses a body that asks for more or names none (a provider's
 * default can be its model's maximum: the Anthropic provider sends 128000 when none is given).
 */
export const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Model requests one chat turn may make: a request per step, and one retry each (the runtime's
 * `maxRetries` is 1). Main refuses a request past the budget of the turns running.
 */
export const MAX_MODEL_REQUESTS_PER_TURN = MAX_TOOL_STEPS * 2;

export type BodyCheck = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly reason: ProxyRefusal };

const refuse = (reason: ProxyRefusal): BodyCheck => ({ ok: false, reason });

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Json, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isString = (value: unknown): value is string => typeof value === 'string';
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
/** An object with only `keys`, each passing its check (absent keys pass). */
const shaped = (value: unknown, keys: Readonly<Record<string, (value: unknown) => boolean>>): boolean =>
  isObject(value) && onlyKeys(value, Object.keys(keys)) && Object.entries(keys).every(([key, check]) => optional(value[key], check));
const any = (): boolean => true;
const oneOf =
  (...values: unknown[]) =>
  (value: unknown) =>
    values.includes(value);
const arrayOf =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    Array.isArray(value) && value.every(check);
const outputCap = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_OUTPUT_TOKENS;

/**
 * Top-level body fields each route may send (the providers' text generation requests with frost's
 * options). Absent from the lists, so refused: Anthropic `mcp_servers`, `container`,
 * `context_management`, `compaction`, `fallbacks`; OpenAI `previous_response_id`, `conversation`,
 * `prompt`, `background`; the gateway's `headers`, `responseFormat` and any provider routing; on the
 * ChatGPT plan also every `CHATGPT_FORBIDDEN_BODY_FIELDS` (no output cap, no sampling knobs).
 */
export const BODY_FIELDS: Readonly<Record<ModelRoute, readonly string[]>> = {
  'byok-anthropic': ['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice', 'stream', 'temperature', 'top_k', 'top_p', 'stop_sequences', 'thinking', 'output_config'],
  'byok-openai': ['model', 'input', 'instructions', 'store', 'include', 'tools', 'tool_choice', 'stream', 'temperature', 'top_p', 'max_output_tokens', 'reasoning', 'text', 'parallel_tool_calls'],
  gateway: ['prompt', 'tools', 'toolChoice', 'providerOptions', 'includeRawChunks', 'maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences', 'presencePenalty', 'frequencyPenalty', 'seed'],
  chatgpt: ['model', 'input', 'instructions', 'store', 'stream', 'include', 'tools', 'tool_choice', 'reasoning', 'text', 'parallel_tool_calls'],
};

// Anthropic Messages: each block's keys, and which role may carry it (what the provider emits for
// text, tool calls and results, thinking with its signature, and redacted thinking). No image,
// document, file, citation, search result, server tool, MCP or container block; no `caller`.
const cacheControl = (value: unknown) => shaped(value, { type: oneOf('ephemeral'), ttl: isString });
/**
 * The only tool caller passed back: `{ type: 'direct' }` (the model called the tool itself). The
 * Anthropic provider turns a response's `tool_use.caller` into metadata and sends it back on the
 * next step; a caller naming a code execution tool (a server tool) is refused.
 */
const directCaller = (value: unknown) => isObject(value) && shaped(value, { type: oneOf('direct') }) && value.type === 'direct';
const anthropicText = (value: unknown) => shaped(value, { type: oneOf('text'), text: isString, cache_control: cacheControl }) && isObject(value) && value.type === 'text';
const ANTHROPIC_BLOCKS: Readonly<Record<'user' | 'assistant', Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>>>> = {
  user: {
    text: { type: any, text: isString, cache_control: cacheControl },
    tool_result: { type: any, tool_use_id: isString, content: (value) => isString(value) || arrayOf(anthropicText)(value), is_error: oneOf(true, false), cache_control: cacheControl },
  },
  assistant: {
    text: { type: any, text: isString, cache_control: cacheControl },
    tool_use: { type: any, id: isString, name: isString, input: isObject, cache_control: cacheControl, caller: directCaller },
    thinking: { type: any, thinking: isString, signature: isString },
    redacted_thinking: { type: any, data: isString },
  },
};
/** Anthropic block types, any role (for the record; `ANTHROPIC_BLOCKS` is the rule). */
export const ANTHROPIC_BLOCK_TYPES: readonly string[] = ['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'];
const anthropicTool = (value: unknown) =>
  shaped(value, { type: oneOf('custom'), name: isString, description: isString, input_schema: isObject, eager_input_streaming: oneOf(true, false), strict: oneOf(true, false), cache_control: cacheControl }) && isObject(value) && isString(value.name);

// OpenAI Responses: the input items the provider emits with `store: false` (messages, function
// calls and their outputs, reasoning carried as encrypted content). No file search, web search,
// computer, shell, MCP, image or stored item reference; no image, file or audio part.
const openaiPart = (value: unknown) => isObject(value) && (shaped(value, { type: oneOf('input_text', 'output_text'), text: isString }) || shaped(value, { type: oneOf('refusal'), refusal: isString })) && isString(value.type);
const OPENAI_ITEMS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  message: { type: oneOf('message'), role: oneOf('user', 'assistant', 'system', 'developer'), content: (value) => isString(value) || arrayOf(openaiPart)(value) },
  function_call: { type: any, call_id: isString, name: isString, arguments: isString },
  function_call_output: { type: any, call_id: isString, output: isString },
  reasoning: { type: any, id: isString, encrypted_content: (value) => value === null || isString(value), summary: arrayOf((part) => shaped(part, { type: oneOf('summary_text'), text: isString })) },
};
/** OpenAI Responses input item types allowed. */
export const OPENAI_INPUT_ITEM_TYPES: readonly string[] = Object.keys(OPENAI_ITEMS);
/** OpenAI `include` values allowed (reasoning carried in the request, since nothing is stored). */
export const OPENAI_INCLUDE: readonly string[] = ['reasoning.encrypted_content'];
const openaiTool = (value: unknown) => shaped(value, { type: oneOf('function'), name: isString, description: isString, parameters: isObject, strict: oneOf(true, false) }) && isObject(value) && value.type === 'function' && isString(value.name);

// The ChatGPT plan (Responses with the route's limits): the same items, but no `system` message
// (the route rejects one; instructions or developer messages carry it), each item's identifying
// keys required (a message without a role is refused), and a function call may name the namespace
// its tool came from. Tools only as namespace groups of plain function tools,
// under `CHATGPT_TOOL_NAMESPACE.name` only.
const CHATGPT_ITEMS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  ...OPENAI_ITEMS,
  message: { ...OPENAI_ITEMS.message!, role: oneOf('user', 'assistant', 'developer') },
  function_call: { ...OPENAI_ITEMS.function_call!, namespace: oneOf(CHATGPT_TOOL_NAMESPACE.name) },
};
/** The keys each ChatGPT input item must carry (absent is refused, not passed). */
const CHATGPT_REQUIRED_ITEM_KEYS: Readonly<Record<string, readonly string[]>> = {
  message: ['role', 'content'],
  function_call: ['call_id', 'name', 'arguments'],
  function_call_output: ['call_id', 'output'],
  reasoning: ['id', 'summary'],
};
const chatgptNamespace = (value: unknown) =>
  shaped(value, { type: oneOf('namespace'), name: oneOf(CHATGPT_TOOL_NAMESPACE.name), description: isString, tools: arrayOf(openaiTool) }) && isObject(value) && value.type === 'namespace' && value.name === CHATGPT_TOOL_NAMESPACE.name && Array.isArray(value.tools);

// The gateway: the language model call options. Parts per role, each with its keys; part and message
// provider options only the ones the providers attach to their own output (Anthropic's thinking
// signature and redacted data, OpenAI's item ids and encrypted reasoning) and cache control.
const partOptions = (value: unknown) =>
  shaped(value, {
    anthropic: (options) => shaped(options, { signature: isString, redactedData: isString, cacheControl, caller: directCaller }),
    openai: (options) => shaped(options, { itemId: isString, reasoningEncryptedContent: (content) => content === null || isString(content) }),
  });
const toolOutput = (value: unknown) =>
  isObject(value) &&
  (shaped(value, { type: oneOf('text', 'error-text'), value: isString }) || shaped(value, { type: oneOf('json', 'error-json'), value: any }) || shaped(value, { type: oneOf('execution-denied'), reason: isString })) &&
  isString(value.type);
const GATEWAY_PARTS: Readonly<Record<'user' | 'assistant' | 'tool', Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>>>> = {
  user: { text: { type: any, text: isString, providerOptions: partOptions } },
  assistant: {
    text: { type: any, text: isString, providerOptions: partOptions },
    reasoning: { type: any, text: isString, providerOptions: partOptions },
    'tool-call': { type: any, toolCallId: isString, toolName: isString, input: any, providerOptions: partOptions },
  },
  tool: { 'tool-result': { type: any, toolCallId: isString, toolName: isString, output: toolOutput, providerOptions: partOptions } },
};
/** Gateway prompt part types allowed, any role (for the record; `GATEWAY_PARTS` is the rule). */
export const GATEWAY_PART_TYPES: readonly string[] = ['text', 'reasoning', 'tool-call', 'tool-result'];
/**
 * Provider options the gateway route may carry, per provider, each with the values it may take:
 * OpenAI's `store` (only `false`) and reasoning, summary, verbosity and parallel-call knobs;
 * Anthropic's reasoning and parallel-call knobs, and `thinking` only as `checkGatewayThinking`
 * allows. Anything else (MCP servers, containers, gateway routing, BYOK credentials) is refused.
 */
export const GATEWAY_PROVIDER_OPTIONS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  openai: {
    store: oneOf(false),
    reasoningEffort: oneOf('minimal', 'low', 'medium', 'high'),
    reasoningSummary: oneOf('auto', 'concise', 'detailed'),
    textVerbosity: oneOf('low', 'medium', 'high'),
    parallelToolCalls: oneOf(true, false),
  },
  anthropic: {
    thinking: isObject,
    sendReasoning: oneOf(true, false),
    effort: oneOf('low', 'medium', 'high'),
    disableParallelToolUse: oneOf(true, false),
  },
};

/**
 * Whether the gateway's Anthropic `thinking` option keeps the output within `MAX_OUTPUT_TOKENS`:
 * the provider asks for `maxOutputTokens + budgetTokens` (a budget of 1024 when none is given), so
 * an `enabled` budget must fit beside the output cap; `disabled` and `adaptive` (thinking within
 * the output) are fine. The runtime sends none today.
 */
export function checkGatewayThinking(thinking: unknown, maxOutputTokens: number): boolean {
  if (!isObject(thinking)) return false;
  if (shaped(thinking, { type: oneOf('disabled', 'adaptive') }) && thinking.type !== undefined) return true;
  if (!shaped(thinking, { type: oneOf('enabled'), budgetTokens: Number.isInteger }) || thinking.type !== 'enabled') return false;
  const budget = thinking.budgetTokens === undefined ? 1024 : (thinking.budgetTokens as number);
  return budget >= 1 && budget + maxOutputTokens <= MAX_OUTPUT_TOKENS;
}

const gatewayTool = (value: unknown) => shaped(value, { type: oneOf('function'), name: isString, description: isString, inputSchema: isObject, strict: oneOf(true, false) }) && isObject(value) && value.type === 'function' && isString(value.name);

/** The model header the gateway reads (its body names no model). */
export const GATEWAY_MODEL_HEADER = 'ai-language-model-id';

/**
 * Whether the body may go out on `route` with `modelId` (main's settings), and the exact text to
 * send: the parsed body written back out (`JSON.stringify`), so the bytes sent are the object
 * checked; a repeated key in the runtime's text (`{"store":true,"store":false}`) can't make the
 * provider read something other than what was checked. The checks: JSON whose model is
 * `routeModelId(route, modelId)` (the gateway's: the `ai-language-model-id` header among
 * `headers`, already filtered), only `BODY_FIELDS`, an output cap of at most `MAX_OUTPUT_TOKENS`,
 * and a nested allowlist below it: each message's, block's or part's keys and which role may carry
 * it, plain function tools only, the provider options the providers attach to their own output,
 * and, for an OpenAI model, `store: false`. Never throws.
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
  let check: BodyCheck;
  try {
    switch (route) {
      case 'byok-anthropic':
        check = parsed.model === expected ? checkAnthropic(parsed) : refuse('model');
        break;
      case 'byok-openai':
        check = parsed.model === expected ? checkOpenAi(parsed) : refuse('model');
        break;
      case 'gateway': {
        const models = headers.filter(([name]) => name.toLowerCase() === GATEWAY_MODEL_HEADER);
        check = models.length !== 1 || models[0]![1] !== expected ? refuse('model') : checkGateway(parsed, modelProvider(modelId) === 'openai');
        break;
      }
      case 'chatgpt':
        check = parsed.model === expected ? checkChatgpt(parsed) : refuse('model');
        break;
      default:
        return refuse('model');
    }
    return check.ok ? { ok: true, body: JSON.stringify(parsed) } : check;
  } catch {
    // Parsed JSON has no getters; this only guards against a bug above.
    return refuse('body-json');
  }
}

const OK: BodyCheck = { ok: true, body: '' };

function checkAnthropic(body: Json): BodyCheck {
  const { system, messages, tools, tool_choice: toolChoice, thinking, output_config: outputConfig } = body;
  if (!outputCap(body.max_tokens)) return refuse('output-cap');
  if (system !== undefined && !isString(system) && !arrayOf(anthropicText)(system)) return refuse('content');
  if (!Array.isArray(messages)) return refuse('content');
  for (const message of messages) {
    if (!isObject(message) || !onlyKeys(message, ['role', 'content']) || (message.role !== 'user' && message.role !== 'assistant')) return refuse('content');
    if (isString(message.content)) continue;
    if (!Array.isArray(message.content)) return refuse('content');
    const allowed = ANTHROPIC_BLOCKS[message.role];
    for (const block of message.content) {
      if (!isObject(block) || !isString(block.type) || !Object.hasOwn(allowed, block.type) || !shaped(block, allowed[block.type]!)) return refuse('content');
    }
  }
  if (tools !== undefined && !arrayOf(anthropicTool)(tools)) return refuse('tool');
  if (toolChoice !== undefined && !(shaped(toolChoice, { type: oneOf('auto', 'any', 'none', 'tool'), name: isString, disable_parallel_tool_use: oneOf(true, false) }) && isObject(toolChoice) && toolChoice.type !== undefined)) return refuse('tool');
  if (thinking !== undefined && !shaped(thinking, { type: oneOf('enabled', 'disabled', 'adaptive', 'between_tools'), budget_tokens: Number.isInteger })) return refuse('body-field');
  if (outputConfig !== undefined && !shaped(outputConfig, { effort: oneOf('low', 'medium', 'high') })) return refuse('body-field');
  return OK;
}

function checkOpenAi(body: Json): BodyCheck {
  if (body.store !== false) return refuse('store');
  if (!outputCap(body.max_output_tokens)) return refuse('output-cap');
  const { input, include, tools, tool_choice: toolChoice, reasoning, text, instructions } = body;
  if (include !== undefined && !arrayOf((value) => isString(value) && OPENAI_INCLUDE.includes(value))(include)) return refuse('body-field');
  if (instructions !== undefined && !isString(instructions)) return refuse('content');
  if (!isString(input)) {
    if (!Array.isArray(input)) return refuse('content');
    for (const item of input) {
      if (!isObject(item)) return refuse('content');
      const type = item.type ?? (isString(item.role) ? 'message' : undefined);
      if (!isString(type) || !Object.hasOwn(OPENAI_ITEMS, type) || !shaped(item, OPENAI_ITEMS[type]!)) return refuse('content');
    }
  }
  if (tools !== undefined && !arrayOf(openaiTool)(tools)) return refuse('tool');
  if (toolChoice !== undefined && !oneOf('auto', 'none', 'required')(toolChoice) && !(shaped(toolChoice, { type: oneOf('function'), name: isString }) && isObject(toolChoice) && toolChoice.type === 'function')) return refuse('tool');
  if (reasoning !== undefined && !shaped(reasoning, { effort: oneOf('minimal', 'low', 'medium', 'high'), summary: oneOf('auto', 'concise', 'detailed') })) return refuse('body-field');
  if (text !== undefined && !shaped(text, { verbosity: oneOf('low', 'medium', 'high'), format: (format) => shaped(format, { type: oneOf('text') }) })) return refuse('body-field');
  return OK;
}

/**
 * The ChatGPT plan's Responses body: `store: false` and `stream: true` required, `input` an array
 * of `CHATGPT_ITEMS` (no `system` message), tools only in the `frost` namespace, no output cap or
 * sampling field (`BODY_FIELDS.chatgpt` already left them out).
 */
function checkChatgpt(body: Json): BodyCheck {
  if (body.store !== false) return refuse('store');
  if (body.stream !== true) return refuse('body-field');
  const { input, include, tools, tool_choice: toolChoice, reasoning, text, instructions, parallel_tool_calls: parallel } = body;
  if (include !== undefined && !arrayOf((value) => isString(value) && OPENAI_INCLUDE.includes(value))(include)) return refuse('body-field');
  if (instructions !== undefined && !isString(instructions)) return refuse('content');
  if (!Array.isArray(input)) return refuse('content');
  for (const item of input) {
    if (!isObject(item)) return refuse('content');
    const type = item.type ?? (isString(item.role) ? 'message' : undefined);
    if (!isString(type) || !Object.hasOwn(CHATGPT_ITEMS, type) || !shaped(item, CHATGPT_ITEMS[type]!)) return refuse('content');
    // Each item's identifying fields are present, not just allowed: a message names its role and
    // content; a call, its id, name and arguments; an output, its call id and output.
    if (!CHATGPT_REQUIRED_ITEM_KEYS[type]!.every((key) => item[key] !== undefined)) return refuse('content');
  }
  if (tools !== undefined && !arrayOf(chatgptNamespace)(tools)) return refuse('tool');
  // A tool inside a namespace can't be named by `tool_choice`; only the modes are allowed.
  if (toolChoice !== undefined && !oneOf('auto', 'none', 'required')(toolChoice)) return refuse('tool');
  if (parallel !== undefined && !oneOf(true, false)(parallel)) return refuse('body-field');
  if (reasoning !== undefined && !shaped(reasoning, { effort: oneOf('minimal', 'low', 'medium', 'high'), summary: oneOf('auto', 'concise', 'detailed') })) return refuse('body-field');
  if (text !== undefined && !shaped(text, { verbosity: oneOf('low', 'medium', 'high'), format: (format) => shaped(format, { type: oneOf('text') }) })) return refuse('body-field');
  return OK;
}

function checkGateway(body: Json, openAiModel: boolean): BodyCheck {
  const { prompt, tools, toolChoice, providerOptions } = body;
  if (!outputCap(body.maxOutputTokens)) return refuse('output-cap');
  if (!Array.isArray(prompt)) return refuse('content');
  for (const message of prompt) {
    if (!isObject(message) || !onlyKeys(message, ['role', 'content', 'providerOptions'])) return refuse('content');
    if (!optional(message.providerOptions, partOptions)) return refuse('provider-options');
    if (message.role === 'system') {
      if (!isString(message.content)) return refuse('content');
      continue;
    }
    if ((message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') || !Array.isArray(message.content)) return refuse('content');
    const allowed = GATEWAY_PARTS[message.role];
    for (const part of message.content) {
      if (!isObject(part) || !isString(part.type) || !Object.hasOwn(allowed, part.type)) return refuse(isObject(part) && part.providerExecuted !== undefined ? 'tool' : 'content');
      if (!optional(part.providerOptions, partOptions)) return refuse('provider-options');
      if (!shaped(part, allowed[part.type]!)) return refuse(part.providerExecuted !== undefined ? 'tool' : 'content');
    }
  }
  if (tools !== undefined && !arrayOf(gatewayTool)(tools)) return refuse('tool');
  if (toolChoice !== undefined && !(isObject(toolChoice) && (shaped(toolChoice, { type: oneOf('auto', 'none', 'required') }) || shaped(toolChoice, { type: oneOf('tool'), toolName: isString })) && toolChoice.type !== undefined)) return refuse('tool');
  // `store` first, so a stored conversation is refused as such.
  const openai = isObject(providerOptions) && isObject(providerOptions.openai) ? providerOptions.openai : undefined;
  if (openai?.store !== undefined && openai.store !== false) return refuse('store');
  if (openAiModel && openai?.store !== false) return refuse('store');
  if (providerOptions !== undefined) {
    if (!isObject(providerOptions)) return refuse('provider-options');
    for (const [provider, options] of Object.entries(providerOptions)) {
      if (!Object.hasOwn(GATEWAY_PROVIDER_OPTIONS, provider) || !shaped(options, GATEWAY_PROVIDER_OPTIONS[provider]!)) return refuse('provider-options');
    }
    const anthropic = providerOptions.anthropic;
    if (isObject(anthropic) && anthropic.thinking !== undefined && !checkGatewayThinking(anthropic.thinking, body.maxOutputTokens as number)) return refuse('output-cap');
  }
  return OK;
}
