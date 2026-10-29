import { AGENT_PALETTE_NEW_CHAT_ID, AGENT_PALETTE_SETTINGS_ID, AGENT_PALETTE_SKILL_ID_PREFIX, AGENT_PALETTE_TOGGLE_ID } from '@app/specs/agent-panel.spec';
import type { AgentSkillView } from '@app/specs/agent-session.spec';
import { SKILL_USER_MARK } from '@app/specs/skills.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// The agent panel in the command palette (spec `agent-panel.spec.ts`; the registration API of
// `command-palette.spec.ts`): "Toggle AI agent", "AI agent settings" and "New AI agent chat", and
// "Run skill: {name}" for each skill main lists (Task 7; a dynamic source over what the panel last
// saw, offered while no turn runs). The panel owns its open state, so the actions only ask it (a
// request it listens for); registered from `components/agent/AgentPanel.tsx`. Pure, so the actions
// are unit tested.

export type AgentPanelRequest =
  | { readonly kind: 'toggle' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'new-chat' }
  | { readonly kind: 'run-skill'; readonly skillId: string };

const listeners = new Set<(request: AgentPanelRequest) => void>();

/** Asks the panel (every mounted one) to toggle, open its settings, or start a new chat. */
export function requestAgentPanel(request: AgentPanelRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Calls `listener` on each request; answers a function that stops. */
export function onAgentPanelRequest(listener: (request: AgentPanelRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const KEYWORDS = ['ai', 'agent', 'assistant', 'chat', 'model'];

/** What the skill actions offer: the skills in the panel's last state, and whether a turn runs. */
export interface PaletteSkills {
  readonly skills: readonly Pick<AgentSkillView, 'id' | 'name' | 'description' | 'builtin'>[];
  readonly running: boolean;
}

let paletteSkills: PaletteSkills = { skills: [], running: false };

/** The panel tells the palette which skills main lists now (each state it renders). */
export function setPaletteSkills(next: PaletteSkills): void {
  paletteSkills = { skills: [...next.skills], running: next.running };
}

/** "Run skill: {name}" per skill, not offered while a turn runs; each asks the panel to run it. */
export function skillPaletteActions(current: PaletteSkills, request: (r: AgentPanelRequest) => void = requestAgentPanel): PaletteAction[] {
  return current.skills.map((skill) => ({
    id: `${AGENT_PALETTE_SKILL_ID_PREFIX}${skill.id}`,
    // The user's own skills are marked, so one can't pass for a built-in.
    label: skill.builtin ? `Run skill: ${skill.name}` : `Run skill: ${skill.name} (${SKILL_USER_MARK})`,
    group: 'browser',
    keywords: [...KEYWORDS, 'skill', 'seo'],
    icon: 'sidebar',
    focus: 'handler',
    detail: () => skill.description,
    available: () => !current.running,
    run: () => request({ kind: 'run-skill', skillId: skill.id }),
  }));
}

/** The palette's agent actions, sending `request`; the skills come from `skills` (default: what the panel last saw). */
export function agentPaletteSources(request: (r: AgentPanelRequest) => void = requestAgentPanel, skills: () => PaletteSkills = () => paletteSkills): PaletteSource[] {
  return [
    { id: AGENT_PALETTE_TOGGLE_ID, label: 'Toggle AI agent', group: 'browser', keywords: [...KEYWORDS, 'panel', 'sidebar'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'toggle' }) },
    { id: AGENT_PALETTE_SETTINGS_ID, label: 'AI agent settings', group: 'browser', keywords: [...KEYWORDS, 'key', 'api key', 'settings'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'settings' }) },
    { id: AGENT_PALETTE_NEW_CHAT_ID, label: 'New AI agent chat', group: 'browser', keywords: [...KEYWORDS, 'new'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'new-chat' }) },
    () => skillPaletteActions(skills(), request),
  ];
}
