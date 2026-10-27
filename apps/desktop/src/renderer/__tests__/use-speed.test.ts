// @vitest-environment jsdom
// Spec: specs/seo-speed.spec.ts (SPEED_POLL_MS, SPEED_LIVE_MAX_POLLS), specs/browser.spec.ts (TabState.documentSeq)
// Acceptance: specs/seo-speed.feature.md (Live updates; Renderer helpers, use-speed-restarts-on-reload)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SpeedResponse } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { SPEED_LIVE_MAX_POLLS, SPEED_POLL_MS } from '@app/specs/seo-speed.spec';

/** The `seo.measureSpeed` calls the test settles. */
const ipc = vi.hoisted(() => ({ calls: [] as { tabId: number; resolve: (response: SpeedResponse | null) => void }[] }));
vi.mock('../ipc', () => ({
  actions: {
    measureSpeed: (tabId: number) => new Promise<SpeedResponse | null>((resolve) => ipc.calls.push({ tabId, resolve })),
  },
}));

const { useSpeed } = await import('../hooks/useSpeed');

const A = 'https://example.com/a';
const tabAt = (documentSeq: number): TabState => ({
  id: 1,
  url: A,
  title: 'A',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  crashed: false,
  unresponsive: false,
  permissionPrompt: null,
  fullscreen: null,
  zoom: 1,
  auditVersion: 1,
  documentSeq,
  highlight: 'off',
  renderProfile: null,
});
const pending = (url: string): SpeedResponse => ({ status: 'pending', url });

let root: Root;
let latest: ReturnType<typeof useSpeed>;
function Probe({ tab }: { readonly tab: TabState }) {
  latest = useSpeed(tab);
  return null;
}
const render = (tab: TabState) => act(() => root.render(createElement(Probe, { tab })));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  ipc.calls.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useSpeed', () => {
  test('use-speed-restarts-on-reload', async () => {
    render(tabAt(1));
    // Poll until the session pauses at the limit.
    for (let i = 0; i < SPEED_LIVE_MAX_POLLS; i++) {
      await act(async () => {
        ipc.calls.at(-1)!.resolve(pending(A));
        await vi.advanceTimersByTimeAsync(SPEED_POLL_MS);
      });
    }
    expect(ipc.calls).toHaveLength(SPEED_LIVE_MAX_POLLS);
    expect(latest.state).toMatchObject({ session: { tabId: 1, url: A }, response: pending(A), polls: SPEED_LIVE_MAX_POLLS, paused: true });
    // A re-render of the same document changes nothing.
    render({ ...tabAt(1), auditVersion: 2 });
    expect(ipc.calls).toHaveLength(SPEED_LIVE_MAX_POLLS);
    // The user reloads: the same tab and URL, a new document. A fresh session polls at once, with no
    // answer from the old document left to show.
    render(tabAt(2));
    expect(ipc.calls).toHaveLength(SPEED_LIVE_MAX_POLLS + 1);
    expect(latest.state).toMatchObject({ response: null, polls: 0, paused: false });
    await act(async () => {
      ipc.calls.at(-1)!.resolve(pending(A));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest.state).toMatchObject({ response: pending(A), polls: 1, paused: false });
  });
});
