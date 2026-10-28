/**
 * The MessagePort protocol between main and the agent runtime utility process (Phase 5 Task 1;
 * acceptance `agent-protocol.feature.md`). Main-and-runtime only (Zod): the chrome imports the plain
 * values of `agent-tools.spec.ts` and this module's types only.
 *
 * Both sides parse every message they receive with the matching union and drop anything that
 * fails: an unknown `type`, an unknown field (every object is strict), or a value over its bound.
 * The runtime asks and reports; main decides. No runtime → main message can approve a call, grant
 * a tool, change a setting or carry a key (plan decision 7; test `agent-cannot-approve`).
 *
 * Bytes travel as `Uint8Array`: the structured clone a MessagePort uses copies typed arrays as they
 * are, with no base64 step (and its third more bytes) on either side.
 */
import { z } from 'zod';
import {
  CHAT_MAX_MESSAGES,
  isAgentToolName,
  isAllowedModelId,
  isMcpToolName,
  MAX_TOOL_STEPS,
  MODEL_ROUTES,
  TOOL_ERROR_CODES,
  TOOL_RESULT_MAX_CHARS,
} from './agent-tools.spec';

/** Bumped when a message changes shape; the runtime reports it in `ready` and main refuses another. */
export const AGENT_PROTOCOL_VERSION = 3;

/** Every bound the schemas enforce. */
export const AGENT_PROTOCOL_LIMITS = {
  /** Chat, call and request ids: printable ASCII without spaces (characters). */
  maxIdChars: 256,
  /** A chat message's text: a user's message or a model reply (characters). */
  maxMessageChars: 64_000,
  /** The system prompt (characters). */
  maxSystemPromptChars: 32_000,
  /** Tool calls in one assistant message. */
  maxToolCallsPerMessage: 32,
  /** Tool names a chat allows (frost's and MCP tools). */
  maxAllowedTools: 64,
  /** A tool call's input: the JSON text (characters), its nesting depth and its values. */
  maxToolInputChars: 100_000,
  maxJsonDepth: 32,
  maxJsonNodes: 20_000,
  /** The untrusted wrapper's `source` (characters). */
  maxSourceChars: 4096,
  /** An error message (`chat.error`, `fetch.error`, a failed tool result). */
  maxErrorChars: 2000,
  /** One `chat.delta`'s text (characters). */
  maxDeltaChars: 16_000,
  /** A model id (characters); main checks it against `ALLOWED_MODEL_IDS`. */
  maxModelIdChars: 128,
  /** A proxied request's URL (characters); main checks it with `isAllowedModelRequest`. */
  maxUrlChars: 4096,
  /** Headers on a proxied request or response, a name's and a value's length (characters). */
  maxHeaders: 128,
  maxHeaderNameChars: 256,
  maxHeaderValueChars: 8192,
  /** A proxied request's body (UTF-16 characters for a string, bytes for a `Uint8Array`). */
  maxRequestBodyBytes: 16 * 1024 * 1024,
  /** One response chunk (bytes); main splits larger reads. */
  maxChunkBytes: 256 * 1024,
  /** A response's status text (characters). */
  maxStatusTextChars: 256,
  /** A proxied response's whole body (bytes); the runtime gives up on a longer one (`too-large`). */
  maxResponseBytes: 32 * 1024 * 1024,
} as const;

/**
 * What the runtime removes at startup (Phase 5 Tasks 2 and 3): the network globals; the `process`
 * functions that reach a builtin or native module around the bundle's imports; the module loader
 * (`process.mainModule`, `Module._load`, `Module.prototype.require`: no module loads once the
 * bundle has); and code generation from strings (`eval`, the `Function` constructors).
 */
export const LOCKDOWN_TARGETS = [
  'fetch',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'XMLHttpRequest',
  'process.getBuiltinModule',
  'process.binding',
  'process._linkedBinding',
  'process.dlopen',
  'process.mainModule',
  'Module._load',
  'Module.prototype.require',
  'eval',
  'Function',
] as const;
export type LockdownTarget = (typeof LOCKDOWN_TARGETS)[number];

const L = AGENT_PROTOCOL_LIMITS;

// ---- Shared values ---------------------------------------------------------------------------

/** An id: 1–`maxIdChars` printable ASCII characters, no spaces. */
export const AgentIdSchema = z.string().regex(/^[\x21-\x7e]+$/).max(L.maxIdChars);

/** A tool name the protocol accepts: one of frost's catalogue or an MCP tool's (`agent-tools.spec.ts`). */
export const ToolNameSchema = z.string().refine((name) => isAgentToolName(name) || isMcpToolName(name), { message: 'not a known tool name' });

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Object keys refused in tool inputs and outputs: they name prototype machinery, never data. */
const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Whether `value` is plain JSON data: null, booleans, finite numbers, strings, dense arrays with no
 * other own keys, and plain objects with no `__proto__`, `constructor` or `prototype` key; no deeper
 * than `maxDepth`, with at most `maxNodes` values and a JSON text of at most `maxChars`. Walks
 * iteratively and checks the value budget before queueing an array's or object's members, so a
 * deeply nested or huge value fails fast without exhausting the stack. Never throws (a getter or
 * proxy that throws makes it `false`).
 */
export function isBoundedJson(value: unknown, maxChars: number, maxDepth: number = L.maxJsonDepth, maxNodes: number = L.maxJsonNodes): value is JsonValue {
  try {
    return walkBoundedJson(value, maxChars, maxDepth, maxNodes);
  } catch {
    return false;
  }
}

function walkBoundedJson(value: unknown, maxChars: number, maxDepth: number, maxNodes: number): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 1;
  let chars = 0;
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (depth > maxDepth) return false;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') {
      if ((chars += current.length) > maxChars) return false;
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) return false;
      if ((nodes += current.length) > maxNodes) return false;
      // A sparse array, or one with a named own key, is not JSON data.
      if (Object.keys(current).length !== current.length) return false;
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(current);
    if ((nodes += keys.length) > maxNodes) return false;
    for (const key of keys) {
      if (FORBIDDEN_JSON_KEYS.has(key) || (chars += key.length) > maxChars) return false;
      stack.push({ value: (current as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return JSON.stringify(value).length <= maxChars;
}

/**
 * Bounded JSON (`isBoundedJson` with `maxChars`), handed on as a fresh copy parsed from its JSON
 * text: a consumer only ever holds canonical JSON data (plain objects and arrays, no `-0`).
 */
export function boundedJsonSchema(maxChars: number, message: string) {
  return z
    .custom<JsonValue>((value) => isBoundedJson(value, maxChars), { message })
    .transform((value): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue);
}

/** A tool call's input: bounded JSON (`maxToolInputChars`). */
export const ToolInputSchema = boundedJsonSchema(L.maxToolInputChars, 'tool input is not bounded JSON');

/**
 * Tool output as the model sees it: main wraps every result as untrusted data, never instructions
 * (plan decision 9). `source` says where it came from (the tool, and the page URL for a page tool);
 * `data`'s JSON text is at most `TOOL_RESULT_MAX_CHARS` (main caps it before wrapping).
 */
export const UntrustedOutputSchema = z.strictObject({
  untrusted: z.literal(true),
  source: z.string().min(1).max(L.maxSourceChars),
  data: boundedJsonSchema(TOOL_RESULT_MAX_CHARS, 'tool output is not bounded JSON'),
});
export type UntrustedOutput = z.output<typeof UntrustedOutputSchema>;

/** A tool call's outcome: the wrapped output, or why there is none (`TOOL_ERROR_CODES`). */
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), output: UntrustedOutputSchema }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.enum(TOOL_ERROR_CODES), message: z.string().max(L.maxErrorChars) }) }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** A tool call an assistant message made (history and `chat.tool-call` cards). */
export const ToolCallSchema = z.strictObject({ callId: AgentIdSchema, toolName: ToolNameSchema, input: ToolInputSchema });
export type ToolCall = z.infer<typeof ToolCallSchema>;

/**
 * A message of the chat so far, as main keeps it: the user's text, the model's reply (its text and
 * the tool calls it made) or a tool call's result (still wrapped untrusted).
 */
export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('user'), content: z.string().min(1).max(L.maxMessageChars) }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().max(L.maxMessageChars),
    toolCalls: z.array(ToolCallSchema).max(L.maxToolCallsPerMessage),
  }),
  z.strictObject({ role: z.literal('tool'), callId: AgentIdSchema, toolName: ToolNameSchema, result: ToolResultSchema }),
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** HTTP headers as `[name, value]` pairs (repeats allowed), bounded. */
export const HeaderListSchema = z
  .array(z.tuple([z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).max(L.maxHeaderNameChars), z.string().regex(/^[\t\x20-\x7e\x80-\xff]*$/).max(L.maxHeaderValueChars)]))
  .max(L.maxHeaders);
export type HeaderList = z.infer<typeof HeaderListSchema>;

const bytes = (max: number) => z.instanceof(Uint8Array).refine((value) => value.byteLength <= max, { message: 'over its byte cap' });

// ---- main → runtime --------------------------------------------------------------------------

/** Starts a turn: the chat so far, ending with the user's new message. */
export const ChatStartMessageSchema = z.strictObject({
  type: z.literal('chat.start'),
  chatId: AgentIdSchema,
  messages: z
    .array(ChatMessageSchema)
    .min(1)
    .max(CHAT_MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === 'user', { message: "a turn starts from the user's message" }),
  systemPrompt: z.string().max(L.maxSystemPromptChars),
  modelId: z.string().max(L.maxModelIdChars).refine(isAllowedModelId, { message: 'not an allowed model' }),
  route: z.enum(MODEL_ROUTES),
  allowedTools: z
    .array(ToolNameSchema)
    .max(L.maxAllowedTools)
    .refine((names) => new Set(names).size === names.length, { message: 'a tool is named twice' }),
});

export const MainToRuntimeMessageSchema = z.discriminatedUnion('type', [
  ChatStartMessageSchema,
  /** Stops a turn (the user's Stop): the runtime aborts its stream and finishes with `aborted`. */
  z.strictObject({ type: z.literal('chat.stop'), chatId: AgentIdSchema }),
  /** Answers a `tool.invoke`. */
  z.strictObject({ type: z.literal('tool.result'), chatId: AgentIdSchema, callId: AgentIdSchema, result: ToolResultSchema }),
  /** A proxied model response's head (main followed no redirect). */
  z.strictObject({
    type: z.literal('fetch.response-start'),
    requestId: AgentIdSchema,
    status: z.int().min(100).max(599),
    statusText: z.string().max(L.maxStatusTextChars),
    headers: HeaderListSchema,
  }),
  /** The next piece of the response body. */
  z.strictObject({ type: z.literal('fetch.chunk'), requestId: AgentIdSchema, bytes: bytes(L.maxChunkBytes) }),
  /** The body is complete. */
  z.strictObject({ type: z.literal('fetch.end'), requestId: AgentIdSchema }),
  /** The request was refused or failed; nothing more comes for it. */
  z.strictObject({
    type: z.literal('fetch.error'),
    requestId: AgentIdSchema,
    code: z.enum(['refused', 'network', 'aborted', 'timeout', 'too-large']),
    message: z.string().max(L.maxErrorChars),
  }),
]);
export type MainToRuntimeMessage = z.infer<typeof MainToRuntimeMessageSchema>;

export const MAIN_TO_RUNTIME_MESSAGE_TYPES = ['chat.start', 'chat.stop', 'tool.result', 'fetch.response-start', 'fetch.chunk', 'fetch.end', 'fetch.error'] as const satisfies readonly MainToRuntimeMessage['type'][];

// ---- runtime → main --------------------------------------------------------------------------

/** Chat finish reasons: the model's own, plus `aborted` (Stop) and `step-limit` (`MAX_TOOL_STEPS`). */
export const CHAT_FINISH_REASONS = ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other', 'aborted', 'step-limit'] as const;
export type ChatFinishReason = (typeof CHAT_FINISH_REASONS)[number];

/** A count the provider reported, or `null` when it reported none. */
const count = z.int().nonnegative().nullable();

export const RuntimeToMainMessageSchema = z.discriminatedUnion('type', [
  /**
   * The runtime is listening (after its lockdown), speaking `protocolVersion`. `lockdown` says what
   * it removed (`LOCKDOWN_TARGETS`), what it could not, and whether Node's permission model is in
   * effect (file writes refused), so the agent settings never claim a lockdown that isn't there.
   */
  z.strictObject({
    type: z.literal('ready'),
    protocolVersion: z.int().positive(),
    lockdown: z.strictObject({
      removed: z.array(z.enum(LOCKDOWN_TARGETS)).max(LOCKDOWN_TARGETS.length),
      failed: z.array(z.enum(LOCKDOWN_TARGETS)).max(LOCKDOWN_TARGETS.length),
      permissionModel: z.boolean(),
    }),
  }),
  /** More of the model's reply text. */
  z.strictObject({ type: z.literal('chat.delta'), chatId: AgentIdSchema, text: z.string().min(1).max(L.maxDeltaChars) }),
  /** The model called a tool: a card for the panel (main still decides whether it runs). */
  z.strictObject({ type: z.literal('chat.tool-call'), chatId: AgentIdSchema, callId: AgentIdSchema, toolName: ToolNameSchema, input: ToolInputSchema }),
  /**
   * The turn ended. `steps` is at most `MAX_TOOL_STEPS`; `usage` is the model's input and output
   * size in its own units (tokens), summed over the steps.
   */
  z.strictObject({
    type: z.literal('chat.finish'),
    chatId: AgentIdSchema,
    finishReason: z.enum(CHAT_FINISH_REASONS),
    steps: z.int().min(0).max(MAX_TOOL_STEPS),
    usage: z.strictObject({ input: count, output: count }),
  }),
  /** The turn failed; `message` is shown to the user (no key or request detail in it). */
  z.strictObject({ type: z.literal('chat.error'), chatId: AgentIdSchema, message: z.string().min(1).max(L.maxErrorChars) }),
  /** Asks main to run a tool call; main's broker decides and answers `tool.result`. */
  z.strictObject({ type: z.literal('tool.invoke'), chatId: AgentIdSchema, callId: AgentIdSchema, toolName: ToolNameSchema, input: ToolInputSchema }),
  /** Asks main to send a model request (main checks the URL, drops credential headers, adds the key). */
  z.strictObject({
    type: z.literal('fetch.request'),
    requestId: AgentIdSchema,
    url: z.string().min(1).max(L.maxUrlChars),
    method: z.enum(['GET', 'POST']),
    headers: HeaderListSchema,
    body: z.union([z.string().max(L.maxRequestBodyBytes), bytes(L.maxRequestBodyBytes), z.null()]),
  }),
  /** The runtime no longer wants a response (Stop, or the provider gave up). */
  z.strictObject({ type: z.literal('fetch.abort'), requestId: AgentIdSchema }),
  /**
   * A model step ended: what the model produced in it, in history shape (an assistant
   * `ChatMessage`'s `content` and `toolCalls`), so main stores exactly that. `text` is cut at
   * `maxMessageChars`. `toolCalls` holds the calls main was asked to run (`tool.invoke`), in order;
   * a call the runtime rejected (invalid input, a tool not offered, out of bounds) is left out with
   * its error result, so the history pairs up. Posted after the step's calls were answered; a step
   * cut short by Stop or a failure is posted before `chat.finish` / `chat.error`.
   */
  z.strictObject({
    type: z.literal('chat.step'),
    chatId: AgentIdSchema,
    step: z.int().min(1).max(MAX_TOOL_STEPS),
    text: z.string().max(L.maxMessageChars),
    toolCalls: z.array(ToolCallSchema).max(L.maxToolCallsPerMessage),
  }),
]);
export type RuntimeToMainMessage = z.infer<typeof RuntimeToMainMessageSchema>;

/**
 * Every message type the runtime may send. None approves, grants, changes a setting or carries a
 * key; main drops any other type.
 */
export const RUNTIME_TO_MAIN_MESSAGE_TYPES = ['ready', 'chat.delta', 'chat.tool-call', 'chat.finish', 'chat.error', 'tool.invoke', 'fetch.request', 'fetch.abort', 'chat.step'] as const satisfies readonly RuntimeToMainMessage['type'][];
