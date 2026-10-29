import { BrowserWindow } from 'electron';
import { MAX_PENDING_SETTINGS_WATCHES, type SettingsViewState } from '@app/specs/account-settings.schema';
import type { SettingsRequests } from '@app/ipc-contract';

// The menu's "Settings…" (Phase 4 Task 9; acceptance `account-settings.feature.md`, Main). The menu is
// main's, so `show` raises a counter **per app window** that the window's chrome long-polls
// (`account.settingsWatch`) and gives that chrome keyboard focus (the sheet then focuses itself).
// Settings' own counters, outside `BrowserState`: no other feature's state changes when Settings is
// asked for. Part of the account (its Settings view), constructed by `createAccountMain`.

export interface SettingsRequestsDeps {
  /** The chrome of app window `windowId`, or of the focused app window when `undefined`; `null` if none. */
  readonly chrome: (windowId: number | undefined) => { readonly windowId: number; focus(): void } | null;
}

export interface SettingsRequestsMain extends SettingsRequests {
  /** Asks the chrome of `windowId` (the window the menu acted on; else the focused one) to open Settings. */
  show(windowId?: number): void;
  /** Answers every waiting watch (quit). */
  dispose(): void;
}

interface Waiter {
  readonly windowId: number;
  readonly since: number;
  readonly resolve: (state: SettingsViewState) => void;
}

export function createSettingsRequests(deps: SettingsRequestsDeps): SettingsRequestsMain {
  const seqs = new Map<number, number>();
  const waiters: Waiter[] = [];
  const state = (windowId: number): SettingsViewState => ({ seq: seqs.get(windowId) ?? 0 });

  const release = (waiter: Waiter): void => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.resolve(state(waiter.windowId));
  };

  return {
    state,
    watch(windowId, sinceSeq, signal) {
      if (state(windowId).seq > sinceSeq || signal?.aborted) return Promise.resolve(state(windowId));
      return new Promise<SettingsViewState>((resolve) => {
        const waiter: Waiter = { windowId, since: sinceSeq, resolve };
        waiters.push(waiter);
        signal?.addEventListener('abort', () => release(waiter), { once: true });
        while (waiters.length > MAX_PENDING_SETTINGS_WATCHES) release(waiters[0]!);
      });
    },
    show(windowId) {
      const chrome = deps.chrome(windowId);
      if (!chrome) return;
      seqs.set(chrome.windowId, state(chrome.windowId).seq + 1);
      chrome.focus();
      for (const waiter of [...waiters]) if (waiter.windowId === chrome.windowId && state(chrome.windowId).seq > waiter.since) release(waiter);
    },
    dispose() {
      for (const waiter of [...waiters]) release(waiter);
    },
  };
}

/**
 * Main's instance: the window by ID (the menu's), else the focused one (else the first open one). A window that is not one of
 * the app's own may get a counter, but nothing reads it: `account.settingsWatch` answers app windows only
 * (`enforceSender`).
 */
export function createSettingsRequestsMain(): SettingsRequestsMain {
  return createSettingsRequests({
    chrome: (windowId) => {
      const win = windowId === undefined ? (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null) : BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return null;
      return { windowId: win.id, focus: () => win.webContents.focus() };
    },
  });
}
