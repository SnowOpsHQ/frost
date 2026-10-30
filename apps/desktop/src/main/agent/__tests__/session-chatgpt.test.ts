// Spec: specs/agent-session.spec.ts (AgentSetupView.chatgpt, AgentSetupView.ready, AgentActiveChatView.chatgptError, AGENT_NOTICE_MESSAGES),
// specs/agent-chatgpt.spec.ts (ChatgptFailure, chatgptFailureMessage, CHATGPT_ERROR_MESSAGES, CHATGPT_SETUP_MESSAGES, chatgptSetupReason)
// Acceptance: specs/agent-chatgpt.feature.md (Through the proxy: chatgpt-session-*) · plan docs/plans/agent-chatgpt-plan.md, Task 3
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ERROR_MESSAGES, CHATGPT_SETUP_MESSAGES, type ChatgptAccountView, type ChatgptFailure, type ChatgptModelView, type ChatgptSetupReason } from '@app/specs/agent-chatgpt.spec';
import { AGENT_NOTICE_MESSAGES, type AgentChatgptView } from '@app/specs/agent-session.spec';
import { setupSession } from './session-fakes';

const MODELS: readonly ChatgptModelView[] = [
  { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini' },
];

/** The route as the session sees it: a view, whether it is ready, and the proxy's failure reports. */
function fakeRoute(account: ChatgptAccountView = { state: 'signed-in', email: 'ada@example.com', planUsage: 'on', acknowledged: true }) {
  const changes = new Set<() => void>();
  const failures = new Set<(failure: ChatgptFailure) => void>();
  const state = { account, ready: true, models: MODELS };
  return {
    state,
    view: (): AgentChatgptView => ({ account: state.account, models: state.models }),
    ready: () => state.ready,
    onChange: (listener: () => void) => (changes.add(listener), () => void changes.delete(listener)),
    onFailure: (listener: (failure: ChatgptFailure) => void) => (failures.add(listener), () => void failures.delete(listener)),
    report: (failure: ChatgptFailure) => failures.forEach((listener) => listener(failure)),
    changed: () => changes.forEach((listener) => listener()),
  };
}

const runs: Awaited<ReturnType<typeof setupSession>>[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.stop();
});

/** The sign-in's procedures as the session calls them (the real service is `chatgpt/__tests__/service.test.ts`'s). */
function fakeAuth() {
  return {
    signIn: vi.fn(async (_options?: { reconsent?: boolean; differentAccount?: boolean; userGesture?: boolean; windowId?: number }) => 'started' as const),
    cancel: vi.fn(() => true),
    signOut: vi.fn(async () => 'signed-out' as const),
    acknowledge: vi.fn(async () => true),
  };
}

async function setup(steps: unknown[] = [{ text: ['Hello.'] }], route = fakeRoute(), extra: Pick<Parameters<typeof setupSession>[0] & object, 'consumeGesture'> = {}) {
  const s = await setupSession({ key: false, steps, chatgpt: route, ...extra });
  runs.push(s);
  expect(await s.agent.settings.setChatgptModels(MODELS)).toBe(true);
  expect(await s.session.setModel('chatgpt', 'chatgpt/gpt-6.1-sol')).toBe(true);
  return { ...s, route };
}

describe('session: the ChatGPT plan route', () => {
  test('chatgpt-session-sign-in-spends-the-gesture (none: needs-gesture, nothing opened)', async () => {
    const auth = fakeAuth();
    const gestures = new Map<number, boolean>([[7, true]]);
    const consumeGesture = vi.fn((windowId: number) => {
      const live = gestures.get(windowId) === true;
      gestures.delete(windowId);
      return live;
    });
    const s = await setup(undefined, Object.assign(fakeRoute(), { auth }), { consumeGesture });
    // A window with no live gesture (another one, or this one's already spent): nothing starts.
    expect(await s.session.chatgptSignIn(8, {})).toBe('needs-gesture');
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(await s.session.chatgptSignIn(7, { reconsent: true })).toBe('started');
    expect(auth.signIn).toHaveBeenCalledWith({ reconsent: true, userGesture: true, windowId: 7 });
    expect(await s.session.chatgptSignIn(7, {})).toBe('needs-gesture');
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    // "Use a different account" passes through (main signs out and registers fresh).
    gestures.set(7, true);
    expect(await s.session.chatgptSignIn(7, { differentAccount: true })).toBe('started');
    expect(auth.signIn).toHaveBeenLastCalledWith({ differentAccount: true, userGesture: true, windowId: 7 });
    expect(consumeGesture).toHaveBeenCalledTimes(4);
  });

  test('chatgpt-session-procedures (cancel, sign out, acknowledge; safe answers without a sign-in)', async () => {
    const auth = fakeAuth();
    const s = await setup(undefined, Object.assign(fakeRoute(), { auth }), { consumeGesture: () => true });
    expect(s.session.chatgptCancel()).toBe(true);
    expect(await s.session.chatgptSignOut()).toBe('signed-out');
    expect(await s.session.chatgptAcknowledge()).toBe(true);
    expect([auth.cancel, auth.signOut, auth.acknowledge].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
    auth.signOut.mockRejectedValueOnce(new Error('x'));
    expect(await s.session.chatgptSignOut()).toBe('not-revoked');
    auth.signIn.mockRejectedValueOnce(new Error('x'));
    expect(await s.session.chatgptSignIn(1, {})).toBe('failed');
    // No sign-in service (or no gesture tracker): nothing opens.
    const none = await setup();
    expect(await none.session.chatgptSignIn(1, {})).toBe('needs-gesture');
    expect(none.session.chatgptCancel()).toBe(false);
    expect(await none.session.chatgptAcknowledge()).toBe(false);
  });

  test('chatgpt-session-setup (the account, its models, ready when the route is)', async () => {
    const s = await setup();
    const setup_ = s.session.getState().setup;
    expect(setup_.route).toBe('chatgpt');
    expect(setup_.modelId).toBe('chatgpt/gpt-6.1-sol');
    expect(setup_.allowedModels).toEqual(['chatgpt/gpt-6.1-sol', 'chatgpt/gpt-6.1-mini']);
    expect(setup_.chatgpt).toEqual({ account: s.route.state.account, models: MODELS });
    expect(setup_.ready).toBe(true);
    // The route's change reaches the panel.
    s.route.state.ready = false;
    s.route.state.account = { state: 'expired', email: 'ada@example.com', acknowledged: true };
    const version = s.session.getState().version;
    s.route.changed();
    expect(s.session.getState().version).toBeGreaterThan(version);
    expect(s.session.getState().setup).toMatchObject({ ready: false, chatgpt: { account: { state: 'expired' } } });
    // Another route lists the catalogue's models again.
    await s.session.setModel('byok-openai', 'openai/gpt-5');
    expect(s.session.getState().setup.allowedModels).toEqual(['openai/gpt-5', 'openai/gpt-5-mini']);
  });

  test('chatgpt-session-send (a turn starts only when the route is ready, with the ChatGPT id)', async () => {
    const s = await setup();
    s.route.state.ready = false;
    expect(await s.session.send(null, 'Audit this page')).toBe('setup-needed');
    expect(s.starts()).toEqual([]);
    s.route.state.ready = true;
    expect(await s.session.send(null, 'Audit this page')).toBe('started');
    await s.until((state) => !state.running);
    expect(s.starts()[0]).toMatchObject({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-sol' });
    expect(s.session.getState().active).toMatchObject({ error: null, chatgptError: null, modelId: 'chatgpt/gpt-6.1-sol' });
  });

  const SIGNED_IN: ChatgptAccountView = { state: 'signed-in', email: 'ada@example.com', planUsage: 'on', acknowledged: true };
  test.each<[ChatgptAccountView, readonly ChatgptModelView[], ChatgptSetupReason]>([
    [{ state: 'signed-out', acknowledged: false }, MODELS, 'signed-out'],
    [{ state: 'pending', acknowledged: false }, MODELS, 'pending'],
    [{ state: 'expired', email: 'ada@example.com', acknowledged: true }, MODELS, 'expired'],
    [{ ...SIGNED_IN, planUsage: 'declined' }, MODELS, 'plan-usage-off'],
    [SIGNED_IN, [], 'no-models'],
    [SIGNED_IN, MODELS, 'choose-model'],
  ])('chatgpt-session-setup-messages (%j: the notice says what the plan needs, not "add a key")', async (account, models, reason) => {
    const s = await setup();
    Object.assign(s.route.state, { ready: false, account, models });
    expect(await s.session.send(null, 'Audit this page')).toBe('setup-needed');
    expect(s.starts()).toEqual([]);
    const notice = s.session.getState().notice;
    expect(notice).toMatchObject({ kind: 'setup-needed', message: CHATGPT_SETUP_MESSAGES[reason] });
    expect(notice!.message).not.toBe(AGENT_NOTICE_MESSAGES['setup-needed']);
  });

  test.each([
    [{ reason: 'usage-limit' }, CHATGPT_ERROR_MESSAGES['usage-limit']],
    [{ reason: 'signed-out' }, CHATGPT_ERROR_MESSAGES['signed-out']],
    [{ reason: 'unsupported', param: 'tools[0].type' }, `${CHATGPT_ERROR_MESSAGES.unsupported} (tools[0].type)`],
  ] as const)('chatgpt-session-error (%j: main reports it, the chat shows it)', async (failure, message) => {
    const s = await setup([{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['Done.'] }]);
    s.runner.hold('page_text');
    expect(await s.session.send(null, 'Audit this page')).toBe('started');
    await s.until(() => s.runner.calls.length === 1);
    const chatId = s.starts()[0]!.chatId;
    s.route.report(failure);
    s.asRuntime({ type: 'chat.error', chatId, message: 'The model provider is limiting requests (HTTP 429). Try again shortly.' });
    const state = await s.until((next) => next.active?.error !== null && next.active?.error !== undefined);
    expect(state.active).toMatchObject({ error: message, chatgptError: failure });
  });

  test('chatgpt-session-error (only the running turn on the plan; cleared by the next turn)', async () => {
    const s = await setup([{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['Done.'] }, { text: ['Again.'] }]);
    // No turn running: nothing to attach it to.
    s.route.report({ reason: 'usage-limit' });
    s.runner.hold('page_text');
    expect(await s.session.send(null, 'Audit this page')).toBe('started');
    await s.until(() => s.runner.calls.length === 1);
    const chatId = s.starts()[0]!.chatId;
    s.route.report({ reason: 'usage-limit' });
    s.asRuntime({ type: 'chat.error', chatId, message: 'The model provider is limiting requests (HTTP 429). Try again shortly.' });
    await s.until((next) => next.active?.chatgptError !== null && next.active?.chatgptError !== undefined);
    // The runtime's own turn ends too; the next turn starts clean.
    s.runner.release('page_text', { ok: true, data: { text: 'Tea.' }, source: 'page:https://shop.example.com' });
    await s.until(() => s.agent.host.activeChats().length === 0);
    expect(await s.session.send(chatId, 'Again')).toBe('started');
    await s.until((next) => !next.running);
    expect(s.session.getState().active).toMatchObject({ error: null, chatgptError: null });
  });

  test('chatgpt-session-error (a failure before the turn, or on another route, is not shown)', async () => {
    const s = await setup([{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['Done.'] }]);
    s.route.report({ reason: 'usage-limit' });
    s.runner.hold('page_text');
    expect(await s.session.send(null, 'Audit this page')).toBe('started');
    await s.until(() => s.runner.calls.length === 1);
    const chatId = s.starts()[0]!.chatId;
    s.asRuntime({ type: 'chat.error', chatId, message: 'The chat failed.' });
    const failed = await s.until((next) => next.active?.error === 'The chat failed.');
    expect(failed.active?.chatgptError).toBeNull();
  });
});
