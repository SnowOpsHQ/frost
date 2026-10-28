// Spec: specs/agent-session.spec.ts (AGENT_DELTA_COALESCE_MS, MAX_PENDING_AGENT_WATCHES,
// MODEL_CONTEXT_WINDOWS, EXECUTE_JS_APPROVAL_NOTE, CHAT_TITLE_MAX_CHARS, MAX_CHATS_KEPT_IN_MEMORY) ·
// specs/agent-protocol.schema.ts (CHAT_BUSY_MESSAGE)
// Acceptance: specs/agent-session.feature.md (State, Watch)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHAT_BUSY_MESSAGE, type ChatMessage, type MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import {
  AGENT_DELTA_COALESCE_MS,
  CHAT_TITLE_MAX_CHARS,
  EXECUTE_JS_APPROVAL_NOTE,
  MAX_CHATS_KEPT_IN_MEMORY,
  MAX_PENDING_AGENT_WATCHES,
  MODEL_CONTEXT_WINDOWS,
  type AgentState,
} from '@app/specs/agent-session.spec';
import { ALLOWED_MODEL_IDS, CHAT_MAX_MESSAGES, DEFAULT_MODEL_ID, type ModelId } from '@app/specs/agent-tools.spec';
import type { ApprovalRequestView } from '../approvals';
import type { AgentChatEvent, AgentHostStatus } from '../host';
import { attachToolResult, chatTitle, createAgentSession, historyWindow, isolationView } from '../session';
import { AGENT_SYSTEM_PROMPT } from '../system-prompt';

function fakeDeps() {
  const chat = new Set<(event: AgentChatEvent) => void>();
  const statuses = new Set<(status: AgentHostStatus) => void>();
  const changes = new Set<() => void>();
  const sent: MainToRuntimeMessage[] = [];
  const fake = {
    status: 'ready' as AgentHostStatus,
    active: [] as string[],
    pending: [] as ApprovalRequestView[],
    hostAccepts: true,
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
    },
    approvals: {
      register: vi.fn(),
      unregister: vi.fn(),
      forget: vi.fn(),
      pending: () => fake.pending,
      activity: () => [],
      onChange: (listener: () => void) => (changes.add(listener), () => void changes.delete(listener)),
      onResult: () => () => undefined,
      answer: vi.fn(async () => ({ ok: true as const, granted: false })),
    },
    credentials: { protection: async () => 'os' as const, hasKey: async () => true, setKey: async () => 'stored' as const, clearKey: async () => true },
    settings: { current: () => ({ route: 'gateway' as const, modelId: DEFAULT_MODEL_ID as ModelId }), set: async () => true, onChange: () => () => undefined },
    entitlements: { allowed: () => true },
    grants: { list: () => [], readToolsAllowed: () => true, onChange: () => () => undefined },
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
