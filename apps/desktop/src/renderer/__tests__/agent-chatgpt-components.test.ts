// @vitest-environment jsdom
// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_UI, CHATGPT_USAGE_URL, CHATGPT_ERROR_MESSAGES, CHATGPT_SIGN_IN_ERROR_MESSAGES)
// Acceptance: specs/agent-chatgpt.feature.md (Panel)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ERROR_MESSAGES, CHATGPT_SIGN_IN_ERROR_MESSAGES, CHATGPT_UI, CHATGPT_USAGE_URL, type ChatgptAccountView, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import type { AgentActiveChatView } from '@app/specs/agent-session.spec';
import { setup } from './agent-fixtures';

const calls = vi.hoisted(() => ({
  setModel: vi.fn(async (..._args: unknown[]) => true),
  setKey: vi.fn(async (..._args: unknown[]) => 'stored' as const),
  clearKey: vi.fn(async (..._args: unknown[]) => true),
  setChatRetention: vi.fn(async (..._args: unknown[]) => 'saved' as const),
  deleteAllChats: vi.fn(async () => 'deleted' as const),
  chatgptSignIn: vi.fn(async (..._args: unknown[]): Promise<string> => 'started'),
  chatgptCancel: vi.fn(async () => true),
  chatgptSignOut: vi.fn(async (): Promise<string> => 'signed-out'),
  chatgptAcknowledge: vi.fn(async () => true),
}));
vi.mock('../agent-actions', () => ({ agentActions: calls }));

const { AgentSettings } = await import('../components/agent/AgentSettings');
const { AgentChat } = await import('../components/agent/AgentChat');
const { ChatgptComposerBar } = await import('../components/agent/AgentChatgpt');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODELS: readonly ChatgptModelView[] = [
  { id: 'chatgpt/gpt-5.5', label: 'GPT-5.5' },
  { id: 'chatgpt/gpt-5.5-mini', label: 'GPT-5.5 mini' },
];
const SIGNED_IN: ChatgptAccountView = { state: 'signed-in', email: 'ada@example.com', planUsage: 'on', acknowledged: false };

let host: HTMLDivElement;
let root: Root;
const render = (element: ReturnType<typeof createElement>) => act(() => root.render(element));
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null) => act(() => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
/** A real click: the button takes focus first. */
const press = (el: HTMLElement | null) => {
  el!.focus();
  return click(el);
};
/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const flush = () => act(async () => undefined);
const pick = (el: HTMLElement | null, value: string) =>
  act(() => {
    const select = el as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const settings = (s: ReturnType<typeof setup>) => createElement(AgentSettings, { setup: s, grantsCount: 0, readToolsAllowed: true, chatRetention: '30d', onOpen: () => undefined });
const onPlan = (account: ChatgptAccountView = SIGNED_IN) => setup({ route: 'chatgpt', modelId: 'chatgpt/gpt-5.5', allowedModels: MODELS.map((model) => model.id), chatgpt: { account, models: MODELS }, ready: true });
const chat = (changes: Partial<AgentActiveChatView>): AgentActiveChatView =>
  ({ id: '00000000-0000-4000-8000-000000000001', title: 'Chat', messages: [], running: false, error: null, chatgptError: null, truncated: false, contextTokens: null, contextWindow: null, tabId: 1, modelId: 'chatgpt/gpt-5.5', ...changes }) as unknown as AgentActiveChatView;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  for (const fn of Object.values(calls)) fn.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ChatGPT plan in the settings', () => {
  test('chatgpt-settings-preview-then-store', async () => {
    // Signed out, nothing listed: picking the plan shows its sign-in and stores nothing.
    const signedOut = setup();
    render(settings(signedOut));
    expect(byTestId('agent-chatgpt')).toBeNull();
    pick(byTestId('agent-route'), 'chatgpt');
    expect(calls.setModel).not.toHaveBeenCalled();
    expect(byTestId('agent-chatgpt')!.dataset.state).toBe('signed-out');
    expect(byTestId('agent-model-none')!.textContent).toBe(CHATGPT_UI.signInToChooseModel);
    expect(byTestId('agent-chatgpt-sign-in')!.textContent).toBe(CHATGPT_UI.continueButton);
    // Continue with ChatGPT: main is asked (it spends the click's gesture), nothing else.
    click(byTestId('agent-chatgpt-sign-in'));
    await flush();
    expect(calls.chatgptSignIn).toHaveBeenCalledWith({});
    // The account signs in and lists models: the route is stored with the first.
    render(settings(setup({ chatgpt: { account: SIGNED_IN, models: MODELS } })));
    await flush();
    expect(calls.setModel).toHaveBeenCalledWith('chatgpt', 'chatgpt/gpt-5.5');
  });

  test('chatgpt-settings-route-switch-with-models', () => {
    render(settings(setup({ chatgpt: { account: SIGNED_IN, models: MODELS } })));
    pick(byTestId('agent-route'), 'chatgpt');
    expect(calls.setModel).toHaveBeenCalledWith('chatgpt', 'chatgpt/gpt-5.5');
  });

  test('chatgpt-settings-model-select-from-account', () => {
    render(settings(onPlan()));
    const options = [...(byTestId('agent-model') as HTMLSelectElement).options].map((option) => [option.value, option.textContent]);
    expect(options).toEqual([
      ['chatgpt/gpt-5.5', 'GPT-5.5'],
      ['chatgpt/gpt-5.5-mini', 'GPT-5.5 mini'],
    ]);
    expect(byTestId('agent-chatgpt-account')!.textContent).toBe('Signed in as ada@example.com');
    expect(byTestId('agent-chatgpt-status')!.textContent).toBe(CHATGPT_UI.planUsageOn);
  });

  test('chatgpt-settings-pending-cancel', async () => {
    render(settings(onPlan({ state: 'pending', acknowledged: false })));
    expect(byTestId('agent-chatgpt-status')!.textContent).toBe(CHATGPT_UI.pending);
    click(byTestId('agent-chatgpt-cancel'));
    await flush();
    expect(calls.chatgptCancel).toHaveBeenCalledOnce();
  });

  test('chatgpt-settings-actions', async () => {
    render(settings(onPlan({ ...SIGNED_IN, planUsage: 'declined' })));
    expect(byTestId('agent-chatgpt-status')!.textContent).toBe(CHATGPT_UI.planUsageDeclined);
    click(byTestId('agent-chatgpt-reconsent'));
    await flush();
    expect(calls.chatgptSignIn).toHaveBeenLastCalledWith({ reconsent: true });
    click(byTestId('agent-chatgpt-different-account'));
    await flush();
    expect(calls.chatgptSignIn).toHaveBeenLastCalledWith({ differentAccount: true });
    calls.chatgptSignOut.mockResolvedValueOnce('not-revoked');
    click(byTestId('agent-chatgpt-sign-out'));
    await flush();
    expect(byTestId('agent-chatgpt-message')!.textContent).toBe(CHATGPT_UI.notRevoked);
  });

  test('chatgpt-settings-needs-gesture', async () => {
    calls.chatgptSignIn.mockResolvedValueOnce('needs-gesture');
    render(settings(onPlan({ state: 'signed-out', acknowledged: false })));
    click(byTestId('agent-chatgpt-sign-in'));
    await flush();
    expect(byTestId('agent-chatgpt-message')!.textContent).toBe(CHATGPT_UI.needsGesture);
  });

  test('chatgpt-settings-cancel-while-busy', async () => {
    // Continue is still waiting for main's answer when the pending state (and Cancel) arrives.
    const answer = deferred<string>();
    calls.chatgptSignIn.mockReturnValueOnce(answer.promise);
    render(settings(onPlan({ state: 'signed-out', acknowledged: false })));
    click(byTestId('agent-chatgpt-sign-in'));
    render(settings(onPlan({ state: 'pending', acknowledged: false })));
    const cancel = byTestId('agent-chatgpt-cancel') as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    click(cancel);
    await flush();
    expect(calls.chatgptCancel).toHaveBeenCalledOnce();
    answer.resolve('started');
    await flush();
  });

  test('chatgpt-settings-live-region', async () => {
    const live = () => host.querySelector<HTMLElement>('[data-testid="agent-chatgpt-live"]')!;
    render(settings(onPlan({ state: 'signed-out', acknowledged: false })));
    // Always rendered, even with nothing to say yet: a region that appears with its text isn't announced.
    expect(live().getAttribute('role')).toBe('status');
    const region = live();
    render(settings(onPlan({ state: 'pending', acknowledged: false })));
    expect(live()).toBe(region);
    expect(region.textContent).toContain(CHATGPT_UI.pending);
    render(settings(onPlan()));
    expect(live()).toBe(region);
    expect(region.textContent).toContain('Signed in as ada@example.com');
    expect(region.textContent).toContain(CHATGPT_UI.planUsageOn);
    render(settings(onPlan({ state: 'expired', email: 'ada@example.com', acknowledged: true, error: 'network' })));
    expect(live()).toBe(region);
    expect(region.textContent).toContain(CHATGPT_UI.expired);
    expect(region.textContent).toContain(CHATGPT_SIGN_IN_ERROR_MESSAGES.network);
    calls.chatgptSignIn.mockResolvedValueOnce('browser-failed');
    click(byTestId('agent-chatgpt-sign-in'));
    await flush();
    expect(region.textContent).toContain(CHATGPT_UI.browserFailed);
  });

  test('chatgpt-settings-focus (the clicked button went away: the first action takes focus)', async () => {
    render(settings(onPlan({ state: 'signed-out', acknowledged: false })));
    await press(byTestId('agent-chatgpt-sign-in'));
    await flush();
    render(settings(onPlan({ state: 'pending', acknowledged: false })));
    expect(document.activeElement).toBe(byTestId('agent-chatgpt-cancel'));
    render(settings(onPlan()));
    expect(document.activeElement).toBe(byTestId('agent-chatgpt-sign-out'));
    // Focus the user put elsewhere is left alone.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    render(settings(onPlan({ state: 'expired', email: 'ada@example.com', acknowledged: true })));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  test('chatgpt-settings-model-label', () => {
    render(settings(setup()));
    pick(byTestId('agent-route'), 'chatgpt');
    // A sentence instead of a select: no label left pointing at nothing.
    expect(byTestId('agent-model-none')).not.toBeNull();
    expect(host.querySelector('label[for="agent-model"]')).toBeNull();
    expect(host.querySelector('#agent-model')).toBeNull();
    render(settings(onPlan()));
    const label = host.querySelector<HTMLLabelElement>('label[for="agent-model"]')!;
    expect(label.textContent).toBe('Model');
    expect(label.control).toBe(byTestId('agent-model'));
  });

  test('chatgpt-settings-error-states', () => {
    render(settings(onPlan({ state: 'signed-out', acknowledged: false, error: 'account-mismatch' })));
    expect(byTestId('agent-chatgpt-error')!.textContent).toBe(CHATGPT_SIGN_IN_ERROR_MESSAGES['account-mismatch']);
    expect(byTestId('agent-chatgpt-different-account')!.textContent).toBe(CHATGPT_UI.useDifferentAccount);
    render(settings(onPlan({ state: 'expired', email: 'ada@example.com', acknowledged: true, error: 'store-unreadable' })));
    expect(byTestId('agent-chatgpt-status')!.textContent).toBe(CHATGPT_UI.expired);
    expect(byTestId('agent-chatgpt-error')!.textContent).toBe(CHATGPT_SIGN_IN_ERROR_MESSAGES['store-unreadable']);
    expect(byTestId('agent-chatgpt-sign-in')!.textContent).toBe(CHATGPT_UI.signInAgain);
  });
});

describe('ChatGPT plan by the composer and in the chat', () => {
  test('chatgpt-composer-line', () => {
    render(createElement(ChatgptComposerBar, { setup: setup() }));
    expect(byTestId('agent-chatgpt-inuse')).toBeNull();
    render(createElement(ChatgptComposerBar, { setup: onPlan({ ...SIGNED_IN, acknowledged: true }) }));
    expect(byTestId('agent-chatgpt-inuse')!.textContent).toBe(`${CHATGPT_UI.inUse} · ${CHATGPT_UI.manageUsage}`);
    const link = byTestId('agent-chatgpt-manage-usage') as HTMLAnchorElement;
    // The app window's open handler sends it to the system browser (allowlisted, on the click's gesture).
    expect(link.getAttribute('href')).toBe(CHATGPT_USAGE_URL);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');
    expect(byTestId('agent-chatgpt-notice')).toBeNull();
    // Selected, but not on the plan (signed out, as at startup, or plan usage off): no line.
    render(createElement(ChatgptComposerBar, { setup: onPlan({ state: 'signed-out', acknowledged: false }) }));
    expect(byTestId('agent-chatgpt-inuse')).toBeNull();
    render(createElement(ChatgptComposerBar, { setup: onPlan({ ...SIGNED_IN, planUsage: 'declined' }) }));
    expect(byTestId('agent-chatgpt-inuse')).toBeNull();
  });

  test('chatgpt-one-time-notice', async () => {
    render(createElement(ChatgptComposerBar, { setup: onPlan() }));
    const notice = byTestId('agent-chatgpt-notice')!;
    expect(notice.textContent).toContain(CHATGPT_UI.noticeTitle);
    expect(byTestId('agent-chatgpt-got-it')!.textContent).toBe(CHATGPT_UI.noticeButton);
    await press(byTestId('agent-chatgpt-got-it'));
    await flush();
    expect(calls.chatgptAcknowledge).toHaveBeenCalledOnce();
    // The notice goes: focus moves to the line's first action, not to nothing.
    render(createElement(ChatgptComposerBar, { setup: onPlan({ ...SIGNED_IN, acknowledged: true }) }));
    expect(byTestId('agent-chatgpt-notice')).toBeNull();
    expect(document.activeElement).toBe(byTestId('agent-chatgpt-manage-usage'));
  });

  test('chatgpt-usage-limit-manage-usage-first', () => {
    render(createElement(AgentChat, { active: chat({ error: CHATGPT_ERROR_MESSAGES['usage-limit'], chatgptError: { reason: 'usage-limit' } }), setup: onPlan(), notice: null, onOpenSettings: () => undefined }));
    const banner = byTestId('agent-error')!;
    expect(banner.dataset.reason).toBe('usage-limit');
    expect(byTestId('agent-chatgpt-error-title')!.textContent).toBe(CHATGPT_UI.usageLimitTitle);
    const action = byTestId('agent-chatgpt-recovery') as HTMLAnchorElement;
    expect(action.tagName).toBe('A');
    expect(action.textContent).toBe(CHATGPT_UI.manageUsage);
    expect(action.getAttribute('href')).toBe(CHATGPT_USAGE_URL);
    expect(action.className).toContain('agent-button-primary');
  });

  test('chatgpt-error-recoveries', async () => {
    const show = (reason: 'plan-usage-off' | 'signed-out' | 'plan-unavailable') =>
      render(createElement(AgentChat, { active: chat({ error: CHATGPT_ERROR_MESSAGES[reason], chatgptError: { reason } }), setup: onPlan(), notice: null, onOpenSettings: () => undefined }));
    show('plan-usage-off');
    expect(byTestId('agent-chatgpt-recovery')!.textContent).toBe(CHATGPT_UI.reconsentButton);
    click(byTestId('agent-chatgpt-recovery'));
    await flush();
    expect(calls.chatgptSignIn).toHaveBeenLastCalledWith({ reconsent: true });
    show('signed-out');
    click(byTestId('agent-chatgpt-recovery'));
    await flush();
    expect(calls.chatgptSignIn).toHaveBeenLastCalledWith({});
    // A double click starts one sign-in: the button waits for the answer.
    const answer = deferred<string>();
    calls.chatgptSignIn.mockClear();
    calls.chatgptSignIn.mockReturnValueOnce(answer.promise);
    const recovery = byTestId('agent-chatgpt-recovery') as HTMLButtonElement;
    // Both clicks before React renders again (the guard can't wait for `disabled`).
    act(() => {
      recovery.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      recovery.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(calls.chatgptSignIn).toHaveBeenCalledOnce();
    expect(recovery.disabled).toBe(true);
    answer.resolve('started');
    await flush();
    expect(recovery.disabled).toBe(false);
    show('plan-unavailable');
    expect(byTestId('agent-error')!.textContent).toBe(CHATGPT_ERROR_MESSAGES['plan-unavailable']);
    expect(byTestId('agent-chatgpt-recovery')).toBeNull();
  });
});
