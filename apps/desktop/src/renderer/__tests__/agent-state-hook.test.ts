// @vitest-environment jsdom
// Spec: specs/agent-session.spec.ts (AgentState, AGENT_WATCH_TIMEOUT_MS)
// Acceptance: specs/agent-panel.feature.md (agent-watch-hook-backs-off-and-stops)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentState } from '@app/specs/agent-session.spec';
import { state as makeState } from './agent-fixtures';

vi.mock('../ipc', () => ({ ipc: {} }));
const { AGENT_WATCH_RETRY_MS, agentWatchRetryMs, useAgentState } = await import('../hooks/useAgentState');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let seen: AgentState | null = null;
function Probe({ watch }: { watch: (since: number) => Promise<AgentState> }) {
  seen = useAgentState(watch);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = null;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  vi.useRealTimers();
});

test('agent-watch-retry-backs-off', () => {
  expect(agentWatchRetryMs(1)).toBe(AGENT_WATCH_RETRY_MS.first);
  expect(agentWatchRetryMs(2)).toBe(AGENT_WATCH_RETRY_MS.first * 2);
  expect(agentWatchRetryMs(3)).toBe(AGENT_WATCH_RETRY_MS.first * 4);
  expect(agentWatchRetryMs(50)).toBe(AGENT_WATCH_RETRY_MS.max);
});

test('agent-watch-hook-backs-off-and-stops', async () => {
  const sinces: number[] = [];
  let failures = 2;
  let pending: ((s: AgentState) => void) | null = null;
  const watch = vi.fn((since: number) => {
    sinces.push(since);
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(new Error('ipc down'));
    }
    if (since === 0) return Promise.resolve(makeState({ version: 7 }));
    return new Promise<AgentState>((resolve) => (pending = resolve));
  });
  act(() => root.render(createElement(Probe, { watch })));
  await act(async () => undefined);
  expect(watch).toHaveBeenCalledTimes(1);
  // First retry after `first`, the second after twice that.
  await act(async () => vi.advanceTimersByTime(AGENT_WATCH_RETRY_MS.first));
  expect(watch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTime(AGENT_WATCH_RETRY_MS.first));
  expect(watch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTime(AGENT_WATCH_RETRY_MS.first));
  // Third call succeeds, then the next poll asks since that version.
  await act(async () => undefined);
  expect(seen?.version).toBe(7);
  expect(sinces).toEqual([0, 0, 0, 7]);
  // Unmounted: an answer still in flight is dropped and no poll follows.
  act(() => root.unmount());
  await act(async () => pending?.(makeState({ version: 9 })));
  await act(async () => vi.advanceTimersByTime(AGENT_WATCH_RETRY_MS.max * 2));
  expect(seen?.version).toBe(7);
  expect(watch).toHaveBeenCalledTimes(4);
});
