// The chat loop (Phase 5 Task 2, plan decisions 5 and 7; acceptance `specs/agent-runtime.feature.md`,
// Chat loop): one turn of a chat, from main's `chat.start` to `chat.finish` or `chat.error`.
//
// The model sees only the chat's allowed catalogue tools, and the MCP tools main defined for the
// turn (`chat.start.mcpTools`, Task 10: sanitised JSON Schemas, untrusted descriptions). Each tool's `execute` is a request: it
// posts `tool.invoke` and waits for main's `tool.result` (main's broker approves, runs or refuses;
// nothing here can). A failed result is the tool's error output to the model, not an exception, so
// the turn goes on. Tool calls run one at a time (acting tools must not race). Each step's output is
// posted as `chat.step` for main's history. The system prompt is main's (`chat.start`); nothing here
// adds one.
import { APICallError, isStepCount, jsonSchema, streamText, zodSchema, type FinishReason, type LanguageModel, type ModelMessage, type Tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import { getToolDefinition } from '@app/ai-skills';
import {
  AGENT_PROTOCOL_LIMITS as L,
  ToolCallSchema,
  type ChatFinishReason,
  type ChatMessage,
  type JsonValue,
  type MainToRuntimeMessage,
  type RuntimeToMainMessage,
  type ToolCall,
  type ToolResult,
} from '@app/specs/agent-protocol.schema';
import { MAX_OUTPUT_TOKENS } from '@app/specs/agent-proxy.spec';
import { isAgentToolName, isMcpToolName, MAX_TOOL_STEPS } from '@app/specs/agent-tools.spec';
import { ProxyFetchError } from './proxy-fetch';
import { ModelNotAllowedError } from './provider';

export type ChatStart = Extract<MainToRuntimeMessage, { type: 'chat.start' }>;

/**
 * Retries of a model request the provider reports retryable (HTTP 429 and 5xx; the AI SDK's default
 * is 2). A failed proxied request is never retried here (`provider.ts`): main decides about those.
 */
export const CHAT_MAX_RETRIES = 1;

/** What the model reads for a call that has no result in the history (Stop during an approval). */
export const UNANSWERED_CALL_OUTPUT = { error: 'aborted', message: 'The chat was stopped before this call was answered.' } as const;

/** Provider options for every turn: OpenAI keeps nothing (`store: false`); other providers ignore it. */
export const CHAT_PROVIDER_OPTIONS = { openai: { store: false } } as const;

export interface RunChatOptions {
  readonly start: ChatStart;
  readonly model: LanguageModel;
  /** Posts a message to main; `false` when it was not sent (out of the protocol's bounds). */
  readonly post: (message: RuntimeToMainMessage) => boolean;
  /** Aborted by `chat.stop`. */
  readonly signal: AbortSignal;
}

export interface ChatRun {
  /** Settles (never rejects) once `chat.finish` or `chat.error` is posted. */
  readonly done: Promise<void>;
  /** Hands main's `tool.result` to the call waiting for it; `false` when none waits. */
  deliverToolResult(callId: string, result: ToolResult): boolean;
}

type ToolResultOutput = { type: 'json'; value: never } | { type: 'error-json'; value: never };

/** A tool result as the model reads it: main's untrusted wrapper (`json`), or `{ error, message }` (`error-json`). */
export function toolResultOutput(result: ToolResult): ToolResultOutput {
  return result.ok
    ? { type: 'json', value: result.output as never }
    : { type: 'error-json', value: { error: result.error.code, message: result.error.message } as never };
}

type AssistantContent = Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string>;
type ToolResultPart = Extract<Extract<ModelMessage, { role: 'tool' }>['content'][number], { type: 'tool-result' }>;

/**
 * The protocol's chat history as AI SDK messages. Each assistant message's tool calls are followed
 * by one tool message with a result per call, in call order: main's result when the tool messages
 * right after it hold one, else `UNANSWERED_CALL_OUTPUT` (`error-json`). A tool result that answers
 * no call of the assistant message just before it is dropped: providers refuse both cases.
 */
export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'tool':
        // Not right after an assistant message's calls: an orphan.
        break;
      case 'assistant': {
        const content: AssistantContent = [];
        if (message.content !== '') content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls) content.push({ type: 'tool-call', toolCallId: call.callId, toolName: call.toolName, input: call.input });
        if (content.length > 0) out.push({ role: 'assistant', content });
        if (message.toolCalls.length === 0) break;
        // The results right after it (the first for each call); the rest are orphans.
        const answers = new Map<string, ToolResult>();
        while (messages[i + 1]?.role === 'tool') {
          i += 1;
          const result = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
          if (!answers.has(result.callId)) answers.set(result.callId, result.result);
        }
        const parts: ToolResultPart[] = message.toolCalls.map((call) => {
          const answer = answers.get(call.callId);
          return {
            type: 'tool-result',
            toolCallId: call.callId,
            toolName: call.toolName,
            output: answer !== undefined ? toolResultOutput(answer) : { type: 'error-json', value: UNANSWERED_CALL_OUTPUT as never },
          };
        });
        out.push({ role: 'tool', content: parts });
        break;
      }
    }
  }
  return out;
}

/** Splits `text` into pieces of at most `max` characters, never between a surrogate pair. */
export function splitText(text: string, max: number = L.maxDeltaChars): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length && end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `text` cut at `max` characters, never between a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max);
}

/**
 * The AI SDK's URL download, replaced: the runtime fetches nothing for the model. The SDK calls it
 * on every step (with no URLs for a text-only chat, answered with none); any URL is refused.
 */
export async function refuseDownload(requests: readonly { url: URL; isUrlSupportedByModel: boolean }[]): Promise<never[]> {
  if (requests.length > 0) throw new Error('frost does not download files for the model');
  return [];
}

/** The turn's finish reason for the protocol (`step-limit` when it still wanted tools at the cap). */
export function chatFinishReason(reason: FinishReason | undefined, steps: number): ChatFinishReason {
  if (reason === 'tool-calls' && steps >= MAX_TOOL_STEPS) return 'step-limit';
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
      return reason;
    default:
      return 'other';
  }
}

/**
 * What the user reads when a turn fails: a short sentence by kind of failure, never the error's
 * own text (which may echo a request or response), a stack or a header.
 */
export function chatErrorMessage(error: unknown): string {
  let statusCode: number | undefined;
  for (let current: unknown = error, depth = 0; current !== null && typeof current === 'object' && depth < 8; depth += 1) {
    if (current instanceof ModelNotAllowedError) return 'This model is not available on the selected route.';
    if (current instanceof ProxyFetchError) {
      switch (current.code) {
        case 'refused':
          return 'frost refused to send this model request.';
        case 'timeout':
          return 'The model provider took too long to answer.';
        case 'too-large':
          return 'The model request or its answer was too large.';
        case 'aborted':
          return 'The model request was stopped.';
        case 'invalid-request':
          return 'The model request could not be sent.';
        case 'network':
          return 'The model provider could not be reached.';
      }
    }
    if (APICallError.isInstance(current) && current.statusCode !== undefined) statusCode ??= current.statusCode;
    const own = (current as { statusCode?: unknown }).statusCode;
    if (typeof own === 'number' && Number.isInteger(own)) statusCode ??= own;
    current = (current as { lastError?: unknown }).lastError ?? (current as { cause?: unknown }).cause;
  }
  if (statusCode === 401 || statusCode === 403) return `The model provider refused the key (HTTP ${statusCode}). Check the key in the agent settings.`;
  if (statusCode === 429) return 'The model provider is limiting requests (HTTP 429). Try again shortly.';
  if (statusCode !== undefined) return `The model provider answered with an error (HTTP ${statusCode}).`;
  return 'The chat failed.';
}

/** Adds a reported count to a running sum that is `null` until a count is reported. */
function addCount(sum: number | null, value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) || value < 0 ? sum : (sum ?? 0) + Math.floor(value);
}

export function runChat({ start, model, post, signal }: RunChatOptions): ChatRun {
  const { chatId } = start;
  const waiting = new Map<string, (result: ToolResult) => void>();
  /** The calls main was asked to run (`tool.invoke` posted), by call id. */
  const invoked = new Map<string, ToolCall>();

  const failure = (code: 'failed' | 'invalid-input', message: string): ToolResult => ({ ok: false, error: { code, message } });

  const invoke = (callId: string, toolName: string, input: unknown): Promise<ToolResult> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (waiting.has(callId) || invoked.has(callId)) return Promise.resolve(failure('failed', 'a tool call with this id was already made'));
    const parsed = ToolCallSchema.safeParse({ callId, toolName, input });
    if (!parsed.success) return Promise.resolve(failure('invalid-input', 'the tool call is out of bounds and was not sent'));
    const call = parsed.data;
    return new Promise<ToolResult>((resolve, reject) => {
      const onAbort = () => {
        waiting.delete(callId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.set(callId, (result) => {
        signal.removeEventListener('abort', onAbort);
        waiting.delete(callId);
        resolve(result);
      });
      // The card first (the panel shows the call), then the request main's broker answers.
      const sent = post({ type: 'chat.tool-call', chatId, ...call }) && post({ type: 'tool.invoke', chatId, ...call });
      if (sent) {
        invoked.set(callId, call);
        return;
      }
      signal.removeEventListener('abort', onAbort);
      waiting.delete(callId);
      resolve(failure('invalid-input', 'the tool call could not be sent'));
    });
  };

  const tools: ToolSet = {};
  // MCP tools (Task 10): main's sanitised definitions, as the protocol checked them (one per MCP name allowed).
  const mcpDefinitions = new Map(start.mcpTools.map((tool) => [tool.name, tool] as const));
  for (const name of start.allowedTools) {
    const execute = (input: unknown, { toolCallId }: { toolCallId: string }) => invoke(toolCallId, name, input);
    const toModelOutput = ({ output }: { output: ToolResult }) => toolResultOutput(output);
    if (!isAgentToolName(name)) {
      if (!isMcpToolName(name)) continue;
      const mcp = mcpDefinitions.get(name);
      if (mcp === undefined) continue;
      // No validation here: main checks the input against the same schema before it calls the server.
      const offered: Tool = { description: mcp.description, inputSchema: jsonSchema(mcp.inputSchema as Parameters<typeof jsonSchema>[0]), execute, toModelOutput };
      tools[name] = offered;
      continue;
    }
    const definition = getToolDefinition(name);
    const offered: Tool = {
      description: definition.description,
      inputSchema: zodSchema(definition.inputSchema as z.ZodType<unknown>),
      execute,
      toModelOutput,
    };
    tools[name] = offered;
  }

  const run = async () => {
    let steps = 0;
    let input: number | null = null;
    let output: number | null = null;
    let reason: FinishReason | undefined;
    let error: unknown;
    let failed = false;
    // The step being streamed: its text and the ids of the calls the model made in it.
    let stepText = '';
    let stepCallIds: string[] = [];
    const postStep = (step: number, usage?: { input: number | null; output: number | null }) => {
      const toolCalls = stepCallIds.flatMap((id) => invoked.get(id) ?? []).slice(0, L.maxToolCallsPerMessage);
      post({ type: 'chat.step', chatId, step: Math.min(Math.max(step, 1), MAX_TOOL_STEPS), text: cut(stepText, L.maxMessageChars), toolCalls, ...(usage ? { usage } : {}) });
      stepText = '';
      stepCallIds = [];
    };
    try {
      const result = streamText({
        model,
        ...(start.systemPrompt === '' ? {} : { instructions: start.systemPrompt }),
        messages: toModelMessages(start.messages),
        tools,
        stopWhen: isStepCount(MAX_TOOL_STEPS),
        toolCallConcurrency: 1,
        maxRetries: CHAT_MAX_RETRIES,
        // Main's proxy refuses a request without this cap (a provider's default can be its model's maximum).
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: signal,
        providerOptions: CHAT_PROVIDER_OPTIONS,
        experimental_download: refuseDownload,
        // The default logs the error (and whatever it carries); the turn's failure is reported below.
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            if (stepText.length <= L.maxMessageChars) stepText += part.text;
            for (const text of splitText(part.text)) post({ type: 'chat.delta', chatId, text });
            break;
          case 'tool-call':
            // A call the SDK rejected (invalid input, a tool not offered) is never invoked: it is
            // left out of the step with its error result.
            if (part.invalid !== true) stepCallIds.push(part.toolCallId);
            break;
          case 'finish-step':
            steps += 1;
            input = addCount(input, part.usage.inputTokens);
            output = addCount(output, part.usage.outputTokens);
            reason = part.finishReason;
            // This step's own usage too: the panel's context meter reads the last step's.
            postStep(steps, { input: addCount(null, part.usage.inputTokens), output: addCount(null, part.usage.outputTokens) });
            break;
          case 'finish':
            reason = part.finishReason;
            break;
          case 'error':
            if (!failed) {
              failed = true;
              error = part.error;
            }
            break;
          default:
            break;
        }
      }
    } catch (thrown) {
      if (!failed) {
        failed = true;
        error = thrown;
      }
    }
    // A step cut short by Stop or a failure: what it produced still goes to main's history.
    if (stepText !== '' || stepCallIds.some((id) => invoked.has(id))) postStep(steps + 1);
    const usage = { input, output };
    const reported = Math.min(steps, MAX_TOOL_STEPS);
    if (signal.aborted) post({ type: 'chat.finish', chatId, finishReason: 'aborted', steps: reported, usage });
    else if (failed) post({ type: 'chat.error', chatId, message: chatErrorMessage(error) });
    else post({ type: 'chat.finish', chatId, finishReason: chatFinishReason(reason, steps), steps: reported, usage });
  };

  return {
    done: run().catch(() => {}),
    deliverToolResult(callId, result) {
      const deliver = waiting.get(callId);
      if (deliver === undefined) return false;
      deliver(result);
      return true;
    },
  };
}
