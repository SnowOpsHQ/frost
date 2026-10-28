import { useSyncExternalStore } from 'react';
import type { ScreenshotKind } from '@app/specs/capture-db.spec';
import type { TakeScreenshotAnswer } from '@app/specs/screenshot.spec';

// The screenshot each tab is taking, kept outside any component (`screenshot.feature.md`, The Changes
// panel), like `capture-project.ts`: the panel's Screenshot group and the palette both start
// screenshots here, so a panel that remounts while one runs (another URL of the same document, the
// sidebar closed and opened) still shows the area's Cancel, and announces the outcome when it comes.

const running = new Map<number, ScreenshotKind>();
const changed = new Set<() => void>();
const finished = new Set<(tabId: number, answer: TakeScreenshotAnswer | null) => void>();
const notify = (): void => {
  for (const listener of [...changed]) listener();
};

/** The kind of screenshot `tabId` is taking (`null`: none). */
export function screenshotRun(tabId: number): ScreenshotKind | null {
  return running.get(tabId) ?? null;
}

/**
 * Takes a screenshot of `tabId` through `take`, recorded as running for the tab until it answers; the
 * answer goes to every `onScreenshotFinished` listener. A tab already taking one is left as it is
 * (main answers `busy`, and that is passed on).
 */
export async function runScreenshot(take: (tabId: number, kind: ScreenshotKind) => Promise<TakeScreenshotAnswer | null>, tabId: number, kind: ScreenshotKind): Promise<TakeScreenshotAnswer | null> {
  const owner = !running.has(tabId);
  if (owner) {
    running.set(tabId, kind);
    notify();
  }
  let answer: TakeScreenshotAnswer | null = null;
  try {
    answer = await take(tabId, kind).catch(() => null);
  } finally {
    if (owner) {
      running.delete(tabId);
      notify();
    }
  }
  for (const listener of [...finished]) listener(tabId, answer);
  return answer;
}

/** Calls `listener` with each screenshot's tab and answer as it ends; answers a function that stops. */
export function onScreenshotFinished(listener: (tabId: number, answer: TakeScreenshotAnswer | null) => void): () => void {
  finished.add(listener);
  return () => {
    finished.delete(listener);
  };
}

function subscribe(listener: () => void): () => void {
  changed.add(listener);
  return () => {
    changed.delete(listener);
  };
}

/** `screenshotRun(tabId)`, re-rendering when it changes. */
export function useScreenshotRun(tabId: number): ScreenshotKind | null {
  return useSyncExternalStore(subscribe, () => screenshotRun(tabId));
}
