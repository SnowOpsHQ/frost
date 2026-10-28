import { useCallback, useSyncExternalStore } from 'react';

// Whether the Projects sheet is open, and what it was opened for (acceptance `projects.feature.md`,
// The sheet; per window, like History). It opens from the palette ("Open projects", "Add this page
// to a project", "Capture project now"), from the Changes panel's Projects button, and closes on
// Esc or Close. `App.tsx` reads it with `useProjectsSheet`; the sheet reads its request with
// `useProjectsRequest`. The last project opened in the sheet is what "Capture project now" runs.

/** What the sheet was opened for: a project to show, or a page to add to a project. `seq` makes each one new. */
export interface ProjectsRequest {
  readonly seq: number;
  readonly projectId: string | null;
  /** The page to add (the active tab's, from "Add this page to a project"). */
  readonly addUrl: string | null;
}

interface Snapshot {
  readonly open: boolean;
  readonly request: ProjectsRequest | null;
}

let snapshot: Snapshot = { open: false, request: null };
let lastProject: string | undefined;
const listeners = new Set<() => void>();

function set(next: Snapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the sheet (on `projectId`, or to add `addUrl` to a project). */
export function openProjects(options: { readonly projectId?: string | null; readonly addUrl?: string | null } = {}): void {
  set({ open: true, request: { seq: (snapshot.request?.seq ?? 0) + 1, projectId: options.projectId ?? null, addUrl: options.addUrl ?? null } });
}

export function closeProjects(): void {
  if (snapshot.open) set({ open: false, request: snapshot.request });
}

/** The project last shown in the sheet (`undefined`: none yet this session). */
export function lastOpenedProject(): string | undefined {
  return lastProject;
}

export function setLastOpenedProject(projectId: string | undefined): void {
  lastProject = projectId;
}

/** Whether the sheet is open, and how to close it (`App.tsx`). */
export function useProjectsSheet(): readonly [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => snapshot.open);
  return [open, useCallback(closeProjects, [])];
}

/** The latest request the sheet was opened with. */
export function useProjectsRequest(): ProjectsRequest | null {
  return useSyncExternalStore(subscribe, () => snapshot.request);
}
