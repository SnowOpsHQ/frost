// Spec: specs/agent-session.spec.ts (AgentState, MODEL_CONTEXT_WINDOWS, AGENT_NOTICE_MESSAGES) ·
// specs/agent-protocol.schema.ts (chat.start, chat.step, ChatMessage) · specs/agent-approvals.spec.ts
// Acceptance: specs/agent-session.feature.md (Session) · plan decisions 7–9
import { afterEach, describe, expect, test } from 'vitest';
import type { ChatMessage } from '@app/specs/agent-protocol.schema';
import { AGENT_NOTICE_MESSAGES, MODEL_CONTEXT_WINDOWS } from '@app/specs/agent-session.spec';
import { AGENT_TOOL_NAMES, DEFAULT_MODEL_ID } from '@app/specs/agent-tools.spec';
import { AGENT_CRASHED_MESSAGE } from '../host';
import { AGENT_SYSTEM_PROMPT } from '../system-prompt';
import { KEY, setupSession, TAB } from './session-fakes';

let current: Awaited<ReturnType<typeof setupSession>> | null = null;
const setup = async (options: Parameters<typeof setupSession>[0] = {}) => (current = await setupSession(options));
afterEach(() => {
  current?.stop();
  current = null;
});

const NAVIGATE = { toolName: 'navigate', input: { url: 'https://shop.example.com/next' } };
const CLICK = { toolName: 'click', input: { selector: '#buy' } };

describe('session', () => {
  test('session-turn-streams-to-state', async () => {
    const s = await setup({
      steps: [
        { text: ['Let me ', 'look.'], toolCalls: [{ toolName: 'page_text', input: { maxChars: 500 } }], usage: { input: 1000, output: 20 } },
        { text: ['The title ', 'is fine.'], usage: { input: 5000, output: 50 } },
      ],
      outcomes: { page_text: { ok: true, data: { text: 'Green tea, fresh.' }, source: 'page_text https://shop.example.com/tea' } },
    });
    expect(s.session.getState().setup).toMatchObject({ route: 'gateway', modelId: DEFAULT_MODEL_ID, ready: true, keys: { gateway: true, anthropic: false, openai: false }, protection: 'os' });
    expect(await s.session.send(null, 'Check this page\nplease')).toBe('started');
    expect(s.session.getState().running).toBe(true);
    const state = await s.until((next) => !next.running);

    const start = s.starts()[0]!;
    expect(start).toMatchObject({ systemPrompt: AGENT_SYSTEM_PROMPT, modelId: DEFAULT_MODEL_ID, route: 'gateway', messages: [{ role: 'user', content: 'Check this page\nplease' }] });
    expect(start.allowedTools).toEqual([...AGENT_TOOL_NAMES]);
    expect(s.runner.calls.map((call) => [call.toolName, call.context.tabId])).toEqual([['page_text', TAB]]);

    expect(state.chats).toEqual([{ id: start.chatId, title: 'Check this page', tabId: TAB, updatedAt: expect.any(Number), running: false }]);
    const active = state.active!;
    expect(active).toMatchObject({ id: start.chatId, tabId: TAB, running: false, error: null, modelId: DEFAULT_MODEL_ID });
    expect(active.messages.map((message) => [message.kind, message.kind === 'assistant' ? message.streaming : null, message.kind === 'user' ? message.text : message.text])).toEqual([
      ['user', null, 'Check this page\nplease'],
      ['assistant', false, 'Let me look.'],
      ['assistant', false, 'The title is fine.'],
    ]);
    const card = active.messages[1]!.kind === 'assistant' ? active.messages[1]!.tools[0]! : null;
    expect(card).toEqual({
      callId: 'e2e-call-1',
      toolName: 'page_text',
      label: "Read this page's visible text",
      status: 'done',
      code: null,
      inputPreview: '{"maxChars":500}',
      outputPreview: '{"text":"Green tea, fresh."}',
    });
    // The meter: the turn's tokens summed, the context the next request starts from (the last step's).
    expect(active.usage).toEqual({ input: 6000, output: 70 });
    expect(active.contextTokens).toBe(5050);
    expect(active.contextWindow).toBe(MODEL_CONTEXT_WINDOWS[DEFAULT_MODEL_ID]);
    expect(state.notice).toBeNull();
  });

  test('session-deltas-stream-before-the-step', async () => {
    const s = await setup({ steps: [{ text: ['Reading…'], toolCalls: [NAVIGATE] }, { text: ['Done.'] }] });
    await s.session.send(null, 'Open the next page');
    const waiting = await s.until((state) => state.approval !== null);
    // The step isn't reported while its call waits: its text streamed in already.
    const assistant = waiting.active!.messages[1]!;
    expect(assistant).toMatchObject({ kind: 'assistant', text: 'Reading…', streaming: true });
    expect(assistant.kind === 'assistant' && assistant.tools.map((tool) => tool.status)).toEqual(['awaiting-approval']);
    expect(waiting.approval).toMatchObject({ queued: 0, request: { toolName: 'navigate', chatId: waiting.active!.id, origin: 'https://shop.example.com', note: null, grantable: true } });
    expect(await s.session.answerApproval(waiting.approval!.request.id, 'allow-once')).toBe('answered');
    const done = await s.until((state) => !state.running);
    expect(done.approval).toBeNull();
    const tools = done.active!.messages[1]!.kind === 'assistant' ? done.active!.messages[1]!.tools : [];
    expect(tools.map((tool) => tool.status)).toEqual(['done']);
    // A second answer to the same request is refused.
    expect(await s.session.answerApproval(waiting.approval!.request.id, 'allow-once')).toBe('unknown');
  });

  test('session-history-across-turns', async () => {
    const s = await setup({
      steps: [
        // Turn 1: a navigate the user denies, then a reply.
        { toolCalls: [NAVIGATE] },
        { text: ['You declined; staying here.'] },
        // Turn 2: a click the user stops during its approval.
        { text: ['Clicking.'], toolCalls: [CLICK] },
        // Turn 3.
        { text: ['Fine.'] },
      ],
    });
    await s.session.send(null, 'Open the next page');
    const first = await s.until((state) => state.approval !== null);
    const chatId = first.active!.id;
    expect(await s.session.answerApproval(first.approval!.request.id, 'deny')).toBe('answered');
    await s.until((state) => !state.running);

    expect(await s.session.send(chatId, 'Then buy it')).toBe('started');
    await s.until((state) => state.approval !== null);
    expect(s.session.stop(chatId)).toBe(true);
    const stopped = await s.until((state) => !state.running);
    expect(stopped.approval).toBeNull();
    const clickCard = stopped.active!.messages.flatMap((message) => (message.kind === 'assistant' ? message.tools : [])).find((tool) => tool.toolName === 'click');
    expect(clickCard).toMatchObject({ status: 'expired', code: 'expired' });

    expect(await s.session.send(chatId, 'Never mind')).toBe('started');
    await s.until((state) => !state.running);
    const history = s.starts()[2]!.messages;
    const denied: ChatMessage = { role: 'tool', callId: 'e2e-call-1', toolName: 'navigate', result: { ok: false, error: { code: 'denied', message: 'The user did not allow this tool call.' } } };
    const expired: ChatMessage = { role: 'tool', callId: 'e2e-call-2', toolName: 'click', result: { ok: false, error: { code: 'expired', message: 'The approval for this call expired before it ran.' } } };
    expect(history).toEqual([
      { role: 'user', content: 'Open the next page' },
      { role: 'assistant', content: '', toolCalls: [{ callId: 'e2e-call-1', ...NAVIGATE }] },
      denied,
      { role: 'assistant', content: 'You declined; staying here.', toolCalls: [] },
      { role: 'user', content: 'Then buy it' },
      { role: 'assistant', content: 'Clicking.', toolCalls: [{ callId: 'e2e-call-2', ...CLICK }] },
      expired,
      { role: 'user', content: 'Never mind' },
    ]);
    // Each turn started from the history so far, ending with the user's new message.
    expect(s.starts().map((start) => start.messages.length)).toEqual([1, 5, 8]);
    expect(s.runner.calls).toEqual([]);
  });

  test('session-one-turn-at-a-time', async () => {
    const s = await setup({ steps: [{ toolCalls: [NAVIGATE] }, { text: ['ok'] }] });
    const sending = s.session.send(null, 'Open the next page');
    // Refused at once, even before the first one has started.
    expect(await s.session.send(null, 'And another')).toBe('busy');
    expect(await sending).toBe('started');
    await s.until((state) => state.approval !== null);
    const chatId = s.session.getState().active!.id;
    expect(await s.session.send(chatId, 'Hurry up')).toBe('busy');
    const state = s.session.getState();
    expect(state.notice).toMatchObject({ kind: 'busy', message: AGENT_NOTICE_MESSAGES.busy });
    expect(state.chats.length).toBe(1);
    expect(state.active!.messages.filter((message) => message.kind === 'user').length).toBe(1);
    expect(s.starts().length).toBe(1);
  });

  test('session-crash-fails-the-turn', async () => {
    const s = await setup({ steps: [{ toolCalls: [NAVIGATE] }] });
    await s.session.send(null, 'Open the next page');
    await s.until((state) => state.approval !== null);
    s.forks.calls[0]!.child.exit(1);
    const state = await s.until((next) => !next.running);
    expect(state.active!.error).toBe(AGENT_CRASHED_MESSAGE);
    expect(state.approval).toBeNull();
    expect(state.setup.runtime.lastFailure).toBe('exited');
  });

  test('session-setup-needed-without-key', async () => {
    const s = await setup({ key: false });
    expect(s.session.getState().setup).toMatchObject({ ready: false, keys: { gateway: false } });
    expect(await s.session.send(null, 'Hello')).toBe('setup-needed');
    const state = s.session.getState();
    expect(state.notice).toMatchObject({ kind: 'setup-needed', message: AGENT_NOTICE_MESSAGES['setup-needed'] });
    expect(state.chats).toEqual([]);
    expect(state.running).toBe(false);
    // Nothing was started for it.
    expect(s.forks.calls.length).toBe(0);

    expect(await s.session.setKey('gateway', `  ${KEY}  `)).toBe('stored');
    expect(s.session.getState().setup).toMatchObject({ ready: true, keys: { gateway: true } });
    expect(await s.session.send(null, 'Hello')).toBe('started');
    await s.until((next) => !next.running);
    expect(await s.session.clearKey('gateway')).toBe(true);
    expect(s.session.getState().setup.ready).toBe(false);
  });

  test('session-scripted-needs-no-key', async () => {
    const s = await setup({ key: false, scripted: true });
    expect(s.session.getState().setup.ready).toBe(true);
    expect(await s.session.send(null, 'Hello')).toBe('started');
    const state = await s.until((next) => !next.running);
    expect(state.active!.messages.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hello.' });
  });

  test('session-not-entitled', async () => {
    const s = await setup({ entitlements: { allowed: (feature) => feature !== 'agent' } });
    expect(await s.session.send(null, 'Hello')).toBe('not-entitled');
    expect(s.session.getState().notice?.kind).toBe('not-entitled');
    expect(s.forks.calls.length).toBe(0);
  });

  test('session-state-never-holds-a-key', async () => {
    const s = await setup({ key: false, steps: [{ text: ['Sure.'], toolCalls: [{ toolName: 'page_audit', input: {} }] }, { text: ['Done.'] }] });
    expect(await s.session.setKey('gateway', KEY)).toBe('stored');
    expect(await s.session.setKey('anthropic', 'sk-ant-other-secret-0123456789')).toBe('stored');
    await s.session.send(null, 'Audit it');
    await s.until((state) => !state.running);
    await s.session.setModel('byok-anthropic', 'anthropic/claude-opus-5-5');
    const everything = [...s.seen, JSON.stringify(s.session.getState()), ...s.logs].join('\n');
    expect(s.seen.length).toBeGreaterThan(3);
    for (const secret of [KEY, KEY.slice(0, 16), KEY.slice(-16), 'sk-ant-other-secret']) expect(everything).not.toContain(secret);
    // What went to the runtime holds no key either.
    expect(JSON.stringify(s.sent)).not.toContain(KEY.slice(0, 16));
  });

  test('session-new-select-delete', async () => {
    const s = await setup({ steps: [{ text: ['One.'] }, { text: ['Two.'] }] });
    await s.session.send(null, 'First chat');
    await s.until((state) => !state.running);
    const first = s.session.getState().active!.id;
    s.session.newChat();
    expect(s.session.getState().active).toBeNull();
    await s.session.send(null, 'Second chat');
    await s.until((state) => !state.running);
    const second = s.session.getState().active!.id;
    expect(second).not.toBe(first);
    expect(s.session.getState().chats.map((chat) => chat.title)).toEqual(['Second chat', 'First chat']);
    expect(s.session.selectChat(first)).toBe(true);
    expect(s.session.getState().active!.title).toBe('First chat');
    expect(s.session.selectChat('6ba7b810-9dad-41d1-80b4-00c04fd430c8')).toBe(false);
    expect(s.session.deleteChat(first)).toBe(true);
    expect(s.session.getState().active).toBeNull();
    expect(s.session.getState().chats.map((chat) => chat.id)).toEqual([second]);
    expect(s.session.deleteChat(first)).toBe(false);
    expect(await s.session.send(first, 'Back?')).toBe('unknown-chat');
  });

  test('session-delete-running-chat-stops-it', async () => {
    const s = await setup({ steps: [{ toolCalls: [NAVIGATE] }, { text: ['never'] }] });
    await s.session.send(null, 'Open the next page');
    const waiting = await s.until((state) => state.approval !== null);
    expect(s.session.deleteChat(waiting.active!.id)).toBe(true);
    const state = await s.until((next) => !next.running);
    expect(state.chats).toEqual([]);
    expect(state.approval).toBeNull();
    expect(s.sent.some((message) => message.type === 'chat.stop')).toBe(true);
  });

  test('session-model-change', async () => {
    const s = await setup();
    expect(await s.session.setModel('gateway', 'openai/gpt-5')).toBe(true);
    expect(s.session.getState().setup).toMatchObject({ route: 'gateway', modelId: 'openai/gpt-5' });
    expect(await s.session.setModel('byok-openai', 'anthropic/claude-opus-5-5')).toBe(false);
    expect(await s.session.setModel('byok-anthropic', 'anthropic/claude-opus-5-5')).toBe(true);
    expect(s.session.getState().setup).toMatchObject({ allowedModels: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'], ready: false });
  });
});
