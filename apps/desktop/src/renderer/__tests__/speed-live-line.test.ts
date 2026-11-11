// @vitest-environment jsdom
// Spec: specs/seo-speed.spec.ts (SPEED_LIVE_MAX_POLLS)
// Acceptance: specs/seo-speed.feature.md (Live updates; Renderer helpers, paused-line-age-keeps-counting)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SpeedReport } from '@app/seo-core';
import { SPEED_LIVE_MAX_POLLS } from '@app/specs/seo-speed.spec';
import type { SpeedPollState } from '../speed-poller';

vi.mock('../ipc', () => ({ actions: {} }));

const { LiveLine } = await import('../components/seo/Speed');

const A = 'https://example.com/a';
const MEASURED_AT = Date.UTC(2026, 10, 11, 12, 0, 0);
// The line reads only `measuredAt` of the report.
const report = { measuredAt: MEASURED_AT } as SpeedReport;
const paused: SpeedPollState = { session: { tabId: 1, url: A, document: 1 }, response: { status: 'ready', url: A, report }, polls: SPEED_LIVE_MAX_POLLS, paused: true };

let host: HTMLDivElement;
let root: Root;
const text = () => host.querySelector('[data-testid="seo-speed-live"] .seo-speed-live-text')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(MEASURED_AT);
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('the Speed live line', () => {
  test('paused-line-age-keeps-counting', async () => {
    act(() => root.render(createElement(LiveLine, { state: paused, report, source: 'live', onResume: () => {} })));
    expect(host.querySelector('[data-testid="seo-speed-live"]')?.getAttribute('data-state')).toBe('paused');
    expect(text()).toBe(`Paused after ${SPEED_LIVE_MAX_POLLS} updates · last just now`);
    // Nothing polls any more, so nothing else re-renders the line: its age still follows the clock.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(text()).toBe(`Paused after ${SPEED_LIVE_MAX_POLLS} updates · last 30 s ago`);
    await act(() => vi.advanceTimersByTimeAsync(150_000));
    expect(text()).toBe(`Paused after ${SPEED_LIVE_MAX_POLLS} updates · last 3 min ago`);
  });
});
