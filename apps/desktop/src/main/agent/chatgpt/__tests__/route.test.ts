// Spec: specs/agent-chatgpt.spec.ts (ChatgptModelView, ChatgptFailure, CHATGPT_SCOPE), specs/agent-session.spec.ts
// (AgentChatgptView, AgentSetupView.ready), specs/agent-proxy.spec.ts (isUsableModelSettings)
// Acceptance: specs/agent-chatgpt.feature.md (Through the proxy: chatgpt-models-refreshed, chatgpt-route-ready)
// · plan docs/plans/agent-chatgpt-plan.md, Task 3 and decision 5
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ENDPOINTS } from '@app/specs/agent-chatgpt.spec';
import { createAgentSettings } from '../../settings';
import { createMemoryFs } from '../../__tests__/fakes';
import { createChatgptRoute } from '../route';
import { createHarness, EMAIL } from './harness';

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.auth.dispose();
    await h.close();
  }
});

const MODELS = {
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
    { slug: 'gpt-6.1-mini', display_name: 'GPT-6.1 mini', visibility: 'list' },
    { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
  ],
};

async function setup() {
  const h = createHarness();
  harnesses.push(h);
  h.server.models = MODELS;
  const memory = createMemoryFs();
  const settings = createAgentSettings({ file: '/user-data/agent-settings.json', fs: memory.fs });
  await settings.load();
  const route = createChatgptRoute({ auth: h.auth, settings });
  const changes = vi.fn();
  route.onChange(changes);
  return { h, memory, settings, route, changes };
}

const modelRequests = (h: Harness) => h.recorded.filter((r) => r.url === CHATGPT_ENDPOINTS.models).length;

describe('chatgpt route', () => {
  test('chatgpt-models-refreshed (on sign-in, persisted with the settings)', async () => {
    const { h, settings, route, changes, memory } = await setup();
    await route.start();
    expect(route.view()).toEqual({ account: { state: 'signed-out', acknowledged: false }, models: [] });
    expect(modelRequests(h)).toBe(0);
    await h.signIn();
    await vi.waitFor(() => expect(route.view().models).toHaveLength(2));
    expect(route.view()).toEqual({
      account: { state: 'signed-in', email: EMAIL, planUsage: 'on', acknowledged: false },
      models: [
        { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
        { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini' },
      ],
    });
    expect(settings.chatgptModels()).toEqual(route.view().models);
    expect(changes).toHaveBeenCalled();
    // Persisted: a restart with no network keeps the list (and so the choice).
    expect(await settings.set({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' })).toBe(true);
    const again = createAgentSettings({ file: '/user-data/agent-settings.json', fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' });
    // A token refresh (same account, still on) does not ask again.
    const asked = modelRequests(h);
    h.clock.now += 3600_000;
    await h.auth.withAccessToken(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(modelRequests(h)).toBe(asked);
    await route.dispose();
  });

  test('chatgpt-models-refreshed (at start when already signed in; a failed list keeps the last)', async () => {
    const { h, settings } = await setup();
    await h.signIn();
    await settings.setChatgptModels([{ id: 'chatgpt/old', label: 'Old' }]);
    h.server.modelsStatus = [503];
    const route = createChatgptRoute({ auth: h.auth, settings });
    await route.start();
    await vi.waitFor(() => expect(modelRequests(h)).toBe(1));
    expect(route.view().models).toEqual([{ id: 'chatgpt/old', label: 'Old' }]);
    expect(await route.refreshModels()).toBe(true);
    expect(route.view().models.map((model) => model.id)).toEqual(['chatgpt/gpt-6.1-sol', 'chatgpt/gpt-6.1-mini']);
    await route.dispose();
  });

  test('chatgpt-route-ready (signed in, plan usage on, the chosen model listed)', async () => {
    const { h, settings, route } = await setup();
    await route.start();
    expect(route.ready()).toBe(false);
    await h.signIn();
    await vi.waitFor(() => expect(route.view().models).toHaveLength(2));
    // Ready only with a listed ChatGPT model chosen.
    expect(route.ready()).toBe(false);
    await settings.set({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-sol' });
    expect(route.ready()).toBe(true);
    await h.auth.signOut();
    expect(route.ready()).toBe(false);
    // Signed in without plan usage: not ready.
    h.server.scope = 'openid profile email offline_access';
    await h.signIn({ client_id: null });
    expect(route.view().account.planUsage).toBe('declined');
    expect(route.ready()).toBe(false);
    await route.dispose();
  });

  test('chatgpt-models-refreshed (an empty or wholly filtered list is a failed read: the last list stays)', async () => {
    const { h, settings } = await setup();
    await h.signIn();
    await settings.setChatgptModels([{ id: 'chatgpt/old', label: 'Old' }]);
    await settings.set({ route: 'chatgpt', modelId: 'chatgpt/old' });
    const route = createChatgptRoute({ auth: h.auth, settings });
    for (const answer of [{ models: [] }, { models: [{ slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'bad slug', display_name: 'Bad', visibility: 'list' }] }]) {
      h.server.models = answer;
      expect(await route.refreshModels()).toBe(false);
      expect(settings.chatgptModels()).toEqual([{ id: 'chatgpt/old', label: 'Old' }]);
      expect(settings.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/old' });
    }
    await route.dispose();
  });

  test('chatgpt-account-change (sign-in, sign-out and plan usage notify; a token refresh does not)', async () => {
    const { h, route } = await setup();
    const accounts = vi.fn();
    route.onAccountChange(accounts);
    await route.start();
    expect(accounts).not.toHaveBeenCalled();
    await h.signIn();
    const afterSignIn = accounts.mock.calls.length;
    expect(afterSignIn).toBeGreaterThan(0);
    h.clock.now += 3600_000;
    await h.auth.withAccessToken(() => undefined);
    expect(accounts).toHaveBeenCalledTimes(afterSignIn);
    await h.auth.signOut();
    expect(accounts.mock.calls.length).toBeGreaterThan(afterSignIn);
    await route.dispose();
  });

  test('chatgpt-route-failures (the proxy reports, the session listens)', async () => {
    const { route } = await setup();
    const heard = vi.fn();
    const off = route.onFailure(heard);
    route.report({ reason: 'usage-limit' });
    expect(heard).toHaveBeenCalledWith({ reason: 'usage-limit' });
    off();
    route.report({ reason: 'signed-out' });
    expect(heard).toHaveBeenCalledTimes(1);
    await route.dispose();
  });
});
