import { AGENT_PALETTE_NEW_CHAT_ID, AGENT_PALETTE_SETTINGS_ID, AGENT_PALETTE_TOGGLE_ID } from '@app/specs/agent-panel.spec';
import type { PaletteSource } from './palette/registry';

// The agent panel in the command palette (spec `agent-panel.spec.ts`; the registration API of
// `command-palette.spec.ts`): "Toggle AI agent", "AI agent settings" and "New AI agent chat". The
// panel owns its open state, so the actions only ask it (a request it listens for); registered
// from `components/agent/AgentPanel.tsx`. Pure, so the actions are unit tested.

export type AgentPanelRequest = { readonly kind: 'toggle' } | { readonly kind: 'settings' } | { readonly kind: 'new-chat' };

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

/** The palette's agent actions, sending `request`. */
export function agentPaletteSources(request: (r: AgentPanelRequest) => void = requestAgentPanel): PaletteSource[] {
  return [
    { id: AGENT_PALETTE_TOGGLE_ID, label: 'Toggle AI agent', group: 'browser', keywords: [...KEYWORDS, 'panel', 'sidebar'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'toggle' }) },
    { id: AGENT_PALETTE_SETTINGS_ID, label: 'AI agent settings', group: 'browser', keywords: [...KEYWORDS, 'key', 'api key', 'settings'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'settings' }) },
    { id: AGENT_PALETTE_NEW_CHAT_ID, label: 'New AI agent chat', group: 'browser', keywords: [...KEYWORDS, 'new'], icon: 'sidebar', focus: 'handler', run: () => request({ kind: 'new-chat' }) },
  ];
}
