// @vitest-environment jsdom
// Spec: specs/visibility-probes.schema.ts (ProbesState: type only)
// Acceptance: specs/serp-panels.feature.md (Command palette: the palette trusts only what a watching panel saw);
// specs/ai-readiness.feature.md (AI readiness views: the Overview tile watches the probes too)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProbesState } from '@app/specs/visibility-probes.schema';

/** `serp.watchProbes` answers each tab's state once, then waits forever (a long-poll with nothing new). */
const fake = vi.hoisted(() => ({ answered: new Set<number>() }));
vi.mock('../ipc', () => ({
  actions: {},
  ipc: {
    serp: {
      watchProbes: {
        query: ({ tabId }: { tabId: number }) => {
          if (fake.answered.has(tabId)) return new Promise<never>(() => undefined);
          fake.answered.add(tabId);
          return Promise.resolve({ tabId, url: 'https://example.com/', status: 'running', rows: [], diffs: [], robotsTxt: [], llmsTxt: null, startedAt: 1, finishedAt: null, version: 1 } satisfies ProbesState);
        },
      },
    },
  },
}));

const { useProbes } = await import('../hooks/useSerp');
const { knownProbes } = await import('../visibility-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Watcher({ tabId }: { readonly tabId: number }) {
  const probes = useProbes(tabId);
  return createElement('span', { 'data-status': probes?.status ?? 'none' });
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  fake.answered.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test('use-probes-forgets-on-unmount', async () => {
  // Two watchers of tab 7 (the Visibility panel and the Overview tile are the same hook): each remembers what it saw.
  await act(async () => root.render(createElement(Watcher, { tabId: 7 })));
  expect(knownProbes(7)?.status).toBe('running');
  // The watcher moves to another tab: tab 7's probes are forgotten, the new tab's remembered.
  await act(async () => root.render(createElement(Watcher, { tabId: 8 })));
  expect(knownProbes(7)).toBeUndefined();
  expect(knownProbes(8)?.status).toBe('running');
  // Any watcher unmounting (the user leaves the Overview): the palette no longer trusts tab 8's last state.
  await act(async () => root.render(createElement('div')));
  expect(knownProbes(8)).toBeUndefined();
});
