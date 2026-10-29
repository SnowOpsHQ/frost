// Spec: specs/agent-panel.spec.ts (AGENT_PALETTE_*_ID), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/agent-panel.feature.md (agent-palette-actions), specs/skills.feature.md (skill-palette-actions)
import { describe, expect, test, vi } from 'vitest';
import { AGENT_PALETTE_NEW_CHAT_ID, AGENT_PALETTE_SETTINGS_ID, AGENT_PALETTE_SKILL_ID_PREFIX, AGENT_PALETTE_TOGGLE_ID } from '@app/specs/agent-panel.spec';
import { agentPaletteSources, onAgentPanelRequest, requestAgentPanel, setPaletteSkills, type AgentPanelRequest, type PaletteSkills } from '../agent-palette';
import { SKILLS } from './agent-fixtures';
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

  test('skill-palette-actions', async () => {
    const request = vi.fn((_r: AgentPanelRequest) => undefined);
    let current: PaletteSkills = { skills: SKILLS, running: false };
    const registry = createPaletteRegistry();
    registry.register(...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi));
    const unregister = registry.register(...agentPaletteSources(request, () => current));
    const skillActions = () => registry.resolve(ctx).filter((a) => a.id.startsWith(AGENT_PALETTE_SKILL_ID_PREFIX));
    // The user's own skills are marked "Your skill".
    expect(skillActions().map((a) => [a.id, a.label])).toEqual(SKILLS.map((skill) => [`agent.skill.${skill.id}`, skill.builtin ? `Run skill: ${skill.name}` : `Run skill: ${skill.name} (Your skill)`]));
    expect(skillActions()[0]!.detail?.(ctx)).toBe(SKILLS[0]!.description);
    await skillActions()[1]!.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'run-skill', skillId: 'rewrite-title-meta' });
    // Not offered while a turn runs; gone when main lists none.
    current = { skills: SKILLS, running: true };
    expect(skillActions()).toEqual([]);
    current = { skills: [], running: false };
    expect(skillActions()).toEqual([]);
    unregister();
    // The default source reads what the panel last told it.
    const panelRegistry = createPaletteRegistry();
    panelRegistry.register(...agentPaletteSources(request));
    setPaletteSkills({ skills: SKILLS.slice(0, 1), running: false });
    expect(panelRegistry.resolve(ctx).map((a) => a.id)).toContain('agent.skill.audit-this-page');
    setPaletteSkills({ skills: [], running: false });
    expect(panelRegistry.resolve(ctx).map((a) => a.id)).not.toContain('agent.skill.audit-this-page');
  });
});
