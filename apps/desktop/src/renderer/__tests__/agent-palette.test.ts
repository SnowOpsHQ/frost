// Spec: specs/agent-panel.spec.ts (AGENT_PALETTE_*_ID), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/agent-panel.feature.md (agent-palette-actions)
import { describe, expect, test, vi } from 'vitest';
import { AGENT_PALETTE_NEW_CHAT_ID, AGENT_PALETTE_SETTINGS_ID, AGENT_PALETTE_TOGGLE_ID } from '@app/specs/agent-panel.spec';
import { agentPaletteSources, onAgentPanelRequest, requestAgentPanel, type AgentPanelRequest } from '../agent-palette';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

const ctx: PaletteContext = { state: null, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };

describe('agent palette actions', () => {
  test('agent-palette-actions', async () => {
    const request = vi.fn((_r: AgentPanelRequest) => undefined);
    const registry = createPaletteRegistry();
    // Registers beside the built-ins without a duplicate id.
    registry.register(...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi));
    expect(() => registry.register(...agentPaletteSources(request))).not.toThrow();
    const actions = registry.resolve(ctx).filter((a) => a.id.startsWith('agent.'));
    expect(actions.map((a) => a.id)).toEqual([AGENT_PALETTE_TOGGLE_ID, AGENT_PALETTE_SETTINGS_ID, AGENT_PALETTE_NEW_CHAT_ID]);
    expect(actions[0]).toMatchObject({ label: 'Toggle AI agent', group: 'browser', focus: 'handler' });
    await actions[0]!.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'toggle' });
    await actions[1]!.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'settings' });
    await actions[2]!.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'new-chat' });
    // The default sends to every listening panel.
    const heard = vi.fn();
    const stop = onAgentPanelRequest(heard);
    requestAgentPanel({ kind: 'toggle' });
    expect(heard).toHaveBeenCalledExactlyOnceWith({ kind: 'toggle' });
    stop();
    requestAgentPanel({ kind: 'toggle' });
    expect(heard).toHaveBeenCalledOnce();
  });
});
