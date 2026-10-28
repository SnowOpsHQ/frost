// Spec: specs/agent-protocol.schema.ts (MainToRuntimeMessageSchema, RuntimeToMainMessageSchema,
// AGENT_PROTOCOL_LIMITS, MAIN_TO_RUNTIME_MESSAGE_TYPES, RUNTIME_TO_MAIN_MESSAGE_TYPES, isBoundedJson),
// specs/agent-tools.spec.ts (CHAT_MAX_MESSAGES, TOOL_RESULT_MAX_CHARS)
// Acceptance: specs/agent-protocol.feature.md (Protocol)
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import {
  AGENT_PROTOCOL_LIMITS,
  AGENT_PROTOCOL_VERSION,
  isBoundedJson,
  MAIN_TO_RUNTIME_MESSAGE_TYPES,
  MainToRuntimeMessageSchema,
  RUNTIME_TO_MAIN_MESSAGE_TYPES,
  RuntimeToMainMessageSchema,
  ToolResultSchema,
} from '@app/specs/agent-protocol.schema';
import { CHAT_MAX_MESSAGES, TOOL_RESULT_MAX_CHARS } from '@app/specs/agent-tools.spec';

const L = AGENT_PROTOCOL_LIMITS;
const CHAT = 'chat-1';
const okResult = { ok: true, output: { untrusted: true, source: 'page_text: https://example.com/', data: { text: 'Hello' } } } as const;

const mainToRuntime = [
  {
    type: 'chat.start',
    chatId: CHAT,
    messages: [
      { role: 'user', content: 'Audit this page' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'call_1', toolName: 'page_audit', input: {} }] },
      { role: 'tool', callId: 'call_1', toolName: 'page_audit', result: okResult },
      { role: 'assistant', content: 'Done.', toolCalls: [] },
      { role: 'user', content: 'Now click the first link' },
    ],
    systemPrompt: 'You are frost.',
    modelId: 'anthropic/claude-sonnet-5-5',
    route: 'gateway',
    allowedTools: ['page_audit', 'click', 'mcp__docs__search'],
  },
  { type: 'chat.stop', chatId: CHAT },
  { type: 'tool.result', chatId: CHAT, callId: 'call_1', result: okResult },
  { type: 'tool.result', chatId: CHAT, callId: 'call_2', result: { ok: false, error: { code: 'denied', message: 'The user said no.' } } },
  { type: 'fetch.response-start', requestId: 'r1', status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] },
  { type: 'fetch.chunk', requestId: 'r1', bytes: new Uint8Array([1, 2, 3]) },
  { type: 'fetch.end', requestId: 'r1' },
  { type: 'fetch.error', requestId: 'r1', code: 'refused', message: 'Not an allowed model endpoint.' },
] as const;

const runtimeToMain = [
  { type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION },
  { type: 'chat.delta', chatId: CHAT, text: 'The title is ' },
  { type: 'chat.tool-call', chatId: CHAT, callId: 'call_1', toolName: 'navigate', input: { url: 'https://example.com/' } },
  { type: 'chat.finish', chatId: CHAT, finishReason: 'stop', steps: 2, usage: { inputTokens: 1200, outputTokens: null } },
  { type: 'chat.error', chatId: CHAT, message: 'The model could not be reached.' },
  { type: 'tool.invoke', chatId: CHAT, callId: 'call_1', toolName: 'navigate', input: { url: 'https://example.com/' } },
  {
    type: 'fetch.request',
    requestId: 'r1',
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '{"stream":true}',
  },
  { type: 'fetch.request', requestId: 'r2', url: 'https://api.anthropic.com/v1/messages', method: 'POST', headers: [], body: new Uint8Array([123, 125]) },
  { type: 'fetch.request', requestId: 'r3', url: 'https://ai-gateway.vercel.sh/v4/ai/config', method: 'GET', headers: [], body: null },
  { type: 'fetch.abort', requestId: 'r1' },
] as const;

const mainOk = (message: unknown) => MainToRuntimeMessageSchema.safeParse(message).success;
const runtimeOk = (message: unknown) => RuntimeToMainMessageSchema.safeParse(message).success;
const chatStart = mainToRuntime[0];

describe('agent protocol', () => {
  test('protocol-round-trip', () => {
    for (const message of mainToRuntime) expect(MainToRuntimeMessageSchema.parse(message)).toStrictEqual(message);
    for (const message of runtimeToMain) expect(RuntimeToMainMessageSchema.parse(message)).toStrictEqual(message);
    // A structured clone (what a MessagePort does) still parses, bytes included.
    for (const message of mainToRuntime) expect(MainToRuntimeMessageSchema.parse(structuredClone(message))).toStrictEqual(message);
    for (const message of runtimeToMain) expect(RuntimeToMainMessageSchema.parse(structuredClone(message))).toStrictEqual(message);
  });

  test('protocol-types-listed', () => {
    const typesOf = (schema: z.ZodDiscriminatedUnion) => schema.options.map((option) => (option as z.ZodObject).shape.type.value as string).sort();
    expect(typesOf(MainToRuntimeMessageSchema)).toStrictEqual([...MAIN_TO_RUNTIME_MESSAGE_TYPES].sort());
    expect(typesOf(RuntimeToMainMessageSchema)).toStrictEqual([...RUNTIME_TO_MAIN_MESSAGE_TYPES].sort());
    expect(new Set(mainToRuntime.map((message) => message.type))).toStrictEqual(new Set(MAIN_TO_RUNTIME_MESSAGE_TYPES));
    expect(new Set(runtimeToMain.map((message) => message.type))).toStrictEqual(new Set(RUNTIME_TO_MAIN_MESSAGE_TYPES));
  });

  test('unknown-messages-rejected', () => {
    for (const bad of [null, undefined, 'chat.stop', 42, [], {}, { chatId: CHAT }, { type: 'chat.reset', chatId: CHAT }, { type: 'CHAT.STOP', chatId: CHAT }]) {
      expect(mainOk(bad)).toBe(false);
      expect(runtimeOk(bad)).toBe(false);
    }
    // A message for the other direction.
    expect(runtimeOk({ type: 'chat.stop', chatId: CHAT })).toBe(false);
    expect(runtimeOk(mainToRuntime[2])).toBe(false);
    expect(mainOk(runtimeToMain[1])).toBe(false);
    expect(mainOk(runtimeToMain[5])).toBe(false);
    // An extra field anywhere.
    expect(mainOk({ type: 'chat.stop', chatId: CHAT, force: true })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[3], usage: { inputTokens: 1, outputTokens: 1, cost: 3 } })).toBe(false);
    expect(mainOk({ ...chatStart, messages: [{ role: 'user', content: 'hi', name: 'x' }] })).toBe(false);
    expect(mainOk({ type: 'tool.result', chatId: CHAT, callId: 'c', result: { ...okResult, output: { ...okResult.output, trusted: true } } })).toBe(false);
  });

  test('malformed-messages-rejected', () => {
    expect(mainOk({ type: 'chat.stop', chatId: 'has space' })).toBe(false);
    expect(mainOk({ type: 'chat.stop', chatId: '' })).toBe(false);
    expect(mainOk({ type: 'chat.stop', chatId: 'x'.repeat(L.maxIdChars + 1) })).toBe(false);
    expect(mainOk({ type: 'chat.stop', chatId: 'x'.repeat(L.maxIdChars) })).toBe(true);
    expect(runtimeOk({ type: 'chat.delta', chatId: CHAT, text: 'x'.repeat(L.maxDeltaChars + 1) })).toBe(false);
    expect(runtimeOk({ type: 'chat.delta', chatId: CHAT, text: '' })).toBe(false);
    expect(mainOk({ type: 'fetch.chunk', requestId: 'r1', bytes: new Uint8Array(L.maxChunkBytes + 1) })).toBe(false);
    expect(mainOk({ type: 'fetch.chunk', requestId: 'r1', bytes: [1, 2, 3] })).toBe(false);
    expect(mainOk({ type: 'fetch.chunk', requestId: 'r1', bytes: 'AQID' })).toBe(false);
    const many = Array.from({ length: CHAT_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'hi' }));
    expect(mainOk({ ...chatStart, messages: many })).toBe(false);
    expect(mainOk({ ...chatStart, messages: many.slice(1) })).toBe(true);
    expect(mainOk({ ...chatStart, messages: [] })).toBe(false);
    expect(mainOk({ ...chatStart, messages: chatStart.messages.slice(0, 4) })).toBe(false);
    expect(mainOk({ ...chatStart, messages: [{ role: 'user', content: 'x'.repeat(L.maxMessageChars + 1) }] })).toBe(false);
    expect(mainOk({ ...chatStart, systemPrompt: 'x'.repeat(L.maxSystemPromptChars + 1) })).toBe(false);
    expect(mainOk({ ...chatStart, route: 'byok-other' })).toBe(false);
    expect(mainOk({ ...chatStart, allowedTools: ['click', 'click'] })).toBe(false);
    expect(mainOk({ ...chatStart, allowedTools: ['shell'] })).toBe(false);
    expect(mainOk({ ...chatStart, allowedTools: ['mcp__a b__c'] })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[5], toolName: 'read_file' })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[3], steps: 13 })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[3], finishReason: 'approved' })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[3], usage: { inputTokens: -1, outputTokens: 0 } })).toBe(false);
    expect(mainOk({ ...mainToRuntime[4], status: 99 })).toBe(false);
    expect(mainOk({ ...mainToRuntime[4], status: 600 })).toBe(false);
    expect(mainOk({ ...mainToRuntime[4], headers: [['bad name', 'x']] })).toBe(false);
    expect(mainOk({ ...mainToRuntime[4], headers: [['x-a', 'line\nbreak']] })).toBe(false);
    expect(mainOk({ ...mainToRuntime[4], headers: Array.from({ length: L.maxHeaders + 1 }, () => ['x-a', 'b']) })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[6], method: 'PUT' })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[6], url: '' })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[6], url: 'https://api.anthropic.com/v1/' + 'x'.repeat(L.maxUrlChars) })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[6], body: new Uint8Array(L.maxRequestBodyBytes + 1) })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[6], body: { stream: true } })).toBe(false);
    expect(runtimeOk({ ...runtimeToMain[0], protocolVersion: 0 })).toBe(false);
  });

  test('tool-input-is-bounded-json', () => {
    const invoke = (input: unknown) => runtimeOk({ ...runtimeToMain[5], input });
    expect(invoke({ a: [1, 'two', null, true, { b: 2.5 }] })).toBe(true);
    let deep: unknown = 'leaf';
    for (let depth = 0; depth < L.maxJsonDepth + 1; depth++) deep = [deep];
    expect(invoke(deep)).toBe(false);
    let veryDeep: unknown = 'leaf';
    for (let depth = 0; depth < 200_000; depth++) veryDeep = { next: veryDeep };
    expect(invoke(veryDeep)).toBe(false);
    expect(invoke({ code: 'x'.repeat(L.maxToolInputChars) })).toBe(false);
    expect(invoke(Array.from({ length: L.maxJsonNodes + 1 }, () => 0))).toBe(false);
    expect(invoke({ n: Number.NaN })).toBe(false);
    expect(invoke({ n: Number.POSITIVE_INFINITY })).toBe(false);
    expect(invoke({ f: () => 1 })).toBe(false);
    expect(invoke({ d: new Date(0) })).toBe(false);
    expect(invoke({ u: undefined })).toBe(false);
    expect(invoke({ b: 1n })).toBe(false);
    expect(invoke(JSON.parse('{"__proto__": {"polluted": true}}'))).toBe(false);
    expect(isBoundedJson(Object.create(null), 10)).toBe(true);
  });

  test('tool-results-are-wrapped', () => {
    const resultOk = (result: unknown) => ToolResultSchema.safeParse(result).success;
    expect(resultOk(okResult)).toBe(true);
    expect(resultOk({ ok: true, output: { source: 's', data: 'x' } })).toBe(false);
    expect(resultOk({ ok: true, output: { untrusted: false, source: 's', data: 'x' } })).toBe(false);
    expect(resultOk({ ok: true, output: { untrusted: true, source: '', data: 'x' } })).toBe(false);
    expect(resultOk({ ok: true, output: { untrusted: true, source: 's', data: 'x'.repeat(TOOL_RESULT_MAX_CHARS - 2) } })).toBe(true);
    expect(resultOk({ ok: true, output: { untrusted: true, source: 's', data: 'x'.repeat(TOOL_RESULT_MAX_CHARS - 1) } })).toBe(false);
    expect(resultOk({ ok: true, output: 'raw text' })).toBe(false);
    expect(resultOk({ ok: false, error: { code: 'timeout', message: 'Ran out of time.' } })).toBe(true);
    expect(resultOk({ ok: false, error: { code: 'approved', message: '' } })).toBe(false);
    expect(resultOk({ ok: false, error: { code: 'failed', message: 'x'.repeat(L.maxErrorChars + 1) } })).toBe(false);
    expect(resultOk({ ok: false, output: okResult.output })).toBe(false);
  });

  test('agent-cannot-approve', () => {
    const forbidden = /approv|grant|setting|key|credential/i;
    for (const type of RUNTIME_TO_MAIN_MESSAGE_TYPES) expect(type).not.toMatch(forbidden);
    const fields = fieldNames(RuntimeToMainMessageSchema);
    expect(fields.size).toBeGreaterThan(10);
    for (const field of fields) expect(field).not.toMatch(forbidden);

    for (const message of [
      { type: 'approval.answer', chatId: CHAT, callId: 'call_1', approved: true },
      { type: 'approval.answer', approvalId: 'a1', allow: 'once' },
      { type: 'grant.add', tool: 'click', origin: 'https://example.com' },
      { type: 'settings.set', route: 'gateway', modelId: 'openai/gpt-5' },
      { type: 'key.set', route: 'gateway', key: 'secret' },
      { type: 'credential.read', route: 'gateway' },
      { ...runtimeToMain[5], approved: true },
      { ...runtimeToMain[5], grant: 'origin' },
      { ...runtimeToMain[2], approved: true },
    ]) {
      expect(runtimeOk(message)).toBe(false);
    }
  });
});

/** Every object key the schema can accept, at any depth (unions, arrays, tuples, wrappers). */
function fieldNames(root: z.ZodType): Set<string> {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const schema = stack.pop() as { _zod?: { def: Record<string, unknown> } } | undefined;
    if (!schema?._zod || seen.has(schema)) continue;
    seen.add(schema);
    const def = schema._zod.def;
    switch (def.type) {
      case 'object':
        for (const [name, child] of Object.entries(def.shape as Record<string, unknown>)) {
          names.add(name);
          stack.push(child);
        }
        break;
      case 'union':
        stack.push(...(def.options as unknown[]));
        break;
      case 'array':
        stack.push(def.element);
        break;
      case 'tuple':
        stack.push(...(def.items as unknown[]));
        break;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'readonly':
        stack.push(def.innerType);
        break;
      case 'pipe':
        stack.push(def.in, def.out);
        break;
      default:
        break;
    }
  }
  return names;
}
