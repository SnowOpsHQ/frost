import { useSyncExternalStore } from 'react';

// The project captures are filed in: the one source both "Capture now" (the panel) and "Capture this
// page" (the palette) read (`changes-panel.feature.md`, Capture now). `undefined` is Unfiled. Task 6's
// project picker sets it with `setCaptureProject`.

let current: string | undefined;
const listeners = new Set<() => void>();

/** The project the next capture goes to (`undefined`: Unfiled). */
export function captureProject(): string | undefined {
  return current;
}

/** Chooses the project captures go to (`undefined`: Unfiled). */
export function setCaptureProject(projectId: string | undefined): void {
  if (projectId === current) return;
  current = projectId;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `captureProject()`, re-rendering when it changes. */
export function useCaptureProject(): string | undefined {
  return useSyncExternalStore(subscribe, captureProject);
}
