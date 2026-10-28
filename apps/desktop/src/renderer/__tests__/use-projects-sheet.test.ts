// @vitest-environment jsdom
// Spec: specs/projects.spec.ts (PROJECTS_TITLE)
// Acceptance: specs/projects.feature.md (The sheet: projects-and-history-sheets-exclude-each-other)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { closeProjects, openProjects, useProjectsSheet } from '../components/changes/projects-sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let open = false;
const closeHistory = vi.fn();
function Probe({ historyOpen }: { historyOpen: boolean }) {
  [open] = useProjectsSheet(historyOpen, closeHistory);
  return null;
}
const show = (historyOpen: boolean) => act(() => root.render(createElement(Probe, { historyOpen })));

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  closeHistory.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  closeProjects();
});

test('projects-and-history-sheets-exclude-each-other', () => {
  // History is open; Projects opens: History closes.
  show(true);
  expect(open).toBe(false);
  act(() => openProjects());
  expect(open).toBe(true);
  expect(closeHistory).toHaveBeenCalledOnce();
  show(false);
  // History opens while Projects is open: Projects closes.
  show(true);
  expect(open).toBe(false);
  expect(closeHistory).toHaveBeenCalledOnce();
  // Closed and opened again on their own: nothing else happens.
  show(false);
  act(() => openProjects({ projectId: 'x' }));
  expect(open).toBe(true);
  act(() => closeProjects());
  expect(open).toBe(false);
  expect(closeHistory).toHaveBeenCalledOnce();
});
