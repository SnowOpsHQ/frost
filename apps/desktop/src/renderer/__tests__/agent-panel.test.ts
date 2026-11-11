// @vitest-environment jsdom
// Spec: specs/agent-panel.spec.ts (AGENT_PANEL_STORAGE_KEY), specs/agent-session.spec.ts (AgentState.approval,
// APPROVAL_ENABLE_DELAY_MS)
// Acceptance: specs/agent-panel.feature.md (agent-panel-swapped-approval-starts-disarmed,
// agent-panel-approval-opens-without-changing-the-preference, agent-panel-palette-requests-move-focus)
import { act, createElement } from 'react';
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
const { requestAgentPanel } = await import('../agent-palette');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const show = (state: AgentState | null) => {
  current.state = state;
  act(() => root.render(createElement(AgentPanel, { tab: undefined })));
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allowOnce = () => byTestId('agent-allow-once') as HTMLButtonElement;

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
  expect(byTestId('agent-panel')!.dataset['open']).toBe('false');
  // A new approval opens the closed panel, showing the card.
  show(makeState({ running: true, approval: { request: approval(), queued: 0 } }));
  expect(byTestId('agent-panel')!.dataset['open']).toBe('true');
  expect(byTestId('agent-approval')).not.toBeNull();
  // The remembered choice is still "closed".
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('0');
  // Collapsing it is the user's choice again: closed, and remembered so.
  act(() => byTestId('agent-collapse')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(byTestId('agent-panel')!.dataset['open']).toBe('false');
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('0');
  // Opening it from the rail is remembered.
  act(() => byTestId('agent-toggle')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(byTestId('agent-panel')!.dataset['open']).toBe('true');
  expect(window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY)).toBe('1');
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
  // From the rail: settings focuses the head's settings button, a skill run the composer.
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
  expect(byTestId('agent-panel')!.dataset['open']).toBe('false');
  ask({ kind: 'run-skill', skillId: 'audit-this-page' });
  expect(document.activeElement).toBe(byTestId('agent-input'));
});
