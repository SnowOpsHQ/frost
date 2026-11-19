// @vitest-environment jsdom
// Spec: specs/agent-panel.spec.ts (AGENT_PANEL_STORAGE_KEY), specs/agent-session.spec.ts (AgentState.approval,
// APPROVAL_ENABLE_DELAY_MS)
// Acceptance: specs/agent-panel.feature.md (agent-panel-swapped-approval-starts-disarmed,
// agent-panel-approval-opens-without-changing-the-preference, agent-panel-palette-requests-move-focus,
// agent-toggle-badge-and-focus)
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AGENT_PANEL_STORAGE_KEY } from '@app/specs/agent-panel.spec';
import { APPROVAL_ENABLE_DELAY_MS, type AgentState } from '@app/specs/agent-session.spec';
import { SKILLS, approval, state as makeState } from './agent-fixtures';

// The panel's state comes from a stand-in for `useAgentState` that the test sets.
const current = vi.hoisted(() => ({ state: null as AgentState | null }));
vi.mock('../hooks/useAgentState', () => ({ useAgentState: () => current.state }));
vi.mock('../agent-actions', () => ({
  agentActions: new Proxy({}, { get: () => vi.fn(async () => true) }),
}));
vi.mock('../ipc', () => ({ ipc: {} }));
const { AgentPanel } = await import('../components/agent/AgentPanel');
const { AgentToggle } = await import('../components/agent/AgentToggle');
const { useAgentPanel } = await import('../components/agent/useAgentPanel');
const { requestAgentPanel } = await import('../agent-palette');

/** What `App.tsx` does: one `useAgentPanel` for the chrome row's toggle and the panel. */
function Harness() {
  const agent = useAgentPanel();
  return createElement(Fragment, null, createElement(AgentToggle, { agent }), createElement(AgentPanel, { tab: undefined, agent }));
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const show = (state: AgentState | null) => {
  current.state = state;
  act(() => root.render(createElement(Harness)));
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allowOnce = () => byTestId('agent-allow-once') as HTMLButtonElement;
/** Open: the panel is rendered and the row's toggle pressed. Collapsed: neither (the panel renders nothing). */
const isOpen = () => {
  const open = byTestId('agent-panel') !== null;
  expect(byTestId('agent-toggle')!.getAttribute('aria-pressed')).toBe(String(open));
  return open;
};
const click = (id: string) => act(() => byTestId(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

test('agent-panel-swapped-approval-starts-disarmed', () => {
  window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, '1');
  show(makeState({ running: true, approval: { request: approval({ id: 'first' }), queued: 1 } }));
  act(() => vi.advanceTimersByTime(APPROVAL_ENABLE_DELAY_MS));
  expect(allowOnce().disabled).toBe(false);
  // The first is answered and the next takes its place: a new card, disarmed for a whole delay.
  show(makeState({ running: true, approval: { request: approval({ id: 'second', input: '{"url":"https://other.example.com/"}', origin: 'https://other.example.com' }), queued: 0 } }));
  expect(byTestId('agent-approval')!.dataset['approvalId']).toBe('second');
  expect(allowOnce().disabled).toBe(true);
  act(() => vi.advanceTimersByTime(APPROVAL_ENABLE_DELAY_MS - 1));
  expect(allowOnce().disabled).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(allowOnce().disabled).toBe(false);
});

test('agent-panel-approval-opens-without-changing-the-preference', () => {
  window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, '0');
  show(makeState());
  // Collapsed, the panel renders nothing in the row.
  expect(isOpen()).toBe(false);
  expect(host.querySelector('aside')).toBeNull();
  // A new approval opens the closed panel, showing the card; the toggle's badge goes with it.
  show(makeState({ running: true, approval: { request: approval(), queued: 0 } }));
  expect(isOpen()).toBe(true);
  expect(byTestId('agent-approval')).not.toBeNull();
  expect(byTestId('agent-toggle-badge')).toBeNull();
  // The remembered choice is still "closed".
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('0');
  // Collapsing it is the user's choice again: closed, and remembered so.
  click('agent-collapse');
  expect(isOpen()).toBe(false);
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('0');
  // Opening it from the row's toggle is remembered, and so is collapsing it there.
  click('agent-toggle');
  expect(isOpen()).toBe(true);
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('1');
  click('agent-toggle');
  expect(isOpen()).toBe(false);
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('0');
});

test('agent-panel-palette-requests-move-focus', () => {
  // The palette closes without restoring focus for these (`focus: 'handler'`): the panel must take it.
  const ask = (request: Parameters<typeof requestAgentPanel>[0]) => {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    act(() => requestAgentPanel(request));
  };
  window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, '0');
  show(makeState({ skills: [...SKILLS] }));
  // From collapsed: settings focuses the head's settings button, a skill run the composer.
  ask({ kind: 'settings' });
  expect(byTestId('agent-panel')!.dataset['view']).toBe('settings');
  expect(document.activeElement).toBe(byTestId('agent-settings-toggle'));
  // Already on settings: still moved there.
  ask({ kind: 'settings' });
  expect(document.activeElement).toBe(byTestId('agent-settings-toggle'));
  ask({ kind: 'run-skill', skillId: 'audit-this-page' });
  expect(byTestId('agent-panel')!.dataset['view']).toBe('chat');
  expect(document.activeElement).toBe(byTestId('agent-input'));
  // Already open on the chat: a skill run and a new chat still focus the composer.
  ask({ kind: 'run-skill', skillId: 'audit-this-page' });
  expect(document.activeElement).toBe(byTestId('agent-input'));
  ask({ kind: 'new-chat' });
  expect(document.activeElement).toBe(byTestId('agent-input'));
  // Collapsed, a skill run opens the panel on the composer.
  ask({ kind: 'toggle' });
  expect(isOpen()).toBe(false);
  ask({ kind: 'run-skill', skillId: 'audit-this-page' });
  expect(document.activeElement).toBe(byTestId('agent-input'));
  // A skill picked in the composer swaps the message field out: its picker takes focus instead.
  const picker = byTestId('agent-skill-picker') as HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(picker, 'rewrite-title-meta');
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(byTestId('agent-input')).toBeNull();
  ask({ kind: 'run-skill', skillId: 'audit-this-page' });
  expect(document.activeElement).toBe(byTestId('agent-skill-picker'));
  // The run disables the picker, which drops its focus (jsdom keeps it, so it is dropped here); back
  // from the turn, the picker takes focus again.
  (document.activeElement as HTMLElement | null)?.blur();
  show(makeState({ skills: [...SKILLS], running: true }));
  expect((byTestId('agent-skill-picker') as HTMLSelectElement).disabled).toBe(true);
  expect(document.activeElement).toBe(document.body);
  show(makeState({ skills: [...SKILLS] }));
  expect(document.activeElement).toBe(byTestId('agent-skill-picker'));
  ask({ kind: 'new-chat' });
  expect(document.activeElement).toBe(byTestId('agent-skill-picker'));
});

test('agent-toggle-badge-and-focus', () => {
  window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, '0');
  show(makeState());
  const toggle = () => byTestId('agent-toggle') as HTMLButtonElement;
  const badge = () => byTestId('agent-toggle-badge')?.dataset['badge'] ?? null;
  // The row's toggle: named, its title saying what a click does, no badge while nothing runs.
  expect(toggle().getAttribute('aria-label')).toBe('AI agent');
  expect(toggle().title).toBe('Open the AI agent');
  expect(badge()).toBeNull();
  // Collapsed, it carries the badge: a turn running, then an approval waiting over it (which opens the panel).
  show(makeState({ running: true }));
  expect(isOpen()).toBe(false);
  expect(badge()).toBe('running');
  expect(byTestId('agent-toggle-badge')!.getAttribute('aria-hidden')).toBe('true');
  // Open, no badge (the turn shows in the panel).
  click('agent-toggle');
  expect(isOpen()).toBe(true);
  expect(badge()).toBeNull();
  click('agent-collapse');
  // The turn over (the composer can take focus again): opening from the toggle focuses the composer,
  // and the title says collapse.
  show(makeState());
  expect(badge()).toBeNull();
  toggle().focus();
  click('agent-toggle');
  expect(isOpen()).toBe(true);
  expect(document.activeElement).toBe(byTestId('agent-input'));
  expect(toggle().title).toBe('Collapse the AI agent');
  // Collapsing from the header's Collapse moves focus to the row's toggle.
  byTestId('agent-collapse')!.focus();
  click('agent-collapse');
  expect(isOpen()).toBe(false);
  expect(document.activeElement).toBe(toggle());
  // From the toggle itself, open then collapse: focus ends on the toggle.
  click('agent-toggle');
  expect(document.activeElement).toBe(byTestId('agent-input'));
  click('agent-toggle');
  expect(isOpen()).toBe(false);
  expect(document.activeElement).toBe(toggle());
  // The panel keeps its view while collapsed: reopened on Agent settings, focus still goes to the composer.
  click('agent-toggle');
  click('agent-settings-toggle');
  click('agent-toggle');
  click('agent-toggle');
  expect(isOpen()).toBe(true);
  expect(document.activeElement).toBe(byTestId('agent-input'));
  click('agent-settings-toggle');
  click('agent-toggle');
  expect(document.activeElement).toBe(toggle());
  // The palette's toggle: open on the composer, collapsed on the row's toggle.
  (document.activeElement as HTMLElement | null)?.blur();
  act(() => requestAgentPanel({ kind: 'toggle' }));
  expect(document.activeElement).toBe(byTestId('agent-input'));
  act(() => requestAgentPanel({ kind: 'toggle' }));
  expect(isOpen()).toBe(false);
  expect(document.activeElement).toBe(toggle());
  // An approval opens it without moving focus, and the badge (an approval, most urgent) shows once collapsed again.
  show(makeState({ running: true, approval: { request: approval({ id: 'a1' }), queued: 0 } }));
  expect(isOpen()).toBe(true);
  expect(document.activeElement).toBe(toggle());
  click('agent-collapse');
  expect(badge()).toBe('approval');
});
