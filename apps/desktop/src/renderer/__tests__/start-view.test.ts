// @vitest-environment jsdom
// Spec: specs/help.spec.ts (SETUP_CHECKLIST_ITEMS, SETUP_CHECKLIST_STORAGE_KEY, SETUP_CHECKLIST_TEXT)
// Acceptance: specs/help.feature.md (Chrome: setup-checklist-done-states, setup-checklist-dismiss,
// setup-checklist-storage-tolerant)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SETUP_CHECKLIST_ITEMS, SETUP_CHECKLIST_STORAGE_KEY, SETUP_CHECKLIST_TEXT } from '@app/specs/help.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Main's side, as the chrome reads it. */
const main = {
  agentReady: false,
  gscConnected: false,
  projects: [{ id: 'unfiled', name: 'Unfiled', unfiled: true }] as { id: string; name: string; unfiled: boolean }[],
  agentReads: 0,
  projectReads: 0,
};
const never = () => new Promise<never>(() => undefined);
const gscStatus = () => ({ version: 1, configured: true, entitled: true, connected: main.gscConnected, connecting: false, keychain: 'persistent', error: null });
/** The Search Console watch waiting in main: answering it ends the chrome's wait. */
let gscWaiting: ((status: unknown) => void) | null = null;
vi.mock('../ipc', () => ({
  ipc: {
    agent: {
      watch: {
        query: async () => {
          main.agentReads += 1;
          return { version: 1, setup: { ready: main.agentReady } };
        },
      },
    },
    gsc: {
      watch: {
        query: ({ sinceVersion }: { sinceVersion: number }) =>
          sinceVersion < 0
            ? Promise.resolve(gscStatus())
            : new Promise((resolve) => {
                gscWaiting = resolve;
              }),
      },
    },
    account: { watch: { query: never }, settingsWatch: { query: never } },
    help: { watch: { query: never } },
  },
  actions: {
    jumpBackIn: async () => ({ mostVisited: [], recent: [] }),
    listProjects: async () => {
      main.projectReads += 1;
      return main.projects;
    },
    navigate: vi.fn(),
  },
}));
const openProjects = vi.fn();
vi.mock('../components/changes/projects-sheet', () => ({ openProjects: (...args: unknown[]) => openProjects(...args) }));

const { StartView } = await import('../components/StartView');
const { onAgentPanelRequest } = await import('../agent-palette');
const { onSettingsRequest } = await import('../settings-open');
const { onHelpSheetRequest } = await import('../help-palette');
const { readSetupMarks } = await import('../components/SetupChecklist');

let root: Root;
let host: HTMLElement;
beforeEach(async () => {
  main.agentReady = false;
  main.gscConnected = false;
  // The chrome's shared Search Console store ends its wait with main's state now (not connected).
  const waiting = gscWaiting;
  gscWaiting = null;
  await act(async () => waiting?.({ ...gscStatus(), version: 9 }));
  main.projects = [{ id: 'unfiled', name: 'Unfiled', unfiled: true }];
  main.agentReads = 0;
  main.projectReads = 0;
  openProjects.mockClear();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const checklist = () => host.querySelector('[data-testid="setup-checklist"]');
const items = () => [...host.querySelectorAll<HTMLElement>('[data-testid="setup-item"]')];
const done = () => items().filter((item) => item.dataset['done'] === 'true').map((item) => item.dataset['item']);
const actionOf = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="setup-item"][data-item="${id}"] [data-testid="setup-action"]`)!;

async function show(tabId = 1): Promise<void> {
  await act(async () => root.render(createElement(StartView, { tabId })));
  // Main's answers arrive.
  await act(async () => undefined);
}

test('setup-checklist-done-states', async () => {
  await show();
  expect(checklist()).not.toBeNull();
  expect(checklist()!.textContent).toContain(SETUP_CHECKLIST_TEXT.title);
  expect(items().map((item) => item.dataset['item'])).toEqual(SETUP_CHECKLIST_ITEMS.map((item) => item.id));
  for (const item of SETUP_CHECKLIST_ITEMS) expect(checklist()!.textContent).toContain(item.label);
  expect(done()).toEqual([]);
  expect(checklist()!.textContent).toContain(SETUP_CHECKLIST_TEXT.progress(0, SETUP_CHECKLIST_ITEMS.length));
  // Read once per empty tab shown, nothing remote.
  expect(main.agentReads).toBe(1);
  expect(main.projectReads).toBe(1);

  // Each button opens where its step is done.
  const agentRequests: unknown[] = [];
  const settingsRequests: unknown[] = [];
  const helpRequests: unknown[] = [];
  const stops = [onAgentPanelRequest((r) => agentRequests.push(r)), onSettingsRequest((s) => settingsRequests.push(s)), onHelpSheetRequest((s) => helpRequests.push(s))];
  act(() => actionOf('agent').click());
  expect(agentRequests).toEqual([{ kind: 'settings' }]);
  act(() => actionOf('search-console').click());
  expect(settingsRequests).toEqual(['search-console']);
  act(() => actionOf('project').click());
  expect(openProjects).toHaveBeenCalledOnce();
  // Privacy and shortcuts are the chrome's own marks: opening them marks them done.
  act(() => actionOf('privacy').click());
  expect(settingsRequests).toEqual(['search-console', 'telemetry']);
  act(() => actionOf('shortcuts').click());
  expect(helpRequests).toEqual(['shortcuts']);
  for (const stop of stops) stop();
  expect(done()).toEqual(['privacy', 'shortcuts']);
  expect(readSetupMarks()).toEqual({ dismissed: false, privacy: true, shortcuts: true });

  // Main's state: agent ready, Search Console connected, a project besides Unfiled (read again on the next empty tab).
  main.agentReady = true;
  main.projects = [...main.projects, { id: 'p1', name: 'Shop', unfiled: false }];
  await show(2);
  expect(done()).toEqual(['agent', 'project', 'privacy', 'shortcuts']);
  expect(checklist()!.textContent).toContain(SETUP_CHECKLIST_TEXT.progress(4, SETUP_CHECKLIST_ITEMS.length));
  act(() => root.unmount());
  root = createRoot(host);
  main.gscConnected = true;
  await act(async () => gscWaiting?.({ ...gscStatus(), version: 2 }));
  // Everything done: the checklist is gone.
  await show(3);
  expect(checklist()).toBeNull();
  expect(host.querySelector('[data-testid="start-view"]')).not.toBeNull();
});

test('setup-checklist-dismiss', async () => {
  await show();
  expect(checklist()).not.toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="setup-dismiss"]')!.click());
  expect(checklist()).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(SETUP_CHECKLIST_STORAGE_KEY)!)).toMatchObject({ dismissed: true });
  // Later new tabs: still gone.
  await show(2);
  expect(checklist()).toBeNull();
});

test('setup-checklist-storage-tolerant', async () => {
  for (const stored of ['{not json', '[]', '"dismissed"', JSON.stringify({ dismissed: 'yes', privacy: 1, shortcuts: null }), 'null']) {
    window.localStorage.setItem(SETUP_CHECKLIST_STORAGE_KEY, stored);
    expect(readSetupMarks(), stored).toEqual({ dismissed: false, privacy: false, shortcuts: false });
  }
  window.localStorage.setItem(SETUP_CHECKLIST_STORAGE_KEY, JSON.stringify({ dismissed: false, privacy: true, extra: 'x' }));
  expect(readSetupMarks()).toEqual({ dismissed: false, privacy: true, shortcuts: false });
  await show();
  expect(done()).toEqual(['privacy']);
  // Storage that throws: read as nothing done and not dismissed; the page still renders, and a step
  // marked now holds for this run.
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied');
  });
  try {
    expect(readSetupMarks()).toEqual({ dismissed: false, privacy: false, shortcuts: false });
    await show(2);
    expect(checklist()).not.toBeNull();
    act(() => actionOf('shortcuts').click());
    expect(done()).toEqual(['privacy', 'shortcuts']);
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
  }
});
