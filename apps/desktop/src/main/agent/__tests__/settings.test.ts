// Spec: specs/agent-proxy.spec.ts (DEFAULT_AGENT_MODEL_SETTINGS, isValidModelSettings, isUsableModelSettings) · specs/agent-tools.spec.ts (DEFAULT_MODEL_ID)
// · specs/agent-chatgpt.spec.ts (isChatgptModelView, CHATGPT_LIMITS.maxModels)
// Acceptance: specs/agent-host.feature.md (Settings) · specs/agent-chatgpt.feature.md (chatgpt-settings-model-list)
import { describe, expect, test, vi } from 'vitest';
import { CHATGPT_LIMITS, isChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { DEFAULT_MODEL_ID } from '@app/specs/agent-tools.spec';
import { createAgentSettings } from '../settings';
import { createMemoryFs } from './fakes';

const FILE = '/user-data/agent-settings.json';

describe('agent settings', () => {
  test('settings-defaults', async () => {
    const { fs } = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs });
    expect(settings.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID });
    await settings.load();
    expect(settings.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID });
  });

  test('settings-validated', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs, tempSuffix: () => 'tmp1' });
    const changes = vi.fn();
    settings.onChange(changes);
    expect(await settings.set({ route: 'byok-openai' })).toBe(false);
    expect(await settings.set({ route: 'byok-openai', modelId: 'anthropic/claude-opus-5-5' })).toBe(false);
    expect(await settings.set({ route: 'other' as 'gateway' })).toBe(false);
    expect(await settings.set({ modelId: 'openai/gpt-6' as 'openai/gpt-5' })).toBe(false);
    expect(memory.files.size).toBe(0);
    expect(await settings.set({ route: 'byok-openai', modelId: 'openai/gpt-5-mini' })).toBe(true);
    expect(settings.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5-mini' });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    expect(memory.ops.filter((op) => !op.startsWith('read'))).toEqual([`write ${FILE}.tmp1.tmp 600 wx flush`, `rename ${FILE}.tmp1.tmp ${FILE}`, 'sync /user-data']);
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5-mini' });
  });

  test('settings-tampered', async () => {
    for (const content of ['{', '{"route":"byok-anthropic","modelId":"openai/gpt-5"}', '{"route":"elsewhere","modelId":"anthropic/claude-opus-5-5"}', '[1]', `{"route":"gateway","modelId":"${'x'.repeat(5000)}"}`]) {
      const memory = createMemoryFs();
      memory.files.set(FILE, { data: new TextEncoder().encode(content), mode: 0o600 });
      const log = vi.fn();
      const settings = createAgentSettings({ file: FILE, fs: memory.fs, log });
      await settings.load();
      expect(settings.current(), content.slice(0, 40)).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID });
      expect(log).toHaveBeenCalledWith('agent settings: the stored settings are not valid; using the defaults');
    }
  });

  test('chatgpt-settings-model-list (a ChatGPT model only from the persisted list; kept across restarts)', async () => {
    const memory = createMemoryFs();
    let n = 0;
    const settings = createAgentSettings({ file: FILE, fs: memory.fs, tempSuffix: () => `t${(n += 1)}` });
    await settings.load();
    expect(settings.chatgptModels()).toEqual([]);
    // Not in any list yet: refused.
    expect(await settings.set({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-sol' })).toBe(false);
    const listed = [
      { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini' },
    ] as const;
    expect(await settings.setChatgptModels([...listed, { id: 'chatgpt/bad slug', label: 'x' } as never, { id: 'chatgpt/gpt-6.1-sol', label: 'Duplicate' }])).toBe(true);
    expect(settings.chatgptModels()).toEqual(listed);
    expect(await settings.set({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' })).toBe(true);
    expect(await settings.set({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-other' })).toBe(false);
    expect(settings.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' });
    // A restart (offline) keeps the choice and the list.
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini' });
    expect(again.chatgptModels()).toEqual(listed);
    // A new list without the chosen model moves the choice to its first; an empty one keeps it (not usable until listed again).
    const changes = vi.fn();
    again.onChange(changes);
    expect(await again.setChatgptModels([{ id: 'chatgpt/gpt-7', label: 'GPT-7' }])).toBe(true);
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-7' });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await again.setChatgptModels([])).toBe(true);
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-7' });
    expect(again.chatgptModels()).toEqual([]);
    // The list is bounded.
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `chatgpt/m-${i}` as const, label: `Model ${i}` }));
    expect(await again.setChatgptModels(many)).toBe(true);
    expect(again.chatgptModels()).toHaveLength(64);
    // A tampered list entry is dropped; a ChatGPT choice it no longer lists reads as the defaults.
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', chatgptModels: [{ id: 'chatgpt/gpt-7', label: 'a\u202eb' }] })), mode: 0o600 });
    const tampered = createAgentSettings({ file: FILE, fs: memory.fs });
    await tampered.load();
    expect(tampered.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID });
    expect(tampered.chatgptModels()).toEqual([]);
  });

  test('chatgpt-settings-model-list (the largest list the bounds allow is written and read back)', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    await settings.load();
    // `maxModels` entries, each with the longest slug and a label of `maxDisplayNameChars` characters
    // that each take 3 bytes in UTF-8 (and one in four escaped in JSON): the file must still be read.
    const slug = (i: number) => `m${String(i).padStart(2, '0')}${'x'.repeat(61)}`;
    const largest = Array.from({ length: CHATGPT_LIMITS.maxModels }, (_, i) => ({ id: `chatgpt/${slug(i)}` as const, label: `"${'€'.repeat(CHATGPT_LIMITS.maxDisplayNameChars - 2)}"` }));
    expect(largest.every((model) => isChatgptModelView(model))).toBe(true);
    expect(await settings.setChatgptModels(largest)).toBe(true);
    expect(await settings.set({ route: 'chatgpt', modelId: largest.at(-1)!.id })).toBe(true);
    expect(memory.files.get(FILE)!.data.byteLength).toBeGreaterThan(32 * 1024);
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: largest.at(-1)!.id });
    expect(again.chatgptModels()).toEqual(largest);
  });
});
