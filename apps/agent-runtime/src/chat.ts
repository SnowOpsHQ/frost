// The chat loop (Phase 5 Task 2, plan decisions 5 and 7; acceptance `specs/agent-runtime.feature.md`,
// Chat loop): one turn of a chat, from main's `chat.start` to `chat.finish` or `chat.error`.
//
// The model sees only the chat's allowed catalogue tools. Each tool's `execute` is a request: it
// posts `tool.invoke` and waits for main's `tool.result` (main's broker approves, runs or refuses;
// nothing here can). A failed result is the tool's output to the model, not an exception, so the
// turn goes on. Tool calls run one at a time (acting tools must not race). The system prompt is
// main's (`chat.start`); nothing here adds one.
import { APICallError, stepCountIs, streamText, zodSchema, type FinishReason, type LanguageModel, type ModelMessage, type Tool, type ToolSet } from 'ai';
import type { z } from 'zod';
import { getToolDefinition } from '@app/ai-skills';
import {
  AGENT_PROTOCOL_LIMITS as L,
  type ChatFinishReason,
  type ChatMessage,
  type JsonValue,
  type MainToRuntimeMessage,
  type RuntimeToMainMessage,
  type ToolResult,
} from '@app/specs/agent-protocol.schema';
import { isAgentToolName, MAX_TOOL_STEPS } from '@app/specs/agent-tools.spec';
import { ProxyFetchError } from './proxy-fetch';
import { ModelNotAllowedError } from './provider';

export type ChatStart = Extract<MainToRuntimeMessage, { type: 'chat.start' }>;

/** Retries of a failed model request (the AI SDK's default is 2). */
export const CHAT_MAX_RETRIES = 1;

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

/** A tool result as the model reads it: main's untrusted wrapper, or `{ error, message }`. */
export function modelToolOutput(result: ToolResult): JsonValue {
  return result.ok ? result.output : { error: result.error.code, message: result.error.message };
}

/** The protocol's chat history as AI SDK messages (consecutive tool results in one message). */
export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.content });
        break;
      case 'assistant': {
        const content: Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string> = [];
        if (message.content !== '') content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls) content.push({ type: 'tool-call', toolCallId: call.callId, toolName: call.toolName, input: call.input });
        if (content.length > 0) out.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        const part = {
          type: 'tool-result' as const,
          toolCallId: message.callId,
          toolName: message.toolName,
          output: { type: 'json' as const, value: modelToolOutput(message.result) as never },
        };
        const last = out.at(-1);
        if (last?.role === 'tool') last.content.push(part);
        else out.push({ role: 'tool', content: [part] });
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
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
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
    const next = (current as { lastError?: unknown; cause?: unknown }).lastError ?? (current as { cause?: unknown }).cause;
    current = next;
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

  const invoke = (callId: string, toolName: string, input: unknown): Promise<JsonValue> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (waiting.has(callId)) return Promise.resolve({ error: 'failed', message: 'a tool call with this id is already running' });
    return new Promise<JsonValue>((resolve, reject) => {
      const onAbort = () => {
        waiting.delete(callId);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.set(callId, (result) => {
        signal.removeEventListener('abort', onAbort);
        waiting.delete(callId);
        resolve(modelToolOutput(result));
      });
      const call = { chatId, callId, toolName, input: input as JsonValue };
      // The card first (the panel shows the call), then the request main's broker answers.
      const sent = post({ type: 'chat.tool-call', ...call }) && post({ type: 'tool.invoke', ...call });
      if (!sent) {
        signal.removeEventListener('abort', onAbort);
        waiting.delete(callId);
        resolve({ error: 'invalid-input', message: 'the tool call is out of bounds and was not sent' });
      }
    });
  };

  const tools: ToolSet = {};
  for (const name of start.allowedTools) {
    // MCP tools are offered once the protocol carries their definitions (Task 10).
    if (!isAgentToolName(name)) continue;
    const definition = getToolDefinition(name);
    const offered: Tool = {
      description: definition.description,
      inputSchema: zodSchema(definition.inputSchema as z.ZodType<unknown>),
      execute: (input: unknown, { toolCallId }: { toolCallId: string }) => invoke(toolCallId, name, input),
    };
    tools[name] = offered;
  }

  const run = async () => {
    let steps = 0;
    let input: number | null = null;
    let output: number | null = null;
    let reason: FinishReason | undefined;
    let failure: unknown;
    let failed = false;
    try {
      const result = streamText({
        model,
        ...(start.systemPrompt === '' ? {} : { instructions: start.systemPrompt }),
        messages: toModelMessages(start.messages),
        tools,
        stopWhen: stepCountIs(MAX_TOOL_STEPS),
        toolCallConcurrency: 1,
        maxRetries: CHAT_MAX_RETRIES,
        abortSignal: signal,
        // The default logs the error (and whatever it carries); the turn's failure is reported below.
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            for (const text of splitText(part.text)) post({ type: 'chat.delta', chatId, text });
            break;
          case 'finish-step':
            steps += 1;
            input = addCount(input, part.usage.inputTokens);
            output = addCount(output, part.usage.outputTokens);
            reason = part.finishReason;
            break;
          case 'finish':
            reason = part.finishReason;
            break;
          case 'error':
            if (!failed) {
              failed = true;
              failure = part.error;
            }
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    const usage = { input, output };
    const reported = Math.min(steps, MAX_TOOL_STEPS);
    if (signal.aborted) post({ type: 'chat.finish', chatId, finishReason: 'aborted', steps: reported, usage });
    else if (failed) post({ type: 'chat.error', chatId, message: chatErrorMessage(failure) });
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
