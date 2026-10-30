// Spec: specs/agent-chatgpt.spec.ts (CHATGPT_UI, CHATGPT_SIGN_IN_ERROR_MESSAGES, CHATGPT_ERROR_MESSAGES,
// chatgptFailureMessage, ChatgptAccountView), specs/agent-panel.spec.ts (AGENT_ROUTE_LABELS.chatgpt)
// Acceptance: specs/agent-chatgpt.feature.md (Panel)
import { describe, expect, test } from 'vitest';
import { CHATGPT_ERROR_MESSAGES, CHATGPT_SIGN_IN_ERROR_MESSAGES, CHATGPT_UI, type ChatgptAccountView, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { MODEL_ROUTES } from '@app/specs/agent-tools.spec';
import { setup } from './agent-fixtures';
import {
  chatgptChecklistValue,
  chatgptComposerModel,
  chatgptErrorModel,
  chatgptSettingsModel,
  chatgptSignInMessage,
  chatgptSignInOptions,
  chatgptSignOutMessage,
  modelForRoute,
  modelLabel,
  modelOptions,
  previewModel,
  routeChoice,
  routeOptions,
  setupChecklist,
} from '../agent-view';

const MODELS: readonly ChatgptModelView[] = [
  { id: 'chatgpt/gpt-5.5', label: 'GPT-5.5' },
  { id: 'chatgpt/gpt-5.5-mini', label: 'GPT-5.5 mini' },
];
const account = (changes: Partial<ChatgptAccountView> = {}): ChatgptAccountView => ({ state: 'signed-out', acknowledged: false, ...changes });
const signedIn = account({ state: 'signed-in', email: 'ada@example.com', planUsage: 'on' });
const onPlan = (changes: Partial<ChatgptAccountView> = {}, models = MODELS) =>
  setup({ route: 'chatgpt', modelId: models[0]?.id ?? 'chatgpt/gpt-5.5', allowedModels: models.map((model) => model.id), chatgpt: { account: { ...signedIn, ...changes }, models }, ready: true });

describe('ChatGPT plan: route and models', () => {
  test('chatgpt-route-offered', () => {
    const options = routeOptions();
    expect(options.map((option) => option.value)).toEqual([...MODEL_ROUTES]);
    expect(options.find((option) => option.value === 'chatgpt')!.label).toBe(CHATGPT_UI.routeLabel);
  });

  test('chatgpt-model-labels-from-account-list', () => {
    expect(modelLabel('chatgpt/gpt-5.5', MODELS)).toBe('GPT-5.5');
    // Not in the list: the id itself (never a guess).
    expect(modelLabel('chatgpt/other', MODELS)).toBe('chatgpt/other');
    expect(modelOptions(onPlan())).toEqual([
      { value: 'chatgpt/gpt-5.5', label: 'GPT-5.5' },
      { value: 'chatgpt/gpt-5.5-mini', label: 'GPT-5.5 mini' },
    ]);
  });

  test('chatgpt-route-switch-picks-listed-model', () => {
    // The account's first listed model, or the current one if it is listed.
    expect(modelForRoute('chatgpt', 'anthropic/claude-sonnet-5-5', MODELS)).toBe('chatgpt/gpt-5.5');
    expect(modelForRoute('chatgpt', 'chatgpt/gpt-5.5-mini', MODELS)).toBe('chatgpt/gpt-5.5-mini');
    expect(modelForRoute('chatgpt', 'chatgpt/gone', [])).toBeNull();
    // Leaving the plan for a key route: a catalogue model again.
    expect(modelForRoute('byok-openai', 'chatgpt/gpt-5.5', MODELS)).toBe('openai/gpt-5');
    const listed = setup({ chatgpt: { account: signedIn, models: MODELS } });
    expect(routeChoice('chatgpt', listed)).toEqual({ kind: 'set', route: 'chatgpt', modelId: 'chatgpt/gpt-5.5' });
    expect(routeChoice('byok-openai', listed)).toEqual({ kind: 'set', route: 'byok-openai', modelId: 'openai/gpt-5' });
  });

  test('chatgpt-route-preview-before-models', () => {
    // No model listed yet (signed out): the route is only previewed, nothing is stored.
    const none = setup();
    expect(routeChoice('chatgpt', none)).toEqual({ kind: 'preview', route: 'chatgpt' });
    expect(previewModel(none)).toBeNull();
    // Once the account lists models, the first is stored with the route.
    expect(previewModel(setup({ chatgpt: { account: signedIn, models: MODELS } }))).toBe('chatgpt/gpt-5.5');
    // Already on the route: nothing to store.
    expect(previewModel(onPlan())).toBeNull();
  });

  test('chatgpt-checklist-sign-in-line', () => {
    const line = (s: ReturnType<typeof setup>) => setupChecklist(s).find((item) => item.id === 'key')!;
    expect(line(setup({ route: 'chatgpt', modelId: 'chatgpt/gpt-5.5', allowedModels: [] }))).toEqual({ id: 'key', label: CHATGPT_UI.routeLabel, value: CHATGPT_UI.checklist['signed-out'], ok: false });
    expect(line(onPlan())).toEqual({ id: 'key', label: CHATGPT_UI.routeLabel, value: CHATGPT_UI.checklist['signed-in'], ok: true });
    expect(setupChecklist(onPlan()).find((item) => item.id === 'model')!.value).toBe('GPT-5.5');
    expect(chatgptChecklistValue({ state: 'signed-in', planUsage: 'declined' })).toBe(CHATGPT_UI.checklist.planUsageOff);
    expect(chatgptChecklistValue({ state: 'expired' })).toBe(CHATGPT_UI.checklist.expired);
    expect(chatgptChecklistValue({ state: 'pending' })).toBe(CHATGPT_UI.pending);
  });
});

describe('ChatGPT plan: the settings section', () => {
  const actions = (view: ChatgptAccountView) => chatgptSettingsModel(view).actions.map((item) => [item.action, item.label, item.primary]);

  test('chatgpt-settings-signed-out', () => {
    const model = chatgptSettingsModel(account());
    expect(model).toMatchObject({ state: 'signed-out', account: null, status: null, error: null });
    expect(actions(account())).toEqual([['sign-in', 'Continue with ChatGPT', true]]);
    expect(CHATGPT_UI.continueButton).toBe('Continue with ChatGPT');
  });

  test('chatgpt-settings-pending', () => {
    expect(chatgptSettingsModel(account({ state: 'pending' }))).toMatchObject({ status: CHATGPT_UI.pending });
    expect(actions(account({ state: 'pending' }))).toEqual([['cancel', CHATGPT_UI.cancel, false]]);
  });

  test('chatgpt-settings-signed-in', () => {
    expect(chatgptSettingsModel(signedIn)).toMatchObject({ account: `${CHATGPT_UI.signedInAs} ada@example.com`, planUsage: 'on', status: CHATGPT_UI.planUsageOn });
    expect(actions(signedIn)).toEqual([
      ['sign-out', CHATGPT_UI.signOut, false],
      ['different-account', CHATGPT_UI.useDifferentAccount, false],
    ]);
  });

  test('chatgpt-settings-plan-usage-declined', () => {
    const declined = account({ state: 'signed-in', email: 'ada@example.com', planUsage: 'declined' });
    expect(chatgptSettingsModel(declined)).toMatchObject({ planUsage: 'declined', status: CHATGPT_UI.planUsageDeclined });
    expect(actions(declined)[0]).toEqual(['reconsent', CHATGPT_UI.reconsentButton, true]);
    expect(chatgptSignInOptions('reconsent')).toEqual({ reconsent: true });
  });

  test('chatgpt-settings-expired', () => {
    const expired = account({ state: 'expired', email: 'ada@example.com' });
    expect(chatgptSettingsModel(expired)).toMatchObject({ status: CHATGPT_UI.expired, account: `${CHATGPT_UI.signedInAs} ada@example.com` });
    expect(actions(expired)).toEqual([
      ['sign-in', CHATGPT_UI.signInAgain, true],
      ['different-account', CHATGPT_UI.useDifferentAccount, false],
    ]);
  });

  test('chatgpt-settings-sign-in-errors', () => {
    expect(chatgptSettingsModel(account({ error: 'store-unreadable' })).error).toBe(CHATGPT_SIGN_IN_ERROR_MESSAGES['store-unreadable']);
    // Another account than the registered one: the way to switch is offered (v1 keeps one account).
    const mismatch = account({ error: 'account-mismatch' });
    expect(chatgptSettingsModel(mismatch).error).toBe(CHATGPT_SIGN_IN_ERROR_MESSAGES['account-mismatch']);
    expect(actions(mismatch).map(([action]) => action)).toEqual(['sign-in', 'different-account']);
    expect(chatgptSignInOptions('different-account')).toEqual({ differentAccount: true });
    expect(chatgptSignInOptions('sign-in')).toEqual({});
    expect(chatgptSignInOptions('sign-out')).toBeNull();
  });

  test('chatgpt-sign-in-and-out-answers', () => {
    expect(chatgptSignInMessage('started')).toBeNull();
    expect(chatgptSignInMessage('needs-gesture')).toBe(CHATGPT_UI.needsGesture);
    expect(chatgptSignInMessage('no-keychain')).toBe(CHATGPT_UI.noKeychain);
    expect(chatgptSignInMessage('browser-failed')).toBe(CHATGPT_UI.browserFailed);
    expect(chatgptSignInMessage('failed')).toBe(CHATGPT_UI.signInFailed);
    // "Use a different account" whose sign-out ChatGPT didn't confirm: nothing was switched.
    expect(chatgptSignInMessage('not-revoked')).toBe(CHATGPT_UI.switchNotRevoked);
    expect(chatgptSignOutMessage('signed-out')).toBe(CHATGPT_UI.signedOut);
    expect(chatgptSignOutMessage('not-revoked')).toBe(CHATGPT_UI.notRevoked);
    expect(chatgptSignOutMessage('failed')).toBe(CHATGPT_UI.signOutFailed);
  });

  test('chatgpt-settings-no-token', () => {
    // Whatever main sends beyond the view (it never does) is not shown.
    const leaky = { ...signedIn, accessToken: 'at-SECRET', refreshToken: 'rt-SECRET' } as ChatgptAccountView;
    expect(JSON.stringify(chatgptSettingsModel(leaky))).not.toContain('SECRET');
  });
});

describe('ChatGPT plan: composer and chat', () => {
  test('chatgpt-composer-in-use-and-notice', () => {
    expect(chatgptComposerModel(setup())).toEqual({ inUse: false, notice: false });
    expect(chatgptComposerModel(onPlan())).toEqual({ inUse: true, notice: true });
    expect(chatgptComposerModel(onPlan({ acknowledged: true }))).toEqual({ inUse: true, notice: false });
    // Not using the plan: plan usage off, signed out (as at startup, before the sign-in was read),
    // waiting for the browser or expired: neither the line nor the notice.
    expect(chatgptComposerModel(onPlan({ planUsage: 'declined' }))).toEqual({ inUse: false, notice: false });
    expect(chatgptComposerModel(onPlan({ state: 'signed-out' }))).toEqual({ inUse: false, notice: false });
    expect(chatgptComposerModel(onPlan({ state: 'pending' }))).toEqual({ inUse: false, notice: false });
    expect(chatgptComposerModel(onPlan({ state: 'expired' }))).toEqual({ inUse: false, notice: false });
    expect(chatgptComposerModel(setup({ route: 'chatgpt' }))).toEqual({ inUse: false, notice: false });
  });

  test('chatgpt-error-recovery', () => {
    expect(chatgptErrorModel({ reason: 'usage-limit' })).toEqual({ title: CHATGPT_UI.usageLimitTitle, message: CHATGPT_ERROR_MESSAGES['usage-limit'], recovery: 'manage-usage', label: CHATGPT_UI.manageUsage });
    expect(chatgptErrorModel({ reason: 'plan-usage-off' })).toMatchObject({ recovery: 'reconsent', label: CHATGPT_UI.reconsentButton });
    expect(chatgptErrorModel({ reason: 'signed-out' })).toMatchObject({ recovery: 'sign-in', label: CHATGPT_UI.signInAgain });
    expect(chatgptErrorModel({ reason: 'plan-unavailable' })).toEqual({ title: null, message: CHATGPT_ERROR_MESSAGES['plan-unavailable'], recovery: null, label: null });
    expect(chatgptErrorModel({ reason: 'not-eligible' }).recovery).toBeNull();
    expect(chatgptErrorModel({ reason: 'unsupported', param: 'tools[0].type' }).message).toBe(`${CHATGPT_ERROR_MESSAGES.unsupported} (tools[0].type)`);
  });
});
