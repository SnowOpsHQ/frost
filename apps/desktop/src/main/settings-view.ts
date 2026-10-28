import { MAX_PENDING_SETTINGS_WATCHES, type SettingsViewState } from '@app/specs/account-settings.schema';
import type { SettingsViewService } from '@app/ipc-contract';

// The menu's "Settings…" (Phase 4 Task 9; acceptance `account-settings.feature.md`, Main). The menu is
// main's, so `show` raises a counter the chrome long-polls (`settingsView.watch`) and gives the chrome
// of the focused app window keyboard focus (the sheet then focuses itself). Settings' own counter,
// outside `BrowserState`: no other feature's state changes when Settings is asked for.

export interface SettingsViewDeps {
  /** The chrome of the app window the request is for (the focused one), or `null`. */
  readonly chrome: () => { focus(): void } | null;
}

export interface SettingsViewMainService extends SettingsViewService {
  /** Asks the chrome to open Settings (the menu item). A no-op without an app window. */
  show(): void;
  /** Answers every waiting watch (quit). */
  dispose(): void;
}

interface Waiter {
  readonly since: number;
  readonly resolve: (state: SettingsViewState) => void;
}

export function createSettingsView(deps: SettingsViewDeps): SettingsViewMainService {
  let seq = 0;
  const waiters: Waiter[] = [];
  const state = (): SettingsViewState => ({ seq });

  const release = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.resolve(state());
  };

  return {
    state,
    watch(sinceSeq, signal) {
      if (seq > sinceSeq || signal?.aborted) return Promise.resolve(state());
      return new Promise<SettingsViewState>((resolve) => {
        const waiter: Waiter = { since: sinceSeq, resolve };
        waiters.push(waiter);
        signal?.addEventListener('abort', () => release(waiter), { once: true });
        while (waiters.length > MAX_PENDING_SETTINGS_WATCHES) release(waiters[0]!);
      });
    },
    show() {
      const chrome = deps.chrome();
      if (!chrome) return;
      seq += 1;
      chrome.focus();
      for (const waiter of [...waiters]) if (seq > waiter.since) release(waiter);
    },
    dispose() {
      for (const waiter of [...waiters]) release(waiter);
    },
  };
}
