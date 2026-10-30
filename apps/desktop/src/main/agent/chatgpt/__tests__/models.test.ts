// Spec: specs/agent-chatgpt.spec.ts (ChatgptModelView.efforts, CHATGPT_ADVERTISED_EFFORTS_FIELD,
// advertisedEfforts), specs/agent-chatgpt.schema.ts (ChatgptModelEntrySchema), specs/agent-reasoning.spec.ts
// (reasoningLevels: the ChatGPT route offers only the levels the account's list advertises)
// Acceptance: specs/agent-chatgpt.feature.md (Through the proxy: chatgpt-models-keep-advertised-efforts) ·
// Phase 8 Task 8b
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_ADVERTISED_EFFORTS_FIELD } from '@app/specs/agent-chatgpt.spec';
import { reasoningLevels } from '@app/specs/agent-reasoning.spec';
import { createAgentSettings } from '../../settings';
import { createMemoryFs } from '../../__tests__/fakes';
import { createChatgptRoute } from '../route';
import { createHarness } from './harness';

type Harness = ReturnType<typeof createHarness>;
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.auth.dispose();
    await h.close();
  }
});

const FILE = '/user-data/agent-settings.json';

describe('chatgpt model list: advertised reasoning levels', () => {
  test('chatgpt-models-keep-advertised-efforts', async () => {
    const h = createHarness();
    harnesses.push(h);
    expect(CHATGPT_ADVERTISED_EFFORTS_FIELD).toBe('supported_reasoning_levels');
    h.server.models = {
      models: [
        // Strings or `{ effort }` objects; unknown, repeated and `off` levels are dropped, the rest kept in order.
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'high', description: 'Deeper' }, 'low', 'xhigh', 'low', 'off'] },
        { slug: 'gpt-6.1-mini', display_name: 'GPT-6.1 mini', visibility: 'list', supported_reasoning_levels: ['medium'] },
        // None advertised (absent, empty, malformed): no `efforts` key, so Auto only.
        { slug: 'gpt-6.1-nano', display_name: 'GPT-6.1 nano', visibility: 'list' },
        { slug: 'gpt-6.1-pico', display_name: 'GPT-6.1 pico', visibility: 'list', supported_reasoning_levels: [] },
        { slug: 'gpt-6.1-femto', display_name: 'GPT-6.1 femto', visibility: 'list', supported_reasoning_levels: 'high' },
      ],
    };
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    await settings.load();
    const route = createChatgptRoute({ auth: h.auth, settings });
    await route.start();
    await h.signIn();

    const expected = [
      { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'high'] },
      { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini', efforts: ['medium'] },
      { id: 'chatgpt/gpt-6.1-nano', label: 'GPT-6.1 nano' },
      { id: 'chatgpt/gpt-6.1-pico', label: 'GPT-6.1 pico' },
      { id: 'chatgpt/gpt-6.1-femto', label: 'GPT-6.1 femto' },
    ];
    // The listing maps each entry's advertised levels into the view.
    expect(await h.auth.listModels()).toEqual({ ok: true, models: expected });
    // The route keeps them with the settings, and shows them.
    await vi.waitFor(() => expect(settings.chatgptModels()).toEqual(expected));
    expect(route.view().models).toEqual(expected);
    // Persisted: a restart reads them back from the file.
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.chatgptModels()).toEqual(expected);
    // So the ChatGPT route offers exactly the advertised levels, and Auto only where none are.
    expect(reasoningLevels('chatgpt/gpt-6.1-sol', again.chatgptModels())).toEqual(['auto', 'low', 'high']);
    expect(reasoningLevels('chatgpt/gpt-6.1-mini', again.chatgptModels())).toEqual(['auto', 'medium']);
    for (const id of ['chatgpt/gpt-6.1-nano', 'chatgpt/gpt-6.1-pico', 'chatgpt/gpt-6.1-femto']) expect(reasoningLevels(id, again.chatgptModels()), id).toEqual(['auto']);

    // A later list that stops advertising a model's levels replaces them (none kept from before).
    h.server.models = { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }] };
    expect(await route.refreshModels()).toBe(true);
    expect(settings.chatgptModels()).toEqual([{ id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' }]);
    await route.dispose();
  });
});
