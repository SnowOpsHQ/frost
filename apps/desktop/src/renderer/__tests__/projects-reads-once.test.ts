// @vitest-environment jsdom
// Spec: specs/retention.spec.ts (RetentionPreviewAnswer, PurgeNowAnswer), specs/projects.spec.ts (RunState)
// Acceptance: specs/retention.feature.md (The project view: the preview line "refreshed after each
// change"). Issue #25 (Efficiency): Save and Purge now read the figures once each.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSummary, RunState } from '@app/specs/projects.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1 = '01920000-0000-7000-8000-0000000000a1';
const P2 = '01920000-0000-7000-8000-0000000000a2';

const fakes = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  runState: vi.fn(),
  retentionPreview: vi.fn(),
  usage: vi.fn(),
  purgeLog: vi.fn(),
  setRetention: vi.fn(),
  purgeNow: vi.fn(),
}));

vi.mock('../ipc', () => ({
  rankingsActions: {},
  projectsActions: {},
  actions: { focusPage: vi.fn(async () => true), navigate: vi.fn(async () => true) },
  ipc: {
    projects: {
      list: { query: fakes.list },
      get: { query: fakes.get },
      runState: { query: fakes.runState },
      retentionPreview: { query: fakes.retentionPreview },
      usage: { query: fakes.usage },
      purgeLog: { query: fakes.purgeLog },
      setRetention: { mutate: fakes.setRetention },
      purgeNow: { mutate: fakes.purgeNow },
      cancelRun: { mutate: vi.fn(async () => true) },
    },
  },
}));

const { Projects } = await import('../components/changes/Projects');
const { openProjects } = await import('../components/changes/projects-sheet');

let host: HTMLDivElement;
let root: Root;
/** Main's answer, a task later (as an IPC reply comes): never in the same round of promises as the call. */
const reply = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
/** Lets every answer in flight land (a few tasks, each followed by its renders). */
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
};
const $ = <T extends Element = HTMLElement>(testId: string) => host.querySelector<T>(`[data-testid="${testId}"]`);

const summary = (id: string, name: string): ProjectSummary => ({ id, name, unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 1, lastCapturedAt: null, cadence: 'off', autoCapture: false, due: false });
const PROJECTS = [summary(P1, 'One'), summary(P2, 'Two')];

/** How many times each read was sent so far. */
const counts = () => ({ list: fakes.list.mock.calls.length, get: fakes.get.mock.calls.length, preview: fakes.retentionPreview.mock.calls.length, usage: fakes.usage.mock.calls.length, purgeLog: fakes.purgeLog.mock.calls.length });
const since = (before: ReturnType<typeof counts>) => {
  const now = counts();
  return { list: now.list - before.list, get: now.get - before.get, preview: now.preview - before.preview, usage: now.usage - before.usage, purgeLog: now.purgeLog - before.purgeLog };
};

/** Opens the sheet on `projectId`; `run`: the run state main answers first (then it waits). */
async function openSheet(run: RunState | null = null, projectId = P1) {
  fakes.runState.mockImplementation(({ sinceVersion }: { sinceVersion: number }) => (run !== null && sinceVersion < run.version ? reply(run) : new Promise(() => undefined)));
  openProjects({ projectId });
  await act(async () => root.render(createElement(Projects, { tab: undefined, onClose: vi.fn() })));
  await flush();
}

beforeEach(() => {
  for (const fake of Object.values(fakes)) fake.mockReset();
  fakes.list.mockImplementation(() => reply({ projects: PROJECTS }));
  fakes.get.mockImplementation(({ projectId }: { projectId: string }) => reply({ project: PROJECTS.find((p) => p.id === projectId)!, pages: [], queries: [], competitors: [] }));
  fakes.retentionPreview.mockImplementation(() => reply({ status: 'ok', policy: { mode: 'forever', value: null }, counts: { captures: 1, versions: 1, diffs: 0, screenshots: 0 }, bytes: 10 }));
  fakes.usage.mockImplementation(() => reply({ status: 'refused', reason: 'store-failed' }));
  fakes.purgeLog.mockImplementation(() => reply({ entries: [] }));
  fakes.setRetention.mockImplementation(() => reply({ status: 'ok' }));
  fakes.purgeNow.mockImplementation(() => reply({ status: 'empty' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test('retention-save-reads-once', async () => {
  await openSheet();
  expect($('projects-retention')).not.toBeNull();
  const before = counts();
  await act(async () => $<HTMLFormElement>('retention-policy')!.requestSubmit());
  await flush();
  expect(fakes.setRetention).toHaveBeenCalledTimes(1);
  // The project is read again, and with it the preview, usage and purge log: once each.
  expect(since(before)).toEqual({ list: 1, get: 1, preview: 1, usage: 1, purgeLog: 1 });
});

test('retention-purge-reads-once', async () => {
  await openSheet();
  expect($<HTMLButtonElement>('retention-purge')!.disabled).toBe(false);
  const before = counts();
  await act(async () => $<HTMLButtonElement>('retention-purge')!.click());
  await flush();
  expect(fakes.purgeNow).toHaveBeenCalledTimes(1);
  expect(since(before)).toEqual({ list: 1, get: 1, preview: 1, usage: 1, purgeLog: 1 });
});
