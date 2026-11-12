// @vitest-environment jsdom
// Spec: specs/seo-compliance.spec.ts (A11Y_RUN_MESSAGES, A11Y_TIMEOUT_MS, IDLE_A11Y_RUN)
// Acceptance: specs/seo-compliance.feature.md (Panel: progress against the time cap; Renderer helpers, a11y-progress-announced-once)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { A11Y_RUN_MESSAGES, A11Y_TIMEOUT_MS, IDLE_A11Y_RUN, type AccessibilityRunState } from '@app/specs/seo-compliance.spec';

vi.mock('../ipc', () => ({ actions: {} }));

const { AccessibilityCard } = await import('../components/seo/Compliance');

const STARTED_AT = Date.UTC(2026, 10, 11, 12, 0, 0);
const TAB = { id: 1 } as TabState;
const RUNNING: AccessibilityRunState = { status: 'running', startedAt: STARTED_AT, finishedAt: null, reason: null };

let host: HTMLDivElement;
let root: Root;
const progress = () => host.querySelector('[data-testid="seo-a11y-progress"]');
const live = () => [...host.querySelectorAll('[role="status"], [aria-live]')];
const card = (run: AccessibilityRunState) => createElement(AccessibilityCard, { tab: TAB, run, report: { status: 'not-run' }, flash: () => undefined });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(STARTED_AT);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('the accessibility run progress', () => {
  test('a11y-progress-announced-once', async () => {
    // Before any run the card already holds its live region, empty: screen readers often skip a
    // region that is inserted with its text in it.
    act(() => root.render(card(IDLE_A11Y_RUN)));
    expect(live()).toHaveLength(1);
    const region = live()[0];
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('');
    // The run starts: the same region gets the stable running message, once.
    act(() => root.render(card(RUNNING)));
    const cap = `of at most ${A11Y_TIMEOUT_MS / 1_000} s`;
    expect(progress()?.textContent).toBe(`${A11Y_RUN_MESSAGES.running} 0 s ${cap}`);
    expect(live()).toEqual([region]);
    expect(region?.textContent).toBe(A11Y_RUN_MESSAGES.running);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    // The seconds still tick on screen, outside the live region, which has not changed.
    expect(progress()?.textContent).toBe(`${A11Y_RUN_MESSAGES.running} 3 s ${cap}`);
    expect(live()).toEqual([region]);
    expect(region?.textContent).toBe(A11Y_RUN_MESSAGES.running);
  });
});
