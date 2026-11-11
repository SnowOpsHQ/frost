// @vitest-environment jsdom
// Spec: specs/seo-checks.spec.ts (ChecksState)
// Acceptance: specs/seo-checks.feature.md (Panels and palette: checks-watch-forgets-on-unmount)
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { IDLE_HREFLANG_RUN, IDLE_LINK_RUN, IDLE_SITEMAP_RUN, type ChecksState } from '@app/specs/seo-checks.spec';

const watch = vi.fn<(input: { tabId: number; sinceVersion: number }) => Promise<ChecksState>>();
vi.mock('../ipc', () => ({ ipc: { checks: { watch: { query: (input: { tabId: number; sinceVersion: number }) => watch(input) } } } }));
const { useChecks } = await import('../hooks/useChecks');
const { knownChecks } = await import('../checks-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ tabId }: { tabId: number }) {
  useChecks(tabId);
  return null;
}

test('checks-watch-forgets-on-unmount', async () => {
  const running: ChecksState = { version: 3, tabId: 7, url: 'https://example.com/', links: { ...IDLE_LINK_RUN, status: 'running', total: 4 }, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN };
  // The first poll answers "running"; the next waits for a push that never comes (the run ends unseen).
  watch.mockImplementation(({ sinceVersion }) => (sinceVersion < 0 ? Promise.resolve(running) : new Promise<ChecksState>(() => undefined)));
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe, { tabId: 7 })));
  await act(async () => undefined);
  expect(knownChecks(7)?.links.status).toBe('running');
  // The Links panel closes: nothing watches tab 7 now, so the palette must not keep offering "Stop link check".
  act(() => root.unmount());
  expect(knownChecks(7)).toBeUndefined();
});
