// Spec: specs/agent-proxy.spec.ts (DEFAULT_AGENT_MODEL_SETTINGS, isValidModelSettings) · specs/agent-tools.spec.ts (DEFAULT_MODEL_ID)
// Acceptance: specs/agent-host.feature.md (Settings)
import { describe, expect, test, vi } from 'vitest';
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
    expect(memory.ops.filter((op) => !op.startsWith('read'))).toEqual([`write ${FILE}.tmp1.tmp 600 wx flush`, `rename ${FILE}.tmp1.tmp ${FILE}`]);
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
});
