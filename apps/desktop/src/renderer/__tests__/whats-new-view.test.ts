// @vitest-environment jsdom
// Spec: specs/help.spec.ts (WHATS_NEW_TEXT), specs/whats-new.schema.ts (WhatsNewAnswerSchema)
// Acceptance: specs/help.feature.md (Chrome: whats-new-shown-once-across-remounts)
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const never = () => new Promise<never>(() => undefined);
let answerTake: (take: boolean) => void = () => undefined;
const takeWhatsNew = vi.fn(
  () =>
    new Promise<boolean>((resolve) => {
      answerTake = resolve;
    }),
);
vi.mock('../ipc', () => ({
  ipc: {
    help: {
      takeWhatsNew: { mutate: () => takeWhatsNew() },
      whatsNew: { query: async () => ({ currentVersion: '1.2.0', releases: [{ version: '1.2.0', date: '2026-11-01', title: 'New things', items: ['A thing'] }] }) },
      watch: { query: never },
      openLink: { mutate: async () => 'opened' },
    },
    gsc: { watch: { query: never } },
    account: { watch: { query: never }, settingsWatch: { query: never } },
  },
  actions: { focusPage: async () => false, listProjects: async () => [] },
}));

const { WhatsNewSheet } = await import('../components/WhatsNewView');

const roots: Root[] = [];
const host = document.createElement('div');
document.body.append(host);
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

type Tab = { id: number; documentSeq: number; loading: boolean } | undefined;
function mount(tab: Tab): Root {
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(StrictMode, null, createElement(WhatsNewSheet, { tab, historySeq: undefined, onOpen: () => undefined }))));
  return root;
}
const sheet = () => host.querySelector('[data-testid="whats-new-view"]');

test('whats-new-shown-once-across-remounts', async () => {
  // Mounted (StrictMode runs the effect twice), unmounted and mounted again before main answers.
  const first = mount({ id: 1, documentSeq: 1, loading: true });
  act(() => first.unmount());
  roots.length = 0;
  const second = mount({ id: 1, documentSeq: 1, loading: true });
  expect(takeWhatsNew).toHaveBeenCalledOnce();
  // Main says this run follows a version change; the restored tab is still loading: not yet.
  await act(async () => answerTake(true));
  expect(sheet()).toBeNull();
  // The tab's document commits and it finishes loading: now it shows (a page change before it showed never closes it).
  act(() => second.render(createElement(StrictMode, null, createElement(WhatsNewSheet, { tab: { id: 1, documentSeq: 2, loading: false }, historySeq: undefined, onOpen: () => undefined }))));
  await act(async () => undefined);
  expect(sheet()).not.toBeNull();
  expect(sheet()!.textContent).toContain('New things');
  // A new document in the tab closes it, as other sheets.
  act(() => second.render(createElement(StrictMode, null, createElement(WhatsNewSheet, { tab: { id: 1, documentSeq: 3, loading: true }, historySeq: undefined, onOpen: () => undefined }))));
  expect(sheet()).toBeNull();
  // Shown once: a later mount neither asks main again nor shows it.
  act(() => second.unmount());
  roots.length = 0;
  mount({ id: 1, documentSeq: 3, loading: false });
  await act(async () => undefined);
  expect(sheet()).toBeNull();
  expect(takeWhatsNew).toHaveBeenCalledOnce();
});
