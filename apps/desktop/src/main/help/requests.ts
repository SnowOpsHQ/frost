import { MAX_PENDING_HELP_WATCHES, type HelpSheet } from '@app/specs/help.spec';
import type { HelpViewState } from '@app/specs/whats-new.schema';

// The Help menu's sheet requests (Phase 11 Task 11; acceptance `help.feature.md`). The menu is main's,
// so `show` raises a counter **per app window** with the sheet asked for, which that window's chrome
// long-polls (`help.watch`), and gives that chrome keyboard focus (the sheet then focuses itself).
// Help's own counters, outside `BrowserState` (as the Settings view's).

export interface HelpRequestsDeps {
  /** The chrome of app window `windowId`, or of the focused app window when `undefined`; `null` if none. */
  readonly chrome: (windowId: number | undefined) => { readonly windowId: number; focus(): void } | null;
}

export interface HelpRequests {
  state(windowId: number): HelpViewState;
  watch(windowId: number, sinceSeq: number, signal?: AbortSignal): Promise<HelpViewState>;
  /** Asks the chrome of `windowId` (the window the menu acted on; else the focused one) to show `sheet`. */
  show(sheet: HelpSheet, windowId?: number): void;
  /** Answers every waiting watch (quit). */
  dispose(): void;
}

interface Waiter {
  readonly windowId: number;
  readonly since: number;
  readonly resolve: (state: HelpViewState) => void;
}

export function createHelpRequests(deps: HelpRequestsDeps): HelpRequests {
  const states = new Map<number, HelpViewState>();
  const waiters: Waiter[] = [];
  const state = (windowId: number): HelpViewState => states.get(windowId) ?? { seq: 0, sheet: null };

  const release = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.resolve(state(waiter.windowId));
  };

  return {
    state,
    watch(windowId, sinceSeq, signal) {
      if (state(windowId).seq > sinceSeq || signal?.aborted) return Promise.resolve(state(windowId));
      return new Promise<HelpViewState>((resolve) => {
        const waiter: Waiter = { windowId, since: sinceSeq, resolve };
        waiters.push(waiter);
        signal?.addEventListener('abort', () => release(waiter), { once: true });
        while (waiters.length > MAX_PENDING_HELP_WATCHES) release(waiters[0]!);
      });
    },
    show(sheet, windowId) {
      const chrome = deps.chrome(windowId);
      if (!chrome) return;
      states.set(chrome.windowId, { seq: state(chrome.windowId).seq + 1, sheet });
      chrome.focus();
      for (const waiter of [...waiters]) if (waiter.windowId === chrome.windowId && state(chrome.windowId).seq > waiter.since) release(waiter);
    },
    dispose() {
      for (const waiter of [...waiters]) release(waiter);
    },
  };
}
