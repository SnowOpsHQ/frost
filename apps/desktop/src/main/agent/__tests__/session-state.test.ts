// Spec: specs/agent-session.spec.ts (AGENT_DELTA_COALESCE_MS, MAX_PENDING_AGENT_WATCHES,
// MODEL_CONTEXT_WINDOWS, EXECUTE_JS_APPROVAL_NOTE, CHAT_TITLE_MAX_CHARS, MAX_CHATS_KEPT_IN_MEMORY) ·
// specs/agent-protocol.schema.ts (CHAT_BUSY_MESSAGE)
// Acceptance: specs/agent-session.feature.md (State, Watch)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHAT_BUSY_MESSAGE, type ChatMessage, type MainToRuntimeMessage, type ToolResult } from '@app/specs/agent-protocol.schema';
import {
  AGENT_DELTA_COALESCE_MS,
  CHAT_TITLE_MAX_CHARS,
  EXECUTE_JS_APPROVAL_NOTE,
  MAX_CHATS_KEPT_IN_MEMORY,
  MAX_PENDING_AGENT_WATCHES,
  MAX_TOOL_CARDS_PER_TURN,
  MODEL_CONTEXT_WINDOWS,
  STOP_DEADLINE_MESSAGE,
  STOP_DEADLINE_MS,
  CHAT_HISTORY_MAX_CHARS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  historyBudgetChars,
  HISTORY_MIN_BUDGET_CHARS,
  OMITTED_TOOL_OUTPUT,
  type AgentState,
} from '@app/specs/agent-session.spec';
import { ALLOWED_MODEL_IDS, CHAT_MAX_MESSAGES, DEFAULT_MODEL_ID, MAX_TOOL_STEPS, type ModelId } from '@app/specs/agent-tools.spec';
import type { ApprovalRequestView, ToolActivity } from '../approvals';
import type { AgentChatEvent, AgentHostStatus } from '../host';
import { attachToolResult, chatTitle, compactHistory, createAgentSession, historyWindow, isolationView } from '../session';
import { AGENT_SYSTEM_PROMPT } from '../system-prompt';

function fakeDeps() {
  const chat = new Set<(event: AgentChatEvent) => void>();
  const statuses = new Set<(status: AgentHostStatus) => void>();
  const changes = new Set<() => void>();
  const results = new Set<(chatId: string, callId: string, toolName: string, result: ToolResult) => void>();
  const sent: MainToRuntimeMessage[] = [];
  const fake = {
    status: 'ready' as AgentHostStatus,
    active: [] as string[],
    pending: [] as ApprovalRequestView[],
    activity: [] as ToolActivity[],
    hostAccepts: true,
    modelId: DEFAULT_MODEL_ID as ModelId,
  };
  const deps = {
    host: {
      send: (message: MainToRuntimeMessage) => {
        sent.push(message);
        if (message.type === 'chat.start' && fake.hostAccepts) fake.active.push(message.chatId);
        return fake.hostAccepts;
      },
      onChat: (listener: (event: AgentChatEvent) => void) => (chat.add(listener), () => void chat.delete(listener)),
      onStatus: (listener: (status: AgentHostStatus) => void) => (statuses.add(listener), () => void statuses.delete(listener)),
      status: () => fake.status,
      lastFailure: () => null,
      lockdown: () => null,
      activeChats: () => fake.active,
      strike: vi.fn(),
      restart: vi.fn(),
    },
    approvals: {
      register: vi.fn(),
      unregister: vi.fn(),
      forget: vi.fn(),
      pending: () => fake.pending,
      activity: () => fake.activity,
      onChange: (listener: () => void) => (changes.add(listener), () => void changes.delete(listener)),
      onResult: (listener: (chatId: string, callId: string, toolName: string, result: ToolResult) => void) => (results.add(listener), () => void results.delete(listener)),
      answer: vi.fn(async () => ({ ok: true as const, granted: false })),
    },
    credentials: { protection: async () => 'os' as const, hasKey: async () => true, setKey: async () => 'stored' as const, clearKey: async () => true },
    settings: { current: () => ({ route: 'gateway' as const, modelId: fake.modelId }), set: async () => true, onChange: () => () => undefined },
    entitlements: { allowed: () => true },
    grants: { list: () => [], readToolsAllowed: () => true, onChange: () => () => undefined, revoke: async () => true, revokeAll: async () => true, setReadToolsAllowed: async () => true },
    start: async () => true,
    activeTabId: (): number | null => 3,
    randomId: (() => {
      let id = 0;
      return () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, '0')}`;
    })(),
  };
  return {
    deps,
    fake,
    sent,
    emit: (event: AgentChatEvent) => {
      for (const listener of [...chat]) listener(event);
    },
    setStatus: (status: AgentHostStatus) => {
      fake.status = status;
      for (const listener of [...statuses]) listener(status);
    },
    changed: () => {
      for (const listener of [...changes]) listener();
    },
    /** The broker runs (or refuses) a call: its activity, then its result. */
    brokerRan: (chatId: string, callId: string, toolName: string, result: ToolResult) => {
      fake.activity.push({ chatId, callId, toolName, status: result.ok ? 'done' : 'denied', code: result.ok ? null : result.error.code, approvalId: null, updatedAt: 1 });
      for (const listener of [...changes]) listener();
      for (const listener of [...results]) listener(chatId, callId, toolName, result);
    },
  };
}

const request = (id: string, createdAt: number, toolName = 'navigate'): ApprovalRequestView => ({
  id,
  chatId: 'c',
  callId: `call-${id}`,
  toolName,
  label: 'l',
  risk: toolName === 'execute_javascript' ? 'execute' : 'act',
  origin: 'https://example.com',
  pageUrl: 'https://example.com/',
  input: '{}',
  inputSha256: 'h',
  code: toolName === 'execute_javascript' ? '1 + 1' : null,
  grantable: toolName !== 'execute_javascript',
  createdAt,
  expiresAt: createdAt + 1000,
});

describe('session state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('watch-coalesces-deltas', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    expect(await session.send(null, 'Hi')).toBe('started');
    const chatId = (f.sent[0] as Extract<MainToRuntimeMessage, { type: 'chat.start' }>).chatId;
    const before = session.getState().version;
    const answers: AgentState[] = [];
    void session.watch(before).then((state) => answers.push(state));
    for (const text of ['a', 'b', 'c']) f.emit({ type: 'chat.delta', chatId, text });
    await vi.advanceTimersByTimeAsync(AGENT_DELTA_COALESCE_MS - 1);
    expect(answers).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(answers.length).toBe(1);
    expect(answers[0]!.version).toBe(before + 1);
    expect(answers[0]!.active!.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'abc', streaming: true });
    // A step lands at once, carrying any text not yet published.
    f.emit({ type: 'chat.delta', chatId, text: 'd' });
    f.emit({ type: 'chat.step', chatId, step: 1, text: 'abcd', toolCalls: [] });
    expect(session.getState().version).toBe(before + 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('watch-long-poll', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    const v = session.getState().version;
    // Newer: at once.
    await expect(session.watch(v - 1)).resolves.toMatchObject({ version: v });
    // Aborted: the current state, and the waiter is gone.
    const release = new AbortController();
    const aborted = session.watch(v, release.signal);
    release.abort();
    await expect(aborted).resolves.toMatchObject({ version: v });
    // At most MAX_PENDING_AGENT_WATCHES wait: one more answers the oldest early.
    const order: number[] = [];
    for (let i = 0; i <= MAX_PENDING_AGENT_WATCHES; i += 1) void session.watch(v).then(() => order.push(i));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]);
    session.newChat();
    f.changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(order.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test('busy-reply-is-not-a-failure', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'First');
    const chatId = session.getState().active!.id;
    f.emit({ type: 'chat.finish', chatId, finishReason: 'stop', steps: 0, usage: { input: null, output: null } });
    expect(await session.send(chatId, 'Second')).toBe('started');
    // The runtime still had a turn for the chat: this one never started.
    f.emit({ type: 'chat.error', chatId, message: CHAT_BUSY_MESSAGE });
    const state = session.getState();
    expect(state.running).toBe(false);
    expect(state.active!.error).toBeNull();
    expect(state.notice?.kind).toBe('busy');
    expect(state.active!.messages.map((message) => message.kind === 'user' && message.text)).toEqual(['First']);

    // After output, the same text is a failure like any other (shown as the chat's error).
    await session.send(chatId, 'Third');
    f.emit({ type: 'chat.delta', chatId, text: 'Partial' });
    f.emit({ type: 'chat.error', chatId, message: CHAT_BUSY_MESSAGE });
    expect(session.getState().active!.error).toBe(CHAT_BUSY_MESSAGE);
    await session.send(chatId, 'Fourth');
    f.emit({ type: 'chat.error', chatId, message: 'The model provider could not be reached.' });
    expect(session.getState()).toMatchObject({ running: false, active: { error: 'The model provider could not be reached.' } });
  });

  test('crash-backstop-when-host-forgets-the-chat', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Hi');
    f.fake.active = [];
    f.setStatus('crashed');
    expect(session.getState()).toMatchObject({ running: false, setup: { runtime: { status: 'crashed' } }, active: { error: expect.stringContaining('stopped unexpectedly') } });
  });

  test('host-refuses-start', async () => {
    const f = fakeDeps();
    f.fake.hostAccepts = false;
    const session = createAgentSession(f.deps);
    expect(await session.send(null, 'Hi')).toBe('unavailable');
    expect(session.getState()).toMatchObject({ running: false, chats: [], active: null, notice: { kind: 'unavailable' } });
    expect(f.deps.approvals.unregister).toHaveBeenCalled();
    const failing = fakeDeps();
    failing.deps.start = async () => false;
    const other = createAgentSession(failing.deps);
    expect(await other.send(null, 'Hi')).toBe('unavailable');
    expect(failing.sent).toEqual([]);
  });

  test('approval-view-is-oldest-with-queued-count', () => {
    const f = fakeDeps();
    f.fake.pending = [request('a', 1), request('b', 2, 'execute_javascript'), request('c', 3)];
    const session = createAgentSession(f.deps);
    expect(session.getState().approval).toEqual({ request: { ...request('a', 1), note: null }, queued: 2 });
    f.fake.pending = [request('b', 2, 'execute_javascript')];
    f.changed();
    expect(session.getState().approval).toEqual({ request: { ...request('b', 2, 'execute_javascript'), note: EXECUTE_JS_APPROVAL_NOTE }, queued: 0 });
    // Nothing the broker might add reaches the renderer.
    f.fake.pending = [{ ...request('d', 4), secret: 'x' } as ApprovalRequestView];
    f.changed();
    expect(session.getState().approval!.request).not.toHaveProperty('secret');
  });

  test('chats-kept-in-memory-are-bounded', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    for (let i = 0; i < MAX_CHATS_KEPT_IN_MEMORY + 3; i += 1) {
      session.newChat();
      await session.send(null, `Chat ${i}`);
      f.emit({ type: 'chat.finish', chatId: session.getState().active!.id, finishReason: 'stop', steps: 0, usage: { input: null, output: null } });
      await vi.advanceTimersByTimeAsync(1);
    }
    const titles = session.getState().chats.map((chat) => chat.title);
    expect(titles.length).toBe(MAX_CHATS_KEPT_IN_MEMORY);
    expect(titles).not.toContain('Chat 0');
    expect(titles[0]).toBe(`Chat ${MAX_CHATS_KEPT_IN_MEMORY + 2}`);
  });

  test('invalid-and-unknown-sends', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    expect(await session.send(null, '   ')).toBe('invalid');
    expect(await session.send('6ba7b810-9dad-41d1-80b4-00c04fd430c8', 'Hi')).toBe('unknown-chat');
    f.deps.activeTabId = () => null;
    expect(await session.send(null, 'Hi')).toBe('no-tab');
    expect(f.sent).toEqual([]);
  });
});

describe('session review fixes (Task 6a)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const startOf = (sent: MainToRuntimeMessage[], index = -1) => sent.filter((m): m is Extract<MainToRuntimeMessage, { type: 'chat.start' }> => m.type === 'chat.start').at(index)!;
  const ok: ToolResult = { ok: true, output: { untrusted: true, source: 'page_audit https://example.com/', data: { score: 90 } } };
  const finish = (chatId: string) => ({ type: 'chat.finish' as const, chatId, finishReason: 'stop' as const, steps: 1, usage: { input: null, output: null } });

  test('turn-steps-and-cards-are-capped', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Go');
    const chatId = startOf(f.sent).chatId;
    for (let i = 0; i < MAX_TOOL_STEPS + 3; i += 1) f.emit({ type: 'chat.step', chatId, step: Math.min(i + 1, MAX_TOOL_STEPS), text: `step ${i}`, toolCalls: [] });
    expect(f.deps.host.strike).toHaveBeenCalledTimes(3);
    // Nothing past the last step: no text, no card.
    f.emit({ type: 'chat.delta', chatId, text: 'more' });
    f.emit({ type: 'chat.tool-call', chatId, callId: 'late', toolName: 'page_audit', input: {} });
    expect(f.deps.host.strike).toHaveBeenCalledTimes(5);
    f.emit(finish(chatId));
    await session.send(chatId, 'Again');
    const history = startOf(f.sent).messages;
    expect(history.filter((message) => message.role === 'assistant').length).toBe(MAX_TOOL_STEPS);
    expect(session.getState().active!.messages.filter((message) => message.kind === 'assistant').length).toBe(MAX_TOOL_STEPS);

    // Cards: at most MAX_TOOL_CARDS_PER_TURN in one turn.
    for (let i = 0; i < MAX_TOOL_CARDS_PER_TURN + 2; i += 1) f.emit({ type: 'chat.tool-call', chatId, callId: `c${i}`, toolName: 'page_audit', input: {} });
    const cards = session.getState().active!.messages.flatMap((message) => (message.kind === 'assistant' ? message.tools : []));
    expect(cards.length).toBe(MAX_TOOL_CARDS_PER_TURN);
    expect(f.deps.host.strike).toHaveBeenCalledTimes(7);
  });

  test('stop-has-a-deadline', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Go');
    const chatId = startOf(f.sent).chatId;
    expect(session.stop(chatId)).toBe(true);
    await vi.advanceTimersByTimeAsync(STOP_DEADLINE_MS - 1);
    expect(session.getState().running).toBe(true);
    expect(f.deps.host.restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getState()).toMatchObject({ running: false, active: { error: STOP_DEADLINE_MESSAGE } });
    expect(f.deps.host.restart).toHaveBeenCalledOnce();
    expect(await session.send(chatId, 'Next')).toBe('started');
    // A turn that stops in time cancels the deadline.
    session.stop(chatId);
    f.emit(finish(chatId));
    await vi.advanceTimersByTimeAsync(STOP_DEADLINE_MS);
    expect(f.deps.host.restart).toHaveBeenCalledOnce();
    expect(session.getState().active!.error).toBeNull();
  });

  test('refused-send-changes-no-chat', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'First');
    const chatId = startOf(f.sent).chatId;
    f.emit({ type: 'chat.error', chatId, message: 'The chat failed.' });
    session.newChat();
    const before = session.getState();
    f.fake.hostAccepts = false;
    expect(await session.send(chatId, 'Second')).toBe('unavailable');
    const after = session.getState();
    expect(after.active).toBeNull();
    expect(after.chats).toEqual(before.chats);
    expect(session.selectChat(chatId)).toBe(true);
    expect(session.getState().active).toMatchObject({ error: 'The chat failed.', modelId: DEFAULT_MODEL_ID });
    expect(session.getState().active!.messages.map((message) => message.kind)).toEqual(['user']);
  });

  test('cards-left-requested-get-an-end-status', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Go');
    const chatId = startOf(f.sent).chatId;
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c1', toolName: 'page_audit', input: {} });
    expect(session.getState().active!.messages[1]).toMatchObject({ tools: [{ status: 'requested' }] });
    f.emit({ type: 'chat.step', chatId, step: 1, text: '', toolCalls: [] });
    expect(session.getState().active!.messages[1]).toMatchObject({ tools: [{ status: 'failed', code: 'failed' }] });
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c2', toolName: 'page_audit', input: {} });
    f.emit(finish(chatId));
    expect(session.getState().active!.messages.at(-1)).toMatchObject({ tools: [{ callId: 'c2', status: 'failed' }] });
  });

  test('crash-before-the-step-keeps-what-ran', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Audit');
    const chatId = startOf(f.sent).chatId;
    f.emit({ type: 'chat.delta', chatId, text: 'Reading.' });
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c1', toolName: 'page_audit', input: {} });
    f.brokerRan(chatId, 'c1', 'page_audit', ok);
    // A card the broker never saw is not written as a call.
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c2', toolName: 'page_text', input: {} });
    f.emit({ type: 'chat.error', chatId, message: 'The agent stopped unexpectedly. Send your message again to retry.' });
    await session.send(chatId, 'Retry');
    expect(startOf(f.sent).messages).toEqual([
      { role: 'user', content: 'Audit' },
      { role: 'assistant', content: 'Reading.', toolCalls: [{ callId: 'c1', toolName: 'page_audit', input: {} }] },
      { role: 'tool', callId: 'c1', toolName: 'page_audit', result: ok },
      { role: 'user', content: 'Retry' },
    ]);
  });

  test('step-calls-are-checked-against-the-broker', async () => {
    const f = fakeDeps();
    const session = createAgentSession(f.deps);
    await session.send(null, 'Go');
    const chatId = startOf(f.sent).chatId;
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c1', toolName: 'navigate', input: { url: 'https://example.com/a' } });
    f.brokerRan(chatId, 'c1', 'navigate', ok);
    f.emit({ type: 'chat.tool-call', chatId, callId: 'c3', toolName: 'page_text', input: {} });
    f.emit({
      type: 'chat.step',
      chatId,
      step: 1,
      text: 'Done.',
      toolCalls: [
        // Announced and run, but reported with another input: refused.
        { callId: 'c1', toolName: 'navigate', input: { url: 'https://evil.example.net/' } },
        // Never announced.
        { callId: 'c2', toolName: 'click', input: { selector: '#buy' } },
        // Announced, never seen by the broker.
        { callId: 'c3', toolName: 'page_text', input: {} },
      ],
    });
    expect(f.deps.host.strike).toHaveBeenCalledOnce();
    f.emit(finish(chatId));
    await session.send(chatId, 'Next');
    const history = startOf(f.sent).messages;
    expect(history[1]).toEqual({ role: 'assistant', content: 'Done.', toolCalls: [] });
    // The call the broker ran is still written, from what was announced, with its result.
    expect(history.slice(2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ callId: 'c1', toolName: 'navigate', input: { url: 'https://example.com/a' } }] },
      { role: 'tool', callId: 'c1', toolName: 'navigate', result: ok },
      { role: 'user', content: 'Next' },
    ]);
  });

  test('dispose-while-starting-clears-the-turn', async () => {
    const f = fakeDeps();
    let release!: (ready: boolean) => void;
    f.deps.start = () => new Promise<boolean>((resolve) => (release = resolve));
    const session = createAgentSession(f.deps);
    const sending = session.send(null, 'Go');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState().running).toBe(true);
    session.dispose();
    release(true);
    expect(await sending).toBe('unavailable');
    expect(session.getState().running).toBe(false);
    expect(f.sent).toEqual([]);
  });
});

describe('history budget (whole-branch review)', () => {
  const user = (content: string): ChatMessage => ({ role: 'user', content });
  const call = (id: string, text = ''): ChatMessage => ({ role: 'assistant', content: text, toolCalls: [{ callId: id, toolName: 'page_text', input: {} }] });
  const big = (id: string, chars = 30_000): Extract<ChatMessage, { role: 'tool' }> => ({
    role: 'tool',
    callId: id,
    toolName: 'page_text',
    result: { ok: true, output: { untrusted: true, source: `page_text https://example.com/${id}`, data: { text: 'x'.repeat(chars) } } },
  });
  const size = (messages: readonly ChatMessage[]) => messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);

  test('history-budget-follows-the-model', () => {
    expect(historyBudgetChars('anthropic/claude-sonnet-5-5')).toBe(CHAT_HISTORY_MAX_CHARS);
    const unknown = historyBudgetChars('openai/gpt-5');
    expect(unknown).toBeLessThan(DEFAULT_CONTEXT_WINDOW_TOKENS * 3);
    expect(unknown).toBeGreaterThan(HISTORY_MIN_BUDGET_CHARS);
    expect(historyBudgetChars('openai/gpt-5', 50_000)).toBe(unknown - 50_000);
    expect(historyBudgetChars('openai/gpt-5', 10_000_000)).toBe(HISTORY_MIN_BUDGET_CHARS);
  });

  test('compact-history-shortens-oldest-tool-outputs-first', () => {
    const history: ChatMessage[] = [user('one'), call('a'), big('a'), call('b'), big('b'), { role: 'assistant', content: 'done', toolCalls: [] }, user('two')];
    expect(compactHistory(history, size(history))).toEqual(history);
    const budget = size(history) - 10_000;
    const compacted = compactHistory(history, budget);
    expect(size(compacted)).toBeLessThanOrEqual(budget);
    // Only the oldest output was shortened; every call keeps a result right after it.
    expect(compacted[2]).toEqual({ role: 'tool', callId: 'a', toolName: 'page_text', result: { ok: true, output: { untrusted: true, source: 'page_text https://example.com/a', data: OMITTED_TOOL_OUTPUT } } });
    expect(compacted[4]).toEqual(big('b'));
    expect(compacted.map((message) => message.role)).toEqual(history.map((message) => message.role));
  });

  test('compact-history-drops-oldest-exchanges-last', () => {
    const history: ChatMessage[] = [user('one ' + 'y'.repeat(20_000)), { role: 'assistant', content: 'z'.repeat(20_000), toolCalls: [] }, user('two'), call('a'), big('a'), user('three')];
    const compacted = compactHistory(history, 5_000);
    // The outputs went first, then the first exchange; the last exchange always stays.
    expect(compacted[0]).toEqual(user('two'));
    expect(compacted.at(-1)).toEqual(user('three'));
    expect((compacted[2] as Extract<ChatMessage, { role: 'tool' }>).result).toMatchObject({ output: { data: OMITTED_TOOL_OUTPUT } });
    expect(compactHistory([user('only')], 1)).toEqual([user('only')]);
  });

  test('turn-history-fits-the-model-and-memory', async () => {
    const f = fakeDeps();
    f.fake.modelId = 'openai/gpt-5';
    const session = createAgentSession(f.deps);
    let chatId: string | null = null;
    // 40 turns, each reading 30,000 characters of page text: far past the unknown model's window.
    for (let turn = 0; turn < 40; turn += 1) {
      await session.send(chatId, `Turn ${turn}`);
      chatId = session.getState().active!.id;
      const id = `t${turn}`;
      f.emit({ type: 'chat.tool-call', chatId, callId: id, toolName: 'page_text', input: {} });
      f.brokerRan(chatId, id, 'page_text', big(id).result);
      f.emit({ type: 'chat.step', chatId, step: 1, text: '', toolCalls: [{ callId: id, toolName: 'page_text', input: {} }] });
      f.emit({ type: 'chat.finish', chatId, finishReason: 'stop', steps: 1, usage: { input: null, output: null } });
      f.fake.activity = [];
    }
    await session.send(chatId, 'And now?');
    const sent = f.sent.filter((m): m is Extract<MainToRuntimeMessage, { type: 'chat.start' }> => m.type === 'chat.start').at(-1)!;
    expect(size(sent.messages)).toBeLessThanOrEqual(historyBudgetChars('openai/gpt-5', AGENT_SYSTEM_PROMPT.length + JSON.stringify(sent.mcpTools ?? []).length));
    expect(sent.messages[0]).toEqual(user('Turn 0'));
    expect(sent.messages.at(-1)).toEqual(user('And now?'));
    // The latest output is whole, the oldest ones shortened, and each still answers its call.
    expect(sent.messages.at(-2)).toEqual(big('t39'));
    expect(sent.messages[2]).toMatchObject({ role: 'tool', callId: 't0', result: { output: { data: OMITTED_TOOL_OUTPUT } } });
    // In memory the chat is bounded too: it was trimmed past CHAT_HISTORY_MAX_CHARS.
    expect(40 * 30_000).toBeGreaterThan(CHAT_HISTORY_MAX_CHARS);
    expect(session.getState().active!.truncated).toBe(true);
  });
});

describe('session helpers', () => {
  test('model-context-windows-cover-allowed-models', () => {
    expect(Object.keys(MODEL_CONTEXT_WINDOWS).sort()).toEqual([...ALLOWED_MODEL_IDS].sort());
    expect(MODEL_CONTEXT_WINDOWS['anthropic/claude-sonnet-5-5']).toBe(1_000_000);
    expect(MODEL_CONTEXT_WINDOWS['anthropic/claude-opus-5-5']).toBe(1_000_000);
    expect(MODEL_CONTEXT_WINDOWS['openai/gpt-5']).toBeNull();
  });

  test('chat-title', () => {
    expect(chatTitle('\n  Fix the   title\nand more')).toBe('Fix the title');
    expect(chatTitle('x'.repeat(200)).length).toBe(CHAT_TITLE_MAX_CHARS);
    // Never cut between a surrogate pair.
    expect(chatTitle(`${'x'.repeat(CHAT_TITLE_MAX_CHARS - 1)}😀`)).toBe('x'.repeat(CHAT_TITLE_MAX_CHARS - 1));
  });

  test('history-window', () => {
    const user = (content: string): ChatMessage => ({ role: 'user', content });
    const reply: ChatMessage = { role: 'assistant', content: 'r', toolCalls: [] };
    const long = Array.from({ length: CHAT_MAX_MESSAGES + 5 }, (_, i) => (i % 2 === 0 ? reply : user(`u${i}`)));
    long.push(user('last'));
    const window = historyWindow(long);
    expect(window.length).toBeLessThanOrEqual(CHAT_MAX_MESSAGES);
    expect(window[0]!.role).toBe('user');
    expect(window.at(-1)).toEqual(user('last'));

    // One turn longer than the window: the user's request and the latest steps are kept.
    const call = (id: number): ChatMessage => ({ role: 'assistant', content: `step ${id}`, toolCalls: [{ callId: `c${id}`, toolName: 'page_audit', input: {} }] });
    const result = (id: number): ChatMessage => ({ role: 'tool', callId: `c${id}`, toolName: 'page_audit', result: { ok: false, error: { code: 'failed', message: 'The tool failed.' } } });
    const turn: ChatMessage[] = [user('earlier'), reply, user('do a lot')];
    for (let i = 0; i < CHAT_MAX_MESSAGES; i += 1) turn.push(call(i), result(i));
    turn.push(user('and now?'));
    const kept = historyWindow(turn);
    expect(kept.length).toBeLessThanOrEqual(CHAT_MAX_MESSAGES);
    expect(kept[0]).toEqual(user('do a lot'));
    expect(kept[1]!.role).toBe('assistant');
    expect(kept.at(-2)).toEqual(result(CHAT_MAX_MESSAGES - 1));
    expect(kept.at(-1)).toEqual(user('and now?'));
    // Every result still follows its call.
    for (let i = 2; i < kept.length - 1; i += 1) if (kept[i]!.role === 'tool') expect(['assistant', 'tool']).toContain(kept[i - 1]!.role);
    // Short histories are sent whole.
    expect(historyWindow(turn.slice(0, 3))).toEqual(turn.slice(0, 3));
  });

  test('attach-tool-result', () => {
    const result = { ok: false as const, error: { code: 'denied' as const, message: 'no' } };
    const history: ChatMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'a', toolName: 'navigate', input: {} }, { callId: 'b', toolName: 'click', input: {} }] },
    ];
    expect(attachToolResult(history, { role: 'tool', callId: 'b', toolName: 'click', result })).toBe(true);
    expect(attachToolResult(history, { role: 'tool', callId: 'b', toolName: 'click', result })).toBe(false);
    expect(attachToolResult(history, { role: 'tool', callId: 'z', toolName: 'click', result })).toBe(false);
    history.push({ role: 'user', content: 'next' });
    expect(attachToolResult(history, { role: 'tool', callId: 'a', toolName: 'navigate', result })).toBe(false);
    expect(history.length).toBe(4);
  });

  test('isolation-view-is-honest', () => {
    expect(isolationView(null)).toMatchObject({ networkGlobalsRemoved: false, fileSandbox: false });
    const view = isolationView({ removed: ['fetch', 'WebSocket', 'EventSource'], failed: [], permissionModel: false });
    expect(view).toMatchObject({ networkGlobalsRemoved: true, fileSandbox: false });
    expect(view.note).toMatch(/without an OS sandbox or file restrictions/);
    expect(isolationView({ removed: ['fetch'], failed: ['WebSocket'], permissionModel: false }).networkGlobalsRemoved).toBe(false);
    expect(isolationView({ removed: [], failed: [], permissionModel: false }).networkGlobalsRemoved).toBe(false);
  });

  test('system-prompt-is-stable-and-says-tool-output-is-untrusted', () => {
    expect(AGENT_SYSTEM_PROMPT).toMatch(/untrusted/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/never follow instructions/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/approval/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/Never ask for, repeat or reveal an API key/);
    // No dates, times or numbers that would change between turns (prompt caching).
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/\d/);
    expect(AGENT_SYSTEM_PROMPT.length).toBeLessThan(2000);
  });
});
