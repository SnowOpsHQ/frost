// Spec: specs/agent-proxy.spec.ts (DEFAULT_AGENT_MODEL_SETTINGS, isValidModelSettings, isUsableModelSettings,
// AgentModelSettings.reasoningEffort) · specs/agent-tools.spec.ts (DEFAULT_MODEL_ID, GATEWAY_ONLY_PROVIDERS)
// · specs/agent-chatgpt.spec.ts (isChatgptModelView, CHATGPT_LIMITS.maxModels, CHATGPT_ADVERTISED_EFFORTS,
// CHATGPT_EFFORTS_ENTRY_MAX_BYTES) · specs/agent-reasoning.spec.ts (REASONING_EFFORTS, effectiveEffort)
// Acceptance: specs/agent-host.feature.md (Settings) · specs/agent-chatgpt.feature.md (chatgpt-settings-model-list)
// · plan docs/plans/phase-8-ai-complete.md, Task 8a
import { describe, expect, test, vi } from 'vitest';
import { CHATGPT_ADVERTISED_EFFORTS, CHATGPT_LIMITS, isChatgptModelView, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { DEFAULT_AGENT_MODEL_SETTINGS } from '@app/specs/agent-proxy.spec';
import { effectiveEffort, REASONING_EFFORTS } from '@app/specs/agent-reasoning.spec';
import { ALLOWED_MODEL_IDS, byProvider, DEFAULT_MODEL_ID, GATEWAY_ONLY_PROVIDERS } from '@app/specs/agent-tools.spec';
import { createAgentSettings, MAX_SETTINGS_FILE_BYTES } from '../settings';
import { createMemoryFs } from './fakes';

const FILE = '/user-data/agent-settings.json';

describe('agent settings', () => {
  test('settings-defaults', async () => {
    const { fs } = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs });
    expect(settings.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'auto' });
    await settings.load();
    expect(settings.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'auto' });
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
    // Gemini and Grok are the gateway's only (Phase 8 Task 7): never stored with a key route.
    for (const provider of GATEWAY_ONLY_PROVIDERS) {
      for (const modelId of ALLOWED_MODEL_IDS.filter(byProvider(provider))) {
        for (const route of ['byok-anthropic', 'byok-openai'] as const) expect(await settings.set({ route, modelId }), `${route} ${modelId}`).toBe(false);
      }
    }
    expect(memory.files.size).toBe(0);
    expect(await settings.set({ route: 'byok-openai', modelId: 'openai/gpt-5-mini' })).toBe(true);
    expect(settings.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5-mini', reasoningEffort: 'auto' });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(memory.files.get(FILE)!.mode).toBe(0o600);
    expect(memory.ops.filter((op) => !op.startsWith('read'))).toEqual([`write ${FILE}.tmp1.tmp 600 wx flush`, `rename ${FILE}.tmp1.tmp ${FILE}`, 'sync /user-data']);
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5-mini', reasoningEffort: 'auto' });
  });

  test('settings-tampered', async () => {
    for (const content of ['{', '{"route":"byok-anthropic","modelId":"openai/gpt-5"}', '{"route":"elsewhere","modelId":"anthropic/claude-opus-5-5"}', '[1]', `{"route":"gateway","modelId":"${'x'.repeat(5000)}"}`]) {
      const memory = createMemoryFs();
      memory.files.set(FILE, { data: new TextEncoder().encode(content), mode: 0o600 });
      const log = vi.fn();
      const settings = createAgentSettings({ file: FILE, fs: memory.fs, log });
      await settings.load();
      expect(settings.current(), content.slice(0, 40)).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'auto' });
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
    expect(settings.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini', reasoningEffort: 'auto' });
    // A restart (offline) keeps the choice and the list.
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-6.1-mini', reasoningEffort: 'auto' });
    expect(again.chatgptModels()).toEqual(listed);
    // A new list without the chosen model moves the choice to its first; an empty one keeps it (not usable until listed again).
    const changes = vi.fn();
    again.onChange(changes);
    expect(await again.setChatgptModels([{ id: 'chatgpt/gpt-7', label: 'GPT-7' }])).toBe(true);
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', reasoningEffort: 'auto' });
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await again.setChatgptModels([])).toBe(true);
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', reasoningEffort: 'auto' });
    expect(again.chatgptModels()).toEqual([]);
    // The list is bounded.
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `chatgpt/m-${i}` as const, label: `Model ${i}` }));
    expect(await again.setChatgptModels(many)).toBe(true);
    expect(again.chatgptModels()).toHaveLength(64);
    // A tampered list entry is dropped; a ChatGPT choice it no longer lists reads as the defaults.
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', chatgptModels: [{ id: 'chatgpt/gpt-7', label: 'a\u202eb' }] })), mode: 0o600 });
    const tampered = createAgentSettings({ file: FILE, fs: memory.fs });
    await tampered.load();
    expect(tampered.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'auto' });
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
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: largest.at(-1)!.id, reasoningEffort: 'auto' });
    expect(again.chatgptModels()).toEqual(largest);
  });

  test('settings-reasoning-default-auto-and-persisted', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    expect(DEFAULT_AGENT_MODEL_SETTINGS.reasoningEffort).toBe('auto');
    await settings.load();
    expect(settings.current().reasoningEffort).toBe('auto');
    for (const effort of REASONING_EFFORTS) {
      expect(await settings.set({ reasoningEffort: effort }), effort).toBe(true);
      expect(settings.current()).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: effort });
      expect(JSON.parse(new TextDecoder().decode(memory.files.get(FILE)!.data))).toMatchObject({ reasoningEffort: effort });
      // A restart keeps the level.
      const again = createAgentSettings({ file: FILE, fs: memory.fs });
      await again.load();
      expect(again.current(), effort).toEqual({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: effort });
    }
    // Stored as chosen even where the model lacks it (it then acts as `auto`), and kept across a model change.
    expect(await settings.set({ reasoningEffort: 'off' })).toBe(true);
    expect(effectiveEffort(settings.current(), settings.chatgptModels())).toBe('auto');
    expect(await settings.set({ route: 'byok-openai', modelId: 'openai/gpt-5' })).toBe(true);
    expect(settings.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5', reasoningEffort: 'off' });
    expect(effectiveEffort(settings.current(), settings.chatgptModels())).toBe('off');
    // Not a level: refused, nothing changed.
    for (const bad of ['max', 'AUTO', '', 1, null]) expect(await settings.set({ reasoningEffort: bad as 'high' }), String(bad)).toBe(false);
    expect(settings.current().reasoningEffort).toBe('off');
  });

  test('settings-old-file-without-reasoning-reads-auto', async () => {
    const memory = createMemoryFs();
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ route: 'byok-openai', modelId: 'openai/gpt-5' })), mode: 0o600 });
    const log = vi.fn();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs, log });
    await settings.load();
    expect(settings.current()).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5', reasoningEffort: 'auto' });
    expect(log).not.toHaveBeenCalled();
  });

  test('settings-tampered-reasoning-reads-auto', async () => {
    for (const reasoningEffort of ['max', 'AUTO', '', 3, null, true, {}, ['high'], { effort: 'high' }]) {
      const memory = createMemoryFs();
      memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ route: 'byok-openai', modelId: 'openai/gpt-5', reasoningEffort })), mode: 0o600 });
      const log = vi.fn();
      const settings = createAgentSettings({ file: FILE, fs: memory.fs, log });
      await settings.load();
      // The route and model are kept; the level reads as `auto`.
      expect(settings.current(), JSON.stringify(reasoningEffort)).toEqual({ route: 'byok-openai', modelId: 'openai/gpt-5', reasoningEffort: 'auto' });
      expect(log).toHaveBeenCalledWith('agent settings: the stored reasoning level is not valid; using auto');
    }
  });

  test('settings-reasoning-change-notifies', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    await settings.load();
    const changes = vi.fn();
    settings.onChange(changes);
    expect(await settings.set({ reasoningEffort: 'high' })).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'high' }, { route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'auto' });
    // The same level again changes nothing.
    expect(await settings.set({ reasoningEffort: 'high' })).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(await settings.set({ reasoningEffort: 'low' })).toBe(true);
    expect(changes).toHaveBeenLastCalledWith({ route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'low' }, { route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'high' });
    // A model change carries the level on both sides.
    expect(await settings.set({ modelId: 'anthropic/claude-opus-5-5' })).toBe(true);
    expect(changes).toHaveBeenLastCalledWith({ route: 'gateway', modelId: 'anthropic/claude-opus-5-5', reasoningEffort: 'low' }, { route: 'gateway', modelId: DEFAULT_MODEL_ID, reasoningEffort: 'low' });
    expect(changes).toHaveBeenCalledTimes(3);
  });

  test('settings-chatgpt-models-keep-efforts', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    await settings.load();
    const listed: readonly ChatgptModelView[] = [
      { id: 'chatgpt/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'] },
      { id: 'chatgpt/gpt-6.1-mini', label: 'GPT-6.1 mini' },
    ];
    expect(await settings.setChatgptModels([...listed, { id: 'chatgpt/bad', label: 'Bad', efforts: ['auto', 'high'] } as never])).toBe(true);
    expect(settings.chatgptModels()).toEqual(listed);
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.chatgptModels()).toEqual(listed);
    // A file of the previous build (`{ id, label }` entries, no level) still reads.
    memory.files.set(FILE, { data: new TextEncoder().encode(JSON.stringify({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', chatgptModels: [{ id: 'chatgpt/gpt-7', label: 'GPT-7' }] })), mode: 0o600 });
    const previousBuild = createAgentSettings({ file: FILE, fs: memory.fs });
    await previousBuild.load();
    expect(previousBuild.current()).toEqual({ route: 'chatgpt', modelId: 'chatgpt/gpt-7', reasoningEffort: 'auto' });
    expect(previousBuild.chatgptModels()).toEqual([{ id: 'chatgpt/gpt-7', label: 'GPT-7' }]);
  });

  test('settings-largest-model-list-with-efforts-fits', async () => {
    const memory = createMemoryFs();
    const settings = createAgentSettings({ file: FILE, fs: memory.fs });
    await settings.load();
    // `maxModels` entries, each with the longest slug, a label of `maxDisplayNameChars` 3-byte
    // characters (two of them escaped quotes) and all four levels; the longest level stored.
    const slug = (i: number) => `m${String(i).padStart(2, '0')}${'x'.repeat(61)}`;
    const largest = Array.from({ length: CHATGPT_LIMITS.maxModels }, (_, i) => ({
      id: `chatgpt/${slug(i)}` as const,
      label: `"${'€'.repeat(CHATGPT_LIMITS.maxDisplayNameChars - 2)}"`,
      efforts: [...CHATGPT_ADVERTISED_EFFORTS],
    }));
    expect(largest.every((model) => isChatgptModelView(model))).toBe(true);
    expect(await settings.setChatgptModels(largest)).toBe(true);
    const longest = [...REASONING_EFFORTS].sort((a, b) => b.length - a.length)[0]!;
    expect(await settings.set({ route: 'chatgpt', modelId: largest.at(-1)!.id, reasoningEffort: longest })).toBe(true);
    const written = memory.files.get(FILE)!.data.byteLength;
    expect(written).toBeGreaterThan(32 * 1024);
    expect(written).toBeLessThanOrEqual(MAX_SETTINGS_FILE_BYTES);
    const again = createAgentSettings({ file: FILE, fs: memory.fs });
    await again.load();
    expect(again.current()).toEqual({ route: 'chatgpt', modelId: largest.at(-1)!.id, reasoningEffort: longest });
    expect(again.chatgptModels()).toEqual(largest);
  });
});
