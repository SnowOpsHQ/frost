// @vitest-environment jsdom
// Acceptance: specs/projects.feature.md (Changes panel: picker-refresh-never-outlives-the-picker)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ProjectSummary } from '@app/specs/projects.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const lists: Deferred<{ projects: ProjectSummary[] }>[] = [];
const forPages: Deferred<{ projects: ProjectSummary[] }>[] = [];
vi.mock('../ipc', () => ({
  ipc: {
    projects: {
      list: { query: () => (lists.push(deferred()), lists.at(-1)!.promise) },
      forPage: { query: () => (forPages.push(deferred()), forPages.at(-1)!.promise) },
    },
  },
}));

const { ProjectPicker } = await import('../components/changes/ProjectPicker');
const { captureProject, setCaptureProject } = await import('../components/changes/capture-project');
const { notifyProjectsChanged } = await import('../components/changes/projects-sheet');

const project = (id: string): ProjectSummary => ({ id, name: id, unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null } });
const P = '01890a5d-ac96-774b-bcce-b302099a8057';

let root: Root;
beforeEach(() => {
  lists.length = 0;
  forPages.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  setCaptureProject(undefined);
});

test('picker-refresh-never-outlives-the-picker', async () => {
  act(() => root.render(createElement(ProjectPicker, { url: 'https://example.com/a' })));
  await act(async () => {
    lists[0]!.resolve({ projects: [] });
    forPages[0]!.resolve({ projects: [] });
  });
  expect(captureProject()).toBeUndefined();
  // The sheet changed the projects: a refresh starts, and the panel goes before it answers.
  act(() => notifyProjectsChanged());
  expect(lists).toHaveLength(2);
  act(() => root.unmount());
  await act(async () => {
    lists[1]!.resolve({ projects: [project(P)] });
    forPages[1]!.resolve({ projects: [project(P)] });
  });
  // Its answer never sets the capture destination the picker gave back.
  expect(captureProject()).toBeUndefined();
});
