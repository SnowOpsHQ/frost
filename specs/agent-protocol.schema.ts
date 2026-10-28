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
  isMcpToolName,
  MAX_TOOL_STEPS,
  MODEL_ROUTES,
  TOOL_ERROR_CODES,
  TOOL_RESULT_MAX_CHARS,
} from './agent-tools.spec';

/** Bumped when a message changes shape; the runtime reports it in `ready` and main refuses another. */
export const AGENT_PROTOCOL_VERSION = 1;

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
  /** A proxied request's URL (characters); main checks it against `MODEL_ENDPOINTS`. */
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
} as const;

const L = AGENT_PROTOCOL_LIMITS;

// ---- Shared values ---------------------------------------------------------------------------

/** An id: 1–`maxIdChars` printable ASCII characters, no spaces. */
export const AgentIdSchema = z.string().regex(/^[\x21-\x7e]+$/).max(L.maxIdChars);

/** A tool name the protocol accepts: one of frost's catalogue or an MCP tool's (`agent-tools.spec.ts`). */
export const ToolNameSchema = z.string().refine((name) => isAgentToolName(name) || isMcpToolName(name), { message: 'not a known tool name' });

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Whether `value` is plain JSON data (null, booleans, finite numbers, strings, arrays, plain
 * objects) no deeper than `maxDepth`, with at most `maxNodes` values and a JSON text of at most
 * `maxChars`. Walks iteratively, so a deeply nested value can't exhaust the stack. Never throws.
 */
export function isBoundedJson(value: unknown, maxChars: number, maxDepth: number = L.maxJsonDepth, maxNodes: number = L.maxJsonNodes): value is JsonValue {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()!;
    if (++nodes > maxNodes || depth > maxDepth) return false;
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof current !== 'object') return false;
    const proto: unknown = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const key of Object.keys(current)) {
      if (key === '__proto__') return false;
      stack.push({ value: (current as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  try {
    return JSON.stringify(value).length <= maxChars;
  } catch {
    return false;
  }
}

/** A tool call's input: bounded JSON (`maxToolInputChars`). */
export const ToolInputSchema = z.custom<JsonValue>((value) => isBoundedJson(value, L.maxToolInputChars), { message: 'tool input is not bounded JSON' });

/**
 * Tool output as the model sees it: main wraps every result as untrusted data, never instructions
 * (plan decision 9). `source` says where it came from (the tool, and the page URL for a page tool);
 * `data`'s JSON text is at most `TOOL_RESULT_MAX_CHARS` (main caps it before wrapping).
 */
export const UntrustedOutputSchema = z.strictObject({
  untrusted: z.literal(true),
  source: z.string().min(1).max(L.maxSourceChars),
  data: z.custom<JsonValue>((value) => isBoundedJson(value, TOOL_RESULT_MAX_CHARS), { message: 'tool output is not bounded JSON' }),
});
export type UntrustedOutput = z.infer<typeof UntrustedOutputSchema>;

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
  modelId: z.string().min(1).max(L.maxModelIdChars),
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

const tokenCount = z.int().nonnegative().nullable();

export const RuntimeToMainMessageSchema = z.discriminatedUnion('type', [
  /** The runtime is listening (after its lockdown), speaking `protocolVersion`. */
  z.strictObject({ type: z.literal('ready'), protocolVersion: z.int().positive() }),
  /** More of the model's reply text. */
  z.strictObject({ type: z.literal('chat.delta'), chatId: AgentIdSchema, text: z.string().min(1).max(L.maxDeltaChars) }),
  /** The model called a tool: a card for the panel (main still decides whether it runs). */
  z.strictObject({ type: z.literal('chat.tool-call'), chatId: AgentIdSchema, callId: AgentIdSchema, toolName: ToolNameSchema, input: ToolInputSchema }),
  /** The turn ended. `steps` is at most `MAX_TOOL_STEPS`. */
  z.strictObject({
    type: z.literal('chat.finish'),
    chatId: AgentIdSchema,
    finishReason: z.enum(CHAT_FINISH_REASONS),
    steps: z.int().min(0).max(MAX_TOOL_STEPS),
    usage: z.strictObject({ inputTokens: tokenCount, outputTokens: tokenCount }),
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
]);
export type RuntimeToMainMessage = z.infer<typeof RuntimeToMainMessageSchema>;

/**
 * Every message type the runtime may send. None approves, grants, changes a setting or carries a
 * key; main drops any other type.
 */
export const RUNTIME_TO_MAIN_MESSAGE_TYPES = ['ready', 'chat.delta', 'chat.tool-call', 'chat.finish', 'chat.error', 'tool.invoke', 'fetch.request', 'fetch.abort'] as const satisfies readonly RuntimeToMainMessage['type'][];
