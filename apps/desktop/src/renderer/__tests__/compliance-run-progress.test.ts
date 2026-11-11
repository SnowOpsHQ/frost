// @vitest-environment jsdom
// Spec: specs/seo-compliance.spec.ts (A11Y_RUN_MESSAGES, A11Y_TIMEOUT_MS)
// Acceptance: specs/seo-compliance.feature.md (Panel: progress against the time cap; Renderer helpers, a11y-progress-announced-once)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { A11Y_RUN_MESSAGES, A11Y_TIMEOUT_MS } from '@app/specs/seo-compliance.spec';

vi.mock('../ipc', () => ({ actions: {} }));

const { RunProgress } = await import('../components/seo/Compliance');

const STARTED_AT = Date.UTC(2026, 10, 11, 12, 0, 0);

let host: HTMLDivElement;
let root: Root;
const progress = () => host.querySelector('[data-testid="seo-a11y-progress"]');
const live = () => [...host.querySelectorAll('[role="status"], [aria-live]')];

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
    act(() => root.render(createElement(RunProgress, { startedAt: STARTED_AT })));
    const cap = `of at most ${A11Y_TIMEOUT_MS / 1_000} s`;
    expect(progress()?.textContent).toBe(`${A11Y_RUN_MESSAGES.running} 0 s ${cap}`);
    // One live region, holding only the stable running message: it is announced once.
    expect(live()).toHaveLength(1);
    expect(live()[0]?.textContent).toBe(A11Y_RUN_MESSAGES.running);
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    // The seconds still tick on screen, outside the live region, which has not changed.
    expect(progress()?.textContent).toBe(`${A11Y_RUN_MESSAGES.running} 3 s ${cap}`);
    expect(live()).toHaveLength(1);
    expect(live()[0]?.textContent).toBe(A11Y_RUN_MESSAGES.running);
  });
});
