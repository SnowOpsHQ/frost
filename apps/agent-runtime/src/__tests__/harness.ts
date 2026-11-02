// Test helpers: the runtime on an in-memory port pair, main's end recorded, and scripted
// LanguageModelV4 streams for `MockLanguageModelV4` (all offline).
import type { LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import { convertArrayToReadableStream } from 'ai/test';
import { vi } from 'vitest';
import type { MainToRuntimeMessage, RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { startRuntime, type RuntimeOptions } from '../runtime';
import { createMemoryPortPair } from '../transport';

export type Received<T extends RuntimeToMainMessage['type']> = Extract<RuntimeToMainMessage, { type: T }>;

export function startHarness(options: RuntimeOptions = {}) {
  const [main, runtimeEnd] = createMemoryPortPair();
  const received: RuntimeToMainMessage[] = [];
  const listeners: ((message: RuntimeToMainMessage) => void)[] = [];
  main.onMessage((data) => {
    received.push(data as RuntimeToMainMessage);
    for (const listener of listeners) listener(data as RuntimeToMainMessage);
  });
  const runtime = startRuntime(runtimeEnd, options);
  const of = <T extends RuntimeToMainMessage['type']>(type: T) => received.filter((message): message is Received<T> => message.type === type);
  return {
    runtime,
    received,
    of,
    /** Posts from main's end (raw: invalid messages too). */
    send: (message: MainToRuntimeMessage | unknown) => main.post(message),
    /** Calls `listener` for each message the runtime posts from now on. */
    onMessage: (listener: (message: RuntimeToMainMessage) => void) => listeners.push(listener),
    /** Waits until a message of `type` (matching `where`) has arrived and answers it. */
    async next<T extends RuntimeToMainMessage['type']>(type: T, where: (message: Received<T>) => boolean = () => true, timeout = 2000): Promise<Received<T>> {
      return vi.waitFor(
        () => {
          const found = of(type).find(where);
          if (found === undefined) throw new Error(`no ${type} yet`);
          return found;
        },
        { timeout, interval: 2 },
      );
    },
  };
}

/**
 * Replaces the network globals with ones that throw, so a fallback to a real request fails the
 * test (restore with `vi.unstubAllGlobals()`).
 */
export function stubNetworkGlobals(): void {
  const refuse = () => {
    throw new Error('the runtime used a network global');
  };
  vi.stubGlobal('fetch', refuse);
  vi.stubGlobal('WebSocket', refuse);
  vi.stubGlobal('EventSource', refuse);
}

/** Lets queued microtasks and timers run. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

export const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

type Unified = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

export function streamOf(parts: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return { stream: convertArrayToReadableStream(parts) };
}

/** A step that streams `deltas` as text and finishes `finish`. */
export function textStep(deltas: readonly string[], finish: Unified = 'stop', tokens = usage(10, 5)): LanguageModelV4StreamResult {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: { unified: finish, raw: undefined }, usage: tokens },
  ]);
}

/** A step that calls `toolName` with `input` (its JSON text) and finishes `tool-calls`. */
export function toolStep(toolCallId: string, toolName: string, input: unknown, tokens = usage(20, 8)): LanguageModelV4StreamResult {
  return streamOf([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: tokens },
  ]);
}

export const chatStart = (overrides: Partial<Extract<MainToRuntimeMessage, { type: 'chat.start' }>> = {}): Extract<MainToRuntimeMessage, { type: 'chat.start' }> => ({
  type: 'chat.start',
  chatId: 'chat-1',
  messages: [{ role: 'user', content: 'How is this page doing?' }],
  systemPrompt: 'You are frost’s SEO assistant.',
  modelId: 'anthropic/claude-sonnet-5-5',
  route: 'byok-anthropic',
  allowedTools: ['page_audit', 'page_text'],
  mcpTools: [],
  // Protocol version 8: main's effective level (`auto` sends no reasoning field).
  reasoningEffort: 'auto',
  ...overrides,
});
