import { useSyncExternalStore } from 'react';

// Whether the AI answers sheet is open, and what it was opened for (Phase 12 Task 9; acceptance
// `ai-answers.feature.md`, Renderer), per window, like the crawl sheet. It opens from the palette ("Ask AI
// engines…", "Show AI answers") and closes on Close or Esc, on "Open in tab", and when another sheet opens
// (one at a time).

export interface AiAnswersRequest {
  readonly seq: number;
  /** Where focus goes: the question (`ask`) or the sheet's heading (`list`). */
  readonly focus: 'ask' | 'list';
}

interface Snapshot {
  readonly open: boolean;
  readonly request: AiAnswersRequest | null;
}

let snapshot: Snapshot = { open: false, request: null };
const listeners = new Set<() => void>();
const openedListeners = new Set<() => void>();

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

export function openAiAnswers(options: { readonly focus?: 'ask' | 'list' } = {}): void {
  set({ open: true, request: { seq: (snapshot.request?.seq ?? 0) + 1, focus: options.focus ?? 'list' } });
  for (const listener of [...openedListeners]) listener();
}

export function closeAiAnswers(): void {
  if (snapshot.open) set({ open: false, request: snapshot.request });
}

/** Subscribes to the sheet's open requests; answers the unsubscribe. */
export function onAiAnswersOpened(listener: () => void): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

export function useAiAnswersSheet(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
